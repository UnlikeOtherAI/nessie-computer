import Foundation

/// Adding and removing the named folders an executor may read.
///
/// Like `PermittedProgram`, this is a *pre*-check so the reach surface can
/// refuse in words rather than in an exit status.
/// `assertExecutorWorkspaceFolders` in the CLI decides for real — the grammar,
/// the duplicate and nesting rules, and whether a path is an ordinary directory
/// at all — and its answer is the one that lands in the policy.
public enum WorkspaceFolder {
    /// `EXECUTOR_WORKSPACE_FOLDER_MAXIMUM` in packages/schemas/src/executor.ts.
    public static let maximumCount = 16
    /// `EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH`.
    public static let maximumNameLength = 40
    /// `EXECUTOR_RESERVED_WORKSPACE_FOLDER_NAMES`. Windows turns these basenames
    /// into devices wherever a path is opened, and a reviewed policy has to stay
    /// legal on the next machine that loads it.
    public static let reservedNames: Set<String> = [
        "aux", "con", "nul", "prn",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
    ]
    public static let fallbackName = "workspace"

    /// The path the runtime will store for a chosen folder: every symbolic link
    /// resolved, as `realpath` does (`/tmp/work` is `/private/tmp/work`). The
    /// console keeps this path, so what it asked for and what is saved compare
    /// equal. A path that cannot be resolved is returned as chosen, and the
    /// runtime's own validation explains why it is refused.
    public static func resolvedPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    public static let nameRefusal =
        "A workspace folder name is 1 to \(maximumNameLength) lowercase letters, digits and interior "
        + "hyphens. It starts every path an agent writes, so it carries no slash, no dot and no case."

    /// `EXECUTOR_WORKSPACE_FOLDER_NAME_PATTERN`: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.
    public static func nameIsLegal(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= maximumNameLength else { return false }
        guard !reservedNames.contains(value) else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        guard value.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return false }
        guard let first = value.first, let last = value.last else { return false }
        return first != "-" && last != "-"
    }

    /// The name a chosen directory gets, derived the way
    /// `deriveExecutorWorkspaceFolderName` derives it, so the name a person is
    /// offered here is the name the CLI would pick. The derivation is total:
    /// anything the grammar refuses becomes `workspace`.
    public static func derivedName(for path: String) -> String {
        let basename = (path.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        var hyphenated = ""
        var pendingHyphen = false
        for character in basename.lowercased() {
            if character.isASCII && (character.isLetter || character.isNumber) {
                if pendingHyphen && !hyphenated.isEmpty { hyphenated.append("-") }
                pendingHyphen = false
                hyphenated.append(character)
            } else {
                pendingHyphen = true
            }
        }
        let derived = String(hyphenated.prefix(maximumNameLength))
        return nameIsLegal(derived) ? derived : fallbackName
    }

    public static func validate(
        adding path: String,
        named requested: String?,
        to existing: [ExecutorDescription.Folder]
    ) -> Result<[ExecutorDescription.Folder], ExecutorRefusal> {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else {
            return .failure(ExecutorRefusal("A workspace folder is an absolute path on this Mac."))
        }
        let typed = (requested?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
            $0.isEmpty ? nil : $0
        }
        let name = typed ?? derivedName(for: trimmed)
        guard nameIsLegal(name) else {
            return .failure(ExecutorRefusal(nameRefusal))
        }
        guard existing.count + 1 <= maximumCount else {
            return .failure(ExecutorRefusal(
                "An executor reaches at most \(maximumCount) folders."
            ))
        }
        guard !existing.contains(where: { $0.name == name }) else {
            return .failure(ExecutorRefusal(
                "This executor already reaches a folder named \(name). Two folders with one name "
                    + "would make every path starting with it ambiguous."
            ))
        }
        // Nesting is refused by the CLI because a file inside two folders would
        // have two workspace paths, which makes a receipt ambiguous about what
        // was read. Saying so here saves a person the round trip.
        for folder in existing where contains(folder.path, trimmed) || contains(trimmed, folder.path) {
            return .failure(ExecutorRefusal(
                folder.path == trimmed
                    ? "This executor already reaches \(trimmed), as \(folder.name)."
                    : "\(trimmed) and \(folder.path) contain one another. A file inside both would "
                        + "have two workspace paths, so only one of them can be a folder."
            ))
        }
        return .success(
            (existing + [ExecutorDescription.Folder(name: name, path: trimmed)])
                .sorted { $0.name < $1.name }
        )
    }

    /// Removing the last folder is refused: an executor paired against nothing
    /// can read nothing, and the CLI refuses an empty list too.
    public static func validate(
        removing name: String,
        from existing: [ExecutorDescription.Folder]
    ) -> Result<[ExecutorDescription.Folder], ExecutorRefusal> {
        let remaining = existing.filter { $0.name != name }
        guard remaining.count != existing.count else {
            return .failure(ExecutorRefusal("\(name) is not one of this executor's folders."))
        }
        guard !remaining.isEmpty else {
            return .failure(ExecutorRefusal(
                "An executor reaches at least one folder. Add the folder it should read before "
                    + "removing this one."
            ))
        }
        return .success(remaining)
    }

    private static func contains(_ outer: String, _ inner: String) -> Bool {
        outer == inner || inner.hasPrefix(outer.hasSuffix("/") ? outer : outer + "/")
    }
}

public extension ExecutorDescription {
    /// What the reach surface says about guest sessions, in the person's terms.
    /// A guest VM mounts one workspace, so this is a refusal to state rather
    /// than a detail to hide — the alternative is `command.run` binding to
    /// whichever folder happened to come first.
    var guestSessionNote: String {
        switch reach.guestSessions {
        case .available:
            return "A sandboxed command or coding session can start: exactly one folder is configured."
        case .refusedMultipleFolders:
            return "Sandboxed commands and coding sessions refuse to start while more than one folder "
                + "is configured — a guest mounts one workspace, so it would otherwise bind to "
                + "whichever folder came first. Listing, reading, writing and reviewing files work "
                + "across all of them."
        }
    }
}
