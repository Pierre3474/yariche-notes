// Yariche pour Windows et Linux : l'app web du serveur Yariche dans une fenêtre (WebView2
// sous Windows, WebKitGTK sous Linux), comme l'app Mac.
// - Démarrage sur une page locale (src/index.html) : adresse du serveur, vérification qu'il
//   répond, puis ouverture du serveur dans la fenêtre.
// - Connexion SSO dans le navigateur par défaut (clés de sécurité, passkeys) : retour par
//   yariche://auth?code=…, code échangé dans la fenêtre avec un secret gardé ici (PKCE).
// - Liens vers d'autres sites : ouverts dans le navigateur par défaut.
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// Adresse proposée par défaut, fixée à la compilation (YARICHE_SERVER_URL), sinon demandée
const EMBEDDED_SERVER_URL: Option<&str> = option_env!("YARICHE_SERVER_URL");
/// Durée de validité d'une connexion lancée dans le navigateur
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
struct LoginState {
    /// Connexion lancée dans le navigateur : le secret attend le retour
    pending: Option<(String, Instant)>,
    /// Code reçu : échangé dès que la fenêtre affiche le serveur
    ready: Option<(String, String)>,
}

#[derive(Default)]
struct AppState {
    login: Mutex<LoginState>,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Config {
    #[serde(rename = "serverUrl")]
    server_url: Option<String>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("config.json"))
}

