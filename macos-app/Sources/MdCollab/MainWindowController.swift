import AppKit
import CryptoKit
import WebKit

/// Hauteur de la barre du haut de l'app web (topbar / haut de la sidebar) :
/// les boutons de fenêtre (feux) y sont centrés verticalement.
private let barHeight: CGFloat = 52
private let darkBackground = NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 20 / 255, alpha: 1)

/// WKWebView qui laisse déplacer la fenêtre depuis les zones vides des barres
/// de l'app (la page envoie leurs rectangles), comme une vraie barre de titre.
final class YaricheWebView: WKWebView {
    var dragRegions: [CGRect] = []
    var noDragRegions: [CGRect] = []

    // Jamais de déplacement implicite : c'est mouseDown qui décide
    override var mouseDownCanMoveWindow: Bool { false }

    private func pagePoint(for event: NSEvent) -> CGPoint {
        let local = convert(event.locationInWindow, from: nil)
        let y = isFlipped ? local.y : bounds.height - local.y
        let zoom = max(pageZoom, 0.1)
        return CGPoint(x: local.x / zoom, y: y / zoom)
    }

    func isDragRegion(_ event: NSEvent) -> Bool {
        let p = pagePoint(for: event)
        return dragRegions.contains { $0.contains(p) } && !noDragRegions.contains { $0.contains(p) }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window, isDragRegion(event) else { return super.mouseDown(with: event) }
        if event.clickCount == 2 {
            // Respecte Réglages > Bureau et Dock > « Double-cliquer sur la barre de titre »
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize" {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }
        window.performDrag(with: event)
    }
}

/// Évite le cycle de rétention WKUserContentController -> handler -> contrôleur
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

final class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, WKDownloadDelegate
{
    let webView: YaricheWebView
    private var titleObservation: NSKeyValueObservation?
    /// Connexion en cours dans le navigateur : secret gardé en mémoire jusqu'au retour
    private var pendingLogin: (verifier: String, started: Date)?
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var showingErrorPage = false

    /// Serveur Yariche distant (adresse réglée, ou fixée à la compilation)
    var remoteServerURL: URL {
        let raw = UserDefaults.standard.string(forKey: "serverURL") ?? defaultServerURL
        return URL(string: raw) ?? URL(string: defaultServerURL)!
    }
    /// Mode local : serveur embarqué, sur un dossier du Mac
    private var localServer: LocalServer?
    private var workMode: String { UserDefaults.standard.string(forKey: "workMode") ?? "server" }
    private var localWorkFolder: String? { UserDefaults.standard.string(forKey: "localWorkFolder") }
    /// Serveur affiché : le serveur local s'il tourne, sinon le serveur distant
    var serverURL: URL { localServer?.baseURL ?? remoteServerURL }

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "YaricheMac/1.6"
        let contentController = WKUserContentController()
        // La page sait qu'elle tourne dans l'app (marges pour les feux, pont natif)
        contentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('macapp');",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = contentController
        webView = YaricheWebView(frame: .zero, configuration: config)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)

        contentController.add(WeakScriptHandler(self), name: "yariche")

