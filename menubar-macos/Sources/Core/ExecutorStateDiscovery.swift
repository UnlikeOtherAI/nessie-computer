import Foundation

/// Discover only the product's documented state roots, one directory level
/// deep. The runtime still owns validation and reading of every machine key.
public enum ExecutorStateDiscovery {
    private static let stateFiles = ["executor-state.json", "executor-pairing-code.json"]

    /// A saved replacement can coexist with the prior key until Nessie confirms
    /// its retirement. A failed network refresh must not restart that executor.
    /// Check metadata only; the CLI remains the sole reader of pairing secrets.
    public static func pendingAttemptBlocksStart(
        in directory: String,
        fileManager: FileManager = .default
    ) -> Bool {
        let path = (directory as NSString).appendingPathComponent("executor-pairing-code.json")
        do {
            _ = try fileManager.attributesOfItem(atPath: path)
            return true
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileReadNoSuchFileError {
            return false
        } catch {
            return true
        }
    }

    /// Teams found in `directories` that this app does not run yet: a team the
    /// command line connected while the app was open. Only a finished pairing
    /// counts; an attempt still showing its code belongs to whoever started it,
    /// which moves it to its own folder once Nessie accepts it.
    public static func unclaimedTeams(
        in directories: [String],
        known: [String],
        fileManager: FileManager = .default
    ) -> [String] {
        let claimed = Set(known.map { ($0 as NSString).standardizingPath })
        return directories.filter { directory in
            !claimed.contains((directory as NSString).standardizingPath)
                && fileManager.fileExists(atPath: (directory as NSString).appendingPathComponent("executor-state.json"))
                && !pendingAttemptBlocksStart(in: directory, fileManager: fileManager)
        }
    }

    public static func resolve(
        preferredDirectory: String,
        legacyRoots: [String],
        fileManager: FileManager = .default
    ) -> Result<[String], ExecutorRefusal> {
        do {
            var candidates: Set<String> = []
            if try containsPairing(preferredDirectory, fileManager: fileManager) {
                candidates.insert(preferredDirectory)
            }
            for root in legacyRoots {
                guard try isDirectory(root, fileManager: fileManager) else { continue }
                for name in try fileManager.contentsOfDirectory(atPath: root) {
                    let directory = (root as NSString).appendingPathComponent(name)
                    if try containsPairing(directory, fileManager: fileManager) {
                        candidates.insert(directory)
                    }
                }
            }
            return .success(candidates.isEmpty ? [preferredDirectory] : candidates.sorted())
        } catch {
            return .failure(ExecutorRefusal(.existingTeamsUnreadable))
        }
    }

    private static func isDirectory(_ path: String, fileManager: FileManager) throws -> Bool {
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try fileManager.attributesOfItem(atPath: path)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileReadNoSuchFileError {
            return false
        }
        if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
            throw ExecutorRefusal(.existingTeamNeedsAttention)
        }
        return attributes[.type] as? FileAttributeType == .typeDirectory
    }

    private static func containsPairing(_ directory: String, fileManager: FileManager) throws -> Bool {
        guard try isDirectory(directory, fileManager: fileManager) else { return false }
        for name in stateFiles {
            let path = (directory as NSString).appendingPathComponent(name)
            do {
                let attributes = try fileManager.attributesOfItem(atPath: path)
                guard attributes[.type] as? FileAttributeType == .typeRegular else {
                    throw ExecutorRefusal(.existingTeamNeedsAttention)
                }
                return true
            } catch let error as NSError where error.domain == NSCocoaErrorDomain
                && error.code == NSFileReadNoSuchFileError {
                continue
            }
        }
        return false
    }
}
