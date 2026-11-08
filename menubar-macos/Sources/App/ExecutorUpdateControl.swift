import Darwin
import Foundation

/// Whether the update helper answers. Every caller shares one count, so a
/// single slow reply never reads as stuck, and two failures in a row do.
@MainActor
final class ComputerUpdateHealth {
    static let shared = ComputerUpdateHealth()
    private(set) var failures = 0
    var onChange: (@MainActor (Bool) -> Void)?

    var stuck: Bool { ComputerUpdateRecovery.stuck(enabled: ComputerUpdateService.enabled, failures: failures) }

    func record(answered: Bool) {
        let before = stuck
        failures = answered ? 0 : failures + 1
        if stuck != before { onChange?(stuck) }
    }

    /// A restart starts counting again; the helper needs a moment to answer.
    func reset() { record(answered: true) }
}

/// Native control only: a blocked or stopped JavaScript runtime must not hide Updates.
enum ExecutorUpdateControl {
    private static let unavailable = "update.coordinator_unavailable"

    @MainActor
    static func run(_ request: [String: Any]) async throws -> [String: Any] {
        guard let operation = request["operation"] as? String else { throw ExecutorRefusal(unavailable) }
        let fields: Set<String>
        switch operation {
        case "status", "check", "install", "remind": fields = ["operation"]
        case "automatic":
            guard request["enabled"] is Bool else { throw ExecutorRefusal(unavailable) }
            fields = ["operation", "enabled"]
        default: throw ExecutorRefusal(unavailable)
        }
        guard Set(request.keys) == fields else { throw ExecutorRefusal(unavailable) }
        let payload = try JSONSerialization.data(withJSONObject: request) + Data([10])
        let runtime = try PackagedRuntime.locate(in: Bundle.main.resourceURL).get()
        let helper = runtime.managedHelperURL() ?? ComputerUpdateService.factory
        do {
            let response: [String: Any] = try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    do {
                        continuation.resume(returning: try exchange(helper: helper, payload: payload))
                    } catch {
                        continuation.resume(throwing: ExecutorRefusal(unavailable))
                    }
                }
            }
            ComputerUpdateHealth.shared.record(answered: true)
            return response
        } catch {
            // A timeout and a refusal are the same to a person: no team can start.
            ComputerUpdateHealth.shared.record(answered: false)
            guard operation == "status" else { throw error }
            if let setup = ComputerUpdateService.unavailableStatus() { return setup }
            if ComputerUpdateHealth.shared.stuck { return ComputerUpdateService.stuckStatus() }
            throw error
        }
    }

    private static func exchange(helper: URL, payload: Data) throws -> [String: Any] {
        let process = Process()
        process.executableURL = helper
        process.arguments = ["update-control"]
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        // This kills only the unprivileged one-shot client. The independent
        // coordinator and any accepted installation continue normally.
        let timeout = DispatchWorkItem {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
        defer { timeout.cancel() }
        try input.fileHandleForWriting.write(contentsOf: payload)
        try input.fileHandleForWriting.close()
        var frame = Data()
        while frame.count <= 16_384 {
            guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { break }
            frame.append(byte)
            if byte == Data([10]) { break }
        }
        if frame.count > 16_384, process.isRunning { kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        guard process.terminationStatus == 0, frame.count <= 16_384, frame.last == 10,
              let response = try JSONSerialization.jsonObject(with: frame) as? [String: Any],
              response["error"] == nil else { throw ExecutorRefusal(unavailable) }
        return response
    }
}

/// A hidden window still needs to alert a person who turned automatic updates off.
@MainActor
final class ExecutorUpdateMonitor {
    private var task: Task<Void, Never>?
    private var announced: String?
    private let restart = ExecutorApplicationRestart()

    func start(console: ConsoleWindowController, connections: ExecutorConnections) {
        task = Task { [weak self, weak console, weak connections] in
            while !Task.isCancelled {
                let status = try? await ExecutorUpdateControl.run(["operation": "status"])
                await self?.restartHelperIfNeeded(status)
                if let status, let self, let console {
                    let version = status["availableVersion"] as? String
                    if status["phase"] as? String == "waiting", status["draining"] as? Bool == true {
                        self.restart.start()
                    }
                    if status["canInstall"] as? Bool == true,
                       status["draining"] as? Bool != true || (status["phase"] as? String == "restarting"
                        && status["installedVersion"] as? String == status["targetVersion"] as? String) {
                        connections?.controllers.forEach { $0.resumePersonalUpdate() }
                    }
                    let notify = status["notify"] as? Bool == true && status["automatic"] as? Bool == false
                        && status["canInstall"] as? Bool == true && version != nil
                    if notify && self.announced != version {
                        self.announced = version
                        console.showUpdate()
                    } else if !notify { self.announced = nil }
                }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    func stop() {
        task?.cancel()
        restart.stop()
    }

    /// An app update never reaches a helper that keeps running; restart it once.
    private func restartHelperIfNeeded(_ status: [String: Any]?) async {
        // The local stuck and setup states carry no installed version.
        let answer = (status?["installedVersion"] as? String).flatMap { version in
            (status?["phase"] as? String).map { (installedVersion: version, phase: $0) }
        }
        guard let version = ComputerUpdateService.applicationVersion, ComputerUpdateRecovery.shouldRestart(
            enabled: ComputerUpdateService.enabled, failures: ComputerUpdateHealth.shared.failures,
            answer: answer, applicationVersion: version, restartedFor: ComputerUpdateService.restartedVersion
        ) else { return }
        await ComputerUpdateService.restartOnce(for: version)
        ComputerUpdateHealth.shared.reset()
    }
}
