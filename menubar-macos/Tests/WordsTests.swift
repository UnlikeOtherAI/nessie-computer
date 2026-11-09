import XCTest

/// Every native sentence exists in all seven languages and uses the product's name.
final class WordsTests: XCTestCase {
    /// One of each case, so a new word is checked in every language too.
    private let samples: [Word] = [
        .statusNoTeam, .statusPaused, .statusWorking(working: 2, paused: 1, notConnected: 1), .statusConnecting,
        .statusNotConnected, .needsYou(team: "Sales · Acme", reason: .programs(1)),
        .needsYou(team: "Sales · Acme", reason: .documentConflicts(5)),
        .needsYou(team: "T", reason: .documentsNeedChecking), .needsYou(team: "T", reason: .allowDocumentsInNessie),
        .needsYou(team: "T", reason: .allowDocumentsAgain), .needsYou(team: "T", reason: .documentsFolderMissing),
        .needsYou(team: "T", reason: .diskFull), .needsYou(team: "T", reason: .notConnected),
        .needsYouReinstall, .needsYouUnreadableTeam, .needsYouMany(3), .pause, .resume,
        .allTeams, .openComputer,
        .addAnotherTeam,
        .openNessie, .quit, .quitWhileWorking, .iconIdle, .iconWorking, .iconNeedsYou, .teamNameUnavailable,
        .programRequestTitle(agent: "Ada", program: "git"), .programRequestTitle(agent: nil, program: "git"),
        .programRequestBody(team: "T", command: "git status"), .allowOnce, .alwaysAllow(program: "git"), .dontAllow,
        .onlyLocalWindow, .invalidRequest, .teamNotFound, .runtimeMissing, .changeRefused, .teamStillStopping,
        .teamNotStarted, .teamStoppedUnexpectedly, .connectRefused, .loginItemNeedsApproval, .loginItemFailed,
        .documentsFolderMissing, .nothingDeleted, .fileNotListed, .teamFolderNotReady, .fileGone, .fileBehindLink,
        .nessieNotAnswered, .documentsStatusUnreadable, .addressNotOpened, .documentsFolderPrompt,
        .addressNeedsHTTPS, .addressHasCredentials, .addressHasPath, .addressMustBeHTTPS, .pairingFailed,
        .pairingCleanupRequired, .pairingCodeMissing, .existingTeamsUnreadable, .existingTeamNeedsAttention,
        .settingsStillOlder(attempts: 25), .settingsNotProposed, .planNameRequired, .planCheckFailed,
        .planCheckPending
    ]

    func testEveryWordIsWrittenInEveryLanguageWithoutTheOldName() {
        XCTAssertEqual(NativeLanguage.allCases.count, 7)
        for language in NativeLanguage.allCases {
            for word in samples {
                let text = word.text(in: language)
                XCTAssertFalse(text.trimmingCharacters(in: .whitespaces).isEmpty, "\(word) in \(language)")
                XCTAssertFalse(text.contains("Executor"), "\(word) in \(language) says Executor")
                XCTAssertFalse(text.lowercased().contains("executor"), "\(word) in \(language)")
            }
        }
    }

    /// Languages other than English are actually translated, not copied.
    func testTranslationsDifferFromEnglish() {
        for language in NativeLanguage.allCases where ![.britishEnglish, .americanEnglish].contains(language) {
            let translated = samples.filter { $0.text(in: language) != $0.text(in: .americanEnglish) }
            XCTAssertGreaterThan(Double(translated.count) / Double(samples.count), 0.9, "\(language)")
        }
    }

    func testTheLanguageFollowsTheMacsPreferences() {
        XCTAssertEqual(NativeLanguage.resolve(["en-GB"]), .britishEnglish)
        XCTAssertEqual(NativeLanguage.resolve(["en-AU"]), .britishEnglish)
        XCTAssertEqual(NativeLanguage.resolve(["en-US"]), .americanEnglish)
        XCTAssertEqual(NativeLanguage.resolve(["cs-CZ"]), .czech)
        XCTAssertEqual(NativeLanguage.resolve(["de-AT", "en"]), .german)
        XCTAssertEqual(NativeLanguage.resolve(["es-MX"]), .spanish)
        XCTAssertEqual(NativeLanguage.resolve(["fr-CA"]), .french)
        XCTAssertEqual(NativeLanguage.resolve(["it-CH"]), .italian)
        XCTAssertEqual(NativeLanguage.resolve(["ja-JP"]), .americanEnglish)
        XCTAssertEqual(NativeLanguage.resolve(["ja-JP", "cs"]), .czech)
    }

    /// Czech counts in three forms; one wrong form reads as a typo to every Czech owner.
    func testCzechCountsUseAllThreeForms() {
        let say = { (word: Word) in word.text(in: .czech) }
        XCTAssertEqual(say(.statusWorking(working: 1, paused: 0, notConnected: 0)), "Pracuje pro 1 tým")
        XCTAssertEqual(say(.statusWorking(working: 3, paused: 0, notConnected: 0)), "Pracuje pro 3 týmy")
        XCTAssertEqual(say(.statusWorking(working: 5, paused: 0, notConnected: 0)), "Pracuje pro 5 týmů")
        XCTAssertEqual(
            say(.needsYou(team: "T", reason: .programs(2))), "Potřebuje vás: T — 2 programy žádají o spuštění"
        )
        XCTAssertEqual(say(.needsYou(team: "T", reason: .programs(7))), "Potřebuje vás: T — 7 programů žádá o spuštění")
        XCTAssertEqual(say(.needsYouMany(2)), "Potřebuje vás: 2 věci — otevřete Nessie Computer")
        XCTAssertEqual(say(.needsYouMany(6)), "Potřebuje vás: 6 věcí — otevřete Nessie Computer")
    }

    /// The menu item uses the window's words for pairing (contract §13), with the menu's ellipsis.
    func testAddAnotherTeamMatchesTheWindowInEveryLanguage() {
        let expected: [NativeLanguage: String] = [
            .britishEnglish: "Add another team…", .americanEnglish: "Add another team…",
            .czech: "Přidat další tým…", .german: "Weiteres Team hinzufügen …",
            .spanish: "Añadir otro equipo…", .french: "Ajouter une autre équipe…",
            .italian: "Aggiungi un altro team…"
        ]
        for language in NativeLanguage.allCases {
            XCTAssertEqual(Word.addAnotherTeam.text(in: language), expected[language], "\(language)")
        }
    }

    func testARefusalCanBeBuiltFromAWord() {
        XCTAssertEqual(ExecutorRefusal(.teamNotFound).message, Word.teamNotFound.text)
    }
}
