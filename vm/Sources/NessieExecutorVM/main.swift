import Darwin
import Dispatch
import Foundation
import NessieExecutorVMCore
import Virtualization

private func json(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}

private func usage() -> Never {
  fputs("Usage: nessie-executor-vm probe | validate --kernel <path> [--initrd <path>] [--disk <path>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n  nessie-executor-vm smoke --console <owner-only-path> --kernel <path> --initrd <path> [--disk <path>] [--timeout-seconds <1-30>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n  nessie-executor-vm handshake --console <owner-only-path> --kernel <path> --initrd <path> --bootstrap-token-stdin [--workspace-cow <owner-only-draft>] [--timeout-seconds <1-30>] [--disk <path>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n  nessie-executor-vm session --console <owner-only-path> --kernel <path> --initrd <path> --workspace-cow <owner-only-draft> --runtime-bundle <owner-only-runtime> --runtime-manifest-digest <sha256:...> [--egress-gateway <owner-only-socket>] --bootstrap-token-stdin [--disk <path>] [--cpus <1-4>] [--memory-mib <2048-8192>]\n", stderr)
  exit(64)
}

private func option(_ arguments: [String], _ name: String) throws -> String? {
  guard let index = arguments.firstIndex(of: name) else { return nil }
  guard arguments.indices.contains(index + 1), !arguments[index + 1].hasPrefix("--") else {
    throw VMError.invalidArgument
  }
  return arguments[index + 1]
}

private func requiredOption(_ arguments: [String], _ name: String) throws -> String {
  guard let value = try option(arguments, name) else { throw VMError.invalidArgument }
  return value
}

private func parseInput(_ arguments: [String]) throws -> VMInput {
  try requireSupportedHost()
  let cpuCount = Int(try option(arguments, "--cpus") ?? "2") ?? 0
  let memoryMiB = Int(try option(arguments, "--memory-mib") ?? "4096") ?? 0
  let kernelURL = try safeRegularFile(try requiredOption(arguments, "--kernel"))
  let diskURL = try option(arguments, "--disk").map(safeRegularFile)
  let initrdURL = try option(arguments, "--initrd").map(safeRegularFile)
  return VMInput(
    cpuCount: cpuCount,
    diskURL: diskURL,
    initrdURL: initrdURL,
    kernelURL: kernelURL,
    memoryMiB: memoryMiB,
  )
}

private func validate(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  if #available(macOS 15.0, *) {
    _ = try configuration(for: input)
    json(["valid": true])
    return
  }
  throw VMError.unsupportedHost
}

private func safeConsoleFile(_ rawPath: String) throws -> URL {
  guard rawPath.hasPrefix("/") else { throw VMError.unsafeImage }
  let url = URL(fileURLWithPath: rawPath).standardizedFileURL
  let parent = url.deletingLastPathComponent()
  let resolvedParent = parent.resolvingSymlinksInPath()
  guard resolvedParent.path == parent.path else { throw VMError.unsafeImage }
  var parentMetadata = stat()
  guard lstat(parent.path, &parentMetadata) == 0, (parentMetadata.st_mode & S_IFMT) == S_IFDIR else {
    throw VMError.unsafeImage
  }
  guard parentMetadata.st_uid == getuid(), parentMetadata.st_mode & (S_IWGRP | S_IWOTH) == 0 else {
    throw VMError.unsafeImage
  }
  if !FileManager.default.fileExists(atPath: url.path) {
    let descriptor = open(url.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw VMError.unsafeImage }
    close(descriptor)
  }
  return try safeRegularFile(url.path)
}

private func waitForMainRunLoop(
  _ condition: () -> Bool,
  timeoutSeconds: Int,
) -> Bool {
  let deadline = Date(timeIntervalSinceNow: TimeInterval(timeoutSeconds))
  while !condition(), Date() < deadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
  }
  return condition()
}

