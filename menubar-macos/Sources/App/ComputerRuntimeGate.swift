/// One app-wide gate for update adoption and the personal OAuth handoff.
@MainActor
enum ComputerRuntimeGate {
    static var holds = ComputerRuntimeHolds()
    static var held: Bool { holds.held }
}
