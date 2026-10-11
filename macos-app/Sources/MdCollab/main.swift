import AppKit

// App AppKit pure (plus de SwiftUI) : contrôle total de la fenêtre, de la barre de
// titre et des délégués WebKit (dialogues, fichiers, téléchargements).
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
