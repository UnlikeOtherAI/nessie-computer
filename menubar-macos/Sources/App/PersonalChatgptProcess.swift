import Foundation

/// Returns the first public frame while retaining the actual foreground
/// controller. An ACK timeout or hidden window is never credential clearance.
final class PersonalChatgptProcess: @unchecked Sendable {
    private let lock = NSLock()
    private var answer: CheckedContinuation<Data, Error>?

    private func complete(_ outcome: Result<Data, Error>) {
        lock.lock()
        let waiting = answer
        answer = nil
        lock.unlock()
        waiting?.resume(with: outcome)
    }

    func run(process: Process, invocation: ExecutorCLIInvocation) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            answer = continuation
            lock.unlock()
            let input = Pipe()
            let output = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                var spawned = false
                do {
                    try process.run()
                    spawned = true
                    try input.fileHandleForWriting.write(contentsOf: invocation.standardInput ?? Data())
                    try input.fileHandleForWriting.close()
                    var frame = Data()
                    while frame.count <= 1_048_576 {
                        guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else {
                            throw ExecutorRefusal(.planCheckFailed)
                        }
                        frame.append(byte)
                        if byte == Data([10]) { break }
                    }
                    guard frame.count <= 1_048_576, frame.last == 10 else {
                        throw ExecutorRefusal(.planCheckFailed)
                    }
                    complete(.success(frame))
                } catch {
                    try? input.fileHandleForWriting.close()
                    complete(.failure(ExecutorRefusal(.planCheckFailed)))
                }
                guard spawned else {
                    try? output.fileHandleForWriting.close()
                    return
                }
                // Drain later public frames without retaining them. The actor
                // and its registered native parent retain their own custody.
                while let bytes = try? output.fileHandleForReading.read(upToCount: 4096), !bytes.isEmpty {}
                if process.isRunning { process.waitUntilExit() }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) { [self] in
                complete(.failure(ExecutorRefusal(.planCheckPending)))
            }
        }
    }
}
