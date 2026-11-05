import Darwin
import Dispatch
import Foundation

public enum GuestEgressGatewayBridgeError: Error {
  case invalidGatewaySocket
  case ioFailure
  case unavailable
}

private let gatewaySocketPathMaxBytes = 96
private let gatewayBridgeBufferMaxBytes = 262_144
private let gatewayBridgeReadBytes = 16_384

/**
 * Connects an already-authenticated per-VM virtio tunnel to the daemon's
 * existing owner-only Unix CONNECT gateway. The bridge only relays bytes: it
 * does not understand HTTP, DNS, origins, credentials, or remote addresses.
 */
public final class GuestEgressGatewayBridge {
  private let guestFileDescriptor: Int32
  private let gatewaySocketPath: String
  private let onTerminated: () -> Void
  private let releaseGuest: () -> Void
  private let queue = DispatchQueue(label: "works.nessie.executor.guest-egress-gateway")
  private let queueKey = DispatchSpecificKey<UInt8>()
  private var gatewayFileDescriptor: Int32 = -1
  private var guestToGateway: GuestEgressSocketPump?
  private var gatewayToGuest: GuestEgressSocketPump?
  private var started = false
  private var terminal = false

  @available(macOS 15.0, *)
  public convenience init(
    tunnel: GuestEgressTunnel,
    gatewaySocketPath: String,
    onTerminated: @escaping () -> Void,
  ) {
    self.init(
      guestFileDescriptor: tunnel.fileDescriptor,
      gatewaySocketPath: gatewaySocketPath,
      releaseGuest: { tunnel.close() },
      onTerminated: onTerminated,
    )
  }

  init(
    guestFileDescriptor: Int32,
    gatewaySocketPath: String,
    releaseGuest: @escaping () -> Void,
    onTerminated: @escaping () -> Void,
  ) {
    self.guestFileDescriptor = guestFileDescriptor
    self.gatewaySocketPath = gatewaySocketPath
    self.releaseGuest = releaseGuest
    self.onTerminated = onTerminated
    queue.setSpecific(key: queueKey, value: 1)
  }

  public func start() throws {
    try onQueue {
      guard !started, !terminal, guestFileDescriptor >= 0 else {
        throw GuestEgressGatewayBridgeError.unavailable
      }
      let gateway = try connectOwnerOnlyGatewaySocket(gatewaySocketPath)
      do {
        try setNonBlocking(guestFileDescriptor)
        try setNonBlocking(gateway)
      } catch {
        Darwin.close(gateway)
        throw error
      }
      gatewayFileDescriptor = gateway
      let stop: () -> Void = { [weak self] in self?.stop() }
      let outgoing = GuestEgressSocketPump(
        readFileDescriptor: guestFileDescriptor,
        writeFileDescriptor: gateway,
        queue: queue,
        onTerminated: stop,
      )
      let incoming = GuestEgressSocketPump(
        readFileDescriptor: gateway,
        writeFileDescriptor: guestFileDescriptor,
        queue: queue,
        onTerminated: stop,
      )
      guestToGateway = outgoing
      gatewayToGuest = incoming
      started = true
      outgoing.start()
      incoming.start()
    }
  }

  public func stop() {
    onQueue {
      guard !terminal else { return }
      terminal = true
      guestToGateway?.stop()
      guestToGateway = nil
      gatewayToGuest?.stop()
      gatewayToGuest = nil
      if gatewayFileDescriptor >= 0 {
        Darwin.close(gatewayFileDescriptor)
        gatewayFileDescriptor = -1
      }
      releaseGuest()
      onTerminated()
    }
  }

  deinit {
    stop()
  }

  private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
    if DispatchQueue.getSpecific(key: queueKey) != nil {
      return try body()
    }
    return try queue.sync(execute: body)
  }
}

private final class GuestEgressSocketPump {
  private let readFileDescriptor: Int32
  private let writeFileDescriptor: Int32
  private let queue: DispatchQueue
  private let onTerminated: () -> Void
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var pending = Data()
  private var offset = 0
  private var stopped = false

  init(
    readFileDescriptor: Int32,
    writeFileDescriptor: Int32,
    queue: DispatchQueue,
    onTerminated: @escaping () -> Void,
  ) {
    self.readFileDescriptor = readFileDescriptor
    self.writeFileDescriptor = writeFileDescriptor
    self.queue = queue
    self.onTerminated = onTerminated
  }

  func start() {
    let source = DispatchSource.makeReadSource(fileDescriptor: readFileDescriptor, queue: queue)
    source.setEventHandler { [weak self] in self?.readAvailable() }
    source.setCancelHandler {}
    readSource = source
    source.resume()
  }

