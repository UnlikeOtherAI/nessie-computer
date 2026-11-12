import Foundation

/// Claude Code and Codex on this computer (contract §12). The console names an
/// engine, an account id, a switch or a name; never a path, program or
/// credential. Each command becomes one `local-inference engines` operation.
public enum LocalAIControl {
    public static let commands: Set<String> = [
        "executor_local_ai", "executor_set_local_ai", "executor_local_ai_add_account",
        "executor_local_ai_sign_in", "executor_local_ai_remove_account"
    ]
    private static let engines: Set<String> = ["claude-code", "codex"]

    public static func invocation(
        command: String, args: [String: Any], stateDirectory: String
    ) throws -> ExecutorCLIInvocation {
        let operation = try operation(command: command, args: args)
        return ExecutorCLIInvocation(
            arguments: ["local-inference", "engines", "--operation-stdin", "--state-dir", stateDirectory],
            standardInput: try JSONSerialization.data(withJSONObject: operation)
        )
    }

    static func operation(command: String, args: [String: Any]) throws -> [String: Any] {
        switch command {
        case "executor_local_ai": return ["operation": "list"]
        case "executor_set_local_ai":
            guard let available = args["available"] as? Bool else { throw ExecutorRefusal(.invalidRequest) }
            return ["operation": "set", "engine": try engine(args), "profileId": try optionalProfile(args),
                    "available": available]
        case "executor_local_ai_add_account":
            guard let name = (args["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty, name.count <= 80 else { throw ExecutorRefusal(.invalidRequest) }
            return ["operation": "add", "engine": try engine(args), "name": name]
        case "executor_local_ai_sign_in":
            return ["operation": "sign-in", "profileId": try profile(args["profileId"])]
        case "executor_local_ai_remove_account":
            return ["operation": "remove", "profileId": try profile(args["profileId"])]
        default: throw ExecutorRefusal(.invalidRequest)
        }
    }

    private static func engine(_ args: [String: Any]) throws -> String {
        guard let engine = args["engine"] as? String, engines.contains(engine) else {
            throw ExecutorRefusal(.invalidRequest)
        }
        return engine
    }

    private static func profile(_ value: Any?) throws -> String {
        guard let identifier = value as? String, UUID(uuidString: identifier) != nil else {
            throw ExecutorRefusal(.invalidRequest)
        }
        return identifier.lowercased()
    }

    private static func optionalProfile(_ args: [String: Any]) throws -> Any {
        guard let value = args["profileId"], !(value is NSNull) else { return NSNull() }
        return try profile(value)
    }
}
