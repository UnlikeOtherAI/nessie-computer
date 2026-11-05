import Foundation
import Virtualization

/** A guest connects outward to this fixed port; the host never opens a guest socket. */
public let nessieGuestControlPort: UInt32 = 49_152

public enum GuestControlError: Error {
  case unavailable
  case invalidBootstrapToken
}

/**
 * Owns the one guest-initiated control channel for a micro-VM. The listener is
 * installed only on that VM's virtio device, accepts one connection at the
 * fixed port, and has no host network listener or ability to reach another VM.
 *
 * The listener owns framing authentication over this connection. Its expected
 * one-use bootstrap token belongs to the VM session, not to an executor-wide
 * daemon identity. It deliberately rejects another connection instead of
 * replacing a live control channel.
 */
@available(macOS 15.0, *)
public final class GuestControlListener: NSObject, VZVirtioSocketListenerDelegate {
  private var activeConnection: VZVirtioSocketConnection?
  private var activeSession: GuestControlSession?
  private let expectedBootstrapToken: String
  private weak var socketDevice: VZVirtioSocketDevice?
  private let listener = VZVirtioSocketListener()
  private let onAuthenticated: () -> Void
  private let onResponse: (GuestControlEnvelope) -> Void
  private let onTerminated: (GuestControlSessionError) -> Void
  private let requestTimeout: TimeInterval

  public init(
    expectedBootstrapToken: String,
    requestTimeout: TimeInterval = 30,
    onAuthenticated: @escaping () -> Void,
    onResponse: @escaping (GuestControlEnvelope) -> Void,
    onTerminated: @escaping (GuestControlSessionError) -> Void,
  ) throws {
    guard isValidGuestControlBootstrapToken(expectedBootstrapToken) else {
      throw GuestControlError.invalidBootstrapToken
    }
    self.expectedBootstrapToken = expectedBootstrapToken
    self.requestTimeout = requestTimeout
    self.onAuthenticated = onAuthenticated
    self.onResponse = onResponse
    self.onTerminated = onTerminated
    super.init()
    listener.delegate = self
  }

  public func attach(to virtualMachine: VZVirtualMachine) throws {
    guard socketDevice == nil, activeConnection == nil else { throw GuestControlError.unavailable }
    guard let device = virtualMachine.socketDevices.compactMap({ $0 as? VZVirtioSocketDevice }).first else {
      throw GuestControlError.unavailable
    }
    device.setSocketListener(listener, forPort: nessieGuestControlPort)
    socketDevice = device
  }

  public func finishConnection() {
    let session = activeSession
    let connection = activeConnection
    activeSession = nil
    activeConnection = nil
    session?.stop()
    connection?.close()
  }

  public func invalidate() {
    socketDevice?.removeSocketListener(forPort: nessieGuestControlPort)
    socketDevice = nil
    finishConnection()
  }

  @discardableResult
  public func sendRequest(payload: Data, requestId: UUID = UUID()) throws -> UUID {
    guard let activeSession else { throw GuestControlError.unavailable }
    return try activeSession.sendRequest(payload: payload, requestId: requestId)
  }

  public func listener(
    _ listener: VZVirtioSocketListener,
    shouldAcceptNewConnection connection: VZVirtioSocketConnection,
    from socketDevice: VZVirtioSocketDevice,
  ) -> Bool {
    guard socketDevice === self.socketDevice, activeConnection == nil else { return false }
    guard connection.destinationPort == nessieGuestControlPort else { return false }
    let session: GuestControlSession
    do {
      session = try GuestControlSession(
        fileDescriptor: connection.fileDescriptor,
        expectedBootstrapToken: expectedBootstrapToken,
        requestTimeout: requestTimeout,
        onAuthenticated: onAuthenticated,
        onResponse: onResponse,
        onTerminated: { [weak self] reason in
          self?.onTerminated(reason)
          self?.finishConnection()
        },
      )
      activeConnection = connection
      activeSession = session
      try session.start()
    } catch {
      activeSession = nil
      activeConnection = nil
      connection.close()
      return false
    }
    return true
  }
}
