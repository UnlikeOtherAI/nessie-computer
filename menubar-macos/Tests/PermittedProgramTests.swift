import XCTest

/// The Swift side of `parseExecutorCommandPattern`
/// (packages/schemas/src/executor.ts). It exists so the Tools section can refuse
/// in words rather than in an exit status, and these cases are the ones the CLI
/// decides, restated so the two readings cannot drift apart unnoticed.
final class PermittedProgramTests: XCTestCase {
    /// An entry is the start of a command now, not a bare program name.
    func testAcceptsACommandWithArgumentsAndATrailingWildcard() {
        XCTAssertEqual(PermittedProgram.normalise("git *"), "git *")
        XCTAssertEqual(PermittedProgram.normalise("npm run *"), "npm run *")
        XCTAssertEqual(PermittedProgram.normalise("git status --short"), "git status --short")
        XCTAssertEqual(PermittedProgram.normalise("node"), "node")
    }

    /// Runs of whitespace are a typo rather than an argument, so re-typing the
    /// same rule loosely is not a new revision for somebody to review.
    func testNormalisesWhitespaceSoRetypingIsNotANewRevision() {
        XCTAssertEqual(PermittedProgram.normalise("  npm   run   *  "), "npm run *")
        XCTAssertEqual(PermittedProgram.normalise("\tgit\tstatus\t"), "git status")
    }

    /// A `*` is only ever the final token. In the program position it reads as
    /// "any program" while matching a name no PATH resolves, and it would reach
    /// straight past the shells the program grammar refuses.
    func testRefusesAWildcardAnywhereButTheEnd() {
        for entry in ["*", "gi*", "git * --force", "* --force", "npm *run"] {
            XCTAssertNil(
                PermittedProgram.normalise(entry),
                "\(entry.debugDescription) must be refused"
            )
        }
    }

    func testRefusesPathsShellsAndEmptyEntries() {
        for entry in ["", "   ", "/usr/bin/git", "bin/git", "sh", "bash", "zsh", "fish", "ksh", "dash",
                      "sh -c echo", "git\u{0}status"] {
            XCTAssertNil(
                PermittedProgram.normalise(entry),
                "\(entry.debugDescription) must be refused"
            )
        }
    }

    func testAddingKeepsTheListSortedSoReorderingIsNotANewRevision() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(adding: "git *", to: ["node", "npm run *"]).get(),
            ["git *", "node", "npm run *"]
        )
    }

    func testRefusesADuplicateRatherThanQuietlyDroppingIt() {
        guard case let .failure(refusal) = PermittedProgram.validate(adding: " git  * ", to: ["git *"])
        else { return XCTFail("a duplicate must be refused, however it was spelled") }
        XCTAssertEqual(refusal.message, "git * is already a permitted command.")
    }

    func testRefusesMoreEntriesThanThePolicyMayCarry() {
        let full = (0..<PermittedProgram.maximumCount).map { "program\($0)" }
        XCTAssertNil(try? PermittedProgram.validate(adding: "onemore", to: full).get())
        XCTAssertNotNil(try? PermittedProgram.validate(adding: "onemore", to: Array(full.dropLast())).get())
    }

    func testRefusesAnEntryLongerThanThePolicyMayCarry() {
        let long = "git " + String(repeating: "a", count: PermittedProgram.maximumLength)
        XCTAssertNil(PermittedProgram.normalise(long))
    }

    func testRemovingAnEntryLeavesTheRest() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(
                removing: "node",
                from: ["git *", "node", "npm run *"],
                commandRunEnabled: true
            ).get(),
            ["git *", "npm run *"]
        )
    }

    /// The configure-time refusal, raised in the section so a person hears it
    /// before the CLI does: `command.run` with no permitted command is an
    /// operation that can never succeed.
    func testEmptyingTheListIsRefusedWhileCommandRunIsEnabled() {
        guard case let .failure(refusal) = PermittedProgram.validate(
            removing: "git *",
            from: ["git *"],
            commandRunEnabled: true
        ) else { return XCTFail("emptying the list must be refused") }
        XCTAssertTrue(
            refusal.message.hasPrefix("Name at least one permitted command before enabling command.run.")
        )
    }

    func testEmptyingTheListIsAllowedWhenCommandRunIsOff() throws {
        XCTAssertEqual(
            try PermittedProgram.validate(removing: "git *", from: ["git *"], commandRunEnabled: false).get(),
            []
        )
    }

    func testRemovingSomethingThatIsNotOnTheListIsRefused() {
        XCTAssertNil(
            try? PermittedProgram.validate(
                removing: "curl",
                from: ["git *"],
                commandRunEnabled: false
            ).get()
        )
    }
}