@available(macOS 15.0, *)
private func stopMachine(_ machine: VZVirtualMachine) throws {
  guard machine.state != .stopped else { return }
  var didStop = false
  var stopError: Error?
  machine.stop { error in
    stopError = error
    didStop = true
  }
  guard waitForMainRunLoop({ didStop }, timeoutSeconds: 10), stopError == nil else {
    throw stopError ?? VMError.invalidArgument
  }
}

private func smoke(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  let consoleURL = try safeConsoleFile(try requiredOption(arguments, "--console"))
  let timeout = Int(try option(arguments, "--timeout-seconds") ?? "8") ?? 0
  guard (1...30).contains(timeout) else { throw VMError.invalidArgument }
  guard input.initrdURL != nil else { throw VMError.invalidArgument }
  if #available(macOS 15.0, *) {
    let machine = VZVirtualMachine(configuration: try configuration(for: input, consoleURL: consoleURL))
    var didStart = false
    var startError: Error?
    machine.start { result in
      if case let .failure(error) = result { startError = error }
      didStart = true
    }
    guard waitForMainRunLoop({ didStart }, timeoutSeconds: 10), startError == nil else {
      throw startError ?? VMError.invalidArgument
    }
    _ = waitForMainRunLoop({ machine.state == .stopped }, timeoutSeconds: timeout)
    try stopMachine(machine)
    json(["console": consoleURL.path, "smoke": "stopped"])
    return
  }
  throw VMError.unsupportedHost
}

private final class GuestHandshakeResult {
  private var authenticated = false
  private let lock = NSLock()
  private var termination: GuestControlSessionError?

  func recordAuthentication() {
    lock.lock()
    authenticated = true
    lock.unlock()
  }

  func recordTermination(_ reason: GuestControlSessionError) {
    lock.lock()
    termination = reason
    lock.unlock()
  }

  func isComplete() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return authenticated || termination != nil
  }

  func succeeded() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return authenticated
  }

  func isTerminated() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return termination != nil
  }
}

@available(macOS 15.0, *)
private final class GuestEgressBridgeRegistry {
  private var bridges = [UUID: GuestEgressGatewayBridge]()
  private let gatewaySocketPath: String
  private let lock = NSLock()

  init(gatewaySocketPath: String) {
    self.gatewaySocketPath = gatewaySocketPath
  }

  func attach(_ tunnel: GuestEgressTunnel) {
    let id = UUID()
    let bridge = GuestEgressGatewayBridge(
      tunnel: tunnel,
      gatewaySocketPath: gatewaySocketPath,
      onTerminated: { [weak self] in self?.remove(id) },
    )
    lock.lock()
    bridges[id] = bridge
    lock.unlock()
    do {
      try bridge.start()
    } catch {
      bridge.stop()
    }
  }

  func stop() {
    lock.lock()
    let active = bridges.values
    bridges.removeAll()
    lock.unlock()
    for bridge in active {
      bridge.stop()
    }
  }

  private func remove(_ id: UUID) {
    lock.lock()
    bridges.removeValue(forKey: id)
    lock.unlock()
  }
}

private final class SessionStopSignal {
  private let lock = NSLock()
  private var requested = false

  func request() {
    lock.lock()
    requested = true
    lock.unlock()
  }

  func isRequested() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return requested
  }
}

private final class GuestControlResponseRelay {
  private let lock = NSLock()
  private var pipe: GuestControlPipe?

  func attach(_ pipe: GuestControlPipe) {
    lock.lock()
    self.pipe = pipe
    lock.unlock()
  }

  func send(_ response: GuestControlEnvelope) {
    lock.lock()
    let activePipe = pipe
    lock.unlock()
    activePipe?.sendResponse(response)
  }
}

