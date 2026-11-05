import CryptoKit
import Foundation

public let guestControlFrameMaxBytes = 65_536
public let guestControlPayloadMaxBytes = 32_768

public enum GuestControlMessageKind: String, Codable, Sendable {
  case close
  case hello
  case request
  case response
}

public struct GuestControlEnvelope: Codable, Equatable, Sendable {
  public let kind: GuestControlMessageKind
  public let payload: Data
  public let requestId: UUID
  public let sessionToken: String?
  public let version: Int

  public init(
    kind: GuestControlMessageKind,
    payload: Data,
    requestId: UUID,
    sessionToken: String? = nil,
    version: Int = 1,
  ) {
    self.kind = kind
    self.payload = payload
    self.requestId = requestId
    self.sessionToken = sessionToken
    self.version = version
  }
}

public enum GuestControlFrameError: Error, Equatable {
  case invalidEnvelope
  case invalidLength
  case oversized
}

private let sessionTokenCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

func isValidExecutorSessionToken(_ value: String) -> Bool {
  guard value.count == 43, value.unicodeScalars.allSatisfy(sessionTokenCharacters.contains) else {
    return false
  }
  let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  guard let decoded = Data(base64Encoded: base64 + "="), decoded.count == 32 else { return false }
  return decoded.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .dropLast() == value
}

func isValidGuestControlBootstrapToken(_ value: String) -> Bool {
  isValidExecutorSessionToken(value)
}

func isValidGuestEgressSessionToken(_ value: String) -> Bool {
  isValidExecutorSessionToken(value)
}

/** A per-session egress credential distinct from the one-use control hello. */
public func guestEgressToken(fromBootstrapToken value: String) throws -> String {
  guard isValidGuestControlBootstrapToken(value) else { throw GuestControlFrameError.invalidEnvelope }
  let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  guard let decoded = Data(base64Encoded: base64 + "=") else { throw GuestControlFrameError.invalidEnvelope }
  let key = SymmetricKey(data: decoded)
  let mac = HMAC<SHA256>.authenticationCode(for: Data("nessie-executor-egress-v1".utf8), using: key)
  return String(Data(mac).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .dropLast())
}

private func validate(_ envelope: GuestControlEnvelope) throws {
  guard envelope.version == 1, envelope.payload.count <= guestControlPayloadMaxBytes else {
    throw GuestControlFrameError.invalidEnvelope
  }
  switch envelope.kind {
  case .hello:
    guard envelope.payload.isEmpty, let token = envelope.sessionToken, isValidGuestControlBootstrapToken(token) else {
      throw GuestControlFrameError.invalidEnvelope
    }
  case .close, .request, .response:
    guard envelope.sessionToken == nil else { throw GuestControlFrameError.invalidEnvelope }
  }
}

/**
 * Length-delimited JSON frames for the one per-VM virtio control channel. A
 * future guest broker validates exact request/response schemas above this
 * transport; this codec deliberately permits no unbounded stream or token on
 * normal messages. The session token appears once in the guest hello only.
 */
public enum GuestControlFrameCodec {
  public static func encode(_ envelope: GuestControlEnvelope) throws -> Data {
    try validate(envelope)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let body = try encoder.encode(envelope)
    guard body.count <= guestControlFrameMaxBytes - 4 else { throw GuestControlFrameError.oversized }
    var length = UInt32(body.count).bigEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(body)
    return frame
  }

  public static func decode(_ frame: Data) throws -> GuestControlEnvelope {
    guard frame.count >= 4 else { throw GuestControlFrameError.invalidLength }
    let declaredLength = frame.prefix(4).reduce(UInt32(0)) { partial, byte in
      (partial << 8) | UInt32(byte)
    }
    guard declaredLength <= UInt32(guestControlFrameMaxBytes - 4) else {
      throw GuestControlFrameError.oversized
    }
    guard Int(declaredLength) == frame.count - 4 else { throw GuestControlFrameError.invalidLength }
    do {
      let envelope = try JSONDecoder().decode(GuestControlEnvelope.self, from: frame.dropFirst(4))
      try validate(envelope)
      return envelope
    } catch let error as GuestControlFrameError {
      throw error
    } catch {
      throw GuestControlFrameError.invalidEnvelope
    }
  }
}
