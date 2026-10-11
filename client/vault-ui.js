// Dossier de travail (comme le sélecteur de coffres d'Obsidian) et Nextcloud :
// premier lancement (connexion par le navigateur, choix du dossier), changement de
// dossier, état de la synchronisation.
import { icon } from './icons.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 10) return 'à l’instant'
  if (s < 60) return `il y a ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `il y a ${h} h`
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

const formatSize = (n) => {
  if (n === null || n === undefined) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 / 1024)} Mo`
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`
}

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const baseName = (folder) => folder.split('/').filter(Boolean).pop() || folder

// Le serveur a changé de coffre : on recharge l'app (plus rien d'ouvert ne vaut)
function reloadInto(name) {
  try {
    sessionStorage.setItem('yariche-vault-opened', name)
  } catch {
    /* rien */
  }
  location.href = '/'
}

// --- Page externe dans le navigateur par défaut ------------------------------------------
// App Mac : le natif l'ouvre dans le navigateur (où l'on est déjà connecté à Nextcloud).
// Navigateur : la fenêtre doit être ouverte pendant le clic, sinon elle est bloquée ; on
// l'ouvre vide tout de suite et on y charge l'adresse quand le serveur l'a donnée.
const nativeBridge = () => window.webkit?.messageHandlers?.yariche
function prepareExternalWindow() {
  if (nativeBridge()) return null
  try {
    return window.open('', '_blank')
  } catch {
    return null
  }
}
function openExternal(url, prepared) {
  if (nativeBridge()) {
    nativeBridge().postMessage({ type: 'openExternal', url })
    return true
  }
  if (prepared && !prepared.closed) {
    prepared.location.href = url
    return true
  }
  return !!window.open(url, '_blank')
}

// --- Connexion à Nextcloud par le navigateur (Login Flow v2) -------------------------------
// Renvoie { cancel } ; onDone(vault) une fois l'accès autorisé dans le navigateur.
function connectWithBrowser({ api, url, prepared, onWaiting, onDone, onError }) {
  let stopped = false
  let timer = null
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    try {
      // Fenêtre préparée restée vide (erreur avant d'avoir l'adresse) : on la referme
      if (prepared && !prepared.closed && prepared.location.href === 'about:blank') prepared.close()
    } catch {
      /* déjà sur la page Nextcloud (autre origine) : on la laisse */
    }
  }
  ;(async () => {
    let flow
    try {
      flow = await api('/api/nextcloud/login/start', { method: 'POST', body: JSON.stringify({ url }) })
    } catch (err) {
      stop()
      return onError(err.message)
    }
    if (stopped) return
    const opened = openExternal(flow.login, prepared)
    onWaiting({ login: flow.login, opened })
    const poll = async () => {
      if (stopped) return
      try {
        const r = await api('/api/nextcloud/login/poll', { method: 'POST', body: JSON.stringify({ id: flow.id }) })
        if (stopped) return
        if (r.done) {
          stopped = true
          return onDone(r)
        }
      } catch (err) {
        stop()
        return onError(err.message)
      }
      timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
  })()
  return { cancel: stop }
}

// --- Navigateur de dossiers Nextcloud -------------------------------------------------------
// suggested : dossier conseillé (proposé même s'il n'existe pas encore, créé au besoin)
function createFolderBrowser(box, { api, toast, startPath = '/', suggested = null, vaults = [], busy, onUse }) {
  let state = { path: startPath, folders: [], loading: true, error: null, maxBytes: Infinity }

  async function load(p) {
    state = { ...state, path: p, loading: true, error: null }
    render()
    try {
      const r = await api(`/api/nextcloud/folders?path=${encodeURIComponent(p)}`)
      state = { path: r.path, folders: r.folders, maxBytes: r.maxBytes || Infinity, loading: false, error: null }
    } catch (err) {
      state = { ...state, loading: false, error: err.message }
    }
    render()
  }

  function render() {
    const crumbs = state.path.split('/').filter(Boolean)
    const current = crumbs[crumbs.length - 1]
    // Dossier conseillé, à la racine, s'il n'existe pas encore
    const showSuggestion =
      suggested && state.path === '/' && !state.loading && !state.folders.some((f) => f.path === suggested)
    const linkedTo = (p) => vaults.find((v) => v.remote?.folder === p)
    const folderRow = (f) => {
      const linked = linkedTo(f.path)
      const tag = f.path === suggested ? '<em class="suggested">conseillé</em>' : linked ? `<em>${linked.active ? 'ouvert' : 'coffre'}</em>` : ''
      return `<button class="vault-folder${f.path === suggested ? ' is-suggested' : ''}" data-path="${esc(f.path)}">${icon('folder', 16)}<span>${esc(f.name)}</span>${tag}<small class="vault-size${f.size > state.maxBytes ? ' too-big' : ''}">${formatSize(f.size)}</small>${icon('chevron', 14)}</button>`
    }
    const sorted = [...state.folders].sort((a, b) => (b.path === suggested) - (a.path === suggested))
    box.innerHTML = `
      <div class="vault-browser">
        <div class="vault-crumbs">
          <button data-path="/">${icon('cloud', 13)}<span>Nextcloud</span></button>
          ${crumbs
            .map((c, i) => `<span class="sep">/</span><button data-path="/${esc(crumbs.slice(0, i + 1).join('/'))}">${esc(c)}</button>`)
            .join('')}
        </div>
        <div class="vault-folders">${
          state.loading
            ? '<div class="vault-empty">Chargement…</div>'
            : state.error
              ? `<div class="vault-empty error">${esc(state.error)}</div>`
              : `${
                  showSuggestion
                    ? `<button class="vault-folder is-suggested new" data-new="${esc(suggested)}">${icon('plus', 16)}<span>${esc(baseName(suggested))}</span><em class="suggested">nouveau dossier conseillé</em></button>`
                    : ''
                }${sorted.map(folderRow).join('') || (showSuggestion ? '' : '<div class="vault-empty">Aucun sous-dossier</div>')}`
        }</div>
        <div class="vault-browser-actions">
          <button class="secondary-btn" data-act="mkdir">${icon('plus', 14)}<span>Nouveau dossier</span></button>
          <span class="topbar-spacer"></span>
          ${
            current
              ? `<button class="primary-btn" data-act="use"${linkedTo(state.path)?.active ? ' disabled' : ''}>${
                  linkedTo(state.path)?.active ? 'Déjà ouvert ici' : `Travailler dans « ${esc(current)} »`
                }</button>`
              : showSuggestion
                ? `<button class="primary-btn" data-act="use-suggested">Travailler dans « ${esc(baseName(suggested))} »</button>`
                : '<span class="vault-hint">Choisis un dossier</span>'
          }
        </div>
      </div>`
    box.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => load(b.dataset.path)))
    const create = async (target) => {
      busy?.('Création du dossier…')
      try {
        await api('/api/nextcloud/folders', { method: 'POST', body: JSON.stringify({ path: target }) })
        return true
      } catch (err) {
        toast(err.message)
        return false
      } finally {
        busy?.(null)
      }
    }
    box.querySelector('[data-new]')?.addEventListener('click', async () => {
      if (await create(suggested)) onUse(suggested)
    })
    box.querySelector('[data-act="use-suggested"]')?.addEventListener('click', async () => {
      if (await create(suggested)) onUse(suggested)
    })
    box.querySelector('[data-act="mkdir"]').addEventListener('click', async () => {
      const name = prompt(`Nouveau dossier dans ${state.path === '/' ? 'Nextcloud' : state.path} :`)?.trim()
      if (!name) return
      if (/[/\\]/.test(name)) return toast('Pas de / dans un nom de dossier')
      const target = `${state.path === '/' ? '' : state.path}/${name}`
      if (await create(target)) load(target)
    })
    box.querySelector('[data-act="use"]')?.addEventListener('click', () => onUse(state.path))
  }

  load(startPath)
  return { reload: () => load(state.path) }
}

// --- Premier lancement : tout se passe dans Nextcloud ----------------------------------------
export function createOnboarding({ api, toast }) {
  const root = document.getElementById('onboarding')
  let login = null

  function close() {
    login?.cancel()
    root.classList.add('hidden')
    document.body.classList.remove('onboarding-open')
  }

  function frame(inner) {
    root.innerHTML = `<div class="ob-card">
      <img class="ob-logo" src="/logo.svg" alt="" width="56" height="56" />
      ${inner}
    </div><div class="ob-busy"></div>`
    root.classList.remove('hidden')
    document.body.classList.add('onboarding-open')
  }
  const busy = (label) => {
    root.classList.toggle('busy', !!label)
    const b = root.querySelector('.ob-busy')
    if (b) b.textContent = label || ''
  }

  async function show(info) {
    const setup = info.setup
    if (!setup?.step) return close()
    if (!info.admin) {
      frame(`<h1>Yariche n’est pas encore prêt</h1>
        <p>Un administrateur doit d’abord connecter Yariche à Nextcloud, où les notes sont enregistrées.</p>`)
      return
    }
    if (setup.step === 'connect') return showConnect(setup)
    return showFolder(info)
  }

  function showConnect(setup, error = null) {
    frame(`<h1>Bienvenue dans Yariche</h1>
      <p>Tes notes sont enregistrées dans <b>ton Nextcloud</b>, en fichiers Markdown : sur tous tes appareils,
      dans le Finder et dans Obsidian.</p>
      <form class="ob-form">
        <label for="ob-url">Adresse de ton Nextcloud</label>
        <input id="ob-url" name="url" type="url" required placeholder="https://cloud.exemple.fr" value="${esc(setup.defaultUrl)}" />
        ${error ? `<div class="ob-error">${esc(error)}</div>` : ''}
        <button class="primary-btn ob-main" type="submit">${icon('cloud', 16)}<span>Se connecter avec Nextcloud</span></button>
      </form>
      <p class="ob-hint">Ton navigateur s’ouvre sur Nextcloud : connecte-toi et autorise Yariche.
      Aucun mot de passe n’est saisi ici, l’accès se révoque dans Nextcloud (Paramètres → Sécurité).</p>
      <div class="ob-alt">
        <button class="link-btn" data-act="manual">Utiliser un mot de passe d’application</button>
        ${setup.allowLocal ? '<button class="link-btn" data-act="local">Continuer sans Nextcloud (notes sur ce serveur)</button>' : ''}
      </div>`)
    const form = root.querySelector('form')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const url = form.url.value.trim()
      const prepared = prepareExternalWindow()
      showWaiting(setup, url)
      login = connectWithBrowser({
        api,
        url,
        prepared,
        onWaiting: ({ login: href, opened }) => {
          const link = root.querySelector('[data-act="reopen"]')
          if (link) link.href = href
          if (!opened) root.querySelector('.ob-wait-text').textContent = 'Ouvre la page de connexion Nextcloud pour continuer :'
        },
        onDone: async () => {
          toast('Connecté à Nextcloud')
          const info = await api('/api/vault')
          show(info)
        },
        onError: (message) => showConnect(setup, message),
      })
    })
    root.querySelector('[data-act="manual"]').addEventListener('click', () => showAppPassword(setup))
    root.querySelector('[data-act="local"]')?.addEventListener('click', async () => {
      if (!confirm('Garder les notes sur ce serveur, sans Nextcloud ? Tu pourras connecter Nextcloud plus tard.')) return
      await api('/api/setup/local', { method: 'POST' }).catch((err) => toast(err.message))
      close()
    })
    requestAnimationFrame(() => form.url.focus())
  }

  function showWaiting(setup, url) {
    frame(`<h1>Autorise Yariche dans Nextcloud</h1>
      <p class="ob-wait"><span class="ob-spinner"></span><span class="ob-wait-text">Termine la connexion dans la page
      Nextcloud qui vient de s’ouvrir dans ton navigateur.</span></p>
      <p class="ob-hint">${esc(hostOf(url))} → connexion → « Se connecter » → « Autoriser l’accès ».</p>
      <div class="ob-actions">
        <a class="secondary-btn" data-act="reopen" href="#" target="_blank" rel="noopener">${icon('open', 14)}<span>Rouvrir la page Nextcloud</span></a>
        <button class="link-btn" data-act="cancel">Annuler</button>
      </div>
      <p class="ob-hint ob-trouble">Nextcloud affiche une erreur (« Accès non autorisé », « jetons ») ?
      Ferme cet onglet et <button class="link-btn" data-act="retry">recommence</button> : une nouvelle demande
      d’accès est créée.</p>`)
    root.querySelector('[data-act="reopen"]').addEventListener('click', (e) => {
      const href = e.currentTarget.href
      if (href.endsWith('#')) return e.preventDefault()
      if (nativeBridge()) {
        e.preventDefault()
        openExternal(href)
      }
    })
    root.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      login?.cancel()
      showConnect(setup)
    })
    root.querySelector('[data-act="retry"]').addEventListener('click', () => {
      login?.cancel()
      showConnect(setup)
      root.querySelector('form')?.requestSubmit()
    })
  }

  // Dernier recours : mot de passe d'application créé à la main dans Nextcloud
  function showAppPassword(setup, error = null) {
    frame(`<h1>Mot de passe d’application</h1>
      <p>Dans Nextcloud : Paramètres personnels → Sécurité → « Créer un mot de passe d’application »,
      puis copie l’identifiant et le mot de passe affichés.</p>
      <form class="ob-form" autocomplete="off">
        <label for="ob-url2">Adresse de ton Nextcloud</label>
        <input id="ob-url2" name="url" type="url" required value="${esc(setup.defaultUrl)}" />
        <label for="ob-user">Identifiant</label>
        <input id="ob-user" name="user" required autocomplete="off" />
        <label for="ob-pass">Mot de passe d’application</label>
        <input id="ob-pass" name="password" type="password" required autocomplete="new-password" />
        ${error ? `<div class="ob-error">${esc(error)}</div>` : ''}
        <button class="primary-btn ob-main" type="submit">Connecter</button>
      </form>
      <button class="link-btn" data-act="back">Revenir à la connexion par le navigateur</button>`)
    const form = root.querySelector('form')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      busy('Connexion à Nextcloud…')
      try {
        await api('/api/nextcloud/connect', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) })
        busy(null)
        show(await api('/api/vault'))
      } catch (err) {
        busy(null)
        showAppPassword(setup, err.message)
      }
    })
    root.querySelector('[data-act="back"]').addEventListener('click', () => showConnect(setup))
  }

  function showFolder(info) {
    const { setup, nextcloud } = info
    frame(`<h1>Où ranger tes notes ?</h1>
      <p>Connecté à Nextcloud en tant que <b>${esc(nextcloud.user)}</b> (${esc(hostOf(nextcloud.server))}).
      Choisis le dossier de travail de Yariche :</p>
      <div class="ob-browser"></div>
      <p class="ob-hint">Les notes déjà créées dans Yariche y seront copiées. Ton client Nextcloud les amène
      ensuite sur tes appareils.</p>`)
    createFolderBrowser(root.querySelector('.ob-browser'), {
      api,
      toast,
      suggested: setup.suggestedFolder,
      busy,
      onUse: async (folder) => {
        busy('Préparation du dossier…')
        try {
          // Le coffre actuel (et ses notes) part dans ce dossier Nextcloud
          await api('/api/vault/link', { method: 'POST', body: JSON.stringify({ folder }) })
          reloadInto(baseName(folder))
        } catch (err) {
          busy(null)
          toast(err.message)
        }
      },
    })
  }

  return { show, close }
}

// --- Sélecteur de coffres et fenêtre « Dossier de travail » ----------------------------------
export function createVaultUI({ api, toast, showMenu, onboarding }) {
  const overlay = document.getElementById('vault-modal')
  const body = document.getElementById('vault-body')
  const nameEl = document.getElementById('vault-name')
  const syncEl = document.getElementById('status-sync')
  let info = null
  let vaults = []
  let login = null

  // --- Indicateurs (nom du coffre, icône de synchro dans la barre d'état) ------------
  function syncState() {
    if (!info?.remote) return null
    const s = info.sync || {}
    if (s.running) return { cls: 'syncing', icon: 'refresh', text: 'Synchronisation avec Nextcloud…' }
    if (s.error) return { cls: 'error', icon: 'cloudOff', text: `Synchronisation impossible : ${s.error}` }
    if (s.lastSync?.ok) return { cls: 'ok', icon: 'cloud', text: `Synchronisé avec Nextcloud ${timeAgo(s.lastSync.at)}` }
    return { cls: 'pending', icon: 'cloud', text: 'Première synchronisation en attente…' }
  }

  function renderIndicators() {
    if (!info) return
    nameEl.textContent = info.name || info.id
    nameEl.title = info.remote ? `Nextcloud · ${info.remote.folder}` : 'Pas encore dans Nextcloud'
    const state = syncState()
    syncEl.classList.toggle('hidden', !state)
    if (!state) return
    syncEl.className = `status-sync ${state.cls}`
    syncEl.innerHTML = `${icon(state.icon, 14)}<span>${state.cls === 'error' ? 'Erreur de synchro' : 'Nextcloud'}</span>`
    syncEl.title = `${state.text}\nCliquer pour synchroniser maintenant`
  }

  async function refresh() {
    info = await api('/api/vault')
    renderIndicators()
    if (!overlay.classList.contains('hidden')) renderCurrent()
    return info
  }

  async function run(action, busyLabel) {
    setBusy(busyLabel)
    try {
      return await action()
    } catch (err) {
      setBusy(null)
      toast(err.message || 'Action impossible')
      return null
    }
  }
  async function openVault(id) {
    if (id === info?.id) return close()
    const r = await run(() => api('/api/vaults/open', { method: 'POST', body: JSON.stringify({ id }) }), 'Ouverture…')
    if (r?.ok) reloadInto(r.vault.name || r.vault.id)
  }
  async function openRemote(folder) {
    const r = await run(
      () => api('/api/vault/open-remote', { method: 'POST', body: JSON.stringify({ folder }) }),
      'Préparation du dossier…'
    )
    if (!r?.ok) return
    if (r.vault.id === info.id) {
      setBusy(null)
      toast(`Déjà ouvert : « ${r.vault.name || r.vault.id} »`)
      return
    }
    reloadInto(r.vault.name || r.vault.id)
  }

  // Petit menu depuis le nom du coffre (comme le sélecteur de coffres d'Obsidian)
  async function openSwitcher(anchor) {
    await refresh().catch(() => {})
    if (info?.admin) vaults = await api('/api/vaults').catch(() => vaults)
    const items = [{ header: info?.setup?.mode === 'nextcloud' ? 'Dossiers Nextcloud' : 'Coffres' }]
    const list = info?.admin ? vaults : [{ id: info?.id, remote: info?.remote, active: true }]
    for (const v of list) {
      items.push({
        icon: v.remote ? 'cloud' : 'vault',
        label: v.remote ? baseName(v.remote.folder) : v.id,
        checked: !!v.active,
        run: () => openVault(v.id),
      })
    }
    items.push('sep', { icon: 'folderOpen', label: 'Changer de dossier de travail…', run: openModal })
    if (info?.remote) items.push({ icon: 'refresh', label: 'Synchroniser maintenant', run: syncNow })
    showMenu(anchor, items)
  }

  async function syncNow() {
    await api('/api/vault/sync', { method: 'POST' }).catch(() => {})
    toast('Synchronisation lancée')
    setTimeout(() => refresh().catch(() => {}), 1500)
  }

  // --- Fenêtre « Dossier de travail » -------------------------------------------------
  function setBusy(label) {
    overlay.classList.toggle('busy', !!label)
    const b = overlay.querySelector('.vault-busy')
    if (b) b.textContent = label || ''
  }

  function close() {
    login?.cancel()
    overlay.classList.add('hidden')
    setBusy(null)
  }

  async function openModal() {
    await refresh().catch(() => {})
    // Premier lancement pas terminé : l'écran d'accueil s'en charge
    if (info?.setup?.step && info.admin && onboarding) return onboarding.show(info)
    overlay.classList.remove('hidden')
    body.innerHTML = '<div class="vault-loading">Chargement…</div>'
    vaults = info?.admin ? await api('/api/vaults').catch(() => []) : []
    render()
  }

  function render() {
    const localAllowed = info.setup?.mode !== 'nextcloud'
    body.innerHTML = `
      <section class="vault-section" id="vault-current"></section>
      ${
        info.admin
          ? `<section class="vault-section" id="vault-nextcloud"></section>
             ${localAllowed ? '<section class="vault-section" id="vault-local"></section>' : ''}`
          : `<p class="vault-note">Seul un administrateur du serveur peut changer de dossier de travail.</p>`
      }
      <div class="vault-busy"></div>`
    renderCurrent()
    if (info.admin) {
      renderNextcloud()
      if (localAllowed) renderLocal()
    }
  }

  function renderCurrent() {
    const box = document.getElementById('vault-current')
    if (!box || !info) return
    const state = syncState()
    const canUnlink = info.remote && info.admin && info.setup?.mode !== 'nextcloud'
    box.innerHTML = `
      <div class="vault-label">Dossier de travail actuel</div>
      <div class="vault-current">
        <span class="vault-current-icon">${icon(info.remote ? 'cloud' : 'vault', 20)}</span>
        <div class="vault-current-text">
          <div class="vault-current-name">${esc(info.name || info.id)}</div>
          <div class="vault-current-where">${
            info.remote
              ? `Nextcloud · <b>${esc(info.remote.folder)}</b> · synchronisé dans les deux sens`
              : 'Pas encore dans Nextcloud : notes seulement sur ce serveur'
          }</div>
          ${state ? `<div class="vault-sync-line ${state.cls}">${icon(state.icon, 13)}<span>${esc(state.text)}</span></div>` : ''}
        </div>
        ${info.remote ? `<button class="secondary-btn" data-act="sync">${icon('refresh', 14)}<span>Synchroniser</span></button>` : ''}
      </div>
      ${canUnlink ? `<button class="link-btn" data-act="unlink">Ne plus synchroniser ce coffre avec Nextcloud</button>` : ''}`
    box.querySelector('[data-act="sync"]')?.addEventListener('click', syncNow)
    box.querySelector('[data-act="unlink"]')?.addEventListener('click', async () => {
      if (!confirm(`Arrêter la synchronisation de « ${info.name} » avec ${info.remote.folder} ?\nLes fichiers restent des deux côtés.`)) return
      const r = await run(() => api('/api/vault/unlink', { method: 'POST' }), 'Arrêt de la synchronisation…')
      setBusy(null)
      if (r?.ok) {
        info = { ...info, ...r.vault }
        renderIndicators()
        render()
      }
    })
  }

  function renderNextcloud() {
    const box = document.getElementById('vault-nextcloud')
    const nc = info.nextcloud
    if (!nc.connected) {
      box.innerHTML = `
        <div class="vault-label">${icon('cloud', 14)}<span>Nextcloud</span></div>
        <p class="vault-help">Connecte ton Nextcloud pour y enregistrer tes notes : synchronisées dans les deux
        sens, sur tous tes appareils, dans le Finder et dans Obsidian.</p>
        <form class="vault-form" autocomplete="off">
          <input name="url" type="url" placeholder="https://cloud.exemple.fr" value="${esc(info.setup?.defaultUrl || '')}" required />
          <div class="vault-form-actions"><button class="primary-btn" type="submit">${icon('cloud', 14)}<span>Se connecter avec Nextcloud</span></button></div>
          <p class="vault-help small">Ton navigateur s’ouvre sur Nextcloud : connecte-toi et autorise Yariche.</p>
        </form>`
      const form = box.querySelector('form')
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const prepared = prepareExternalWindow()
        setBusy('Termine la connexion dans ton navigateur…')
        login = connectWithBrowser({
          api,
          url: form.url.value.trim(),
          prepared,
          onWaiting: () => {},
          onDone: async (r) => {
            setBusy(null)
            info = { ...info, ...r.vault, setup: r.setup }
            toast(`Connecté à ${hostOf(info.nextcloud.server)}`)
            render()
          },
          onError: (message) => {
            setBusy(null)
            toast(message)
          },
        })
      })
      return
    }
    box.innerHTML = `
      <div class="vault-label">${icon('cloud', 14)}<span>Nextcloud</span>
        <span class="vault-account">${esc(nc.user)} · ${esc(hostOf(nc.server))}</span>
        ${nc.fromEnv ? '' : '<button class="link-btn" data-act="disconnect">Déconnecter</button>'}
      </div>
      <div class="vault-nc-browser"></div>`
    box.querySelector('[data-act="disconnect"]')?.addEventListener('click', async () => {
      if (!confirm('Déconnecter Nextcloud ? La synchronisation s’arrête, les fichiers restent des deux côtés.')) return
      const r = await run(() => api('/api/nextcloud/disconnect', { method: 'POST' }), 'Déconnexion…')
      setBusy(null)
      if (r?.ok) {
        info = { ...info, ...r.vault }
        renderIndicators()
        render()
      }
    })
    const startPath = info.remote ? info.remote.folder.split('/').slice(0, -1).join('/') || '/' : '/'
    createFolderBrowser(box.querySelector('.vault-nc-browser'), {
      api,
      toast,
      startPath,
      vaults,
      busy: setBusy,
      // Coffre pas encore dans Nextcloud : le dossier choisi l'accueille (avec ses notes)
      onUse: async (folder) => {
        if (!info.remote) {
          const r = await run(() => api('/api/vault/link', { method: 'POST', body: JSON.stringify({ folder }) }), 'Préparation du dossier…')
          if (r?.ok) reloadInto(baseName(folder))
          return
        }
        openRemote(folder)
      },
    })
  }

  function renderLocal() {
    const box = document.getElementById('vault-local')
    const local = vaults.filter((v) => !v.remote || v.active)
    box.innerHTML = `
      <div class="vault-label">${icon('vault', 14)}<span>Coffres sur ce serveur (sans Nextcloud)</span></div>
      <div class="vault-list">${local
        .map(
          (v) => `<button class="vault-row${v.active ? ' active' : ''}" data-id="${esc(v.id)}">
            ${icon(v.remote ? 'cloud' : 'vault', 16)}
            <span class="vault-row-name">${esc(v.remote ? baseName(v.remote.folder) : v.id)}</span>
            <span class="vault-row-where">${v.remote ? `Nextcloud ${esc(v.remote.folder)}` : 'sur ce serveur'}</span>
            ${v.active ? `<em>ouvert</em>` : ''}
          </button>`
        )
        .join('')}</div>
      <form class="vault-new">
        <input name="name" placeholder="Nouveau coffre sur ce serveur" maxlength="100" />
        <button class="secondary-btn" type="submit">${icon('plus', 14)}<span>Créer</span></button>
      </form>`
    box.querySelectorAll('.vault-row').forEach((b) => b.addEventListener('click', () => openVault(b.dataset.id)))
    box.querySelector('.vault-new').addEventListener('submit', async (e) => {
      e.preventDefault()
      const name = new FormData(e.target).get('name')?.toString().trim()
      if (!name) return
      const r = await run(
        () => api('/api/vaults/create', { method: 'POST', body: JSON.stringify({ name }) }),
        'Création du coffre…'
      )
      if (r?.ok) reloadInto(r.vault.name || r.vault.id)
    })
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })
  document.getElementById('vault-close').addEventListener('click', close)
  syncEl.addEventListener('click', syncNow)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close()
  })

  // Après un changement de coffre : petit rappel de ce qui vient d'être ouvert
  try {
    const opened = sessionStorage.getItem('yariche-vault-opened')
    if (opened) {
      sessionStorage.removeItem('yariche-vault-opened')
      setTimeout(() => toast(`Dossier « ${opened} » ouvert`), 600)
    }
  } catch {
    /* rien */
  }

  return { refresh, openModal, openSwitcher, syncNow, get info() { return info } }
}
