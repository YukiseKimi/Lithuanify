import LithuanifyCore
import SwiftUI

struct SetupView: View {
    @State private var status = SetupStatus()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                statusList
                steps
                if SafariExtension.canOpenSettings {
                    Button(.buttonOpenSafariSettings) {
                        Task { await status.openSafariSettings() }
                    }
                    .buttonStyle(.borderedProminent)
                    if status.openFailed {
                        Text(.setupOpenSettingsFailed)
                            .foregroundStyle(.red)
                    }
                }
                Text(.setupCredits)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await status.refresh() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(.setupTitle)
                .font(.largeTitle.bold())
            Text(.setupTagline)
                .foregroundStyle(.secondary)
        }
    }

    private var statusList: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let on = status.extensionOn {
                StatusRow(
                    title: on ? .statusExtensionOn : .statusExtensionOff,
                    fix: on ? nil : .statusExtensionOffFix,
                    ok: on
                )
            }
            StatusRow(title: status.model.title, fix: status.model.fix, ok: status.model == .ready)
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(.setupHeading)
                .font(.headline)
            Label { Text(SafariExtension.openSettingsStep) } icon: { Image(systemName: "1.circle") }
            Label { Text(.setupTurnOn) } icon: { Image(systemName: "2.circle") }
            Label { Text(.setupAllowWebsites) } icon: { Image(systemName: "3.circle") }
        }
    }
}

private struct StatusRow: View {
    let title: LocalizedStringResource
    let fix: LocalizedStringResource?
    let ok: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label {
                Text(title).bold()
            } icon: {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(ok ? .green : .orange)
            }
            if let fix {
                Text(fix)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private extension AIStatus {
    var title: LocalizedStringResource {
        switch self {
        case .ready: .statusModelReady
        case .turnedOff: .statusModelOff
        case .downloading: .statusModelDownloading
        case .notSupported: .statusModelNotSupported
        }
    }

    var fix: LocalizedStringResource? {
        switch self {
        case .ready: nil
        case .turnedOff: .statusModelOffFix
        case .downloading: .statusModelDownloadingFix
        case .notSupported: .statusModelNotSupportedFix
        }
    }
}

#Preview {
    SetupView()
}
