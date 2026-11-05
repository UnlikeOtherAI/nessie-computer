import XCTest

final class ApprovedAPIOriginTests: XCTestCase {
    /// The contract this file restates, read rather than copied.
    ///
    /// A copy is exactly what drifts: this app, the CLI and Nessie Desktop all
    /// decide which server may be handed a machine key, and three independent
    /// spellings of two hostnames is a way for one of them to quietly accept a
    /// host the others do not. Reading the TypeScript means moving an origin
    /// there fails here until it is moved here too.
    private var contract: String {
        get throws {
            let repository = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent() // Tests
                .deletingLastPathComponent() // menubar-macos
                .deletingLastPathComponent() // executor
            return try String(
                contentsOf: repository
                    .appendingPathComponent("packages/protocol/src/executor-pairing-origins.ts"),
                encoding: .utf8
            )
        }
    }

    func testThePresetsAreTheOnesTheContractNames() throws {
        let source = try contract
        XCTAssertEqual(ApprovedAPIOrigin.presets.map(\.id), ["nessie", "deeptest"])
        XCTAssertEqual(
            ApprovedAPIOrigin.presets.map(\.apiBaseUrl),
            ["https://api.nessie.works", "https://api.deeptest.live"]
        )
        for preset in ApprovedAPIOrigin.presets {
            XCTAssertTrue(
                source.contains("apiBaseUrl: '\(preset.apiBaseUrl)'"),
                "\(preset.apiBaseUrl) is not the origin packages/schemas pins for \(preset.id)"
            )
            XCTAssertTrue(
                source.contains("id: '\(preset.id)'"),
                "\(preset.id) is not a preset packages/schemas names"
            )
            XCTAssertTrue(
                source.contains("label: '\(preset.label)'"),
                "\(preset.label) is not the label packages/schemas gives \(preset.id)"
            )
        }
        XCTAssertTrue(
            source.contains("EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN = '\(ApprovedAPIOrigin.localDevelopment)'"),
            "the local development origin does not match packages/schemas"
        )
    }

