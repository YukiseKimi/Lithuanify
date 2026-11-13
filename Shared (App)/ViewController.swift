//
//  ViewController.swift
//  Shared (App)
//
//  Created by yukisekimi on 2026-06-09.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "mannychau.Lithuanify.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        Task {
            guard let state = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionBundleIdentifier) else {
                return
            }
            let useSettings: Bool
            if #available(macOS 13, *) {
                useSettings = true
            } else {
                useSettings = false
            }
            webView.evaluateJavaScript("show('mac', \(state.isEnabled), \(useSettings))", completionHandler: nil)
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        guard message.body as? String == "open-preferences" else {
            return
        }

        Task {
            do {
                try await SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier)
                NSApp.terminate(self)
            } catch {
                webView.evaluateJavaScript("showOpenError()", completionHandler: nil)
            }
        }
#endif
    }

}