private func bootstrapTokenFromStandardInput(_ arguments: [String]) throws -> String {
  guard arguments.filter({ $0 == "--bootstrap-token-stdin" }).count == 1 else {
    throw VMError.invalidArgument
  }
  var tokenData = Data()
  while tokenData.count < 43 {
    let chunk = FileHandle.standardInput.readData(ofLength: 43 - tokenData.count)
    guard !chunk.isEmpty else { throw VMError.invalidArgument }
    tokenData.append(chunk)
  }
  guard tokenData.count == 43, let token = String(data: tokenData, encoding: .utf8) else {
    throw VMError.invalidArgument
  }
  return token
}

private func handshake(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  let consoleURL = try safeConsoleFile(try requiredOption(arguments, "--console"))
  let timeout = Int(try option(arguments, "--timeout-seconds") ?? "10") ?? 0
  guard (1...30).contains(timeout), input.initrdURL != nil else { throw VMError.invalidArgument }
  let bootstrapToken = try bootstrapTokenFromStandardInput(arguments)
  let guestWorkspaceURL = try option(arguments, "--workspace-cow").map(safeGuestWorkspaceDirectory)
  if #available(macOS 15.0, *) {
    do {
      let outcome = GuestHandshakeResult()
      let machine = VZVirtualMachine(configuration: try configuration(
        for: input,
        consoleURL: consoleURL,
        enableGuestControl: true,
        guestWorkspaceURL: guestWorkspaceURL,
      ))
      let control = try GuestControlListener(
        expectedBootstrapToken: bootstrapToken,
        onAuthenticated: { outcome.recordAuthentication() },
        onResponse: { _ in },
        onTerminated: { reason in outcome.recordTermination(reason) },
      )
      try control.attach(to: machine)
      var didStart = false
      var startError: Error?
      machine.start { result in
        if case let .failure(error) = result { startError = error }
        didStart = true
      }
      guard waitForMainRunLoop({ didStart }, timeoutSeconds: 10), startError == nil else {
        control.invalidate()
        throw VMError.guestHandshake
      }
      let completed = waitForMainRunLoop({ outcome.isComplete() }, timeoutSeconds: timeout)
      control.invalidate()
      try stopMachine(machine)
      guard completed, outcome.succeeded() else { throw VMError.guestHandshake }
      json(["handshake": "verified", "valid": true, "workspaceAttached": guestWorkspaceURL != nil])
      return
    } catch let error as VMError {
      throw error
    } catch {
      throw VMError.guestHandshake
    }
  }
  throw VMError.unsupportedHost
}

