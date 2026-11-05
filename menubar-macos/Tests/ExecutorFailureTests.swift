import XCTest

/// The mapping a person actually reads. Every case below pins the API's own
/// literal from `packages/executor-manage`, because that literal is the only
/// thing reaching this process — the CLI prints `error.message` and nothing
/// else — and a literal that drifts has to fall through to the honest default
/// rather than get labelled as something it is not.
final class ExecutorFailureTests: XCTestCase {
    /// The one that started this. A banner reading "Executor descriptor
    /// revisions cannot move backwards." with a lone Dismiss button told a
    /// person nothing; the reply it got was "what does that mean?".
    func testTheRollbackSaysWhatHappenedAndOffersTheFix() {
        let failure = ExecutorFailureTranslator.translate(
            "Executor descriptor revisions cannot move backwards."
        )
        XCTAssertEqual(failure.code, "EXECUTOR_DESCRIPTOR_ROLLBACK")
        XCTAssertEqual(failure.remedy, .reProposePolicy)
        XCTAssertEqual(failure.remedyTitle, "Propose these settings again")
        // The explanation has to name the cause and the consequence without
        // using the protocol's vocabulary.
        for forbidden in ["descriptor", "revision", "rollback"] {
            XCTAssertFalse(
                failure.explanation.lowercased().contains(forbidden),
                "the explanation must not fall back on \(forbidden.debugDescription)"
            )
        }
        XCTAssertGreaterThan(failure.explanation.count, 80)
        // The raw sentence survives as the footnote somebody would quote.
        XCTAssertEqual(failure.detail, "Executor descriptor revisions cannot move backwards.")
    }

    func testTheRevisionConflictAlsoOffersAFreshRevision() {
        let failure = ExecutorFailureTranslator.translate(
            "A descriptor revision cannot describe two different policies."
        )
        XCTAssertEqual(failure.code, "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT")
        XCTAssertEqual(failure.remedy, .reProposePolicy)
    }

    func testTheConnectionFenceExplainsThatAnotherMachineTookIt() {
        let failure = ExecutorFailureTranslator.translate("Executor connection is fenced.")
        XCTAssertEqual(failure.code, "EXECUTOR_CONNECTION_FENCED")
        XCTAssertEqual(failure.remedy, .restartExecutor)
        XCTAssertTrue(failure.explanation.lowercased().contains("another"))
    }

    /// Both spellings the API raises for an invalid proof map to the same code,
    /// and neither offers a button: nothing this app can press fixes a key that
    /// no longer matches.
    func testAnInvalidProofIsExplainedAndOffersNoButtonItCannotHonour() {
        for message in ["Executor proof is invalid.", "Executor descriptor proof is invalid."] {
            let failure = ExecutorFailureTranslator.translate(message)
            XCTAssertEqual(failure.code, "EXECUTOR_DAEMON_PROOF_INVALID", "for \(message)")
            XCTAssertEqual(failure.remedy, .none)
            XCTAssertNil(failure.remedyTitle)
            XCTAssertTrue(failure.explanation.contains("Pair this Mac again"))
        }
    }

    func testAStaleHeartbeatOffersARestart() {
        for message in ["Executor heartbeat is stale.", "Executor control call is stale."] {
            let failure = ExecutorFailureTranslator.translate(message)
            XCTAssertEqual(failure.code, "EXECUTOR_HEARTBEAT_STALE", "for \(message)")
            XCTAssertEqual(failure.remedy, .restartExecutor)
        }
    }

    func testAnUnconfirmedFingerprintSendsAPersonToNessie() {
        let failure = ExecutorFailureTranslator.translate(
            "The confirmation fingerprint does not match the pending executor."
        )
        XCTAssertEqual(failure.code, "FINGERPRINT_NOT_CONFIRMED")
        XCTAssertEqual(failure.remedy, .openNessie)
    }

    /// An unmapped refusal must still produce something honest. An empty banner,
    /// or one that invented a cause, would both be worse than quoting what
    /// Nessie said under a sentence that admits it is a quote.
    func testAnUnmappedRefusalIsQuotedRatherThanInvented() {
        let failure = ExecutorFailureTranslator.translate("Something nobody has mapped yet.")
        XCTAssertNil(failure.code)
        XCTAssertEqual(failure.remedy, .none)
        XCTAssertNil(failure.remedyTitle)
        XCTAssertFalse(failure.explanation.isEmpty)
        XCTAssertEqual(failure.detail, "Something nobody has mapped yet.")
    }

    func testAnEmptyRefusalStillSaysSomething() {
        for raw in ["", "   \n  "] {
            let failure = ExecutorFailureTranslator.translate(raw)
            XCTAssertFalse(failure.explanation.isEmpty, "\(raw.debugDescription) produced no words")
            XCTAssertTrue(failure.detail.isEmpty)
        }
    }

    /// The CLI prints its message on a line of its own, sometimes with the
    /// remedy sentence appended. Matching has to survive that.
    func testMatchingSurvivesSurroundingText() {
        let failure = ExecutorFailureTranslator.translate(
            "Executor descriptor revisions cannot move backwards. Run connect again.\n"
        )
        XCTAssertEqual(failure.code, "EXECUTOR_DESCRIPTOR_ROLLBACK")
    }

    /// Every mapping has to be worth showing: a sentence a person can act on,
    /// and a button title exactly when there is a remedy to press.
    func testEveryMappingIsWorthShowing() {
        let messages = [
            "Executor descriptor revisions cannot move backwards.",
            "A descriptor revision cannot describe two different policies.",
            "Executor connection is fenced.",
            "Executor proof is invalid.",
            "Executor descriptor proof is invalid.",
            "Executor heartbeat is stale.",
            "Executor control call is stale.",
            "No active executor enrollment is ready to confirm.",
            "The confirmation fingerprint does not match the pending executor.",
            "Executor API request timed out."
        ]
        for message in messages {
            let failure = ExecutorFailureTranslator.translate(message)
            XCTAssertNotNil(failure.code, "\(message) must be recognised")
            XCTAssertGreaterThan(failure.explanation.count, 40, "\(message) explains too little")
            XCTAssertNotEqual(failure.explanation, failure.detail, "\(message) is not translated")
            if failure.remedy == .none {
                XCTAssertNil(failure.remedyTitle, "\(message) offers a button that does nothing")
            } else {
                XCTAssertNotNil(failure.remedyTitle, "\(message) has a remedy with no button")
            }
        }
    }
}
