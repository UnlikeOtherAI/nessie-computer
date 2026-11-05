import XCTest

final class ExecutorStateDiscoveryTests: XCTestCase {
    private func withRoot(_ body: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func paired(_ path: URL, pending: Bool = false) throws {
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        let name = pending ? "executor-pairing-code.json" : "executor-state.json"
        try Data("unread by discovery".utf8).write(to: path.appendingPathComponent(name))
    }

    func testUsesCanonicalDirectoryWhenNothingWasPaired() throws {
        try withRoot { root in
            let preferred = root.appendingPathComponent("current").path
            XCTAssertEqual(try ExecutorStateDiscovery.resolve(
                preferredDirectory: preferred, legacyRoots: [root.appendingPathComponent("desktop").path]
            ).get(), [preferred])
        }
    }

    func testReusesExistingDesktopPairingInsteadOfCreatingAnother() throws {
        try withRoot { root in
            let existing = root.appendingPathComponent("desktop/machine-one")
            try paired(existing)
            XCTAssertEqual(try ExecutorStateDiscovery.resolve(
                preferredDirectory: root.appendingPathComponent("current").path,
                legacyRoots: [root.appendingPathComponent("desktop").path]
            ).get(), [existing.path])
        }
    }

    func testFindsAnAttemptWhoseConfirmationResponseWasLost() throws {
        try withRoot { root in
            let pending = root.appendingPathComponent("desktop/machine-one")
            try paired(pending, pending: true)
            XCTAssertEqual(try ExecutorStateDiscovery.resolve(
                preferredDirectory: root.appendingPathComponent("current").path,
                legacyRoots: [root.appendingPathComponent("desktop").path]
            ).get(), [pending.path])
        }
    }

    func testMultipleKnownPairingsAreAllDiscovered() throws {
        try withRoot { root in
            let preferred = root.appendingPathComponent("current")
            try paired(preferred)
            try paired(root.appendingPathComponent("desktop/machine-one"))
            XCTAssertEqual(try ExecutorStateDiscovery.resolve(
                preferredDirectory: preferred.path, legacyRoots: [root.appendingPathComponent("desktop").path]
            ).get(), [preferred.path, root.appendingPathComponent("desktop/machine-one").path].sorted())
        }
    }

    func testSavedReplacementBlocksOldDaemonWithoutReadingItsSecrets() throws {
        try withRoot { root in
            let directory = root.appendingPathComponent("current")
            try paired(directory)
            XCTAssertFalse(ExecutorStateDiscovery.pendingAttemptBlocksStart(in: directory.path))
            // The process may restart before any status response arrives. These
            // bytes deliberately are not JSON: the host checks only presence.
            try paired(directory, pending: true)
            XCTAssertTrue(ExecutorStateDiscovery.pendingAttemptBlocksStart(in: directory.path))
            try FileManager.default.removeItem(at: directory.appendingPathComponent("executor-pairing-code.json"))
            XCTAssertFalse(ExecutorStateDiscovery.pendingAttemptBlocksStart(in: directory.path))
        }
    }

    func testDoesNotFollowLinksOrSearchBeyondKnownRootChildren() throws {
        try withRoot { root in
            let preferred = root.appendingPathComponent("current").path
            let desktop = root.appendingPathComponent("desktop")
            try paired(desktop.appendingPathComponent("unrelated/deeper"))
            XCTAssertEqual(try ExecutorStateDiscovery.resolve(
                preferredDirectory: preferred, legacyRoots: [desktop.path]
            ).get(), [preferred])
            try FileManager.default.createSymbolicLink(
                at: desktop.appendingPathComponent("linked"),
                withDestinationURL: desktop.appendingPathComponent("unrelated")
            )
            XCTAssertThrowsError(try ExecutorStateDiscovery.resolve(
                preferredDirectory: preferred, legacyRoots: [desktop.path]
            ).get())
        }
    }
}
