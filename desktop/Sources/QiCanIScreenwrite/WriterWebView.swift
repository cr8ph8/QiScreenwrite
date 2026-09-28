import AppKit
import WebKit
import UniformTypeIdentifiers

@MainActor final class WriterWebView: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    let view: WKWebView
    var origin: URL?
    var onStatus: ((String) -> Void)?
    var onReady: (() -> Void)?
    var onRestoreSession: (() async throws -> Void)?
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var activeSavePanel: NSSavePanel?
    private var activeSaveDownloadID: ObjectIdentifier?
    private var activeQiMoviPanel: NSOpenPanel?
    private var qiMoviScopedURL: URL?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "writerSession")
        view.navigationDelegate = self; view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        view.underPageBackgroundColor = NSColor(calibratedRed: 0.035, green: 0.043, blue: 0.052, alpha: 1)
    }

    deinit { qiMoviScopedURL?.stopAccessingSecurityScopedResource() }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Named actions from our own main frame; never accept a URL, token,
        // filesystem path, or instruction from web content.
        guard message.name == "writerSession", message.frameInfo.isMainFrame,
              message.webView === view, let frameURL = message.frameInfo.request.url,
              isLocal(frameURL), let pageURL = view.url, isLocal(pageURL),
              let body = message.body as? [String: String], body.count == 1,
              let action = body["action"], ["restore", "authorize-qimovi"].contains(action) else {
            replyHandler(nil, "Local session restoration is unavailable for this page."); return
        }
        if action == "authorize-qimovi" {
            authorizeQiMovi(replyHandler: replyHandler); return
        }
        guard let onRestoreSession else {
            replyHandler(nil, "Local session restoration is unavailable for this page."); return
        }
        Task {
            do {
                try await onRestoreSession()
                _ = try await view.evaluateJavaScript("window.dispatchEvent(new Event('writer:session-restored'))")
                replyHandler(true, nil)
            }
            catch { replyHandler(nil, "Access could not be restored. Keep this window open and check the local connection.") }
        }
    }

    private func selectedQiMoviWorkspace() -> URL? {
        // Read this single supported preference key. Do not open the other
        // app's plist, config, database, or private owner token from WebKit.
        guard let selected = UserDefaults(suiteName: "com.hampton.qimovieslate.local")?.string(forKey: "workspacePath"),
              selected.hasPrefix("/"), selected != "/",
              !selected.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        let url = URL(fileURLWithPath: selected, isDirectory: true)
        guard url.path != "/", url.path == selected else { return nil }
        return url
    }

    private func authorizeQiMovi(replyHandler: @escaping (Any?, String?) -> Void) {
        guard activeQiMoviPanel == nil, let window = view.window, window.attachedSheet == nil else {
            replyHandler(nil, "Finish or cancel the open dialog, then choose the QiMovi project folder again."); return
        }
        guard let expected = selectedQiMoviWorkspace() else {
            replyHandler(nil, "Open the intended project in QiMovi first, then choose its project folder here."); return
        }
        let panel = NSOpenPanel()
        panel.title = "Allow access to the selected QiMovi project"
        panel.message = "Choose the project folder currently open in QiMovi so this Mac can connect it to the writer."
        panel.prompt = "Allow Access"
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.canCreateDirectories = false
        panel.directoryURL = expected
        activeQiMoviPanel = panel
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { replyHandler(nil, "The writing window closed before access was granted."); return }
            if self.activeQiMoviPanel === panel { self.activeQiMoviPanel = nil }
            guard response == .OK, let selected = panel.url else {
                replyHandler(false, nil); return
            }
            // User selection authorizes filesystem access. Start a supplied
            // scope before checking canonical paths; unsandboxed URLs may not
            // supply one, which does not itself mean access was denied.
            let scoped = selected.startAccessingSecurityScopedResource()
            let canonical = selected.standardizedFileURL.resolvingSymlinksInPath()
            let expectedCanonical = expected.standardizedFileURL.resolvingSymlinksInPath()
            guard let current = self.selectedQiMoviWorkspace(), current.path == expected.path,
                  expectedCanonical.path == expected.path,
                  canonical.path == expectedCanonical.path,
                  current.standardizedFileURL.resolvingSymlinksInPath().path == expectedCanonical.path else {
                if scoped { selected.stopAccessingSecurityScopedResource() }
                replyHandler(nil, "Choose the exact project folder currently selected in QiMovi. If the project changed, try again."); return
            }
            // Keep the granted scope for subsequent bounded discovery children.
            // An unsuccessful/cancelled selection never replaces prior access.
            let previous = self.qiMoviScopedURL
            self.qiMoviScopedURL = scoped ? selected : nil
            previous?.stopAccessingSecurityScopedResource()
            replyHandler(true, nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) || (url.scheme == "blob" && url.absoluteString.hasPrefix("blob:\(origin?.absoluteString ?? "invalid")/")) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && url.scheme == "https" { NSWorkspace.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onStatus?("Local workspace · Saved work stays on this Mac"); onReady?() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onStatus?("Connection interrupted. Saved work remains on disk; use Reconnect.") }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let frameURL = frame.request.url, isLocal(frameURL) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard activeSavePanel == nil, let window = view.window, window.attachedSheet == nil else {
            onStatus?("Finish or cancel the open dialog before requesting another export.")
            completionHandler(nil); return
        }
        let panel = NSSavePanel(); panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        activeSavePanel = panel; activeSaveDownloadID = ObjectIdentifier(download)
        onStatus?("Choose where to save the export.")
        panel.beginSheetModal(for: window) { [weak self] result in
            if self?.activeSavePanel === panel {
                self?.activeSavePanel = nil; self?.activeSaveDownloadID = nil
            }
            guard result == .OK, let url = panel.url else {
                self?.onStatus?("Save cancelled. Your saved project remains on disk.")
                completionHandler(nil); return
            }
            // WKDownload writes a new file only; never silently replace an existing export.
            guard !FileManager.default.fileExists(atPath: url.path) else {
                self?.onStatus?("Choose a new filename to preserve the existing export."); completionHandler(nil); return
            }
            self?.destinations[ObjectIdentifier(download)] = url; completionHandler(url)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let url = destinations.removeValue(forKey: ObjectIdentifier(download)) { onStatus?("Saved \(url.lastPathComponent)") }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let id = ObjectIdentifier(download)
        if activeSaveDownloadID == id { activeSavePanel?.cancel(nil) }
        destinations.removeValue(forKey: id)
        if (error as NSError).code == NSURLErrorCancelled {
            // A rejected duplicate must not replace the active sheet's status.
            if activeSavePanel == nil { onStatus?("Save cancelled. Your saved project remains on disk.") }
        } else { onStatus?("Export did not finish. Retry from the saved draft.") }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(isLocal) == true ? .allow : .cancel)
    }
}
