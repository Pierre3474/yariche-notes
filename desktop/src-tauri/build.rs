fn main() {
    // Commandes de l'app déclarées : elles ne sont permises que là où une capability les
    // accorde (la page de démarrage locale), jamais aux pages du serveur
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["get_server_url", "set_server_url", "open_server"]),
        ),
    )
    .expect("tauri-build");
}
