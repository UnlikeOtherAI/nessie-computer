import Darwin
import Dispatch
import Foundation

public enum GuestEgressTunnelSessionError: Error, Equatable {
  case closed
  case handshakeTimedOut
  case invalidConfiguration
  case ioFailure
  case protocolViolation
  case unavailable
}

/**
 * Reads exactly one guest egress admission prelude. Once that prelude has been
 * verified, it releases the descriptor untouched to the VM-bound tunnel owner;
 * it never reads a CONNECT byte and never closes a descriptor it does not own.
 */
public final class GuestEgressTunnelSession {
  private let expectedSessionToken: String
  private let fileDescriptor: Int32
  private let handshakeTimeout: TimeInterval
  private let onAuthenticated: () -> Void
  private let onTerminated: (GuestEgressTunnelSessionError) -> Void
  private let queue = DispatchQueue(label: "works.nessie.executor.guest-egress-admission")
  private let queueKey = DispatchSpecificKey<UInt8>()
  private var deadlineTimer: DispatchSourceTimer?
  private var readSource: DispatchSourceRead?
  private var received = Data()
  private var started = false
  private var handedOff = false
  private var terminal = false

  public init(
    fileDescriptor: Int32,
    expectedSessionToken: String,
    handshakeTimeout: TimeInterval = 10,
    onAuthenticated: @escaping () -> Void,
    onTerminated: @escaping (GuestEgressTunnelSessionError) -> Void,
  ) throws {
    guard fileDescriptor >= 0, isValidGuestEgressSessionToken(expectedSessionToken),
      (1...30).contains(handshakeTimeout)
    else {
      throw GuestEgressTunnelSessionError.invalidConfiguration
    }
    self.fileDescriptor = fileDescriptor
    self.expectedSessionToken = expectedSessionToken
    self.handshakeTimeout = handshakeTimeout
    self.onAuthenticated = onAuthenticated
    self.onTerminated = onTerminated
    queue.setSpecific(key: queueKey, value: 1)
  }

  public func start() throws {
    try onQueue {
      guard !started, !terminal, !handedOff else { throw GuestEgressTunnelSessionError.unavailable }
      let flags = fcntl(fileDescriptor, F_GETFL)
      guard flags >= 0, fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        throw GuestEgressTunnelSessionError.ioFailure
      }
      let source = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: queue)
      source.setEventHandler { [weak self] in self?.readAvailable() }
      source.setCancelHandler {}
      readSource = source
      started = true
      source.resume()
      armDeadline()
    }
  }

  public func stop() {
    onQueue {
      guard !handedOff else { return }
      terminate(.closed)
    }
  }

  private func readAvailable() {
    while !terminal && !handedOff && received.count < guestEgressPreludeBytes {
      var bytes = [UInt8](repeating: 0, count: guestEgressPreludeBytes - received.count)
      let count = bytes.withUnsafeMutableBytes { buffer in
        Darwin.read(fileDescriptor, buffer.baseAddress, buffer.count)
      }
      if count > 0 {
        received.append(contentsOf: bytes.prefix(Int(count)))
        if received.count == guestEgressPreludeBytes {
          authenticate()
        }
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

  private func authenticate() {
    do {
      let supplied = try GuestEgressTunnelCodec.decodePrelude(received)
      guard constantTimeEqual(supplied, expectedSessionToken) else {
        throw GuestEgressTunnelSessionError.protocolViolation
      }
      handedOff = true
      deadlineTimer?.cancel()
      deadlineTimer = nil
      readSource?.cancel()
      readSource = nil
      received.removeAll(keepingCapacity: false)
      onAuthenticated()
    } catch {
      terminate(.protocolViolation)
    }
  }

  private func armDeadline() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.setEventHandler { [weak self] in self?.terminate(.handshakeTimedOut) }
    deadlineTimer = timer
    timer.schedule(deadline: .now() + handshakeTimeout)
    timer.resume()
  }

  private func terminate(_ reason: GuestEgressTunnelSessionError) {
    guard !terminal, !handedOff else { return }
    terminal = true
    deadlineTimer?.cancel()
    deadlineTimer = nil
    readSource?.cancel()
    readSource = nil
    received.removeAll(keepingCapacity: false)
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
