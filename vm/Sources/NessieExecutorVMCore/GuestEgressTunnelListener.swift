import Foundation
import Virtualization

public enum GuestEgressTunnelListenerError: Error {
  case invalidConfiguration
  case unavailable
}

/**
 * Owns one authenticated egress tunnel from one virtual machine. The tunnel is
 * a descriptor capability only for the supplied callback; no listener here
 * understands HTTP, resolves names, or opens an internet connection.
 */
@available(macOS 15.0, *)
public final class GuestEgressTunnel: NSObject {
  public let fileDescriptor: Int32
  private let connection: VZVirtioSocketConnection
  private let release: () -> Void
  private let lock = NSLock()
  private var closed = false

  fileprivate init(
    connection: VZVirtioSocketConnection,
    release: @escaping () -> Void,
  ) {
    fileDescriptor = connection.fileDescriptor
    self.connection = connection
    self.release = release
  }

  public func close() {
    lock.lock()
    guard !closed else {
      lock.unlock()
      return
    }
    closed = true
    lock.unlock()
    release()
  }

  deinit {
    close()
  }

  fileprivate func closeConnection() {
    connection.close()
  }
}

/**
 * The VM's egress port is distinct from control and is guest-initiated only.
 * Connections are admission-limited before a callback receives their file
 * descriptor. The callback must retain the tunnel while it forwards bytes and
 * call `close()` when its bridge to the owner-only gateway has ended.
 */
@available(macOS 15.0, *)
public final class GuestEgressTunnelListener: NSObject, VZVirtioSocketListenerDelegate {
  private let expectedSessionToken: String
  private let listener = VZVirtioSocketListener()
  private let lock = NSLock()
  private let maxConcurrentTunnels: Int
  private let onAuthenticated: (GuestEgressTunnel) -> Void
  private let onTerminated: (GuestEgressTunnelSessionError) -> Void
  private weak var socketDevice: VZVirtioSocketDevice?
  private var accepting = false
  private var pending = [UUID: (VZVirtioSocketConnection, GuestEgressTunnelSession)]()
  private var active = [UUID: GuestEgressTunnel]()

  public init(
    expectedSessionToken: String,
    maxConcurrentTunnels: Int = 4,
    onAuthenticated: @escaping (GuestEgressTunnel) -> Void,
    onTerminated: @escaping (GuestEgressTunnelSessionError) -> Void,
  ) throws {
    guard isValidGuestEgressSessionToken(expectedSessionToken), (1...16).contains(maxConcurrentTunnels) else {
      throw GuestEgressTunnelListenerError.invalidConfiguration
    }
    self.expectedSessionToken = expectedSessionToken
    self.maxConcurrentTunnels = maxConcurrentTunnels
    self.onAuthenticated = onAuthenticated
    self.onTerminated = onTerminated
    super.init()
    listener.delegate = self
  }

  public func attach(to virtualMachine: VZVirtualMachine) throws {
    lock.lock()
    defer { lock.unlock() }
    guard socketDevice == nil else { throw GuestEgressTunnelListenerError.unavailable }
    guard let device = virtualMachine.socketDevices.compactMap({ $0 as? VZVirtioSocketDevice }).first else {
      throw GuestEgressTunnelListenerError.unavailable
    }
    device.setSocketListener(listener, forPort: nessieGuestEgressPort)
    socketDevice = device
  }

  /** Control authentication must explicitly open egress admission for this VM. */
  public func activate() throws {
    lock.lock()
    defer { lock.unlock() }
    guard socketDevice != nil, !accepting else { throw GuestEgressTunnelListenerError.unavailable }
    accepting = true
  }

  public func invalidate() {
    lock.lock()
    socketDevice?.removeSocketListener(forPort: nessieGuestEgressPort)
    socketDevice = nil
    accepting = false
    let pending = self.pending
    self.pending.removeAll()
    let active = self.active
    self.active.removeAll()
    lock.unlock()
    for (_, value) in pending {
      value.1.stop()
      value.0.close()
    }
    for (_, tunnel) in active {
      tunnel.closeConnection()
    }
  }

  public func listener(
    _ listener: VZVirtioSocketListener,
    shouldAcceptNewConnection connection: VZVirtioSocketConnection,
    from socketDevice: VZVirtioSocketDevice,
  ) -> Bool {
    lock.lock()
    let allowed = accepting
      && socketDevice === self.socketDevice
      && connection.destinationPort == nessieGuestEgressPort
      && pending.count + active.count < maxConcurrentTunnels
    lock.unlock()
    guard allowed else { return false }

    let id = UUID()
    let session: GuestEgressTunnelSession
    do {
      session = try GuestEgressTunnelSession(
        fileDescriptor: connection.fileDescriptor,
        expectedSessionToken: expectedSessionToken,
        onAuthenticated: { [weak self, weak connection] in
          guard let self, let connection else { return }
          self.didAuthenticate(id: id, connection: connection)
        },
        onTerminated: { [weak self] reason in
          self?.didTerminate(id: id, reason: reason)
        },
      )
      lock.lock()
      pending[id] = (connection, session)
      lock.unlock()
      try session.start()
    } catch {
      lock.lock()
      pending.removeValue(forKey: id)
      lock.unlock()
      connection.close()
      return false
    }
    return true
  }

  private func didAuthenticate(id: UUID, connection: VZVirtioSocketConnection) {
    lock.lock()
    guard let pending = pending.removeValue(forKey: id), pending.0 === connection else {
      lock.unlock()
      connection.close()
      return
    }
    let tunnel = GuestEgressTunnel(connection: connection) { [weak self] in
      self?.releaseTunnel(id: id)
    }
    active[id] = tunnel
    lock.unlock()
    onAuthenticated(tunnel)
  }

  private func didTerminate(id: UUID, reason: GuestEgressTunnelSessionError) {
    lock.lock()
    let connection = pending.removeValue(forKey: id)?.0
    lock.unlock()
    connection?.close()
    onTerminated(reason)
  }

  private func releaseTunnel(id: UUID) {
    lock.lock()
    let tunnel = active.removeValue(forKey: id)
    lock.unlock()
    tunnel?.closeConnection()
  }
}
