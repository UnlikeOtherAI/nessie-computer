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

    /// Only what the owner has to settle becomes a "Needs you" line; work in
    /// progress, an idle copy and a paused one never do.
    func testOnlyWhatTheOwnerMustSettleNeedsThem() {
        let asks: [(FolderSyncLine, NeedsYouReason)] = [
            (.conflicts(3), .documentConflicts(3)), (.needsAttention, .documentsNeedChecking),
            (.allowInNessie, .allowDocumentsInNessie), (.allowAgainInNessie, .allowDocumentsAgain),
            (.folderMissing, .documentsFolderMissing), (.diskFull, .diskFull)
        ]
        for (line, reason) in asks {
            XCTAssertEqual(line.needsYouReason, reason)
            XCTAssertTrue(line.needsYou)
        }
        for line in [FolderSyncLine.off, .notPrivate, .paused, .upToDate, .starting, .offline, .syncing(4)] {
            XCTAssertNil(line.needsYouReason, "\(line) is not the owner's to settle")
        }
    }

    /// Documents that need the owner light the icon whatever the daemon is doing.
    func testDocumentsThatNeedTheOwnerAreAmber() {
        for daemon in [DaemonState.running, .stopped] {
            let team = TeamSnapshot(executorId: "team", label: "Sales · Acme", daemon: daemon, documents: .conflicts(2))
            let menu = ComputerMenuModel(teams: [team], language: .britishEnglish)
            XCTAssertEqual(menu.icon, .needsYou)
            XCTAssertEqual(menu.needsYou?.title, "Needs you: Sales · Acme — 2 document conflicts")
            XCTAssertEqual(menu.needsYou?.target, ConsoleTarget(section: .documents, executorId: "team"))
        }
        let quiet = TeamSnapshot(executorId: "team", label: "Sales · Acme", daemon: .running, documents: .syncing(2))
        XCTAssertEqual(ComputerMenuModel(teams: [quiet]).icon, .working)
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
    /// The menu and links open the page through the same event the Windows
    /// tray sends, and its payload names the team — as JSON, so no id can escape it.
    func testTheEventNamesTheSectionAndCarriesTheTeamAsJSON() throws {
        let target = ConsoleTarget(section: .documents, executorId: "32b7de69-e303-46d6-b864-8a99a80d25e6")
        XCTAssertEqual(target.eventName, "tray://section/documents")
        XCTAssertEqual(
            target.script,
            "window.dispatchEvent(new CustomEvent('tray://section/documents', "
                + "{ detail: {\"executorId\":\"32b7de69-e303-46d6-b864-8a99a80d25e6\"} }))"
        )
        XCTAssertEqual(
            ConsoleTarget(section: .overview).script,
            "window.dispatchEvent(new CustomEvent('tray://section/overview', { detail: null }))"
        )
        let hostile = ConsoleTarget(section: .access, executorId: "'}))</script>\"").script
        XCTAssertFalse(hostile.contains("'}))</script>\""), "the id is escaped inside the JSON payload")
    }

    /// The five tabs of the contract, in its order, and the Connect a team event.
    func testTheSectionsAreTheWindowsTabs() {
        XCTAssertEqual(ConsoleSection.allCases.map(\.rawValue), ["overview", "access", "documents", "ai", "settings"])
        XCTAssertEqual(
            ConsoleTarget.connectScript, "window.dispatchEvent(new CustomEvent('tray://connect', { detail: null }))"
        )
    }
}
