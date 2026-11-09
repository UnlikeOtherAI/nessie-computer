import XCTest

/// `{team} · {organisation}` everywhere, never an id or an API address.
final class TeamLabelTests: XCTestCase {
    private func names(_ id: String, _ team: String?, _ organization: String?, _ api: String?) -> TeamNames {
        TeamNames(executorId: id, teamName: team, organizationName: organization, apiBaseUrl: api)
    }

    func testATeamIsNamedTeamThenOrganisation() {
        let labels = TeamLabel.labels(for: [
            names("a", "Sales", "Acme", "https://api.nessie.works"),
            names("b", "Ops", "Acme", "https://api.nessie.works")
        ], language: .britishEnglish)
        XCTAssertEqual(labels, ["a": "Sales · Acme", "b": "Ops · Acme"])
    }

    /// Two teams that read the same get their server's host, so they differ.
    func testEqualLabelsGetTheirServer() {
        let labels = TeamLabel.labels(for: [
            names("a", "Sales", "Acme", "https://api.nessie.works"),
            names("b", "Sales", "Acme", "https://nessie.acme.example")
        ], language: .britishEnglish)
        XCTAssertEqual(labels["a"], "Sales · Acme (api.nessie.works)")
        XCTAssertEqual(labels["b"], "Sales · Acme (nessie.acme.example)")
    }

    /// Names not known yet say so; the id and the API address never stand in.
    func testUnknownNamesAreNeverAnIdOrAnAddress() {
        let labels = TeamLabel.labels(for: [
            names("32b7de69-e303-46d6-b864-8a99a80d25e6", nil, nil, "https://api.nessie.works"),
            names("b", "  ", "", nil)
        ], language: .britishEnglish)
        XCTAssertEqual(labels["32b7de69-e303-46d6-b864-8a99a80d25e6"], "Team name not available yet (api.nessie.works)")
        XCTAssertEqual(labels["b"], "Team name not available yet")
        XCTAssertEqual(
            TeamLabel.labels(for: [names("c", nil, nil, nil)], language: .german)["c"],
            "Teamname noch nicht verfügbar"
        )
        for label in labels.values {
            XCTAssertFalse(label.contains("32b7de69"))
            XCTAssertFalse(label.contains("https://"))
        }
    }

    func testATeamNamesCallsFailuresAreKeptForTheLogAndNothingElse() {
        let printed = """
        [nessie-executor] team names: api.nessie.works did not answer the batched read (HTTP 401 AUTH_REQUIRED); asking each team.
        (node:1) Warning: something else
        [nessie-executor] heartbeat failed: x
        [nessie-executor] team names: api.nessie.works did not name team 48d72fea (HTTP 401 UOA_SESSION_REQUIRED).
        """
        XCTAssertEqual(TeamNamesFailures.lines(in: printed), [
            "team names: api.nessie.works did not answer the batched read (HTTP 401 AUTH_REQUIRED); asking each team.",
            "team names: api.nessie.works did not name team 48d72fea (HTTP 401 UOA_SESSION_REQUIRED)."
        ])
        XCTAssertEqual(TeamNamesFailures.lines(in: ""), [])
    }
}
