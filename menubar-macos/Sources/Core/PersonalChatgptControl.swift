import Foundation

/// The bundled console may name an action and public identifiers, never a
/// path, URL, OAuth code, token or authority claim. The CLI owns validation.
public enum PersonalChatgptControl {
    public static func invocation(operation: [String: Any], stateDirectory: String) throws -> ExecutorCLIInvocation {
        guard let action = operation["operation"] as? String else {
            throw ExecutorRefusal("Choose a local account action.")
        }
        let fields: Set<String>
        switch action {
        case "status": fields = ["operation", "profileId"]
        case "start":
            fields = ["operation", "profileId", "acknowledgeHostRestriction", "newProfileId", "label"]
            guard operation["acknowledgeHostRestriction"] is Bool else {
                throw ExecutorRefusal("Confirm the computer restriction.")
            }
        case "rename": fields = ["operation", "profileId", "label"]
        case "cancel": fields = ["operation", "operationId"]
        case "disconnect": fields = ["operation", "profileId"]
        case "background-consent":
            fields = ["operation", "profileId", "enabled", "expectedRevision"]
            guard operation["enabled"] is Bool, operation["expectedRevision"] != nil else {
                throw ExecutorRefusal("Choose a revision-bound background permission.")
            }
        default: throw ExecutorRefusal("Unknown local account action.")
        }
        guard Set(operation.keys).isSubset(of: fields) else {
            throw ExecutorRefusal("Invalid local account action.")
        }
        for key in ["profileId", "operationId", "newProfileId"] where operation[key] != nil {
            guard let identifier = operation[key] as? String, UUID(uuidString: identifier) != nil else {
                throw ExecutorRefusal("Invalid local sign-in identity.")
            }
        }
        if let label = operation["label"] {
            guard let text = label as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                text.count <= 80 else { throw ExecutorRefusal("Name this connection.") }
        } else if action == "rename" { throw ExecutorRefusal("Name this connection.") }
        if action == "cancel" && operation["operationId"] == nil
            || ["disconnect", "background-consent", "rename"].contains(action) && operation["profileId"] == nil {
            throw ExecutorRefusal("Choose the local sign-in.")
        }
        return ExecutorCLIInvocation(
            arguments: ["personal-chatgpt-local", "--operation-stdin", "--state-dir", stateDirectory],
            standardInput: try JSONSerialization.data(withJSONObject: operation)
        )
    }
}
