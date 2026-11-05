// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "NessieExecutorVM",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "nessie-executor-vm", targets: ["NessieExecutorVM"]),
  ],
  targets: [
    .target(name: "NessieExecutorVMCore"),
    .executableTarget(
      name: "NessieExecutorVM",
      dependencies: ["NessieExecutorVMCore"],
    ),
    .testTarget(
      name: "NessieExecutorVMCoreTests",
      dependencies: ["NessieExecutorVMCore"],
    ),
  ],
)
