import XCTest

/// The menu's Sync line. The same cases as the Windows tray's
/// `sync_status.rs` tests, because both apps read the same fields and must say
/// the same thing about them.
final class FolderSyncLineTests: XCTestCase {
    private func summary(
        _ state: String, enabled: Bool = true, counts: [String: Int] = [:]
    ) throws -> FolderSyncSummary {
        var all = ["entries": 128, "pendingUploads": 0, "pendingDownloads": 0, "openConflicts": 0,
                   "waiting": 0, "errors": 0, "heldDeletes": 0, "notSynced": 0]
        all.merge(counts) { _, new in new }
        // `describe --json`'s whole folderSync block: fields the line does not need are ignored.
        let block: [String: Any] = ["enabled": enabled, "root": "/Users/person/Documents/Nessie",
                                    "state": state, "counts": all]
        return try JSONDecoder().decode(
            FolderSyncSummary.self, from: JSONSerialization.data(withJSONObject: block)
        )
    }

    private func line(_ state: String, enabled: Bool = true, counts: [String: Int] = [:]) throws -> FolderSyncLine? {
        FolderSyncLine(try summary(state, enabled: enabled, counts: counts))
    }

    func testTheLineNeverSaysUpToDateWhileAnythingIsLeft() throws {
        XCTAssertEqual(try line("up_to_date"), .upToDate)
        XCTAssertEqual(try line("up_to_date", counts: ["pendingUploads": 3]), .syncing(3))
        XCTAssertEqual(try line("up_to_date", counts: ["waiting": 1]), .syncing(0))
        XCTAssertEqual(try line("up_to_date", counts: ["openConflicts": 1]), .conflicts(1))
        XCTAssertEqual(try line("up_to_date", counts: ["heldDeletes": 23]), .needsAttention)
        XCTAssertEqual(try line("syncing", counts: ["pendingUploads": 7, "pendingDownloads": 5]), .syncing(12))
        XCTAssertEqual(try line("needs_attention", counts: ["openConflicts": 4, "errors": 1]), .conflicts(4))
        XCTAssertEqual(try line("needs_attention", counts: ["errors": 1]), .needsAttention)
        XCTAssertEqual(try line("needs_attention", counts: ["errors": 1, "pendingDownloads": 2]), .syncing(2))
    }

    func testTheEngineStatesThatNameTheirOwnRemedyKeepIt() throws {
        let expected: [(String, FolderSyncLine)] = [
            ("paused", .paused), ("starting", .starting), ("offline", .offline),
            ("waiting_for_confirmation", .allowInNessie), ("needs_reauthorization", .allowAgainInNessie),
            ("root_missing", .folderMissing), ("disk_full", .diskFull)
        ]
        for (state, line) in expected {
            XCTAssertEqual(try self.line(state, counts: ["pendingDownloads": 40]), line, state)
        }
        XCTAssertEqual(try line("off", enabled: false), .off)
        XCTAssertEqual(try line("not_private", enabled: false), .notPrivate)
        XCTAssertNil(try line("a_state_from_a_newer_runtime"))
    }

    func testTheMenuLineIsShortAndPlain() {
        let titled = { (line: FolderSyncLine) in
            folderSyncMenuTitle(FolderSyncOverview(executorId: "team", line: line))
        }
        XCTAssertEqual(folderSyncMenuTitle(nil), "Sync…")
        XCTAssertEqual(titled(.upToDate), "Sync: up to date")
        XCTAssertEqual(titled(.off), "Sync: off")
        XCTAssertEqual(titled(.conflicts(1)), "Sync: 1 conflict")
        XCTAssertEqual(titled(.conflicts(3)), "Sync: 3 conflicts")
        XCTAssertEqual(titled(.syncing(1)), "Sync: syncing 1 file")
        XCTAssertEqual(titled(.syncing(12)), "Sync: syncing 12 files")
        XCTAssertEqual(titled(.syncing(0)), "Sync: syncing")
        XCTAssertEqual(titled(.allowInNessie), "Sync: allow it in Nessie")
    }

