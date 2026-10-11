// Pas de console en plus de la fenêtre sous Windows (build de production)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yariche_lib::run()
}
