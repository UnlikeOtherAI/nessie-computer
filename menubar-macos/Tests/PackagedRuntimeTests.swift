import XCTest

final class PackagedRuntimeTests: XCTestCase {
    private let resources = URL(fileURLWithPath: "/Applications/Nessie Executor.app/Contents/Resources")

    /// The layout `executor/scripts/prepare-runtime.mjs` lays down, resolved from
    /// the bundle rather than guessed from this host's platform.
    func testResolvesThePreparedRuntimeLayout() throws {
        let runtime = try PackagedRuntime.locate(in: resources) { _ in true }.get()
        XCTAssertEqual(runtime.nodeURL.lastPathComponent, "nessie-executor-runtime")
        XCTAssertEqual(runtime.bundleURL.lastPathComponent, "nessie-executor.cjs")
        XCTAssertEqual(runtime.root.lastPathComponent, "executor-runtime")
        XCTAssertTrue(runtime.root.path.hasSuffix("Contents/Resources/executor-runtime"))
    }

    /// An app assembled without its runtime says so and names the remedy. It must
    /// never fall back to a `node` on the person's PATH: the packaged Node is the
    /// runtime the release pinned and hashed.
    func testAMissingRuntimeIsARefusalWithARemedy() {
        for exists in [{ (_: String) in false }, { (path: String) in path.hasSuffix("nessie-executor-runtime") }] {
            guard case let .failure(refusal) = PackagedRuntime.locate(in: resources, fileExists: exists) else {
                return XCTFail("an incomplete runtime must be refused")
            }
            XCTAssertEqual(refusal.message, PackagedRuntime.missingRefusal)
        }
        guard case .failure = PackagedRuntime.locate(in: nil, fileExists: { _ in true }) else {
            return XCTFail("no resource directory must be refused")
        }
    }

    func testManagedCreationRequiresTheExactManifestReleaseAndEveryFixedFile() {
        let runtime = PackagedRuntime(root: resources.appendingPathComponent("executor-runtime"))
        let manifest = Data("verified package manifest".utf8)
        let creator = runtime.managedHelperURL(manifest: manifest, fileExists: { _ in true })
        XCTAssertTrue(creator?.path.hasPrefix("/Library/Application Support/Nessie Executor/releases/") == true)
        XCTAssertEqual(creator?.lastPathComponent, "nessie-executor-native")
        let replacement = runtime.managedHelperURL(manifest: Data("replacement".utf8), fileExists: { _ in true })
        XCTAssertNotEqual(creator, replacement)
        XCTAssertNil(runtime.managedHelperURL(manifest: manifest, fileExists: { !$0.hasSuffix("nessie-executor.cjs") }))
        XCTAssertNil(runtime.managedHelperURL(manifest: Data(repeating: 0, count: 65_537), fileExists: { _ in true }))
    }

    func testNoLeaseNeverBlocksAStart() {
        XCTAssertFalse(leaseBlocksStart(.absent, daemonIsLive: { _ in true }))
    }

    /// A lease naming a live daemon blocks; a stale one from a crashed daemon must
    /// not block every later start forever.
    func testALeaseNamingALiveDaemonBlocksAndADeadOneDoesNot() {
        XCTAssertTrue(leaseBlocksStart(.held(pid: 4242), daemonIsLive: { pid in
            XCTAssertEqual(pid, 4242)
            return true
        }))
        XCTAssertFalse(leaseBlocksStart(.held(pid: 4242), daemonIsLive: { _ in false }))
    }

    /// A suspect lease never consults liveness: there is no pid to ask about.
    func testASuspectLeaseBlocksWithoutAskingAboutAPid() {
        XCTAssertTrue(leaseBlocksStart(.suspect, daemonIsLive: { _ in
            XCTFail("liveness must not be asked about a lease with no pid")
            return false
        }))
    }

    func testReadsTheLeaseADaemonWritesAndCallsAnythingElseSuspect() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nessie-menubar-lease-\(getpid())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let lease = directory.appendingPathComponent(DaemonLeaseReader.fileName)

        XCTAssertEqual(DaemonLeaseReader.read(in: directory.path), .absent)
        try "4242\n".write(to: lease, atomically: true, encoding: .utf8)
        XCTAssertEqual(DaemonLeaseReader.read(in: directory.path), .held(pid: 4242))
        for contents in ["", "  ", "0", "-1", "not-a-pid", "12 34"] {
            try contents.write(to: lease, atomically: true, encoding: .utf8)
            XCTAssertEqual(
                DaemonLeaseReader.read(in: directory.path),
                .suspect,
                "lease \(contents.debugDescription) must be suspect"
            )
        }
    }
}