    func testTheLineIsAboutTheTeamThatMostNeedsThePerson() throws {
        let teams = { (summaries: [FolderSyncSummary?]) in
            FolderSyncOverview.mostDemanding(summaries.enumerated().map {
                (executorId: "team-\($0.offset)", summary: $0.element)
            })
        }
        XCTAssertNil(teams([]))
        // A runtime that predates sync describes no folderSync; that team is left out.
        XCTAssertNil(teams([nil]))
        XCTAssertEqual(
            teams([try summary("up_to_date"), try summary("up_to_date", counts: ["openConflicts": 2]),
                   try summary("root_missing")]),
            FolderSyncOverview(executorId: "team-1", line: .conflicts(2))
        )
        XCTAssertEqual(
            teams([try summary("off", enabled: false), try summary("paused"), nil, try summary("up_to_date")])?
                .executorId,
            "team-3"
        )
        XCTAssertEqual(teams([try summary("off", enabled: false), try summary("off", enabled: false)])?.executorId,
                       "team-0")
    }

    func testTheToolTipNamesSyncOnlyWhenItNeedsThePerson() {
        let header = "Nessie Executor — running"
        XCTAssertEqual(menuToolTip(header: header, sync: nil), header)
        XCTAssertEqual(menuToolTip(header: header, sync: FolderSyncOverview(executorId: "team", line: .syncing(4))),
                       header)
        XCTAssertEqual(
            menuToolTip(header: header, sync: FolderSyncOverview(executorId: "team", line: .conflicts(3))),
            "Nessie Executor — running\nSync: 3 conflicts"
        )
    }

    /// Sync that needs the person is amber whatever the daemon is doing.
    func testSyncThatNeedsThePersonIsAmber() {
        for daemon in [DaemonState.running, .stopped] {
            let model = MenuModel(pairing: .paired(sampleDescription()), daemon: daemon)
            XCTAssertEqual(menuIcon(for: model, syncNeedsYou: true), .needsAttention)
        }
        XCTAssertEqual(
            menuIcon(for: MenuModel(pairing: .paired(sampleDescription()), daemon: .running), syncNeedsYou: false),
            .running
        )
    }

    /// The describe the menu bar already runs carries the summary; one from a
    /// runtime that predates sync still decodes.
    func testTheDescriptionCarriesTheSyncSummary() throws {
        XCTAssertNil(sampleDescription().folderSync)
        let withSync = describeFixtureJSON.replacingOccurrences(
            of: "\"executorId\": \"32b7de69-e303-46d6-b864-8a99a80d25e6\",",
            with: """
            "executorId": "32b7de69-e303-46d6-b864-8a99a80d25e6",
              "folderSync": { "enabled": true, "root": "/Users/person/Documents/Nessie", "state": "needs_attention",
                "counts": { "entries": 12, "pendingUploads": 0, "pendingDownloads": 0, "openConflicts": 2,
                  "waiting": 0, "errors": 0, "heldDeletes": 0, "notSynced": 0 } },
            """
        )
        let description = try ExecutorDescription.decode(Data(withSync.utf8))
        let summary = try XCTUnwrap(description.folderSync)
        XCTAssertEqual(FolderSyncLine(summary), .conflicts(2))
    }
}

final class ConsoleTargetTests: XCTestCase {
    /// The menu line opens the page through the same event the Windows tray
    /// sends, and its payload names the team — as JSON, so no id can escape it.
    func testTheEventNamesTheSectionAndCarriesTheTeamAsJSON() throws {
        let target = ConsoleTarget(section: .sync, executorId: "32b7de69-e303-46d6-b864-8a99a80d25e6")
        XCTAssertEqual(target.eventName, "tray://section/sync")
        XCTAssertEqual(
            target.script,
            "window.dispatchEvent(new CustomEvent('tray://section/sync', "
                + "{ detail: {\"executorId\":\"32b7de69-e303-46d6-b864-8a99a80d25e6\"} }))"
        )
        XCTAssertEqual(
            ConsoleTarget(section: .reach).script,
            "window.dispatchEvent(new CustomEvent('tray://section/reach', { detail: null }))"
        )
        let hostile = ConsoleTarget(section: .sync, executorId: "'}))</script>\"").script
        XCTAssertFalse(hostile.contains("'}))</script>\""), "the id is escaped inside the JSON payload")
    }
}
