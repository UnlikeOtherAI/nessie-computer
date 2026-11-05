import AppKit
import UserNotifications

/// Save confirmations and removals reach the person as ordinary macOS
/// notifications, in the top-right corner, even while the console is in front.
@MainActor
final class LocalNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LocalNotifications()

    /// Asks once, then honours whatever the person chose in System Settings. A
    /// refusal is returned to the console, which then says it on the page.
    func post(title: String, body: String) async throws {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            status = try await center.requestAuthorization(options: [.alert]) ? .authorized : .denied
        }
        guard status == .authorized || status == .provisional else {
            throw ExecutorRefusal("Notifications are turned off for Nessie Executor.")
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner])
    }
}

/// Nessie's desktop app, when it is installed: the Developer ID build or the
/// Mac App Store build.
enum NessieDesktop {
    static let bundleIdentifiers = ["com.unlikeotherai.nessie.desktop", "com.km.nessie"]

    static func installedURL() -> URL? {
        bundleIdentifiers.lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
    }
}