fn parse_server(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

fn server_url(app: &AppHandle) -> Option<Url> {
    let saved = config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .and_then(|c| c.server_url);
    saved
        .as_deref()
        .or(EMBEDDED_SERVER_URL.filter(|s| !s.is_empty()))
        .and_then(parse_server)
}

#[tauri::command]
fn get_server_url(app: AppHandle) -> Option<String> {
    server_url(&app).map(|u| u.to_string())
}

#[tauri::command]
fn set_server_url(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = parse_server(&url).ok_or("adresse http(s) invalide")?;
    let path = config_path(&app).ok_or("dossier de configuration introuvable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let config = Config { server_url: Some(parsed.to_string()) };
    std::fs::write(&path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(parsed.to_string())
}

/// Page de démarrage → serveur (une fois qu'il répond)
#[tauri::command]
fn open_server(app: AppHandle) -> Result<(), String> {
    let url = server_url(&app).ok_or("aucune adresse de serveur")?;
    let window = app.get_webview_window("main").ok_or("fenêtre introuvable")?;
    window.navigate(url).map_err(|e| e.to_string())
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Pages de l'app elle-même : tauri://localhost (Linux), http(s)://tauri.localhost (Windows)
fn is_app_page(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob") || url.host_str() == Some("tauri.localhost")
}

fn random_b64url(len: usize) -> String {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).expect("générateur aléatoire du système");
    URL_SAFE_NO_PAD.encode(buf)
}

fn show_start_page(app: &AppHandle, query: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        if let Ok(url) = Url::parse(&format!("{base}{query}")) {
            let _ = window.navigate(url);
        }
    }
}

/// « Continuer avec … » sur la page de connexion : connexion dans le navigateur par défaut
fn start_browser_login(app: &AppHandle) {
    let Some(server) = server_url(app) else { return };
    let verifier = random_b64url(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let Ok(mut url) = server.join("login/app") else { return };
    url.query_pairs_mut().append_pair("challenge", &challenge);
    app.state::<AppState>().login.lock().unwrap().pending = Some((verifier, Instant::now()));
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Retour du navigateur : yariche://auth?code=…
fn handle_deep_link(app: &AppHandle, url: &Url) {
    if url.scheme() != "yariche" || url.host_str() != Some("auth") {
        return;
    }
    // Le lien peut venir de n'importe où : forme stricte, sinon ignoré
    let Some(code) = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .filter(|c| (20..=100).contains(&c.len()) && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
    else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let state = app.state::<AppState>();
    let verifier = {
        let mut login = state.login.lock().unwrap();
        match login.pending.take() {
            Some((verifier, at)) if at.elapsed() < LOGIN_TIMEOUT => verifier,
            _ => return, // pas lancée depuis cette fenêtre, ou trop ancienne
        }
    };
    state.login.lock().unwrap().ready = Some((code, verifier));
    let Some(server) = server_url(app) else { return };
    match window.url() {
        Ok(current) if same_origin(&server, &current) => exchange_if_ready(app, &window),
        _ => {
            if let Ok(login) = server.join("login") {
                let _ = window.navigate(login);
            }
        }
    }
}

/// Échange code + secret depuis la page du serveur : le cookie de session est posé dans la vue web
fn exchange_if_ready(app: &AppHandle, window: &WebviewWindow) {
    let Some((code, verifier)) = app.state::<AppState>().login.lock().unwrap().ready.take() else { return };
    // Valeurs base64url (vérifiées) : sûres dans un corps de formulaire ; chaîne JSON pour le JS
    let body = serde_json::to_string(&format!("code={code}&verifier={verifier}")).unwrap_or_default();
    let js = format!(
        "fetch('/login/app/exchange',{{method:'POST',headers:{{'Content-Type':'application/x-www-form-urlencoded'}},body:{body},credentials:'same-origin'}})\
         .then(function(){{location.replace('/')}},function(){{location.replace('/login')}})"
    );
    let _ = window.eval(&js);
}

/// Fichier téléchargé (export .md) : dans Téléchargements, sans écraser
fn download_destination(suggested: &std::path::Path) -> Option<PathBuf> {
    let dir = dirs::download_dir()?;
    let name = suggested.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "yariche.md".into());
    let path = dir.join(&name);
    if !path.exists() {
        return Some(path);
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    (2..1000).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !p.exists())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let server = MenuItem::with_id(app, "server", "Adresse du serveur…", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Recharger", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(app, "back", "Page précédente", true, Some("Alt+Left"))?;
    let forward = MenuItem::with_id(app, "forward", "Page suivante", true, Some("Alt+Right"))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quitter"))?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let menu = Submenu::with_items(app, "Yariche", true, &[&server, &separator1, &back, &forward, &reload, &separator2, &quit])?;
    Menu::with_items(app, &[&menu])
}

pub fn run() {
    tauri::Builder::default()
        // En premier : un second lancement (lien yariche:// compris) rejoint la fenêtre ouverte
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_server_url, set_server_url, open_server])
        .setup(|app| {
            let handle = app.handle().clone();
            // Schéma yariche:// déclaré aussi à l'exécution (AppImage, installation manuelle)
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&links, &url);
                }
            });

            let nav = handle.clone();
            let loaded = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Yariche")
                .inner_size(1320.0, 860.0)
                .min_inner_size(900.0, 600.0)
                .menu(build_menu(&handle)?)
                .on_navigation(move |url| {
                    if is_app_page(url) {
                        return true;
                    }
                    if let Some(server) = server_url(&nav) {
                        if same_origin(&server, url) {
                            if url.path() == "/login/start" {
                                start_browser_login(&nav);
                                return false;
                            }
                            return true;
                        }
                    }
                    // Autre site : navigateur par défaut, la fenêtre reste sur Yariche
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = nav.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    if let Some(server) = server_url(&loaded) {
                        if same_origin(&server, payload.url()) {
                            exchange_if_ready(&loaded, &window);
                        }
                    }
                })
                .on_download(|_webview, event| {
                    if let DownloadEvent::Requested { destination, .. } = event {
                        if let Some(path) = download_destination(destination) {
                            *destination = path;
                        }
                    }
                    true
                })
                .build()?;

            app.on_menu_event(move |app, event| {
                let Some(window) = app.get_webview_window("main") else { return };
                match event.id().as_ref() {
                    "server" => show_start_page(app, "?settings=1"),
                    "reload" => {
                        let _ = window.eval("location.reload()");
                    }
                    "back" => {
                        let _ = window.eval("history.back()");
                    }
                    "forward" => {
                        let _ = window.eval("history.forward()");
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("démarrage de Yariche");
}
