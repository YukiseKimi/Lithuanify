import SwiftUI

enum SafariExtension {
    static let canOpenSettings = false
    static let openSettingsStep = LocalizedStringResource.setupPhoneOpenSettings

    static func isOn() async -> Bool? { nil }

    static func openSettings() async -> Bool { false }
}
