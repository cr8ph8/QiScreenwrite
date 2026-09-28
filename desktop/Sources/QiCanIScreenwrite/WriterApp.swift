import AppKit
import WebKit

@main struct WriterMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = WriterAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor final class WriterAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let web = WriterWebView()
    private let service = LocalService()
    private let status = NSTextField(labelWithString: "Opening your local writing workspace…")
    private var workspace: URL!
    private var quitting = false
    private var pendingFiles: [URL] = []
    private var pageReady = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--workspace"), i + 1 < args.count {
            workspace = URL(fileURLWithPath: args[i + 1], isDirectory: true)
        } else {
            workspace = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("QiCanIScreenwrite/Workspace", isDirectory: true)
        }
        menus()
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: min(1500, screen.width - 60), height: min(960, screen.height - 60)),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "QiCanIScreenwrite"
        window.subtitle = "Local writing studio"
        window.minSize = NSSize(width: 1000, height: 680)
        window.isReleasedWhenClosed = false; window.delegate = self
        window.setFrameAutosaveName("QiCanIScreenwriteMain")
        let stack = NSStackView(views: [web.view, status])
        stack.orientation = .vertical; stack.spacing = 0; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        web.view.translatesAutoresizingMaskIntoConstraints = false
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingMiddle
        let root = NSView(); window.contentView = root; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor), stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: root.topAnchor), stack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            web.view.widthAnchor.constraint(equalTo: stack.widthAnchor), status.heightAnchor.constraint(equalToConstant: 24)
        ])
        web.onStatus = { [weak self] text in self?.status.stringValue = "  " + text }
        web.onReady = { [weak self] in self?.pageReady = true; self?.deliverPendingFiles() }
        web.onRestoreSession = { [weak self] in
            guard let self else { return }
            _ = try await self.service.authenticate(workspace: self.workspace, cookies: self.web.view.configuration.websiteDataStore.httpCookieStore)
        }
        service.onReady = { [weak self] _ in self?.openSession() }
        service.onFailure = { [weak self] message in self?.status.stringValue = message; self?.showFailure(message) }
        service.onStopped = { [weak self] in if self?.quitting == true { NSApp.reply(toApplicationShouldTerminate: true) } }
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        Task { do { try await service.start(workspace: workspace) } catch { showFailure(error.localizedDescription) } }
    }

    private func menus() {
        let menu = NSMenu()
        func add(_ title: String) -> NSMenu {
            let item = NSMenuItem(); let child = NSMenu(title: title); item.submenu = child; menu.addItem(item); return child
        }
        func command(_ menu: NSMenu, _ title: String, _ key: String, _ name: String, shift: Bool = false) {
            let item = NSMenuItem(title: title, action: #selector(runCommand(_:)), keyEquivalent: key)
            item.target = self; item.representedObject = name
            if shift { item.keyEquivalentModifierMask = [.command, .shift] }
            menu.addItem(item)
        }
        let app = add("QiCanIScreenwrite")
        let about = app.addItem(withTitle: "About QiCanIScreenwrite", action: #selector(aboutApp), keyEquivalent: ""); about.target = self
        app.addItem(.separator())
        app.addItem(withTitle: "Hide QiCanIScreenwrite", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit QiCanIScreenwrite", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = add("File")
        command(file, "New Screenplay", "n", "new")
        command(file, "Import Screenplay…", "o", "import")
        command(file, "Save Draft", "s", "save")
        file.addItem(.separator())
        command(file, "Export PDF…", "e", "export-pdf")
        command(file, "Back Up Saved Workspace…", "", "backup")
        let reveal = file.addItem(withTitle: "Show Workspace in Finder", action: #selector(revealWorkspace), keyEquivalent: ""); reveal.target = self
        file.addItem(.separator()); file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = add("Edit")
        command(edit, "Undo", "z", "undo")
        command(edit, "Redo", "z", "redo", shift: true)
        for (title, action, key) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: action, keyEquivalent: key) }
        command(edit, "Find and Replace…", "f", "find")
        let view = add("View")
        command(view, "My Drafts", "l", "library", shift: true)
        command(view, "Knowledge", "", "knowledge")
        command(view, "Connections", "", "connections")
        command(view, "Rights & Collaborators", "", "rights")
        command(view, "Preservation", "", "preservation")
        view.addItem(.separator())
        let reconnect = view.addItem(withTitle: "Reconnect to Workspace", action: #selector(reconnect), keyEquivalent: "r"); reconnect.target = self
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "")
        let help = add("Help")
        let guide = help.addItem(withTitle: "QiCanIScreenwrite Desktop Guide", action: #selector(openGuide), keyEquivalent: ""); guide.target = self
        NSApp.mainMenu = menu
    }

    @objc private func runCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if name == "undo" || name == "redo" {
            routeUndoRedo(name, sender: sender); return
        }
        web.view.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('writer:command', {detail: command}));", arguments: ["command": name], in: nil, in: .page) { _ in }
    }

    private func routeUndoRedo(_ command: String, sender: NSMenuItem) {
        // A native sheet or another window may own focus while the page still
        // remembers its last active element. Let that responder handle editing.
        guard let keyWindow = NSApp.keyWindow, keyWindow === web.view.window,
              let responder = keyWindow.firstResponder as? NSView,
              responder === web.view || responder.isDescendant(of: web.view) else {
            nativeUndoRedo(command, sender: sender); return
        }
        // Check and dispatch together so a second asynchronous call cannot undo
        // the screenplay after focus has moved into a different text field.
        web.view.evaluateJavaScript("""
            (() => {
              const focused = document.activeElement;
              if (!(focused instanceof Element)) return false;
              const surface = focused.closest('.screenplay-writing-surface');
              if (!surface || focused.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
              if (!surface.getClientRects().length || !focused.getClientRects().length ||
                  getComputedStyle(focused).visibility !== 'visible') return false;
              window.dispatchEvent(new CustomEvent('writer:command', {detail: '\(command)'}));
              return true;
            })()
            """) { [weak self] result, error in
                if error != nil || result as? Bool != true {
                    self?.nativeUndoRedo(command, sender: sender)
                }
            }
    }

    private func nativeUndoRedo(_ command: String, sender: NSMenuItem) {
        // Send the standard selectors through the responder chain, including
        // WKWebView's focused text control. These cannot recurse into runCommand.
        NSApp.sendAction(NSSelectorFromString(command == "undo" ? "undo:" : "redo:"), to: nil, from: sender)
    }
    @objc private func revealWorkspace() { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: workspace.path) }
    @objc private func openGuide() {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("Desktop Guide.md") { NSWorkspace.shared.open(url) }
    }
    @objc private func aboutApp() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "QiCanIScreenwrite", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development", .credits: NSAttributedString(string: "Local writing, development, revisions and screenplay exports.\nOptional QiMovi and competition connections.")])
    }
    private func showFailure(_ message: String) {
        let alert = NSAlert(); alert.messageText = "The writing workspace could not open"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window)
    }
    private func openSession() {
        Task {
            do {
                let origin = try await service.authenticate(workspace: workspace, cookies: web.view.configuration.websiteDataStore.httpCookieStore)
                if web.origin == origin, pageReady {
                    // The restarted service deliberately reuses its old port.
                    // Keep the active page and all unsaved edits in place.
                    _ = try await web.view.evaluateJavaScript("window.dispatchEvent(new Event('writer:session-restored'))")
                    status.stringValue = "  Local workspace reconnected · Your edits are still open"
                    return
                }
                web.origin = origin; pageReady = false
                web.view.load(URLRequest(url: origin.appendingPathComponent("local.html")))
            } catch { showFailure(error.localizedDescription) }
        }
    }
    @objc private func reconnect() {
        guard service.process == nil else {
            Task {
                do { _ = try await service.authenticate(workspace: workspace, cookies: web.view.configuration.websiteDataStore.httpCookieStore)
                    _ = try await web.view.evaluateJavaScript("window.dispatchEvent(new Event('writer:session-restored'))")
                    status.stringValue = "  Local session restored"
                } catch { showFailure(error.localizedDescription) }
            }; return
        }
        Task { do { try await service.start(workspace: workspace) } catch { showFailure(error.localizedDescription) } }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        pendingFiles.append(contentsOf: filenames.map { URL(fileURLWithPath: $0) })
        deliverPendingFiles(); sender.reply(toOpenOrPrint: .success)
    }
    private func deliverPendingFiles() {
        guard pageReady, let url = pendingFiles.first else { return }
        pendingFiles.removeFirst()
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 4_000_000,
                  ["fountain", "fdx", "txt"].contains(url.pathExtension.lowercased()) else { throw LocalFailure(message: "Import a Fountain, FDX or text file up to 4 MB.") }
            let text = try String(contentsOf: url, encoding: .utf8)
            web.view.callAsyncJavaScript("if (!window.__localWriterReady) await new Promise(resolve => window.addEventListener('writer:ready', resolve, {once:true})); window.dispatchEvent(new CustomEvent('writer:import-file',{detail:{name:name,text:text}}));", arguments: ["name": url.lastPathComponent, "text": text], in: nil, in: .page) { _ in }
        } catch { showFailure(error.localizedDescription) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return service.process == nil ? .terminateNow : .terminateLater }
        web.view.evaluateJavaScript("Boolean(window.__localWriterDirty || document.querySelector('[data-development-dirty=\"true\"], [data-rights-dirty=\"true\"]'))") { [weak self] result, _ in
            guard let self else { sender.reply(toApplicationShouldTerminate: true); return }
            if result as? Bool == true {
                let alert = NSAlert(); alert.messageText = "Keep writing or close with unsaved changes?"
                alert.informativeText = "Save the draft to keep an explicit revision. Recovery copies are retained separately."
                alert.addButton(withTitle: "Keep Writing"); alert.addButton(withTitle: "Quit")
                if alert.runModal() != .alertSecondButtonReturn { sender.reply(toApplicationShouldTerminate: false); return }
            }
            // Flush the last keystrokes before stopping the service, including
            // edits still inside the editor's short recovery debounce.
            self.web.view.callAsyncJavaScript("""
                await Promise.race([
                  Promise.all([window.__flushWriterRecovery?.(), window.__flushDevelopmentRecovery?.(), window.__flushRightsRecovery?.()]),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('Recovery timed out')), 8000))
                ]);
                return true;
                """, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success:
                    self.quitting = true
                    if self.service.process == nil { sender.reply(toApplicationShouldTerminate: true) }
                    else { self.service.stop() }
                case .failure:
                    sender.reply(toApplicationShouldTerminate: false)
                    let alert = NSAlert(); alert.messageText = "Your recovery copy has not finished saving"
                    alert.informativeText = "The app is still open. Save or export your changes, or reconnect to the workspace, before quitting."
                    alert.addButton(withTitle: "Keep Writing"); alert.beginSheetModal(for: self.window)
                }
            }
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) { service.stop() }
}
