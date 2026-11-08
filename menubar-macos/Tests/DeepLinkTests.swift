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
        XCTAssertEqual(parse("nessie-computer://open"), .open(ConsoleTarget(section: .overview)))
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
}
