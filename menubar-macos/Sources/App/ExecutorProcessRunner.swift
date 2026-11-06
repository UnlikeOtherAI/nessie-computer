import Foundation

/// Runs the bundled CLI. This is the app's only door to executor state: it reads
/// through `describe` and writes through `configure`, and it has no code path
/// that opens `executor-state.json`.
struct ExecutorProcessRunner {
    let runtime: PackagedRuntime
    let isDevelopmentBuild: Bool

    struct Completion {
        let standardOutput: String
        let standardError: String
        let succeeded: Bool
    }

    /// The child's environment, built key by key rather than inherited wholesale
    /// so nothing a person's shell profile happens to export reaches the daemon.
    private var childEnvironment: [String: String] {
        var environment: [String: String] = [
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NESSIE_EXECUTOR_PACKAGED_CLI": "1",
            // Which supervisor owns this executor decides which controls a person
            // is offered in Nessie. A menu bar app is a desktop supervisor: its
            // daemon is a child process that dies with the app, not a service.
            "NESSIE_EXECUTOR_SUPERVISOR": "desktop"
        ]
        if let tmpdir = ProcessInfo.processInfo.environment["TMPDIR"] {
            environment["TMPDIR"] = tmpdir
        }
        if isDevelopmentBuild {
            environment["NESSIE_EXECUTOR_ALLOW_LOCAL_API"] = "1"
        }
        return environment
    }

    func process(for invocation: ExecutorCLIInvocation) -> Process {
        let process = Process()
        let activity = [
            "serve", "serve-direct-local-inference", "personal-chatgpt-credential", "personal-chatgpt-local"
        ]
            .contains(invocation.arguments.first ?? "")
        let required = !isDevelopmentBuild && activity ? ComputerUpdateService.factory : nil
        if let creator = runtime.managedHelperURL() ?? required {
            process.executableURL = creator
            process.arguments = ["managed-runtime", "--"] + invocation.arguments
        } else {
            process.executableURL = runtime.nodeURL
            process.arguments = [runtime.bundleURL.path] + invocation.arguments
        }
        process.environment = childEnvironment
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        return process
    }

    /// Runs to completion and collects both streams. Standard error is carried
    /// back because the CLI's refusals are the wording a person must read — an
    /// app that replaced them with "something went wrong" would be hiding the
    /// only explanation that exists.
    func run(_ invocation: ExecutorCLIInvocation) throws -> Completion {
        let process = process(for: invocation)
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        if invocation.standardInput != nil {
            process.standardInput = Pipe()
        } else {
            process.standardInput = FileHandle.nullDevice
        }
        try process.run()
        if let payload = invocation.standardInput, let input = process.standardInput as? Pipe {
            try? input.fileHandleForWriting.write(contentsOf: payload)
            try? input.fileHandleForWriting.close()
        }
        let outputData = output.fileHandleForReading.readDataToEndOfFile()
        let errorData = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        // Preserve readable CLI diagnostics even when a child emits malformed UTF-8.
        // swiftlint:disable optional_data_string_conversion
        return Completion(
            standardOutput: String(decoding: outputData, as: UTF8.self),
            standardError: String(decoding: errorData, as: UTF8.self),
            succeeded: process.terminationStatus == 0
        )
        // swiftlint:enable optional_data_string_conversion
    }

    /// The refusal a completion carries, preferring the CLI's own last line.
    static func refusal(from completion: Completion, fallback: String) -> ExecutorRefusal {
        let line = completion.standardError
            .split(whereSeparator: \.isNewline)
            .last
            .map(String.init)?
            .trimmingCharacters(in: .whitespaces)
        return ExecutorRefusal(line.flatMap { $0.isEmpty ? nil : $0 } ?? fallback)
    }

    /// Spawns `serve` and keeps the write end of its standard input. Holding that
    /// handle is the supervision: the daemon watches the pipe and tears every
    /// guest session down when it closes, so it cannot outlive this app. The same
    /// contract `desktop/src-tauri/src/executor_companion/runtime.rs` uses.
    func spawnDaemon(stateDirectory: String) throws -> (process: Process, parentLiveness: FileHandle) {
        let process = process(for: ExecutorCLI.serve(stateDirectory: stateDirectory))
        let liveness = Pipe()
        process.standardInput = liveness
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return (process, liveness.fileHandleForWriting)
    }
}
