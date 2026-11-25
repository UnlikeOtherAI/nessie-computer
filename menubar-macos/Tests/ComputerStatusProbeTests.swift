import Foundation
import XCTest

@MainActor final class ComputerStatusProbeTests: XCTestCase {
    func testConcurrentReadersShareFailureAndNextReadRecovers() async throws {
        let probe = ComputerStatusProbe()
        var release: CheckedContinuation<Void, Never>?
        var attempts = 0
        let first = Task {
            try await probe.read {
                attempts += 1
                await withCheckedContinuation { release = $0 }
                throw CocoaError(.fileReadUnknown)
            }
        }
        while release == nil { await Task.yield() }
        var joined = false
        let second = Task {
            joined = true
            return try await probe.read { attempts += 1; return Data() }
        }
        while !joined { await Task.yield() }
        release?.resume()
        for reader in [first, second] {
            do {
                _ = try await reader.value
                XCTFail("Both readers should receive the failed probe")
            } catch { XCTAssertEqual((error as NSError).code, CocoaError.fileReadUnknown.rawValue) }
        }
        XCTAssertEqual(attempts, 1)
        let fresh = try await probe.read { Data([1]) }
        XCTAssertEqual(fresh, Data([1]))
    }
}
