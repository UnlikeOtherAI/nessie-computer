import Foundation

/** A separate guest-initiated virtio port reserved for forced egress tunnels. */
public let nessieGuestEgressPort: UInt32 = 49_153
public let guestEgressPreludeBytes = 48

public enum GuestEgressTunnelError: Error, Equatable {
  case invalidPrelude
}

/**
 * A tunnel starts with an exact fixed-size proof before it carries one HTTP
 * CONNECT conversation. This is deliberately not a control frame: it cannot
 * carry a request id, payload, or bootstrap token. The host compares the
 * derived egress token to its one expected VM session value before forwarding
 * any remaining bytes to the daemon-private gateway.
 */
public enum GuestEgressTunnelCodec {
  private static let magic = Data("NEXG".utf8)
  private static let version: UInt8 = 1

  public static func encodePrelude(sessionToken: String) throws -> Data {
    guard isValidGuestEgressSessionToken(sessionToken) else {
      throw GuestEgressTunnelError.invalidPrelude
    }
    var prelude = magic
    prelude.append(version)
    prelude.append(contentsOf: sessionToken.utf8)
    return prelude
  }

  public static func decodePrelude(_ prelude: Data) throws -> String {
    guard prelude.count == guestEgressPreludeBytes,
      prelude.prefix(magic.count) == magic,
      prelude[magic.count] == version,
      let token = String(data: prelude.dropFirst(magic.count + 1), encoding: .utf8),
      isValidGuestEgressSessionToken(token)
    else {
      throw GuestEgressTunnelError.invalidPrelude
    }
    return token
  }
}
