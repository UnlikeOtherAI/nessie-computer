import XCTest

/// `nessie-computer://` links navigate and nothing else.
final class DeepLinkTests: XCTestCase {
    private func parse(_ text: String) -> DeepLink? {
        guard let url = URL(string: text) else { return nil }
        return DeepLink.parse(url)
    }

    private let team = "32b7de69-e303-46d6-b864-8a99a80d25e6"

    func testEverySectionOpensWithOrWithoutATeam() {
        for section in ConsoleSection.allCases {
            XCTAssertEqual(
                parse("nessie-computer://open?section=\(section.rawValue)"),
                .open(ConsoleTarget(section: section))
            )
            XCTAssertEqual(
                parse("nessie-computer://open?section=\(section.rawValue)&team=\(team)"),
                .open(ConsoleTarget(section: section, executorId: team))
            )
        }
        XCTAssertEqual(parse("nessie-computer://open"), .open(ConsoleTarget()), "no section: the window as it was")
        XCTAssertEqual(parse("nessie-computer://open?team=\(team)"), .open(ConsoleTarget(executorId: team)))
        XCTAssertEqual(
            parse("NESSIE-COMPUTER://OPEN?section=access&team=\(team.uppercased())"),
            .open(ConsoleTarget(section: .access, executorId: team))
        )
    }

    func testConnectOpensConnectATeam() {
        XCTAssertEqual(parse("nessie-computer://connect"), .connect)
        XCTAssertEqual(parse("nessie-computer://connect/"), .connect)
    }

    /// A link that could carry a value, a path or a command is refused whole,
    /// rather than followed with the unknown part dropped.
    func testAnythingElseIsRefused() {
        let refused = [
            "nessie-computer://open?section=teams",
            "nessie-computer://open?section=",
            "nessie-computer://open?section=access&team=../../etc",
            "nessie-computer://open?section=access&team=",
            "nessie-computer://open?section=access&section=ai",
            "nessie-computer://open?section=access&paused=false",
            "nessie-computer://open/extra?section=access",
            "nessie-computer://open?section=access#fragment",
            "nessie-computer://user@open?section=access",
            "nessie-computer://open:8080?section=access",
            "nessie-computer://connect?code=12345678",
            "nessie-computer://pause",
            "nessie-computer://",
            "https://open?section=access",
            "nessie-executor://open?section=access"
        ]
        for link in refused {
            XCTAssertNil(parse(link), link)
        }
    }

    /// A copy launched by a link while another copy runs hands the link over
    /// instead of losing it; the running copy parses it again and follows only
    /// what it would have followed itself.
    func testASecondCopyHandsItsLinksToTheRunningOne() throws {
        let urls = try [
            "nessie-computer://open?section=access&team=0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11",
            "https://example.com/not-a-link",
            "nessie-computer://connect"
        ].map { try XCTUnwrap(URL(string: $0)) }
        let userInfo = DeepLink.handoverUserInfo(urls)
        XCTAssertEqual(DeepLink.handedOver(userInfo), [
            .open(ConsoleTarget(section: .access, executorId: "0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11")),
            .connect
        ])
        XCTAssertNil(DeepLink.handoverUserInfo([]), "no link: the running copy opens Overview")
        XCTAssertEqual(DeepLink.handedOver([DeepLink.handoverKey: ["nessie-computer://pause", 7]]), [])
        XCTAssertEqual(DeepLink.handedOver([DeepLink.handoverKey: ["nessie-computer://pause"]]), [])
        XCTAssertEqual(DeepLink.handedOver(nil), [])
    }
}