    func testAPresetIsChosenByNameAndResolvesToItsPinnedOrigin() {
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("nessie", isDevelopmentBuild: false).get(),
            "https://api.nessie.works"
        )
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("deeptest", isDevelopmentBuild: false).get(),
            "https://api.deeptest.live"
        )
        // Naming the origin outright is the same decision as picking its name.
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("https://api.deeptest.live", isDevelopmentBuild: false).get(),
            "https://api.deeptest.live"
        )
    }

    func testANessieSomebodyHostsThemselvesIsApproved() {
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("https://nessie.example.com", isDevelopmentBuild: false).get(),
            "https://nessie.example.com"
        )
        // A trailing slash is the same origin, not a second one to review, and
        // neither is a spelled-out default port.
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("https://nessie.example.com/", isDevelopmentBuild: false).get(),
            "https://nessie.example.com"
        )
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("https://nessie.example.com:443", isDevelopmentBuild: false).get(),
            "https://nessie.example.com"
        )
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("  https://nessie.example.com:8443  ", isDevelopmentBuild: false).get(),
            "https://nessie.example.com:8443"
        )
    }

    func testWhatAPairingAddressMayNeverBe() {
        for isDevelopment in [true, false] {
            for value in [
                // Plain HTTP would put the pairing challenge on the network.
                "http://nessie.example.com",
                // A path is how one host is dressed up as another in a label.
                "https://evil.example.com/api.nessie.works",
                "https://nessie.example.com?next=x",
                "https://nessie.example.com#fragment",
                "https://user:pass@nessie.example.com",
                "ftp://nessie.example.com",
                "not a url",
                "api.nessie.works",
                ""
            ] {
                XCTAssertNil(
                    try? ApprovedAPIOrigin.approve(value, isDevelopmentBuild: isDevelopment).get(),
                    "\(value.debugDescription) must be refused by a "
                        + "\(isDevelopment ? "development" : "release") build"
                )
            }
        }
    }

    func testTheLocalApiIsReachableOnlyByADevelopmentBuild() {
        XCTAssertEqual(
            try? ApprovedAPIOrigin.approve("http://127.0.0.1:5454", isDevelopmentBuild: true).get(),
            "http://127.0.0.1:5454"
        )
        XCTAssertNil(
            try? ApprovedAPIOrigin.approve("http://127.0.0.1:5454", isDevelopmentBuild: false).get()
        )
        // The hatch is that one origin, not "any http on loopback".
        for near in ["http://127.0.0.1:9999", "http://localhost:5454", "http://127.0.0.1"] {
            XCTAssertNil(
                try? ApprovedAPIOrigin.approve(near, isDevelopmentBuild: true).get(),
                "\(near) is not the local development origin"
            )
        }
    }

    func testABuildStartsOnItsOwnOrigin() {
        XCTAssertEqual(ApprovedAPIOrigin.default(isDevelopmentBuild: false), "https://api.nessie.works")
        XCTAssertEqual(ApprovedAPIOrigin.default(isDevelopmentBuild: true), "http://127.0.0.1:5454")
    }

    func testAnOriginIsNamedByItsServiceOrByItsHost() {
        XCTAssertEqual(ApprovedAPIOrigin.label(for: "https://api.nessie.works"), "Nessie")
        XCTAssertEqual(ApprovedAPIOrigin.label(for: "https://api.deeptest.live"), "DeepTest")
        // Never "custom": the hostname is the fact a person is confirming.
        XCTAssertEqual(ApprovedAPIOrigin.label(for: "https://nessie.example.com"), "nessie.example.com")
    }

    func testTheConsoleLinkFollowsTheNessieThisMacIsPairedWith() {
        XCTAssertEqual(
            ApprovedAPIOrigin.consoleURL(
                forAPIOrigin: "https://api.nessie.works", isDevelopmentBuild: false
            ).absoluteString,
            "https://app.nessie.works/admin/computers"
        )
        // A Mac paired with DeepTest sent to nessie.works would be a remedy
        // pointing at a stranger's console.
        XCTAssertEqual(
            ApprovedAPIOrigin.consoleURL(
                forAPIOrigin: "https://api.deeptest.live", isDevelopmentBuild: false
            ).absoluteString,
            "https://app.deeptest.live/admin/computers"
        )
        // A self-hosted origin nobody here can second-guess is offered as itself.
        XCTAssertEqual(
            ApprovedAPIOrigin.consoleURL(
                forAPIOrigin: "https://nessie.example.com", isDevelopmentBuild: false
            ).absoluteString,
            "https://nessie.example.com/admin/computers"
        )
        XCTAssertEqual(
            ApprovedAPIOrigin.consoleURL(
                forAPIOrigin: "http://127.0.0.1:5454", isDevelopmentBuild: true
            ).absoluteString,
            "http://localhost:5455/admin/computers"
        )
    }

    func testTheRefusalSaysWhatIsWrongWithTheAddress() {
        guard case let .failure(http) =
            ApprovedAPIOrigin.approve("http://nessie.example.com", isDevelopmentBuild: false),
            case let .failure(path) =
            ApprovedAPIOrigin.approve("https://evil.example.com/api.nessie.works", isDevelopmentBuild: false),
            case let .failure(credentials) =
            ApprovedAPIOrigin.approve("https://user:pass@nessie.example.com", isDevelopmentBuild: false)
        else { return XCTFail("each of these addresses must be refused") }
        XCTAssertEqual(
            http.message,
            "The server address must start with https://."
        )
        XCTAssertEqual(
            path.message,
            "Enter only the server address, without a page path or anything after it."
        )
        XCTAssertEqual(credentials.message, "Enter the server address without a username or password.")
    }

    /// The desktop app only ever shows the hosted service, so only that
    /// origin may open it; a self-hosted or local Nessie opens in the browser.
    func testOnlyTheHostedNessieOpensTheDesktopApp() {
        XCTAssertTrue(ApprovedAPIOrigin.isHostedNessie("https://api.nessie.works"))
        XCTAssertTrue(ApprovedAPIOrigin.isHostedNessie("nessie"))
        XCTAssertFalse(ApprovedAPIOrigin.isHostedNessie("https://api.deeptest.live"))
        XCTAssertFalse(ApprovedAPIOrigin.isHostedNessie("https://nessie.example.com"))
        XCTAssertFalse(ApprovedAPIOrigin.isHostedNessie(ApprovedAPIOrigin.localDevelopment))
    }
}
