/// Independent reasons the app must start no team or transient runtime reads.
public struct ComputerRuntimeHolds {
    public var update = false
    public private(set) var personalSignIn = false
    public init() {}
    public var held: Bool { update || personalSignIn }
    public mutating func beginPersonalSignIn() -> Bool {
        guard !held else { return false }
        personalSignIn = true
        return true
    }
    public mutating func endPersonalSignIn() { personalSignIn = false }
}
