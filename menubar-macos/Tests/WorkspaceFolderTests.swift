import XCTest

/// The Swift side of `assertExecutorWorkspaceFolders` and
/// `deriveExecutorWorkspaceFolderName`. It exists so the reach surface can
/// refuse in words rather than in an exit status, and these cases are the ones
/// the CLI decides — restated so the two readings cannot drift apart unnoticed.
final class WorkspaceFolderTests: XCTestCase {
    private func folder(_ name: String, _ path: String) -> ExecutorDescription.Folder {
        ExecutorDescription.Folder(name: name, path: path)
    }

    /// `/Users/me/Projects/nessie` becomes `nessie`, so an agent's paths read
    /// the way a person expects.
    func testDerivesTheNameTheCLIWouldPick() {
        XCTAssertEqual(WorkspaceFolder.derivedName(for: "/Users/me/Projects/nessie"), "nessie")
        XCTAssertEqual(WorkspaceFolder.derivedName(for: "/Users/me/My Notes"), "my-notes")
        XCTAssertEqual(WorkspaceFolder.derivedName(for: "/Users/me/Work_2026"), "work-2026")
    }

    /// The derivation is total: anything the grammar refuses becomes
    /// `workspace`, never an illegal name and never nothing.
    func testTheDerivationIsTotal() {
        for path in ["/", "/Users/me/...", "/Users/me/日本語", "/Users/me/-", "/Users/me/nul"] {
            let derived = WorkspaceFolder.derivedName(for: path)
            XCTAssertTrue(
                WorkspaceFolder.nameIsLegal(derived),
                "\(path) derived \(derived.debugDescription), which the grammar refuses"
            )
        }
        XCTAssertEqual(WorkspaceFolder.derivedName(for: "/"), WorkspaceFolder.fallbackName)
        XCTAssertEqual(WorkspaceFolder.derivedName(for: "/Users/me/nul"), WorkspaceFolder.fallbackName)
    }

    func testTheNameGrammarMatchesTheSchema() {
        for legal in ["nessie", "a", "a1", "my-notes", "x-y-z", String(repeating: "a", count: 40)] {
            XCTAssertTrue(WorkspaceFolder.nameIsLegal(legal), "\(legal) must be legal")
        }
        for illegal in [
            "", "-nessie", "nessie-", "Nessie", "nessie/api", "nessie.api", "nessie api",
            String(repeating: "a", count: 41),
            // Windows turns these basenames into devices wherever a path is
            // opened, and the reviewed policy has to stay legal on the next
            // machine that loads it.
            "aux", "con", "nul", "prn", "com1", "lpt9"
        ] {
            XCTAssertFalse(WorkspaceFolder.nameIsLegal(illegal), "\(illegal.debugDescription) must be refused")
        }
    }

    func testAddingKeepsTheListSortedByName() throws {
        let folders = try WorkspaceFolder.validate(
            adding: "/Users/me/Projects/atlas",
            named: nil,
            to: [folder("nessie", "/Users/me/Projects/nessie")]
        ).get()
        XCTAssertEqual(folders.map(\.name), ["atlas", "nessie"])
    }

    func testARequestedNameWinsOverTheDerivedOne() throws {
        let folders = try WorkspaceFolder.validate(
            adding: "/Users/me/Projects/nessie",
            named: "work",
            to: []
        ).get()
        XCTAssertEqual(folders.map(\.name), ["work"])
    }

    func testRefusesARelativePath() {
        XCTAssertNil(try? WorkspaceFolder.validate(adding: "Projects/nessie", named: nil, to: []).get())
    }

    /// Two folders with one name would make every path starting with it
    /// ambiguous, which is why the CLI refuses it too.
    func testRefusesADuplicateName() {
        guard case let .failure(refusal) = WorkspaceFolder.validate(
            adding: "/elsewhere/nessie",
            named: "nessie",
            to: [folder("nessie", "/Users/me/Projects/nessie")]
        ) else { return XCTFail("a duplicate name must be refused") }
        XCTAssertTrue(refusal.message.contains("already reaches a folder named nessie"))
    }

    /// A file inside two folders would have two workspace paths, which makes a
    /// receipt ambiguous about what was read.
    func testRefusesNestingInEitherDirection() {
        let existing = [folder("projects", "/Users/me/Projects")]
        for path in ["/Users/me/Projects/nessie", "/Users/me"] {
            guard case let .failure(refusal) = WorkspaceFolder.validate(
                adding: path, named: "other", to: existing
            ) else { return XCTFail("\(path) nests and must be refused") }
            XCTAssertTrue(refusal.message.contains("contain one another"), "for \(path)")
        }
        // A sibling whose path merely shares a prefix as text does not nest.
        XCTAssertNotNil(
            try? WorkspaceFolder.validate(
                adding: "/Users/me/ProjectsArchive", named: "archive", to: existing
            ).get()
        )
    }

    func testRefusesTheSamePathTwiceUnderADifferentName() {
        guard case let .failure(refusal) = WorkspaceFolder.validate(
            adding: "/Users/me/Projects/nessie",
            named: "work",
            to: [folder("nessie", "/Users/me/Projects/nessie")]
        ) else { return XCTFail("the same path twice must be refused") }
        XCTAssertTrue(refusal.message.contains("already reaches"))
    }

    func testRefusesMoreFoldersThanThePolicyMayCarry() {
        let full = (0..<WorkspaceFolder.maximumCount).map { folder("f\($0)", "/roots/f\($0)") }
        XCTAssertNil(try? WorkspaceFolder.validate(adding: "/roots/more", named: "more", to: full).get())
        XCTAssertNotNil(
            try? WorkspaceFolder.validate(
                adding: "/roots/more", named: "more", to: Array(full.dropLast())
            ).get()
        )
    }

    func testRemovingAFolderLeavesTheRest() throws {
        let folders = try WorkspaceFolder.validate(
            removing: "notes",
            from: [folder("nessie", "/a"), folder("notes", "/b")]
        ).get()
        XCTAssertEqual(folders.map(\.name), ["nessie"])
    }

    /// An executor paired against nothing can read nothing, and the CLI refuses
    /// an empty list too.
    func testRemovingTheLastFolderIsRefused() {
        guard case let .failure(refusal) = WorkspaceFolder.validate(
            removing: "nessie", from: [folder("nessie", "/a")]
        ) else { return XCTFail("removing the last folder must be refused") }
        XCTAssertTrue(refusal.message.contains("at least one folder"))
    }

    func testRemovingSomethingThatIsNotAFolderIsRefused() {
        XCTAssertNil(
            try? WorkspaceFolder.validate(
                removing: "missing", from: [folder("nessie", "/a"), folder("notes", "/b")]
            ).get()
        )
    }

    /// The chooser keeps the path the runtime stores, so a later comparison is exact.
    func testAChosenFolderIsKeptByItsResolvedPath() {
        XCTAssertEqual(WorkspaceFolder.resolvedPath("/tmp"), "/private/tmp")
        XCTAssertEqual(WorkspaceFolder.resolvedPath("/Users/Shared"), "/Users/Shared")
        XCTAssertEqual(WorkspaceFolder.resolvedPath("/no/such/folder/here"), "/no/such/folder/here")
    }
}
