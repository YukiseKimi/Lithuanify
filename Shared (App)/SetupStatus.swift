import LithuanifyCore
import Observation

@MainActor
@Observable
final class SetupStatus {
    var model = AIStatus.current
    var extensionOn: Bool?
    var openFailed = false

    func refresh() async {
        model = .current
        extensionOn = await SafariExtension.isOn()
    }

    func openSafariSettings() async {
        openFailed = await !SafariExtension.openSettings()
    }
}
