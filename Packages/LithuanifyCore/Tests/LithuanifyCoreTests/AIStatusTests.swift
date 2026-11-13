import FoundationModels
import LithuanifyCore
import Testing

struct AIStatusTests {
    @Test(arguments: [
        (SystemLanguageModel.Availability.available, AIStatus.ready),
        (.unavailable(.appleIntelligenceNotEnabled), .turnedOff),
        (.unavailable(.modelNotReady), .downloading),
        (.unavailable(.deviceNotEligible), .notSupported)
    ])
    func eachAvailabilityGivesItsStatus(availability: SystemLanguageModel.Availability, expected: AIStatus) {
        #expect(AIStatus(availability) == expected)
    }
}
