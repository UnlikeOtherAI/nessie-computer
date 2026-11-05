import Foundation

/// The grammar a permitted command has to satisfy, restated so the Tools section
/// can refuse in words a person can act on instead of showing the CLI's exit
/// status. It is a *pre*-check, never the decision: `configure` runs
/// `parseExecutorCommandPattern` (packages/schemas/src/executor.ts) over the
/// same list and its answer is the one that lands in the policy.
///
/// An entry is the start of a command, not a bare program name: `git *` permits
/// every git command, `npm run *` every script and no `npm publish`, and a bare
/// `node` permits exactly `node` with no arguments. The `*` is only ever the
/// final token — in the program position it would read as "any program" while
/// matching a name no PATH resolves, and it would reach straight past the shells
/// the program grammar refuses.
public enum PermittedProgram {
    /// `EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM` in packages/schemas/src/executor.ts.
    public static let maximumCount = 64
    /// `EXECUTOR_COMMAND_PATTERN_MAXIMUM_LENGTH`.
    public static let maximumLength = 512
    public static let wildcard = "*"
    private static let shells = ["bash", "dash", "fish", "ksh", "sh", "zsh"]
    private static let maximumArgumentLength = 4_096

    /// The refusal the CLI raises for a malformed list, word for word.
    public static let grammarRefusal =
        "A permitted command is a program the guest resolves through its fixed PATH, "
        + "optionally followed by arguments and a trailing \"*\" — for example \"git *\" or "
        + "\"npm run *\". Paths, shells and a leading \"*\" are refused, at most "
        + "\(maximumCount) entries."

    /// The canonical spelling of an entry, or `nil` when it is not one. Mirrors
    /// `parseExecutorCommandPattern`: runs of whitespace are a typo rather than
    /// an argument, so normalising here means re-typing the same rule with two
    /// spaces is not a new revision for somebody to review.
    public static func normalise(_ entry: String) -> String? {
        guard !entry.isEmpty, entry.count <= maximumLength, !entry.contains("\0") else { return nil }
        let tokens = entry.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let program = tokens.first else { return nil }
        guard !program.isEmpty, program.count <= 256,
              !program.contains("/"), !shells.contains(program)
        else { return nil }
        let rest = tokens.dropFirst()
        let permitsFurtherArguments = rest.last == wildcard
        let argumentPrefix = permitsFurtherArguments ? Array(rest.dropLast()) : Array(rest)
        guard !([program] + argumentPrefix).contains(where: { $0.contains(wildcard) }) else { return nil }
        guard !argumentPrefix.contains(where: { $0.count > maximumArgumentLength }) else { return nil }
        return (([program] + argumentPrefix) + (permitsFurtherArguments ? [wildcard] : []))
            .joined(separator: " ")
    }

    public static func validate(
        adding entry: String,
        to existing: [String]
    ) -> Result<[String], ExecutorRefusal> {
        guard let command = normalise(entry) else {
            return .failure(ExecutorRefusal(grammarRefusal))
        }
        guard !existing.contains(command) else {
            return .failure(ExecutorRefusal("\(command) is already a permitted command."))
        }
        guard existing.count + 1 <= maximumCount else {
            return .failure(ExecutorRefusal(grammarRefusal))
        }
        return .success((existing + [command]).sorted())
    }

    /// Removing the last entry while `command.run` is enabled is refused here for
    /// the same reason `configure` refuses it: an operation that can never
    /// succeed is a misconfiguration, not a policy.
    public static func validate(
        removing command: String,
        from existing: [String],
        commandRunEnabled: Bool
    ) -> Result<[String], ExecutorRefusal> {
        let remaining = existing.filter { $0 != command }
        guard remaining.count != existing.count else {
            return .failure(ExecutorRefusal("\(command) is not a permitted command."))
        }
        if commandRunEnabled && remaining.isEmpty {
            return .failure(ExecutorRefusal(
                "Name at least one permitted command before enabling command.run. Turn off "
                    + "command.run in Nessie first, or keep one command on the list."
            ))
        }
        return .success(remaining)
    }
}
