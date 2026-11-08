import AppKit
import Combine
import UserNotifications

/// Program requests reach the owner as macOS notifications with Allow once,
/// Always allow and Don't allow, answered here on this computer and nowhere
/// else. Nothing else posts a notification: saves and removals are shown in
/// the window, never in Notification Center.
///
/// Permission is asked the first time a request needs a notification, not at
/// launch. If the owner turned notifications off, the request still waits in
/// the window's Overview and on the menu's "Needs you" line.
@MainActor
final class ProgramRequestNotifier: NSObject, UNUserNotificationCenterDelegate {
    private enum Action {
        static let allowOnce = "allow-once"
        static let alwaysAllow = "always-allow"
        static let dontAllow = "dont-allow"
    }

    private let connections: ExecutorConnections
    private let console: ConsoleWindowController
    private var posted: Set<String> = []
    private var observation: AnyCancellable?
    private var delivering = false

    init(connections: ExecutorConnections, console: ConsoleWindowController) {
        self.connections = connections
        self.console = console
        super.init()
    }

    func start() {
        UNUserNotificationCenter.current().delegate = self
        observation = connections.objectWillChange
            .sink { [weak self] _ in Task { @MainActor in await self?.deliver() } }
    }

    /// Posts what is new and takes back what was answered or expired.
    private func deliver() async {
        guard !delivering else { return }
        delivering = true
        defer { delivering = false }
        let labels = connections.labels()
        var notices: [String: ProgramRequestNotice] = [:]
        for controller in connections.teams {
            guard let executorId = controller.model.description?.executorId else { continue }
            for request in controller.programRequests {
                let notice = ProgramRequestNotice(
                    request: request, executorId: executorId,
                    teamLabel: labels[executorId] ?? Word.teamNameUnavailable.text
                )
                notices[notice.identifier] = notice
            }
        }
        let delivery = ProgramRequestDelivery(open: Set(notices.keys), alreadyPosted: posted)
        let center = UNUserNotificationCenter.current()
        if !delivery.withdraw.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: delivery.withdraw)
            posted.subtract(delivery.withdraw)
        }
        let fresh = delivery.post.compactMap { notices[$0] }
        guard !fresh.isEmpty, await authorized(center) else { return }
        center.setNotificationCategories(Set(notices.values.map(category)))
        for notice in fresh {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.categoryIdentifier = notice.categoryIdentifier
            content.sound = .default
            do {
                let request = UNNotificationRequest(identifier: notice.identifier, content: content, trigger: nil)
                try await center.add(request)
                posted.insert(notice.identifier)
            } catch { continue }
        }
    }

    private func authorized(_ center: UNUserNotificationCenter) async -> Bool {
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            status = (try? await center.requestAuthorization(options: [.alert, .sound])) == true ? .authorized : .denied
        }
        return status == .authorized || status == .provisional
    }

    /// Answering from the notification needs an unlocked Mac: whoever is at a
    /// locked screen is not necessarily its owner.
    private func category(_ notice: ProgramRequestNotice) -> UNNotificationCategory {
        let action = { (identifier: String, title: String) in
            UNNotificationAction(identifier: identifier, title: title, options: [.authenticationRequired])
        }
        return UNNotificationCategory(
            identifier: notice.categoryIdentifier,
            actions: [
                action(Action.allowOnce, notice.allowOnce),
                action(Action.alwaysAllow, notice.alwaysAllow),
                action(Action.dontAllow, notice.dontAllow)
            ],
            intentIdentifiers: []
        )
    }

    /// The answer the owner chose, or the window when they clicked the
    /// notification itself or the answer could not be saved.
    private func respond(executorId: String, requestId: String, action: String) async {
        let answer: ProgramRequestAnswer?
        switch action {
        case Action.allowOnce: answer = .once
        case Action.alwaysAllow: answer = .always
        case Action.dontAllow: answer = .deny
        default: answer = nil
        }
        posted.remove(ProgramRequestNotice.identifier(executorId: executorId, requestId: requestId))
        guard let answer, let controller = connections.team(executorId) else {
            if action != UNNotificationDismissActionIdentifier {
                console.show(ConsoleTarget(section: .overview, executorId: executorId))
            }
            return
        }
        do { try await controller.answer(requestId, answer) } catch {
            console.show(ConsoleTarget(section: .overview, executorId: executorId))
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let parts = Self.parts(of: response.notification.request.identifier)
        let action = response.actionIdentifier
        Task { @MainActor [weak self] in
            if let parts {
                await self?.respond(executorId: parts.executorId, requestId: parts.requestId, action: action)
            }
            completionHandler()
        }
    }

    /// `program-request.<executorId>.<requestId>`: neither part holds a dot.
    nonisolated private static func parts(of identifier: String) -> (executorId: String, requestId: String)? {
        let pieces = identifier.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard pieces.count == 3, pieces[0] == ProgramRequestNotice.categoryPrefix,
              ProgramRequestID.isValid(pieces[2]) else { return nil }
        return (pieces[1], pieces[2])
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
