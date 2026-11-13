import FoundationModels

public enum AIStatus: Equatable, Sendable {
    case ready
    case turnedOff
    case downloading
    case notSupported

    public init(_ availability: SystemLanguageModel.Availability) {
        switch availability {
        case .available: self = .ready
        case .unavailable(.appleIntelligenceNotEnabled): self = .turnedOff
        case .unavailable(.modelNotReady): self = .downloading
        case .unavailable: self = .notSupported
        }
    }

    public static var current: AIStatus {
        AIStatus(SystemLanguageModel.default.availability)
    }
}