        window.title = "Yariche"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 900, height: 600)
        window.delegate = self
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("YaricheMainWindow")
        window.tabbingMode = .disallowed

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // Pas de fond blanc pendant le chargement ni au rebond du défilement
        webView.setValue(false, forKey: "drawsBackground")
        applyTheme(dark: UserDefaults.standard.object(forKey: "lastThemeDark") as? Bool ?? true)

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] webView, _ in
            if let title = webView.title, !title.isEmpty { self?.window?.title = title }
        }

        loadServer()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) non utilisé") }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        layoutTrafficLights()
    }

    // MARK: - Chargement

    func loadServer() {
        showingErrorPage = false
        if workMode == "local" { return startLocalMode() }
        stopLocalServer()
        webView.load(URLRequest(url: remoteServerURL))
    }

    // MARK: - Mode local (serveur dans l'app, sur un dossier du Mac)

    private func startLocalMode() {
        guard let path = localWorkFolder else { return showWorkLocation() }
        let dir = URL(fileURLWithPath: path, isDirectory: true)
        if let running = localServer, running.vaultDir.path == dir.path {
            webView.load(URLRequest(url: running.loginURL))
            return
        }
        stopLocalServer()
        let server = LocalServer(vaultDir: dir)
        server.onUnexpectedExit = { [weak self] message in
            self?.localServer = nil
            self?.showErrorPage(message: message)
        }
        localServer = server
        showLocalPage(body: "\(logoSVG)<h1>Ouverture de « \(escapeHTML(dir.lastPathComponent)) »…</h1><p>Yariche démarre sur ce Mac.</p>")
        server.start { [weak self] error in
            guard let self else { return }
            if let error {
                server.stop()
                self.localServer = nil
                self.showErrorPage(message: error)
                return
            }
            self.webView.load(URLRequest(url: server.loginURL))
        }
    }

    func stopLocalServer() {
        localServer?.stop()
        localServer = nil
    }

    /// Menu Yariche → « Où travailler… » : sur le serveur, ou sur ce Mac (dossier local)
    func showWorkLocation() {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Où travailler ?"
        let current = workMode == "local"
            ? "sur ce Mac (\(localWorkFolder.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "aucun dossier"))"
            : "sur le serveur \(remoteServerURL.host ?? remoteServerURL.absoluteString)"
        alert.informativeText = "Actuellement : \(current).\n\n"
            + "Sur ce Mac : Yariche tourne dans l'app et écrit directement dans un dossier du Mac, "
            + "par exemple ton dossier Nextcloud (qui synchronise ensuite). Marche hors connexion ; "
            + "commentaires, partages et historique sont propres à ce Mac.\n\n"
            + "Sur le serveur : édition à plusieurs, liens de partage, accès depuis partout."
        alert.addButton(withTitle: "Sur ce Mac…")
        alert.addButton(withTitle: "Sur le serveur")
        alert.addButton(withTitle: "Annuler")
        if !LocalServer.isBundled {
            alert.buttons[0].isEnabled = false
            alert.informativeText += "\n\n(Cette version de l'app n'embarque pas le serveur local.)"
        }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            switch response {
            case .alertFirstButtonReturn:
                DispatchQueue.main.async { self.chooseLocalWorkFolder() }
            case .alertSecondButtonReturn:
                UserDefaults.standard.set("server", forKey: "workMode")
                self.loadServer()
            default:
                break
            }
        }
    }

    private func chooseLocalWorkFolder() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Travailler ici"
        panel.message = "Dossier de notes sur ce Mac (par exemple ton dossier Nextcloud « Cours »)"
        if let current = localWorkFolder {
            panel.directoryURL = URL(fileURLWithPath: current, isDirectory: true)
        } else {
            let cloud = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/CloudStorage")
            let nextcloud = (try? FileManager.default.contentsOfDirectory(atPath: cloud.path))?.sorted().first { $0.hasPrefix("Nextcloud-") }
            panel.directoryURL = nextcloud.map { cloud.appendingPathComponent($0) } ?? FileManager.default.homeDirectoryForCurrentUser
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: "localWorkFolder")
            UserDefaults.standard.set("local", forKey: "workMode")
            self.stopLocalServer()
            self.loadServer()
        }
    }

    private func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    func reload() {
        if showingErrorPage { loadServer() } else { webView.reload() }
    }

    func changePageZoom(by delta: CGFloat) {
        webView.pageZoom = min(2, max(0.6, webView.pageZoom + delta))
    }

    func resetPageZoom() { webView.pageZoom = 1 }

    func showServerSettings() {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Adresse du serveur Yariche"
        alert.informativeText = "Par exemple http://localhost:5174 ou https://notes.exemple.fr"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = serverURL.absoluteString
        alert.accessoryView = field
        alert.addButton(withTitle: "Enregistrer")
        alert.addButton(withTitle: "Annuler")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            let value = field.stringValue.trimmingCharacters(in: .whitespaces)
            guard let url = URL(string: value), url.scheme?.hasPrefix("http") == true else { return }
            UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
            UserDefaults.standard.set("server", forKey: "workMode")
            self?.loadServer()
        }
    }

    // MARK: - Connexion par le navigateur par défaut

    /// La vue web d'une app n'a pas droit à WebAuthn (clé de sécurité, passkey, Touch ID :
    /// Apple le réserve aux navigateurs), l'étape « clé » du SSO y échoue toujours. La
    /// connexion se fait donc dans le navigateur par défaut, qui rend la main à l'app par un
    /// lien yariche://auth?code=… (code à usage unique). L'app l'échange contre la session
    /// dans sa vue web avec un secret qu'elle seule connaît (le serveur n'en a reçu que
    /// l'empreinte) : une autre app qui capterait le lien n'en ferait rien.
    func startBrowserLogin() {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return }
        let verifier = base64URL(Data(bytes))
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        guard var components = URLComponents(url: remoteServerURL.appendingPathComponent("login/app"), resolvingAgainstBaseURL: false)
        else { return }
        components.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        guard let url = components.url else { return }
        pendingLogin = (verifier, Date())
        NSWorkspace.shared.open(url)
        showWaitingForBrowser()
    }

    /// Retour du navigateur (lien yariche://auth?code=…, reçu par l'AppDelegate)
    func handleLoginCallback(_ url: URL) {
        guard url.scheme?.lowercased() == "yariche", url.host == "auth" else { return }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
        else { return }
        // Une seule utilisation, et seulement pour une connexion lancée ici il y a peu
        guard let pending = pendingLogin, Date().timeIntervalSince(pending.started) < 15 * 60 else {
            showLoginError("Cette connexion n'a pas été lancée depuis cette fenêtre de Yariche (ou a expiré). Relance-la depuis Yariche.")
            loadServer()
            return
        }
        pendingLogin = nil
        exchangeLoginCode(code, verifier: pending.verifier)
    }

    /// Code + secret envoyés en POST depuis la vue web : le cookie de session y est posé
    private func exchangeLoginCode(_ code: String, verifier: String) {
        showingErrorPage = false
        var request = URLRequest(url: remoteServerURL.appendingPathComponent("login/app/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "code", value: code), URLQueryItem(name: "verifier", value: verifier)]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        webView.load(request)
    }

    private func showLoginError(_ message: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Connexion impossible"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Afficher dans le Finder

    /// Le coffre vit sur le serveur ; sur le Mac il existe là où le client Nextcloud le
    /// synchronise. On retrouve ce dossier tout seul, sinon on le demande une fois.
    private var lastVault: (name: String, remoteFolder: String?, server: String?)?

    private func revealInFinder(path: String, vault: String, remoteFolder: String?, server: String?, serverDir: String?) {
        lastVault = (vault, remoteFolder, server)
        guard let root = localVaultRoot(vault: vault, remoteFolder: remoteFolder, server: server, serverDir: serverDir) else {
            explainMissingVault(vault: vault, remoteFolder: remoteFolder) { [weak self] in
                self?.revealInFinder(path: path, vault: vault, remoteFolder: remoteFolder, server: server, serverDir: serverDir)
            }
            return
        }
        let relative = path.hasSuffix("/") ? String(path.dropLast()) : path
        var target = (relative.isEmpty ? root : root.appendingPathComponent(relative)).standardizedFileURL
        // Chemin venu de la page : jamais hors du dossier du coffre (« ../ »)
        let rootPath = root.standardizedFileURL.path
        guard target.path == rootPath || target.path.hasPrefix(rootPath + "/") else { return }
        let wanted = target
        // Pas encore synchronisé sur ce Mac : on montre le dossier parent le plus proche
        while !FileManager.default.fileExists(atPath: target.path) && target.path.count > root.path.count {
            target.deleteLastPathComponent()
        }
        NSWorkspace.shared.activateFileViewerSelecting([target])
        if target != wanted {
            showToast("« \(wanted.lastPathComponent) » n'est pas encore sur ce Mac : dossier parent affiché")
        }
    }

    /// Le coffre n'est pas sur ce Mac : on dit pourquoi et comment l'y mettre
    private func explainMissingVault(vault: String, remoteFolder: String?, then retry: @escaping () -> Void) {
        guard let window else { return }
        let alert = NSAlert()
        if let remoteFolder {
            alert.messageText = "Le dossier Nextcloud « \(remoteFolder) » n'est pas encore sur ce Mac"
            alert.informativeText = "Vérifie que le client Nextcloud synchronise ce dossier (ou tout ton Nextcloud) "
                + "sur ce Mac. S'il est déjà ailleurs sur le disque, indique où."
            alert.addButton(withTitle: "Choisir le dossier…")
            alert.addButton(withTitle: "Annuler")
        } else {
            alert.messageText = "Yariche n'est pas encore connecté à ton Nextcloud"
            alert.informativeText = "Connecte-le : tes notes seront enregistrées dans un dossier de ton Nextcloud, "
                + "et ton client Nextcloud les amènera sur ce Mac et dans le Finder."
            alert.addButton(withTitle: "Se connecter à Nextcloud…")
            alert.addButton(withTitle: "Annuler")
            alert.addButton(withTitle: "Le coffre est déjà sur ce Mac…")
        }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            let pickFolder = { self.chooseLocalVaultFolder(vault: vault) { if $0 != nil { retry() } } }
            switch (remoteFolder, response) {
            case (.some, .alertFirstButtonReturn), (.none, .alertThirdButtonReturn):
                // La feuille d'alerte doit être fermée avant d'ouvrir celle du sélecteur
                DispatchQueue.main.async(execute: pickFolder)
            case (.none, .alertFirstButtonReturn):
                self.webView.evaluateJavaScript("window.__yaricheOpenVaultModal && window.__yaricheOpenVaultModal()")
            default:
                break
            }
        }
    }

    private func localVaultRoot(vault: String, remoteFolder: String?, server: String?, serverDir: String?) -> URL? {
        let fm = FileManager.default
        if let saved = UserDefaults.standard.string(forKey: "localVault:\(vault)"), fm.fileExists(atPath: saved) {
            return URL(fileURLWithPath: saved, isDirectory: true)
        }
        // Serveur Yariche qui tourne sur ce Mac : le coffre est directement là
        if let serverDir, serverDir.hasPrefix("/"), fm.fileExists(atPath: serverDir) {
            return URL(fileURLWithPath: serverDir, isDirectory: true)
        }
        guard let remoteFolder, remoteFolder != "/" else { return nil }
        let inside = String(remoteFolder.drop(while: { $0 == "/" }))
        let home = fm.homeDirectoryForCurrentUser
        // Client Nextcloud avec l'intégration Finder : ~/Library/CloudStorage/Nextcloud-<hôte>-<compte>
        let cloudStorage = home.appendingPathComponent("Library/CloudStorage", isDirectory: true)
        let host = server.flatMap { URL(string: $0)?.host }
        if let names = try? fm.contentsOfDirectory(atPath: cloudStorage.path) {
            for name in names.sorted() where name.hasPrefix("Nextcloud-") && (host == nil || name.contains(host!)) {
                let candidate = cloudStorage.appendingPathComponent(name).appendingPathComponent(inside)
                if fm.fileExists(atPath: candidate.path) { return candidate }
            }
        }
        // Client Nextcloud classique : dossiers de synchro déclarés dans nextcloud.cfg
        let cfg = home.appendingPathComponent("Library/Preferences/Nextcloud/nextcloud.cfg")
        if let text = try? String(contentsOf: cfg, encoding: .utf8) {
            var local: [String: String] = [:]
            var remote: [String: String] = [:]
            for line in text.split(separator: "\n") {
                let parts = line.split(separator: "=", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                if parts[0].hasSuffix("\\localPath") { local[String(parts[0].dropLast(10))] = parts[1] }
                if parts[0].hasSuffix("\\targetPath") { remote[String(parts[0].dropLast(11))] = parts[1] }
            }
            for (key, localPath) in local {
                let target = remote[key] ?? "/"
                let prefix = target.hasSuffix("/") ? target : target + "/"
                let wanted = remoteFolder.hasSuffix("/") ? remoteFolder : remoteFolder + "/"
                guard wanted.hasPrefix(prefix) else { continue }
                let candidate = URL(fileURLWithPath: localPath, isDirectory: true)
                    .appendingPathComponent(String(wanted.dropFirst(prefix.count)))
                if fm.fileExists(atPath: candidate.path) { return candidate }
            }
        }
        return nil
    }

    private func chooseLocalVaultFolder(vault: String, completion: @escaping (URL?) -> Void) {
        guard let window else { return completion(nil) }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choisir"
        panel.message = "Où se trouve le coffre « \(vault) » sur ce Mac ? (le dossier synchronisé par Nextcloud)"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return completion(nil) }
            UserDefaults.standard.set(url.path, forKey: "localVault:\(vault)")
            completion(url)
        }
    }

    /// Menu Yariche → « Dossier du coffre sur ce Mac… »
    func changeLocalVaultFolder() {
        webView.evaluateJavaScript("window.__yaricheVault && window.__yaricheVault()") { [weak self] result, _ in
            guard let self, let vault = (result as? String) ?? self.lastVault?.name else { return }
            UserDefaults.standard.removeObject(forKey: "localVault:\(vault)")
            self.chooseLocalVaultFolder(vault: vault) { url in
                if let url { self.showToast("Coffre « \(vault) » : \(url.path)") }
            }
        }
    }

    // MARK: - Apparence

    private func applyTheme(dark: Bool) {
        let background = dark ? darkBackground : NSColor.white
        window?.backgroundColor = background
        window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        webView.underPageBackgroundColor = background
        UserDefaults.standard.set(dark, forKey: "lastThemeDark")
        // Un changement d'apparence relance la mise en page de la barre de titre
        DispatchQueue.main.async { [weak self] in self?.layoutTrafficLights() }
    }

    /// Centre les feux dans la barre de 52 px de l'app (même technique que Tauri/tao :
    /// on agrandit le conteneur de la barre de titre puis on place les boutons).
    private func layoutTrafficLights() {
        guard let window, !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let miniaturize = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let titlebarView = close.superview,
              let container = titlebarView.superview
        else { return }
        var frame = container.frame
        frame.size.height = barHeight
        frame.origin.y = window.frame.height - barHeight
        container.frame = frame
        titlebarView.frame = container.bounds
        let spacing = max(miniaturize.frame.minX - close.frame.minX, 20)
        let y = ((barHeight - close.frame.height) / 2).rounded()
        for (index, button) in [close, miniaturize, zoom].enumerated() {
            button.setFrameOrigin(NSPoint(x: 18 + CGFloat(index) * spacing, y: y))
        }
    }

    // MARK: - NSWindowDelegate

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights() }
    func windowDidResignKey(_ notification: Notification) { layoutTrafficLights() }

    func windowWillEnterFullScreen(_ notification: Notification) {
        webView.evaluateJavaScript("document.documentElement.classList.add('macapp-fullscreen')")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        webView.evaluateJavaScript("document.documentElement.classList.remove('macapp-fullscreen')")
        layoutTrafficLights()
    }

    // MARK: - Messages de la page (window.webkit.messageHandlers.yariche)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        // Pont natif réservé au serveur Yariche affiché (et aux pages locales de l'app : erreur,
        // attente de connexion) : une autre page (fournisseur SSO, lien suivi dans l'app) n'ouvre
        // pas d'URL, ne montre rien dans le Finder, etc.
        guard message.frameInfo.isMainFrame else { return }
        let origin = message.frameInfo.securityOrigin
        let fromServer = origin.protocol == serverURL.scheme
            && origin.host == serverURL.host
            && origin.port == (serverURL.port ?? 0)
        let fromLocalPage = origin.host.isEmpty
        let localPageTypes: Set<String> = ["retry", "settings", "workLocation", "loginAgain", "loginCancel", "theme"]
        guard fromServer || (fromLocalPage && localPageTypes.contains(type)) else { return }
        switch type {
        case "theme":
            applyTheme(dark: (body["theme"] as? String) != "light")
        case "dragRegions":
            webView.dragRegions = rects(body["drag"])
            webView.noDragRegions = rects(body["noDrag"])
        case "badge":
            let count = body["count"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = count > 0 ? (count > 99 ? "99+" : String(count)) : nil
        case "retry":
            loadServer()
        case "loginAgain":
            startBrowserLogin()
        case "loginCancel":
            pendingLogin = nil
            loadServer()
        case "settings":
            showServerSettings()
        case "workLocation":
            showWorkLocation()
        case "openExternal":
            // Connexion Nextcloud : dans le navigateur par défaut, où la session Nextcloud existe déjà
            guard let raw = body["url"] as? String, let url = URL(string: raw),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
            NSWorkspace.shared.open(url)
        case "reveal":
            guard let path = body["path"] as? String, let vault = body["vault"] as? String else { return }
            revealInFinder(
                path: path,
                vault: vault,
                remoteFolder: body["remoteFolder"] as? String,
                server: body["server"] as? String,
                serverDir: body["serverDir"] as? String
            )
        default:
            break
        }
    }

    private func rects(_ value: Any?) -> [CGRect] {
        guard let list = value as? [[Double]] else { return [] }
        return list.compactMap { r in r.count == 4 ? CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil }
    }

    // MARK: - Navigation, liens externes, téléchargements

    private func isInternal(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "blob" || scheme == "data" || scheme == "about" { return true }
        guard scheme == "http" || scheme == "https" else { return false }
        return url.host == serverURL.host && url.port == serverURL.port
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        // « Continuer avec … » sur la page de connexion : connexion dans le navigateur
        if let url = navigationAction.request.url, isInternal(url), url.path == "/login/start",
           navigationAction.targetFrame?.isMainFrame != false
        {
            decisionHandler(.cancel, preferences)
            startBrowserLogin()
            return
        }
        // Seuls les liens cliqués dans Yariche partent dans le navigateur. Les redirections
        // et formulaires (connexion SSO chez n'importe quel fournisseur OpenID Connect)
        // restent dans l'app, qui garde ainsi le cookie de session.
        if let url = navigationAction.request.url,
           navigationAction.targetFrame?.isMainFrame != false,
           navigationAction.navigationType == .linkActivated,
           webView.url.map(isInternal) ?? true,
           !isInternal(url)
        {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var destination = folder.appendingPathComponent(suggestedFilename)
        var n = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        showToast("Enregistré dans Téléchargements : \(url.lastPathComponent)")
        NSApp.requestUserAttention(.informationalRequest)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        showToast("Téléchargement impossible : \(error.localizedDescription)")
    }

    private func showToast(_ text: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [text]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__yaricheToast && window.__yaricheToast(\(json)[0])")
    }

    // Logo de l'app (même dessin que branding/logo-mark.svg), sans dépendre du serveur
    private let logoSVG = """
    <svg class="logo" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><defs>\
    <linearGradient id="bg" x1="0.12" y1="0" x2="0.88" y2="1"><stop offset="0" stop-color="#4163f5"/>\
    <stop offset="0.52" stop-color="#1c9fe6"/><stop offset="1" stop-color="#19cfa3"/></linearGradient></defs>\
    <rect width="1024" height="1024" rx="232" fill="url(#bg)"/>\
    <g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="112">\
    <path d="M704 262 L512 540" stroke="#fff" stroke-opacity="0.62"/>\
    <path d="M320 262 L512 540 L512 780" stroke="#fff"/></g></svg>
    """

    // Serveur injoignable : page d'erreur sombre plutôt qu'une fenêtre blanche
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // téléchargement
        showErrorPage(message: nsError.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// Pendant la connexion dans le navigateur : ce qu'il se passe, et de quoi relancer
    private func showWaitingForBrowser() {
        showLocalPage(body: """
        \(logoSVG)<h1>Connexion dans ton navigateur</h1>
        <p>Termine la connexion dans l'onglet qui vient de s'ouvrir, puis accepte d'ouvrir Yariche :
        l'app reprendra la main toute seule.</p>
        <div class="row"><button class="primary" onclick="webkit.messageHandlers.yariche.postMessage({type:'loginAgain'})">Rouvrir le navigateur</button>
        <button onclick="webkit.messageHandlers.yariche.postMessage({type:'loginCancel'})">Annuler</button></div>
        """)
    }

    private func showErrorPage(message: String) {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
        if workMode == "local" {
            showLocalPage(body: """
            \(logoSVG)<h1>Mode local</h1>
            <p>\(escaped)</p>
            <div class="row"><button class="primary" onclick="webkit.messageHandlers.yariche.postMessage({type:'retry'})">Réessayer</button>
            <button onclick="webkit.messageHandlers.yariche.postMessage({type:'workLocation'})">Où travailler…</button></div>
            """)
            return
        }
        let server = remoteServerURL.absoluteString.replacingOccurrences(of: "<", with: "&lt;")
        showLocalPage(body: """
        \(logoSVG)<h1>Serveur injoignable</h1>
        <p>Impossible de joindre <code>\(server)</code>.</p><p>\(escaped)</p>
        <p>Vérifie la connexion (VPN, réseau local) ou l'adresse du serveur.</p>
        <div class="row"><button class="primary" onclick="webkit.messageHandlers.yariche.postMessage({type:'retry'})">Réessayer</button>
        <button onclick="webkit.messageHandlers.yariche.postMessage({type:'settings'})">Changer d'adresse…</button>
        <button onclick="webkit.messageHandlers.yariche.postMessage({type:'workLocation'})">Travailler sur ce Mac…</button></div>
        """)
    }

    /// Page locale (hors serveur) au style de l'app ; « Recharger » y revient au serveur
    private func showLocalPage(body: String) {
        showingErrorPage = true
        let html = """
        <!doctype html><html class="macapp"><head><meta charset="utf-8"><style>
        :root { color-scheme: dark light; }
        body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
          background:#141414; color:#eaeaea; font:15px -apple-system, "Inter", sans-serif; -webkit-user-select:none; }
        @media (prefers-color-scheme: light) { body { background:#fff; color:#121212; } }
        .card { text-align:center; max-width:420px; padding:24px; }
        .logo { width:64px; height:64px; margin:0 auto 18px; display:block; }
        h1 { font-size:20px; margin:0 0 8px; } p { margin:0 0 6px; color:#9c9ca0; line-height:1.45; }
        code { font:13px ui-monospace, Menlo, monospace; color:inherit; }
        .row { margin-top:20px; display:flex; gap:8px; justify-content:center; }
        button { font:inherit; font-size:14px; height:34px; padding:0 16px; border-radius:8px; border:1px solid #414141;
          background:transparent; color:inherit; cursor:pointer; }
        button.primary { background:#1e96eb; border-color:#1e96eb; color:#fff; }
        </style></head><body><div class="card">
        \(body)
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - WKUIDelegate : sans ça, alert/confirm/prompt et <input type=file> sont muets

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // target="_blank" : lien externe -> navigateur, lien interne -> même fenêtre
        if let url = navigationAction.request.url {
            if isInternal(url) { webView.load(navigationAction.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        guard let window else { return completionHandler() }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let window else { return completionHandler(false) }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Annuler")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        guard let window else { return completionHandler(nil) }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Annuler")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}
