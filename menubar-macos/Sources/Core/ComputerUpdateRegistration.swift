import ServiceManagement

/// A missing BTM record is a first-registration state, not a missing certificate.
public enum ComputerUpdateRegistration {
    public static func shouldRegister(
        status: SMAppService.Status, attempted: Bool, requested: Bool
    ) -> Bool {
        (status == .notRegistered || status == .notFound) && (requested || !attempted)
    }
}
