import Foundation
import Security

/// Mode local : le serveur Yariche tourne dans l'app (Node.js et le serveur sont embarqués
/// dans Contents/Resources) et écrit directement dans un dossier du Mac, typiquement le
/// dossier Nextcloud synchronisé. Il n'écoute que sur 127.0.0.1 et n'ouvre qu'avec le secret
/// de ce lancement (cookie posé par /local-login) : ni un site ouvert dans un navigateur, ni
/// un autre programme du Mac ne peuvent s'en servir.
final class LocalServer {
    let port: Int
    let vaultDir: URL
    private let token: String
    private var process: Process?
    private var stopping = false
    /// Arrêt imprévu (plantage) : message à afficher
    var onUnexpectedExit: ((String) -> Void)?

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
    var loginURL: URL { URL(string: "http://127.0.0.1:\(port)/local-login?token=\(token)")! }

    static var nodeURL: URL? { Bundle.main.resourceURL?.appendingPathComponent("node/bin/node") }
    static var serverAppURL: URL? { Bundle.main.resourceURL?.appendingPathComponent("server-app") }
    /// Cette version de l'app contient-elle le serveur ? (build-app.sh avec YARICHE_LOCAL=0 : non)
    static var isBundled: Bool {
        guard let node = nodeURL, let app = serverAppURL else { return false }
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: node.path) && fm.fileExists(atPath: app.appendingPathComponent("server/index.js").path)
    }
    static var supportDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Yariche/local", isDirectory: true)
    }
    static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Yariche/local-server.log")
    }

    init(vaultDir: URL) {
        self.vaultDir = vaultDir
        // Port fixe si possible : l'adresse MCP locale (http://127.0.0.1:5178/mcp) reste la même
        port = LocalServer.freePort(preferred: 5178)
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = bytes.map { String(format: "%02x", $0) }.joined()
    }

    func start(completion: @escaping (String?) -> Void) {
        guard LocalServer.isBundled, let node = LocalServer.nodeURL, let app = LocalServer.serverAppURL else {
            return completion("Cette version de l'app n'embarque pas le serveur (recompiler sans YARICHE_LOCAL=0).")
        }
        let fm = FileManager.default
        guard fm.fileExists(atPath: vaultDir.path) else { return completion("Dossier introuvable : \(vaultDir.path)") }
        let support = LocalServer.supportDir
        try? fm.createDirectory(at: support.appendingPathComponent("internal"), withIntermediateDirectories: true)
        try? fm.createDirectory(at: LocalServer.logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Journal : repart de zéro au-delà de 5 Mo
        if let size = try? fm.attributesOfItem(atPath: LocalServer.logURL.path)[.size] as? Int, size > 5_000_000 {
            try? fm.removeItem(at: LocalServer.logURL)
        }
        if !fm.fileExists(atPath: LocalServer.logURL.path) { fm.createFile(atPath: LocalServer.logURL.path, contents: nil) }
        guard let log = try? FileHandle(forWritingTo: LocalServer.logURL) else { return completion("Journal impossible à ouvrir") }
        log.seekToEndOfFile()

        let p = Process()
        p.executableURL = node
        p.arguments = [app.appendingPathComponent("server/index.js").path]
        p.currentDirectoryURL = app
        // Assistant IA : LLM_BASE_URL, LLM_MODEL, LLM_API_KEY dans <support>/ai.env (KEY=VALEUR)
        var llmEnv: [String: String] = [:]
        if let raw = try? String(contentsOf: support.appendingPathComponent("ai.env"), encoding: .utf8) {
            for line in raw.split(whereSeparator: \.isNewline) {
                let t = line.trimmingCharacters(in: .whitespaces)
                guard !t.hasPrefix("#"), let eq = t.firstIndex(of: "=") else { continue }
                let k = String(t[..<eq]).trimmingCharacters(in: .whitespaces)
                if k.hasPrefix("LLM_") { llmEnv[k] = String(t[t.index(after: eq)...]).trimmingCharacters(in: .whitespaces) }
            }
        }
        p.environment = llmEnv.merging([
            "HOME": fm.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Nextcloud.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin",
            "LANG": "fr_FR.UTF-8",
            "NODE_ENV": "production",
            "PORT": String(port),
            "HOST": "127.0.0.1",
            "DATA_DIR": support.path,
            "VAULT_DIR": vaultDir.path,
            "YARICHE_INTERNAL_DIR": support.appendingPathComponent("internal").path,
            "YARICHE_STORAGE": "local",
            "YARICHE_LOCAL_TOKEN": token,
            "DEV_USER_EMAIL": "moi@ce-mac",
            "YARICHE_DEFAULT_OWNER": "moi@ce-mac",
            "DEV_USER_NAME": NSFullUserName().isEmpty ? "Moi" : NSFullUserName(),
        ], uniquingKeysWith: { _, fixed in fixed })
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.onUnexpectedExit?("Le serveur local s'est arrêté (code \(proc.terminationStatus)). Journal : \(LocalServer.logURL.path)")
            }
        }
        do {
            try p.run()
        } catch {
            return completion("Démarrage impossible : \(error.localizedDescription)")
        }
        process = p
        waitUntilReady(deadline: Date().addingTimeInterval(20), completion: completion)
    }

    /// Prêt dès qu'il répond (401 attendu : pas encore de cookie)
    private func waitUntilReady(deadline: Date, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("favicon.svg"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if response is HTTPURLResponse { return completion(nil) }
                if self.process?.isRunning != true {
                    return completion("Le serveur local n'a pas démarré. Journal : \(LocalServer.logURL.path)")
                }
                if Date() > deadline { return completion("Le serveur local ne répond pas. Journal : \(LocalServer.logURL.path)") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    self.waitUntilReady(deadline: deadline, completion: completion)
                }
            }
        }.resume()
    }

    func stop() {
        stopping = true
        guard let p = process, p.isRunning else { return }
        p.terminate()
        // Laisse le serveur finir d'écrire (métadonnées) avant que l'app ne se ferme
        let deadline = Date().addingTimeInterval(2)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        process = nil
    }

    /// Port libre sur 127.0.0.1 : celui demandé, sinon un port donné par le système
    static func freePort(preferred: Int) -> Int {
        func bindable(_ port: Int) -> Int? {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { return nil }
            defer { close(fd) }
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(UInt16(port).bigEndian)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard bound == 0 else { return nil }
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
            }
            return Int(UInt16(bigEndian: addr.sin_port))
        }
        return bindable(preferred) ?? bindable(0) ?? preferred
    }
}
