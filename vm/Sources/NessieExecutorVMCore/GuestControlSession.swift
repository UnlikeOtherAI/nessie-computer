import Darwin
import Dispatch
import Foundation

enum GuestControlProtocolError: Error, Equatable {
  case closed
  case invalidBootstrapToken
  case invalidState
  case requestAlreadyActive
  case unexpectedIncomingRequest
  case unexpectedResponse
}

enum GuestControlConversationEvent: Equatable {
  case authenticated
  case closed
  case response(GuestControlEnvelope)
}

/**
 * Keeps the authentication and request/response invariants independent from a
 * virtio file descriptor. There is no guest-initiated command direction: after
 * its one hello, the guest can only answer the host's one outstanding request
 * or close the channel.
 */
final class GuestControlConversation {
  private let expectedBootstrapToken: String
  private(set) var authenticated = false
  private(set) var pendingRequestId: UUID?
  private var isClosed = false

  init(expectedBootstrapToken: String) throws {
    guard isValidGuestControlBootstrapToken(expectedBootstrapToken) else {
      throw GuestControlProtocolError.invalidBootstrapToken
    }
    self.expectedBootstrapToken = expectedBootstrapToken
  }

  func beginRequest(_ requestId: UUID) throws {
    guard authenticated, !isClosed else { throw GuestControlProtocolError.invalidState }
    guard pendingRequestId == nil else { throw GuestControlProtocolError.requestAlreadyActive }
    pendingRequestId = requestId
  }

  func receive(_ envelope: GuestControlEnvelope) throws -> GuestControlConversationEvent {
    guard !isClosed else { throw GuestControlProtocolError.closed }
    if !authenticated {
      guard envelope.kind == .hello, let token = envelope.sessionToken,
        constantTimeEqual(token, expectedBootstrapToken)
      else {
        throw GuestControlProtocolError.invalidState
      }
      authenticated = true
      return .authenticated
    }

    switch envelope.kind {
    case .hello:
      throw GuestControlProtocolError.invalidState
    case .request:
      throw GuestControlProtocolError.unexpectedIncomingRequest
    case .response:
      guard envelope.requestId == pendingRequestId else {
        throw GuestControlProtocolError.unexpectedResponse
      }
      pendingRequestId = nil
      return .response(envelope)
    case .close:
      isClosed = true
      return .closed
    }
  }
}

/** Buffers only one partially received bounded frame at a time. */
public final class GuestControlFrameStreamDecoder {
  private var buffered = Data()

  public init() {}

  public func append(_ bytes: Data) throws -> [GuestControlEnvelope] {
    guard buffered.count + bytes.count <= guestControlFrameMaxBytes + 8_192 else {
      throw GuestControlFrameError.oversized
    }
    buffered.append(bytes)
    var envelopes: [GuestControlEnvelope] = []
    while buffered.count >= 4 {
      let bodyLength = buffered.prefix(4).reduce(UInt32(0)) { partial, byte in
        (partial << 8) | UInt32(byte)
      }
      guard bodyLength <= UInt32(guestControlFrameMaxBytes - 4) else {
        throw GuestControlFrameError.oversized
      }
      let frameLength = Int(bodyLength) + 4
      guard buffered.count >= frameLength else { break }
      let frame = Data(buffered.prefix(frameLength))
      buffered.removeFirst(frameLength)
      envelopes.append(try GuestControlFrameCodec.decode(frame))
    }
    return envelopes
  }
}

public enum GuestControlSessionError: Error, Equatable {
  case closed
  case handshakeTimedOut
  case invalidConfiguration
  case ioFailure
  case protocolViolation
  case requestTimedOut
  case unavailable
}

/**
 * Host side of the one per-VM guest control socket. The descriptor belongs to
 * Virtualization.framework: this class stops its dispatch sources on terminal
 * state but never closes the descriptor itself. Its owner closes the matching
 * `VZVirtioSocketConnection`, preventing descriptor reuse from crossing VMs.
 */
public final class GuestControlSession {
  private let conversation: GuestControlConversation
  private let fileDescriptor: Int32
  private let handshakeTimeout: TimeInterval
  private let onAuthenticated: () -> Void
  private let onResponse: (GuestControlEnvelope) -> Void
  private let onTerminated: (GuestControlSessionError) -> Void
  private let queue = DispatchQueue(label: "works.nessie.executor.guest-control")
  private let queueKey = DispatchSpecificKey<UInt8>()
  private let requestTimeout: TimeInterval
  private var deadlineTimer: DispatchSourceTimer?
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var pendingWrite: Data?
  private var pendingWriteOffset = 0
  private var started = false
  private var terminal = false
  private let streamDecoder = GuestControlFrameStreamDecoder()

