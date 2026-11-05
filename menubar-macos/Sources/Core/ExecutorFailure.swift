import Foundation

/// What a failure means to the person looking at it, and what they can do next.
///
/// This exists because the app once put `Executor descriptor revisions cannot
/// move backwards.` in a banner with a single Dismiss button. That sentence is
/// the API's own refusal, written for the protocol
/// (`packages/executor-manage/src/executor-daemon.ts`); to a person it names no
/// cause, no consequence and no remedy, and the honest response to it was "what
/// does that mean?". A raw API sentence is never the whole of an error here.
///
/// The raw sentence is kept rather than thrown away — it is what somebody would
/// quote in a support conversation — but it is the footnote, not the headline.
///
/// **Matched on the message, not the code.** The CLI writes `error.message` to
/// standard error and nothing else, so the code never reaches this process. The
/// messages are fixed string literals beside their codes in `executor-manage`,
/// and each mapping below names the code it stands for, so a message that
/// changes without this file changing falls through to the honest default rather
/// than mislabelling anything.
public struct ExecutorFailure: Equatable, Sendable {
    /// What a person can do about it, if anything.
    public enum Remedy: Equatable, Sendable {
        case none
        /// Propose a fresh, higher policy revision and reconnect.
        case reProposePolicy
        /// The fingerprint has to be confirmed by a person in Nessie.
        case openNessie
        /// Another daemon took this executor; stopping and starting is the fix.
        case restartExecutor
    }

    /// The `EXECUTOR_ERROR_CODES` entry this stands for, when it is recognised.
    public let code: String?
    /// What happened, in the person's terms. One or two sentences.
    public let explanation: String
    public let remedy: Remedy
    /// The button's words. `nil` when there is nothing to offer but Dismiss.
    public let remedyTitle: String?
    /// The sentence the CLI actually printed.
    public let detail: String

    public init(
        code: String?,
        explanation: String,
        remedy: Remedy = .none,
        remedyTitle: String? = nil,
        detail: String
    ) {
        self.code = code
        self.explanation = explanation
        self.remedy = remedy
        self.remedyTitle = remedyTitle
        self.detail = detail
    }
}

public enum ExecutorFailureTranslator {
    public static func translate(_ raw: String) -> ExecutorFailure {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for known in known where detail.contains(known.message) {
            return ExecutorFailure(
                code: known.code,
                explanation: known.explanation,
                remedy: known.remedy,
                remedyTitle: known.remedyTitle,
                detail: detail
            )
        }
        // An unmapped failure still says something true: that Nessie refused,
        // and what it said. Silence, or an invented cause, would both be worse
        // than quoting the refusal under a sentence that admits it is a quote.
        return ExecutorFailure(
            code: nil,
            explanation: detail.isEmpty
                ? "Nessie Executor could not finish that, and gave no reason."
                : "Nessie refused that, and this is what it said:",
            detail: detail
        )
    }

    private struct Known {
        let code: String
        /// The literal the API raises beside that code.
        let message: String
        let explanation: String
        let remedy: ExecutorFailure.Remedy
        let remedyTitle: String?
    }

    private static let known: [Known] = [
        Known(
            code: "EXECUTOR_DESCRIPTOR_ROLLBACK",
            message: "Executor descriptor revisions cannot move backwards.",
            explanation: "This Mac's copy of the executor's settings is older than the one Nessie has "
                + "already recorded, and Nessie never accepts an older set — going back to older "
                + "settings is how someone would quietly restore access that was taken away. It "
                + "happens honestly after a reinstall, or when a copy of this executor's files is "
                + "moved between machines. Proposing the current settings again as a newer version "
                + "fixes it, and nothing about what this executor may do changes.",
            remedy: .reProposePolicy,
            remedyTitle: "Propose these settings again"
        ),
        Known(
            code: "EXECUTOR_DESCRIPTOR_REVISION_CONFLICT",
            message: "A descriptor revision cannot describe two different policies.",
            explanation: "Nessie already has a different set of settings recorded under this version "
                + "number, so it cannot tell which of the two a person reviewed. Proposing these "
                + "settings again as a newer version gives them a number of their own.",
            remedy: .reProposePolicy,
            remedyTitle: "Propose these settings again"
        ),
        Known(
            code: "EXECUTOR_CONNECTION_FENCED",
            message: "Executor connection is fenced.",
            explanation: "Another copy of this executor connected to Nessie after this one did, so "
                + "Nessie is no longer listening to this Mac. Only one machine holds an executor at "
                + "a time. Stopping and starting it here takes the connection back — if you did not "
                + "expect a second machine, check the executor in Nessie first.",
            remedy: .restartExecutor,
            remedyTitle: "Stop and start it here"
        ),
        Known(
            code: "EXECUTOR_DAEMON_PROOF_INVALID",
            message: "Executor proof is invalid.",
            explanation: "Nessie did not accept this Mac's signature, which means the private key "
                + "here no longer matches the executor Nessie knows. That is what a re-paired or "
                + "restored executor looks like. Pair this Mac again from Settings.",
            remedy: .none,
            remedyTitle: nil
        ),
        Known(
            code: "EXECUTOR_DAEMON_PROOF_INVALID",
            message: "Executor descriptor proof is invalid.",
            explanation: "Nessie did not accept the signature on these settings, which means the "
                + "private key on this Mac no longer matches the executor Nessie knows. Pair this "
                + "Mac again from Settings.",
            remedy: .none,
            remedyTitle: nil
        ),
        Known(
            code: "EXECUTOR_HEARTBEAT_STALE",
            message: "Executor heartbeat is stale.",
            explanation: "Nessie stopped hearing from this Mac long enough to consider it gone — "
                + "usually sleep, or a network that dropped. Starting the executor again reconnects "
                + "it.",
            remedy: .restartExecutor,
            remedyTitle: "Stop and start it here"
        ),
        Known(
            code: "EXECUTOR_HEARTBEAT_STALE",
            message: "Executor control call is stale.",
            explanation: "Nessie stopped hearing from this Mac long enough to consider it gone — "
                + "usually sleep, or a network that dropped. Starting the executor again reconnects "
                + "it.",
            remedy: .restartExecutor,
            remedyTitle: "Stop and start it here"
        ),
        Known(
            code: "FINGERPRINT_NOT_CONFIRMED",
            message: "No active executor enrollment is ready to confirm.",
            explanation: "Nessie has no invitation waiting for this Mac. The one you pasted may have "
                + "already been used or expired; create a new executor in Nessie and paste its "
                + "invitation again.",
            remedy: .openNessie,
            remedyTitle: "Open Nessie"
        ),
        Known(
            code: "FINGERPRINT_NOT_CONFIRMED",
            message: "The confirmation fingerprint does not match the pending executor.",
            explanation: "The fingerprint this Mac produced is not the one Nessie is waiting to have "
                + "confirmed. Compare the fingerprint in Settings with the one on the executor's "
                + "page in Nessie before confirming it.",
            remedy: .openNessie,
            remedyTitle: "Open Nessie"
        ),
        Known(
            code: "ENROLLMENT_EXPIRED",
            message: "No active executor enrollment is ready",
            explanation: "That invitation has expired. Create a new executor in Nessie and paste its "
                + "invitation again.",
            remedy: .openNessie,
            remedyTitle: "Open Nessie"
        ),
        Known(
            code: "EXECUTOR_API_TIMEOUT",
            message: "Executor API request timed out.",
            explanation: "Nessie did not answer in time. Check this Mac's network and try again.",
            remedy: .none,
            remedyTitle: nil
        )
    ]
}