private func session(_ arguments: [String]) throws {
  let input = try parseInput(arguments)
  let consoleURL = try safeConsoleFile(try requiredOption(arguments, "--console"))
  let guestWorkspaceURL = try safeGuestWorkspaceDirectory(try requiredOption(arguments, "--workspace-cow"))
  let guestRuntimeURL = try safeGuestRuntimeDirectory(try requiredOption(arguments, "--runtime-bundle"))
  let runtimeManifestDigest = try requiredOption(arguments, "--runtime-manifest-digest")
  let gatewaySocketPath = try option(arguments, "--egress-gateway")
  guard input.initrdURL != nil else { throw VMError.invalidArgument }
  let bootstrapToken = try bootstrapTokenFromStandardInput(arguments)
  if #available(macOS 15.0, *) {
    do {
      let outcome = GuestHandshakeResult()
      let bridges = gatewaySocketPath.map(GuestEgressBridgeRegistry.init)
      let egress = try gatewaySocketPath.map { path in
        try GuestEgressTunnelListener(
          expectedSessionToken: guestEgressToken(fromBootstrapToken: bootstrapToken),
          onAuthenticated: { tunnel in bridges?.attach(tunnel) },
          onTerminated: { _ in },
        )
      }
      let relay = GuestControlResponseRelay()
      let machine = VZVirtualMachine(configuration: try configuration(
        for: input,
        consoleURL: consoleURL,
        enableGuestControl: true,
        enableGuestEgress: gatewaySocketPath != nil,
        guestRuntimeManifestDigest: runtimeManifestDigest,
        guestRuntimeURL: guestRuntimeURL,
        guestWorkspaceURL: guestWorkspaceURL,
      ))
      let control = try GuestControlListener(
        expectedBootstrapToken: bootstrapToken,
        onAuthenticated: {
          do {
            try egress?.activate()
            outcome.recordAuthentication()
          } catch {
            outcome.recordTermination(.unavailable)
          }
        },
        onResponse: { response in relay.send(response) },
        onTerminated: { reason in outcome.recordTermination(reason) },
      )
      try control.attach(to: machine)
      if let egress {
        try egress.attach(to: machine)
      }
      var didStart = false
      var startError: Error?
      machine.start { result in
        if case let .failure(error) = result { startError = error }
        didStart = true
      }
      guard waitForMainRunLoop({ didStart }, timeoutSeconds: 10), startError == nil else {
        control.invalidate()
        egress?.invalidate()
        bridges?.stop()
        throw VMError.guestSession
      }
      let completed = waitForMainRunLoop({ outcome.isComplete() }, timeoutSeconds: 10)
      guard completed, outcome.succeeded() else {
        control.invalidate()
        egress?.invalidate()
        bridges?.stop()
        try stopMachine(machine)
        throw VMError.guestSession
      }
      json(["session": "ready", "valid": true, "workspaceAttached": true])
      let pipe = try GuestControlPipe(
        inputDescriptor: STDIN_FILENO,
        outputDescriptor: STDOUT_FILENO,
        forwardRequest: { payload, requestId in
          _ = try control.sendRequest(payload: payload, requestId: requestId)
        },
        onTerminated: { outcome.recordTermination(.unavailable) },
      )
      relay.attach(pipe)
      try pipe.start()

      signal(SIGINT, SIG_IGN)
      signal(SIGTERM, SIG_IGN)
      let stop = SessionStopSignal()
      let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
      let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
      interrupt.setEventHandler { stop.request() }
      terminate.setEventHandler { stop.request() }
      interrupt.resume()
      terminate.resume()
      while !stop.isRequested(), !outcome.isTerminated() {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
      }
      interrupt.cancel()
      terminate.cancel()
      pipe.stop()
      let failed = outcome.isTerminated() && !stop.isRequested()
      control.invalidate()
      egress?.invalidate()
      bridges?.stop()
      try stopMachine(machine)
      if failed { throw VMError.guestSession }
      return
    } catch let error as VMError {
      throw error
    } catch {
      throw VMError.guestSession
    }
  }
  throw VMError.unsupportedHost
}

private func run() -> Int32 {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard let command = arguments.first else { usage() }
  do {
    switch command {
    case "probe":
      guard arguments.count == 1 else { usage() }
      let result = hostProbe()
      json(["architecture": result.architecture, "supported": result.supported])
    case "validate":
      try validate(Array(arguments.dropFirst()))
    case "smoke":
      try smoke(Array(arguments.dropFirst()))
    case "handshake":
      try handshake(Array(arguments.dropFirst()))
    case "session":
      try session(Array(arguments.dropFirst()))
    default:
      usage()
    }
    return 0
  } catch VMError.unsupportedHost {
    json(["code": "EXECUTOR_VM_UNSUPPORTED_HOST", "valid": false])
    return 1
  } catch VMError.unsafeImage {
    json(["code": "EXECUTOR_VM_UNSAFE_IMAGE", "valid": false])
    return 1
  } catch VMError.guestHandshake {
    json(["code": "EXECUTOR_VM_GUEST_HANDSHAKE_FAILED", "valid": false])
    return 1
  } catch VMError.guestSession {
    json(["code": "EXECUTOR_VM_GUEST_SESSION_FAILED", "valid": false])
    return 1
  } catch {
    fputs("nessie-executor-vm local failure: \((error as NSError).localizedDescription)\n", stderr)
    json(["code": "EXECUTOR_VM_CONFIGURATION_INVALID", "valid": false])
    return 1
  }
}

exit(run())
