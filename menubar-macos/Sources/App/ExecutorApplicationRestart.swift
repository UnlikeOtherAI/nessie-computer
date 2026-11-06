import AppKit
import Darwin

/// The native agent retains this user's GUI session while the app is replaced.
/// It can reopen only the fixed, publisher-verified installed menu app.
@MainActor
final class ExecutorApplicationRestart {
    private var process: Process?
    private var accepted = false

    func start() {
        guard process?.isRunning != true,
              let runtime = try? PackagedRuntime.locate(in: Bundle.main.resourceURL).get(),
              let helper = runtime.managedHelperURL() else { return }
        let native = Process()
        native.executableURL = helper
        native.arguments = ["update-application-reopen"]
        native.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
        native.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        native.standardInput = FileHandle.nullDevice
        native.standardError = FileHandle.nullDevice
        let output = Pipe()
        native.standardOutput = output
        do { try native.run() } catch { return }
        process = native
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var frame = Data()
            while frame.count <= 512 {
                guard let byte = try? output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { break }
                frame.append(byte)
                if byte == Data([10]) { break }
            }
            let value = try? JSONSerialization.jsonObject(with: frame) as? [String: Bool]
            Task { @MainActor [weak self] in
                guard let self, self.process === native else { return }
                if value?["ready"] == true, native.isRunning {
                    self.accepted = true
                    NSApp.terminate(nil)
                } else {
                    if native.isRunning { native.terminate() }
                    self.process = nil
                }
            }
        }
    }

    func stop() {
        // An acknowledged handoff must survive this app's expected exit. A
        // person quitting before acceptance cancels only the native waiter.
        if !accepted, let process, process.isRunning { process.terminate() }
    }
}
