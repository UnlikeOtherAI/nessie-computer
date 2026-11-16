import XCTest

final class DaemonLeaseTests: XCTestCase {
    private let token = "db895064-b147-43d9-98b4-27c9ba31eefb"
    private let boot = "01234567-89ab-cdef-0123-456789abcdef"

    private func claim(version: Int, pid: Int32, birth: String, bootID: String? = nil) throws -> String {
        var value: [String: Any] = ["version": version, "pid": pid, "startedAt": birth, "token": token]
        if let bootID { value["bootId"] = bootID }
        return try XCTUnwrap(String(bytes: JSONSerialization.data(withJSONObject: value), encoding: .utf8))
    }

    func testBothFormatsCompareTheRecordedBirthAndRetainUnknownProcesses() throws {
        for version in [1, 2] {
            let text = try claim(version: version, pid: 42, birth: "123", bootID: version == 2 ? boot : nil)
            let lease = DaemonLeaseReader.parse(text)
            XCTAssertEqual(lease, .generation(pid: 42, startedAt: "123", bootID: version == 2 ? boot : nil))
            XCTAssertTrue(leaseBlocksStart(lease, processBirth: { _ in "123" }, bootID: { self.boot }))
            XCTAssertFalse(leaseBlocksStart(lease, processBirth: { _ in "456" }, bootID: { self.boot }))
            XCTAssertTrue(leaseBlocksStart(lease, daemonIsLive: { _ in true },
                                          processBirth: { _ in nil }, bootID: { self.boot }))
            XCTAssertFalse(leaseBlocksStart(lease, daemonIsLive: { _ in false },
                                           processBirth: { _ in nil }, bootID: { self.boot }))
        }
        let lease = DaemonLease.generation(pid: 42, startedAt: "123", bootID: boot)
        XCTAssertTrue(leaseBlocksStart(lease, bootID: { nil }))
        XCTAssertFalse(leaseBlocksStart(lease, processBirth: { _ in
            XCTFail("an earlier boot cannot own a current PID")
            return nil
        }, bootID: { "another-boot" }))
    }

    func testPartialAndSubstitutedClaimsRemainSuspect() throws {
        let valid = try claim(version: 2, pid: 42, birth: "123", bootID: boot)
        for invalid in [
            valid.replacingOccurrences(of: "\"version\":2", with: "\"version\":3"),
            valid.replacingOccurrences(of: token, with: "invalid"),
            valid.replacingOccurrences(of: boot, with: "invalid"),
            valid.replacingOccurrences(of: "\"123\"", with: "\"\""),
            valid.replacingOccurrences(of: "}", with: ",\"extra\":true}"),
            try claim(version: 1, pid: 42, birth: "123", bootID: boot)
        ] {
            XCTAssertEqual(DaemonLeaseReader.parse(invalid), .suspect, invalid)
        }
    }

    func testRealMacGenerationLeavesTheReplacementAlive() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        let birth = try XCTUnwrap(DaemonLeaseReader.birth(child.processIdentifier))
        let currentBoot = try XCTUnwrap(DaemonLeaseReader.bootID())
        let path = directory.appendingPathComponent(DaemonLeaseReader.fileName)
        let live = try claim(version: 2, pid: child.processIdentifier, birth: birth, bootID: currentBoot)
        try live.write(to: path, atomically: true, encoding: .utf8)
        XCTAssertTrue(leaseBlocksStart(DaemonLeaseReader.read(in: directory.path)))
        let reused = try claim(version: 2, pid: child.processIdentifier, birth: "0", bootID: currentBoot)
        try reused.write(to: path, atomically: true, encoding: .utf8)
        XCTAssertFalse(leaseBlocksStart(DaemonLeaseReader.read(in: directory.path)))
        XCTAssertTrue(child.isRunning)
        try live.write(to: path, atomically: true, encoding: .utf8)
        child.terminate()
        child.waitUntilExit()
        XCTAssertFalse(leaseBlocksStart(DaemonLeaseReader.read(in: directory.path)))
    }
}
