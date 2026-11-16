import Darwin
import Foundation

/// Lifecycle observations only; the CLI owns atomic acquisition and removal.
public enum DaemonLease: Equatable, Sendable {
    case absent
    case held(pid: Int32)
    case generation(pid: Int32, startedAt: String, bootID: String?)
    case suspect
}

public enum DaemonLeaseReader {
    public static let fileName = "daemon.pid"

    public static func read(in stateDirectory: String, fileManager: FileManager = .default) -> DaemonLease {
        let path = (stateDirectory as NSString).appendingPathComponent(fileName)
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try fileManager.attributesOfItem(atPath: path)
        } catch {
            let failure = error as NSError
            return failure.domain == NSCocoaErrorDomain
                && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(failure.code) ? .absent : .suspect
        }
        guard (attributes[.type] as? FileAttributeType) == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? 4097 <= 4096,
              let file = FileHandle(forReadingAtPath: path) else { return .suspect }
        defer { try? file.close() }
        guard let bytes = try? file.read(upToCount: 4097), bytes.count <= 4096,
              let text = String(data: bytes, encoding: .utf8) else { return .suspect }
        return parse(text)
    }

    private struct Claim: Decodable {
        let version: Int
        let pid: Int32
        let startedAt: String
        let token: String
        let bootId: String?
    }

    static func parse(_ text: String) -> DaemonLease {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if decimal(value), let pid = Int32(value), pid > 0 { return .held(pid: pid) }
        guard let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let claim = try? JSONDecoder().decode(Claim.self, from: data),
              claim.pid > 0, decimal(claim.startedAt), uuid(claim.token),
              Array(claim.token)[14] == "4", ["8", "9", "a", "b"].contains(String(Array(claim.token)[19]))
        else { return .suspect }
        let expected: Set<String> = ["version", "pid", "startedAt", "token"]
        switch claim.version {
        case 1:
            guard Set(object.keys) == expected else { return .suspect }
        case 2:
            guard Set(object.keys) == expected.union(["bootId"]),
                  let boot = claim.bootId, uuid(boot) else { return .suspect }
        default: return .suspect
        }
        return .generation(pid: claim.pid, startedAt: claim.startedAt, bootID: claim.bootId)
    }

    private static func decimal(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { (48...57).contains($0) }
    }

    private static func uuid(_ value: String) -> Bool {
        value.count == 36 && value == value.lowercased() && UUID(uuidString: value) != nil
    }

    /// An inspection failure is not proof that a process has gone.
    public static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno != ESRCH
    }

    public static func birth(_ pid: Int32) -> String? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000 else { return nil }
        let (seconds, overflow) = info.pbi_start_tvsec.multipliedReportingOverflow(by: 1_000_000)
        let (micros, addedOverflow) = seconds.addingReportingOverflow(info.pbi_start_tvusec)
        return overflow || addedOverflow ? nil : String(micros)
    }

    public static func bootID() -> String? {
        var bytes = [CChar](repeating: 0, count: 64)
        var size = bytes.count
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 0, size <= bytes.count, bytes[size - 1] == 0 else { return nil }
        let value = String(cString: bytes).lowercased()
        return uuid(value) ? value : nil
    }
}

public func leaseBlocksStart(
    _ lease: DaemonLease,
    daemonIsLive: (Int32) -> Bool = DaemonLeaseReader.isAlive,
    processBirth: (Int32) -> String? = DaemonLeaseReader.birth,
    bootID: () -> String? = DaemonLeaseReader.bootID
) -> Bool {
    switch lease {
    case .absent: return false
    case .suspect: return true
    case let .held(pid): return daemonIsLive(pid)
    case let .generation(pid, expected, boot):
        if let boot {
            guard let current = bootID() else { return true }
            if current != boot { return false }
        }
        if let current = processBirth(pid) { return current == expected }
        return daemonIsLive(pid)
    }
}