  public init(
    fileDescriptor: Int32,
    expectedBootstrapToken: String,
    handshakeTimeout: TimeInterval = 10,
    requestTimeout: TimeInterval = 30,
    onAuthenticated: @escaping () -> Void,
    onResponse: @escaping (GuestControlEnvelope) -> Void,
    onTerminated: @escaping (GuestControlSessionError) -> Void,
  ) throws {
    guard fileDescriptor >= 0, (1...30).contains(handshakeTimeout), (1...300).contains(requestTimeout) else {
      throw GuestControlSessionError.invalidConfiguration
    }
    conversation = try GuestControlConversation(expectedBootstrapToken: expectedBootstrapToken)
    self.fileDescriptor = fileDescriptor
    self.handshakeTimeout = handshakeTimeout
    self.requestTimeout = requestTimeout
    self.onAuthenticated = onAuthenticated
    self.onResponse = onResponse
    self.onTerminated = onTerminated
    queue.setSpecific(key: queueKey, value: 1)
  }

  public func start() throws {
    try onQueue {
      guard !started, !terminal else { throw GuestControlSessionError.unavailable }
      let flags = fcntl(fileDescriptor, F_GETFL)
      guard flags >= 0, fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        throw GuestControlSessionError.ioFailure
      }
      let source = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: queue)
      source.setEventHandler { [weak self] in self?.readAvailable() }
      source.setCancelHandler {}
      readSource = source
      started = true
      source.resume()
      armDeadline(after: handshakeTimeout, failure: .handshakeTimedOut)
    }
  }

  @discardableResult
  public func sendRequest(payload: Data, requestId: UUID = UUID()) throws -> UUID {
    try onQueue {
      guard started, !terminal, conversation.authenticated else {
        throw GuestControlSessionError.unavailable
      }
      let envelope = GuestControlEnvelope(kind: .request, payload: payload, requestId: requestId)
      let frame: Data
      do {
        frame = try GuestControlFrameCodec.encode(envelope)
        try conversation.beginRequest(requestId)
      } catch {
        throw GuestControlSessionError.protocolViolation
      }
      pendingWrite = frame
      pendingWriteOffset = 0
      drainWrite()
      if !terminal {
        armDeadline(after: requestTimeout, failure: .requestTimedOut)
      }
      guard !terminal else { throw GuestControlSessionError.ioFailure }
      return requestId
    }
  }

  public func stop() {
    onQueue {
      terminate(.closed)
    }
  }

  private func readAvailable() {
    var chunk = [UInt8](repeating: 0, count: 8_192)
    while !terminal {
      let count = chunk.withUnsafeMutableBytes { bytes in
        Darwin.read(fileDescriptor, bytes.baseAddress, bytes.count)
      }
      if count > 0 {
        receive(Data(chunk.prefix(Int(count))))
        continue
      }
      if count == 0 {
        terminate(.closed)
        return
      }
      if errno == EAGAIN || errno == EWOULDBLOCK { return }
      terminate(.ioFailure)
      return
    }
  }

  private func receive(_ bytes: Data) {
    do {
      for envelope in try streamDecoder.append(bytes) {
        switch try conversation.receive(envelope) {
        case .authenticated:
          clearDeadline()
          onAuthenticated()
        case let .response(response):
          clearDeadline()
          onResponse(response)
        case .closed:
          terminate(.closed)
        }
        if terminal { return }
      }
    } catch {
      terminate(.protocolViolation)
    }
  }

  private func drainWrite() {
    guard let write = pendingWrite else { return }
    while pendingWriteOffset < write.count {
      let wrote = write.withUnsafeBytes { bytes in
        Darwin.write(
          fileDescriptor,
          bytes.baseAddress!.advanced(by: pendingWriteOffset),
          write.count - pendingWriteOffset,
        )
      }
      if wrote > 0 {
        pendingWriteOffset += Int(wrote)
        continue
      }
      if wrote < 0, errno == EAGAIN || errno == EWOULDBLOCK {
        waitForWritableSocket()
        return
      }
      terminate(.ioFailure)
      return
    }
    pendingWrite = nil
    pendingWriteOffset = 0
    writeSource?.cancel()
    writeSource = nil
  }

  private func waitForWritableSocket() {
    guard writeSource == nil else { return }
    let source = DispatchSource.makeWriteSource(fileDescriptor: fileDescriptor, queue: queue)
    source.setEventHandler { [weak self] in self?.drainWrite() }
    source.setCancelHandler {}
    writeSource = source
    source.resume()
  }

  private func armDeadline(after timeout: TimeInterval, failure: GuestControlSessionError) {
    clearDeadline()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.setEventHandler { [weak self] in self?.terminate(failure) }
    deadlineTimer = timer
    timer.schedule(deadline: .now() + timeout)
    timer.resume()
  }

  private func clearDeadline() {
    deadlineTimer?.cancel()
    deadlineTimer = nil
  }

  private func terminate(_ reason: GuestControlSessionError) {
    guard !terminal else { return }
    terminal = true
    clearDeadline()
    readSource?.cancel()
    readSource = nil
    writeSource?.cancel()
    writeSource = nil
    pendingWrite = nil
    onTerminated(reason)
  }

  private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
    if DispatchQueue.getSpecific(key: queueKey) != nil {
      return try body()
    }
    return try queue.sync(execute: body)
  }
}

private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
  let leftBytes = Array(left.utf8)
  let rightBytes = Array(right.utf8)
  guard leftBytes.count == rightBytes.count else { return false }
  var difference: UInt8 = 0
  for index in leftBytes.indices {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference == 0
}
