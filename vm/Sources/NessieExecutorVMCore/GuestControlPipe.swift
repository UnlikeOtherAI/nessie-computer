import Darwin
import Dispatch
import Foundation

/**
 * Relays framed requests from the companion-owned helper stdin to one guest
 * control listener. Stdin/stdout are inherited pipe descriptors, never a host
 * listener. The pipe accepts only request envelopes and returns only matching
 * response envelopes, so it cannot replace the guest's authenticated channel.
 */
@available(macOS 15.0, *)
public final class GuestControlPipe {
  private let inputDescriptor: Int32
  private let outputDescriptor: Int32
  private let forwardRequest: (Data, UUID) throws -> Void
  private let onTerminated: () -> Void
  private let queue = DispatchQueue(label: "works.nessie.executor.guest-control-pipe")
  private let queueKey = DispatchSpecificKey<UInt8>()
  private let decoder = GuestControlFrameStreamDecoder()
  private var inputSource: DispatchSourceRead?
  private var outputSource: DispatchSourceWrite?
  private var pendingWrite: Data?
  private var pendingWriteOffset = 0
  private var queuedWrites = [Data]()
  private var queuedWriteBytes = 0
  private var started = false
  private var terminated = false

  public init(
    inputDescriptor: Int32,
    outputDescriptor: Int32,
    forwardRequest: @escaping (Data, UUID) throws -> Void,
    onTerminated: @escaping () -> Void,
  ) throws {
    guard inputDescriptor >= 0, outputDescriptor >= 0 else { throw GuestControlSessionError.invalidConfiguration }
    self.inputDescriptor = inputDescriptor
    self.outputDescriptor = outputDescriptor
    self.forwardRequest = forwardRequest
    self.onTerminated = onTerminated
    queue.setSpecific(key: queueKey, value: 1)
  }

  public func start() throws {
    try onQueue {
      guard !started, !terminated else { throw GuestControlSessionError.unavailable }
      try configureNonblocking(inputDescriptor)
      try configureNonblocking(outputDescriptor)
      let source = DispatchSource.makeReadSource(fileDescriptor: inputDescriptor, queue: queue)
      source.setEventHandler { [weak self] in self?.readAvailable() }
      source.setCancelHandler {}
      inputSource = source
      started = true
      source.resume()
    }
  }

  public func sendResponse(_ envelope: GuestControlEnvelope) {
    onQueue {
      guard !terminated, envelope.kind == .response else { return }
      do {
        try enqueue(GuestControlFrameCodec.encode(envelope))
      } catch {
        terminate()
      }
    }
  }

  public func stop() {
    onQueue { terminate() }
  }

  private func readAvailable() {
    var chunk = [UInt8](repeating: 0, count: 8_192)
    while !terminated {
      let count = chunk.withUnsafeMutableBytes { bytes in
        Darwin.read(inputDescriptor, bytes.baseAddress, bytes.count)
      }
      if count > 0 {
        receive(Data(chunk.prefix(Int(count))))
        continue
      }
      if count == 0 {
        terminate()
        return
      }
      if errno == EAGAIN || errno == EWOULDBLOCK { return }
      terminate()
      return
    }
  }

  private func receive(_ bytes: Data) {
    do {
      for envelope in try decoder.append(bytes) {
        guard envelope.kind == .request, envelope.sessionToken == nil else {
          terminate()
          return
        }
        do {
          try forwardRequest(envelope.payload, envelope.requestId)
        } catch {
          try enqueue(try GuestControlFrameCodec.encode(GuestControlEnvelope(
            kind: .response,
            payload: Data(#"{"code":"EXECUTOR_GUEST_HOST_UNAVAILABLE"}"#.utf8),
            requestId: envelope.requestId,
          )))
        }
      }
    } catch {
      terminate()
    }
  }

  private func enqueue(_ frame: Data) throws {
    guard queuedWriteBytes + frame.count <= guestControlFrameMaxBytes * 2 else {
      throw GuestControlSessionError.unavailable
    }
    queuedWriteBytes += frame.count
    if pendingWrite == nil {
      pendingWrite = frame
      pendingWriteOffset = 0
      drainWrite()
    } else {
      queuedWrites.append(frame)
    }
  }

  private func drainWrite() {
    while let write = pendingWrite, !terminated {
      while pendingWriteOffset < write.count {
        let count = write.withUnsafeBytes { bytes in
          Darwin.write(
            outputDescriptor,
            bytes.baseAddress!.advanced(by: pendingWriteOffset),
            write.count - pendingWriteOffset,
          )
        }
        if count > 0 {
          pendingWriteOffset += Int(count)
          continue
        }
        if count < 0, errno == EAGAIN || errno == EWOULDBLOCK {
          waitForWritablePipe()
          return
        }
        terminate()
        return
      }
      queuedWriteBytes -= write.count
      pendingWrite = queuedWrites.isEmpty ? nil : queuedWrites.removeFirst()
      pendingWriteOffset = 0
    }
    outputSource?.cancel()
    outputSource = nil
  }

  private func waitForWritablePipe() {
    guard outputSource == nil else { return }
    let source = DispatchSource.makeWriteSource(fileDescriptor: outputDescriptor, queue: queue)
    source.setEventHandler { [weak self] in self?.drainWrite() }
    source.setCancelHandler {}
    outputSource = source
    source.resume()
  }

  private func terminate() {
    guard !terminated else { return }
    terminated = true
    inputSource?.cancel()
    inputSource = nil
    outputSource?.cancel()
    outputSource = nil
    pendingWrite = nil
    queuedWrites.removeAll()
    queuedWriteBytes = 0
    onTerminated()
  }

  private func configureNonblocking(_ descriptor: Int32) throws {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
      throw GuestControlSessionError.ioFailure
    }
  }

  private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
    if DispatchQueue.getSpecific(key: queueKey) != nil {
      return try body()
    }
    return try queue.sync(execute: body)
  }
}
