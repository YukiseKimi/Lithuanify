import SafariServices
import SwiftUI

enum SafariExtension {
    static let identifier = "mannychau.Lithuanify.Extension"
    static let canOpenSettings = true
    static let openSettingsStep = LocalizedStringResource.setupMacOpenSettings

    static func isOn() async -> Bool? {
        try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: identifier).isEnabled
    }

    static func openSettings() async -> Bool {
        do {
            try await SFSafariApplication.showPreferencesForExtension(withIdentifier: identifier)
            return true
        } catch {
            return false
        }
    }
}
