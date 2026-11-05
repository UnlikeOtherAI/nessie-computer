import Foundation
import Testing
import Virtualization
@testable import NessieExecutorVMCore

@Test("the VM bootstrap reports a concrete architecture and support decision")
func probeReportsSupportDecision() {
  let probe = hostProbe()
  #expect(!probe.architecture.isEmpty)
  #expect(!probe.supported || probe.architecture == "arm64")
}

@Test("guest images must be absolute owner-safe regular files")
func guestImagesRejectUnsafePaths() throws {
  #expect(throws: VMError.self) {
    try safeRegularFile("relative-kernel")
  }
  let sourceFile = URL(fileURLWithPath: #filePath).standardizedFileURL.path
  let resolved = try safeRegularFile(sourceFile)
  #expect(resolved.path == sourceFile)
}

@Test("a VM can receive only one owner-private COW workspace share")
func workspaceShareIsExplicitAndWritableOnlyInsideTheGuest() throws {
  let workspace = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  let safeWorkspace = try safeGuestWorkspaceDirectory(workspace.path)
  if #available(macOS 15.0, *) {
    let device = guestWorkspaceShareConfiguration(safeWorkspace)
    #expect(device.tag == "nessie-cow")
    let share = try #require(device.share as? VZSingleDirectoryShare)
    #expect(!share.directory.isReadOnly)
  }
}

@Test("a guest runtime is a separate read-only virtiofs share")
func runtimeShareIsExplicitAndReadOnly() throws {
  let runtime = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  let safeRuntime = try safeGuestRuntimeDirectory(runtime.path)
  if #available(macOS 15.0, *) {
    let device = guestRuntimeShareConfiguration(safeRuntime)
    #expect(device.tag == "nessie-runtime")
    let share = try #require(device.share as? VZSingleDirectoryShare)
    #expect(share.directory.isReadOnly)
  }
}

@Test("guest egress cannot be configured without the paired control socket")
func egressRequiresGuestControl() throws {
  let sourceFile = URL(fileURLWithPath: #filePath).standardizedFileURL
  let input = VMInput(
    cpuCount: 2,
    diskURL: nil,
    initrdURL: sourceFile,
    kernelURL: sourceFile,
    memoryMiB: 2048,
  )
  if #available(macOS 15.0, *) {
    #expect(throws: VMError.self) {
      try configuration(for: input, enableGuestEgress: true)
    }
  }
}
