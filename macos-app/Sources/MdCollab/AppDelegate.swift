import AppKit

/// Adresse proposée par défaut : celle fixée à la compilation (YARICHE_SERVER_URL,
/// voir build-app.sh), sinon un serveur local.
let embeddedServerURL = Bundle.main.object(forInfoDictionaryKey: "YaricheServerURL") as? String
let defaultServerURL = embeddedServerURL ?? "http://localhost:5174"

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: MainWindowController?
    private var urlsBeforeLaunch: [URL] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = buildMainMenu()
        let controller = MainWindowController()
        windowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        urlsBeforeLaunch.forEach(controller.handleLoginCallback)
        urlsBeforeLaunch = []
        // Premier lancement sans adresse connue : on la demande tout de suite
        if UserDefaults.standard.string(forKey: "serverURL") == nil && embeddedServerURL == nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { controller.showServerSettings() }
        }
    }

    // Retour de la connexion faite dans le navigateur (lien yariche://auth?code=…)
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let controller = windowController else {
            urlsBeforeLaunch += urls
            return
        }
        urls.forEach(controller.handleLoginCallback)
    }

    // Clic sur l'icône du Dock quand la fenêtre est fermée : on la rouvre
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { windowController?.showWindow(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // Mode local : le serveur embarqué s'arrête avec l'app
    func applicationWillTerminate(_ notification: Notification) {
        windowController?.stopLocalServer()
    }

    // MARK: - Actions de menu

    @objc func showServerSettings(_ sender: Any?) { windowController?.showServerSettings() }
    @objc func showWorkLocation(_ sender: Any?) { windowController?.showWorkLocation() }
    @objc func changeLocalVaultFolder(_ sender: Any?) { windowController?.changeLocalVaultFolder() }
    @objc func reloadPage(_ sender: Any?) { windowController?.reload() }
    @objc func goBackPage(_ sender: Any?) { windowController?.webView.goBack() }
    @objc func goForwardPage(_ sender: Any?) { windowController?.webView.goForward() }
    @objc func zoomInPage(_ sender: Any?) { windowController?.changePageZoom(by: 0.1) }
    @objc func zoomOutPage(_ sender: Any?) { windowController?.changePageZoom(by: -0.1) }
    @objc func resetPageZoom(_ sender: Any?) { windowController?.resetPageZoom() }

    // MARK: - Menus (sans menu Édition, ⌘C/⌘V/⌘Z ne sont pas routés vers la WebView)

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Yariche")
        appMenu.addItem(withTitle: "À propos de Yariche", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "Adresse du serveur…", action: #selector(showServerSettings(_:)), keyEquivalent: ",")
        settings.target = self
        let workLocation = appMenu.addItem(withTitle: "Où travailler (serveur ou ce Mac)…", action: #selector(showWorkLocation(_:)), keyEquivalent: "")
        workLocation.target = self
        let localVault = appMenu.addItem(withTitle: "Dossier du coffre sur ce Mac…", action: #selector(changeLocalVaultFolder(_:)), keyEquivalent: "")
        localVault.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Masquer Yariche", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Masquer les autres", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Tout afficher", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quitter Yariche", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Édition")
        editMenu.addItem(withTitle: "Annuler", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Rétablir", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Couper", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copier", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Coller", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let plain = editMenu.addItem(withTitle: "Coller sans mise en forme", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        plain.keyEquivalentModifierMask = [.command, .option, .shift]
        editMenu.addItem(withTitle: "Tout sélectionner", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "Présentation")
        let reload = viewMenu.addItem(withTitle: "Recharger", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        let back = viewMenu.addItem(withTitle: "Précédent", action: #selector(goBackPage(_:)), keyEquivalent: "[")
        back.target = self
        let forward = viewMenu.addItem(withTitle: "Suivant", action: #selector(goForwardPage(_:)), keyEquivalent: "]")
        forward.target = self
        viewMenu.addItem(.separator())
        // ⌥ en plus : ⌘+ / ⌘- / ⌘0 restent au canevas (zoom du whiteboard)
        let zoomIn = viewMenu.addItem(withTitle: "Agrandir le texte", action: #selector(zoomInPage(_:)), keyEquivalent: "+")
        zoomIn.keyEquivalentModifierMask = [.command, .option]
        zoomIn.target = self
        let zoomOut = viewMenu.addItem(withTitle: "Réduire le texte", action: #selector(zoomOutPage(_:)), keyEquivalent: "-")
        zoomOut.keyEquivalentModifierMask = [.command, .option]
        zoomOut.target = self
        let zoomReset = viewMenu.addItem(withTitle: "Taille réelle", action: #selector(resetPageZoom(_:)), keyEquivalent: "0")
        zoomReset.keyEquivalentModifierMask = [.command, .option]
        zoomReset.target = self
        viewMenu.addItem(.separator())
        let fullscreen = viewMenu.addItem(withTitle: "Plein écran", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Fenêtre")
        windowMenu.addItem(withTitle: "Réduire", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Tout ramener au premier plan", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        return main
    }
}
