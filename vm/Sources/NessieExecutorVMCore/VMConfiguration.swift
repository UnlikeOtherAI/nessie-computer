import Darwin
import Foundation
import Virtualization

public enum VMError: Error {
  case guestHandshake
  case guestSession
  case invalidArgument
  case unsupportedHost
  case unsafeImage
  case unsafeRuntime
  case unsafeWorkspace
}

public struct VMInput {
  public let cpuCount: Int
  public let diskURL: URL?
  public let initrdURL: URL?
  public let kernelURL: URL
  public let memoryMiB: Int

  public init(
    cpuCount: Int,
    diskURL: URL?,
    initrdURL: URL?,
    kernelURL: URL,
    memoryMiB: Int,
  ) {
    self.cpuCount = cpuCount
    self.diskURL = diskURL
    self.initrdURL = initrdURL
    self.kernelURL = kernelURL
    self.memoryMiB = memoryMiB
  }
}

public struct VMHostProbe {
  public let architecture: String
  public let supported: Bool
}

public func safeRegularFile(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeImage }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  var metadata = stat()
  guard lstat(url.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1 else {
    throw VMError.unsafeImage
  }
  guard metadata.st_uid == getuid(), metadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeImage
  }
  let resolved = url.resolvingSymlinksInPath()
  guard resolved.path == url.path else { throw VMError.unsafeImage }
  return resolved
}

/**
 * The only host directory a guest VM may receive is a daemon-created COW
 * draft. Callers must not pass the paired workspace root here. The helper
 * nevertheless enforces an absolute, non-link, owner-private directory so a
 * changed local path cannot become an ambient share while the VM starts.
 */
public func safeGuestWorkspaceDirectory(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeWorkspace }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  var metadata = stat()
  guard lstat(url.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFDIR else {
    throw VMError.unsafeWorkspace
  }
  guard metadata.st_uid == getuid(), metadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeWorkspace
  }
  let resolved = url.resolvingSymlinksInPath()
  guard resolved.path == url.path else { throw VMError.unsafeWorkspace }
  return resolved
}

/** A runtime payload is a separate, read-only guest share—not a workspace. */
public func safeGuestRuntimeDirectory(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeRuntime }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  var metadata = stat()
  guard lstat(url.path, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFDIR else {
    throw VMError.unsafeRuntime
  }
  guard metadata.st_uid == getuid(), metadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeRuntime
  }
  let resolved = url.resolvingSymlinksInPath()
  guard resolved.path == url.path else { throw VMError.unsafeRuntime }
  return resolved
}

public func isValidGuestRuntimeManifestDigest(_ value: String) -> Bool {
  guard value.count == 71, value.hasPrefix("sha256:") else { return false }
  return value.dropFirst(7).unicodeScalars.allSatisfy { scalar in
    ("0"..."9").contains(Character(String(scalar))) || ("a"..."f").contains(Character(String(scalar)))
  }
}

public func hostProbe() -> VMHostProbe {
  #if arch(arm64)
  let architecture = "arm64"
  #else
  let architecture = "unsupported"
  #endif
  let supported: Bool
  if #available(macOS 15.0, *), architecture == "arm64" {
    supported = true
  } else {
    supported = false
  }
  return VMHostProbe(architecture: architecture, supported: supported)
}

public func requireSupportedHost() throws {
  guard hostProbe().supported else { throw VMError.unsupportedHost }
}

@available(macOS 15.0, *)
func guestWorkspaceShareConfiguration(_ workspaceURL: URL) -> VZVirtioFileSystemDeviceConfiguration {
  let sharedDirectory = VZSharedDirectory(url: workspaceURL, readOnly: false)
  let share = VZSingleDirectoryShare(directory: sharedDirectory)
  let device = VZVirtioFileSystemDeviceConfiguration(tag: "nessie-cow")
  device.share = share
  return device
}

@available(macOS 15.0, *)
func guestRuntimeShareConfiguration(_ runtimeURL: URL) -> VZVirtioFileSystemDeviceConfiguration {
  let sharedDirectory = VZSharedDirectory(url: runtimeURL, readOnly: true)
  let share = VZSingleDirectoryShare(directory: sharedDirectory)
  let device = VZVirtioFileSystemDeviceConfiguration(tag: "nessie-runtime")
  device.share = share
  return device
}

@available(macOS 15.0, *)
public func configuration(
  for input: VMInput,
  consoleURL: URL? = nil,
  enableGuestControl: Bool = false,
  enableGuestEgress: Bool = false,
  guestRuntimeManifestDigest: String? = nil,
  guestRuntimeURL: URL? = nil,
  guestWorkspaceURL: URL? = nil,
) throws -> VZVirtualMachineConfiguration {
  guard (1...4).contains(input.cpuCount), (2048...8192).contains(input.memoryMiB) else {
    throw VMError.invalidArgument
  }
  guard !enableGuestEgress || enableGuestControl else {
    throw VMError.invalidArgument
  }
  guard (guestRuntimeURL == nil) == (guestRuntimeManifestDigest == nil),
    guestRuntimeManifestDigest.map(isValidGuestRuntimeManifestDigest) ?? true
  else {
    throw VMError.invalidArgument
  }
  let loader = VZLinuxBootLoader(kernelURL: input.kernelURL)
  let baseBootCommand = input.diskURL == nil
    ? "console=hvc0 rdinit=/init panic=-1"
    : "console=hvc0 root=/dev/vda ro panic=-1"
  let bootArguments = [
    guestRuntimeManifestDigest.map { "nessie.runtime_manifest=\($0)" },
    guestRuntimeURL == nil ? nil : "nessie.runtime=1",
    guestWorkspaceURL == nil ? nil : "nessie.workspace=1",
    enableGuestEgress ? "nessie.egress=1" : nil,
  ].compactMap { $0 }
  loader.commandLine = ([baseBootCommand] + bootArguments).joined(separator: " ")
  loader.initialRamdiskURL = input.initrdURL

  let configuration = VZVirtualMachineConfiguration()
  configuration.bootLoader = loader
  configuration.cpuCount = input.cpuCount
  configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  configuration.memorySize = UInt64(input.memoryMiB) * 1_024 * 1_024
  if let diskURL = input.diskURL {
    let disk = try VZDiskImageStorageDeviceAttachment(url: diskURL, readOnly: true)
    configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
  }
  if let consoleURL {
    let consoleOutput = try FileHandle(forWritingTo: consoleURL)
    try consoleOutput.truncate(atOffset: 0)
    let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()
    serialPort.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/null")),
      fileHandleForWriting: consoleOutput,
    )
    configuration.serialPorts = [serialPort]
  }
  if enableGuestControl {
    configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  }
  configuration.directorySharingDevices = [
    guestRuntimeURL.map(guestRuntimeShareConfiguration),
    guestWorkspaceURL.map(guestWorkspaceShareConfiguration),
  ].compactMap { $0 }

  // Guest control is a per-VM virtio socket, never a network adapter. The only
  // filesystem bridge is the exact daemon-owned COW workspace above; a paired
  // root, home directory, or generic host share is never configured here. The
  // broker must still add forced egress before browser/coding descriptors can
  // be advertised.
  try configuration.validate()
  return configuration
}