  func stop() {
    guard !stopped else { return }
    stopped = true
    readSource?.cancel()
    readSource = nil
    writeSource?.cancel()
    writeSource = nil
    pending.removeAll(keepingCapacity: false)
    offset = 0
  }

  private func readAvailable() {
    while !stopped {
      var bytes = [UInt8](repeating: 0, count: gatewayBridgeReadBytes)
      let count = bytes.withUnsafeMutableBytes { buffer in
        Darwin.read(readFileDescriptor, buffer.baseAddress, buffer.count)
      }
      if count > 0 {
        guard pending.count - offset + Int(count) <= gatewayBridgeBufferMaxBytes else {
          onTerminated()
          return
        }
        if offset > 0 {
          pending.removeFirst(offset)
          offset = 0
        }
        pending.append(contentsOf: bytes.prefix(Int(count)))
        drainWrite()
        continue
      }
      if count == 0 {
        onTerminated()
        return
      }
      if errno == EAGAIN || errno == EWOULDBLOCK { return }
      onTerminated()
      return
    }
  }

  private func drainWrite() {
    while !stopped && offset < pending.count {
      let count = pending.withUnsafeBytes { bytes in
        Darwin.write(
          writeFileDescriptor,
          bytes.baseAddress!.advanced(by: offset),
          pending.count - offset,
        )
      }
      if count > 0 {
        offset += Int(count)
        continue
      }
      if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        waitForWritableSocket()
        return
      }
      onTerminated()
      return
    }
    if offset == pending.count {
      pending.removeAll(keepingCapacity: false)
      offset = 0
      writeSource?.cancel()
      writeSource = nil
    }
  }

  private func waitForWritableSocket() {
    guard writeSource == nil else { return }
    let source = DispatchSource.makeWriteSource(fileDescriptor: writeFileDescriptor, queue: queue)
    source.setEventHandler { [weak self] in self?.drainWrite() }
    source.setCancelHandler {}
    writeSource = source
    source.resume()
  }
}

private func setNonBlocking(_ fileDescriptor: Int32) throws {
  let flags = fcntl(fileDescriptor, F_GETFL)
  guard flags >= 0, fcntl(fileDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
    throw GuestEgressGatewayBridgeError.ioFailure
  }
}

private func connectOwnerOnlyGatewaySocket(_ rawPath: String) throws -> Int32 {
  guard rawPath.hasPrefix("/") else { throw GuestEgressGatewayBridgeError.invalidGatewaySocket }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  guard url.path.utf8.count <= gatewaySocketPathMaxBytes else {
    throw GuestEgressGatewayBridgeError.invalidGatewaySocket
  }
  try assertOwnerOnlyGatewayPath(url)
  let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
  guard descriptor >= 0 else { throw GuestEgressGatewayBridgeError.ioFailure }
  var address = sockaddr_un()
  address.sun_len = UInt8(MemoryLayout<sa_family_t>.size + url.path.utf8.count + 1)
  address.sun_family = sa_family_t(AF_UNIX)
  let copied = withUnsafeMutableBytes(of: &address.sun_path) { destination in
    url.path.withCString { source in
      strncpy(destination.baseAddress!.assumingMemoryBound(to: CChar.self), source, destination.count)
    }
  }
  guard copied != nil else {
    Darwin.close(descriptor)
    throw GuestEgressGatewayBridgeError.invalidGatewaySocket
  }
  let addressLength = socklen_t(address.sun_len)
  let result = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.connect(descriptor, $0, addressLength)
    }
  }
  guard result == 0 else {
    Darwin.close(descriptor)
    throw GuestEgressGatewayBridgeError.ioFailure
  }
  return descriptor
}

private func assertOwnerOnlyGatewayPath(_ socketURL: URL) throws {
  let parent = socketURL.deletingLastPathComponent()
  guard parent.resolvingSymlinksInPath().path == parent.path,
    socketURL.resolvingSymlinksInPath().path == socketURL.path
  else {
    throw GuestEgressGatewayBridgeError.invalidGatewaySocket
  }
  var parentMetadata = stat()
  var socketMetadata = stat()
  guard lstat(parent.path, &parentMetadata) == 0,
    (parentMetadata.st_mode & S_IFMT) == S_IFDIR,
    lstat(socketURL.path, &socketMetadata) == 0,
    (socketMetadata.st_mode & S_IFMT) == S_IFSOCK,
    parentMetadata.st_uid == getuid(), socketMetadata.st_uid == getuid(),
    parentMetadata.st_mode & (S_IWGRP | S_IWOTH) == 0,
    socketMetadata.st_mode & (S_IRWXG | S_IRWXO) == 0
  else {
    throw GuestEgressGatewayBridgeError.invalidGatewaySocket
  }
}
