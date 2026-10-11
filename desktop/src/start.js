// Page de démarrage de l'app : adresse du serveur, vérification qu'il répond, puis ouverture
// du serveur dans la fenêtre (commande open_server). Seule cette page locale peut appeler
// les commandes de l'app ; les pages du serveur n'y ont pas accès.
const { invoke } = window.__TAURI__.core
const $ = (id) => document.getElementById(id)
const show = (id) => ['loading', 'setup', 'offline'].forEach((s) => $(s).classList.toggle('hidden', s !== id))

// Le serveur répond-il ? (requête « opaque » : seul compte le fait d'avoir une réponse)
async function reachable(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    await fetch(new URL('favicon.svg', url), { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function start() {
  const settings = new URLSearchParams(location.search).has('settings')
  const url = await invoke('get_server_url')
  if (!url || settings) {
    $('server-input').value = url || ''
    show('setup')
    $('server-input').focus()
    return
  }
  show('loading')
  $('loading-text').textContent = `Connexion à ${new URL(url).host}…`
  if (await reachable(url)) return invoke('open_server')
  $('offline-url').textContent = url
  show('offline')
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('setup-error').textContent = ''
  try {
    await invoke('set_server_url', { url: $('server-input').value })
    history.replaceState(null, '', location.pathname)
    start()
  } catch (err) {
    $('setup-error').textContent = String(err)
  }
})
$('retry').addEventListener('click', start)
$('change').addEventListener('click', async () => {
  $('server-input').value = (await invoke('get_server_url')) || ''
  show('setup')
})

start()
