// Zoom sur les images d'une page : clic pour agrandir, molette ou +/- pour zoomer,
// glisser pour déplacer, Échap ou clic sur le fond pour fermer.
const SELECTOR = '.ProseMirror img, .embed-image'

export function mountLightbox() {
  const root = document.createElement('div')
  root.className = 'lightbox hidden'
  root.innerHTML = '<img class="lightbox-img" alt="" draggable="false" />'
  document.body.appendChild(root)
  const img = root.querySelector('img')
  let scale = 1
  let x = 0
  let y = 0
  let drag = null

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }
  const open = (src, alt) => {
    img.src = src
    img.alt = alt || ''
    scale = 1
    x = 0
    y = 0
    apply()
    root.classList.remove('hidden')
  }
  const close = () => {
    root.classList.add('hidden')
    img.removeAttribute('src')
  }
  const zoom = (factor) => {
    scale = Math.min(8, Math.max(0.5, scale * factor))
    apply()
  }

  document.addEventListener('click', (e) => {
    const target = e.target.closest?.(SELECTOR)
    if (!target || target.classList.contains('missing') || target.closest('.board-view')) return
    if (!target.currentSrc && !target.src) return
    e.preventDefault()
    open(target.currentSrc || target.src, target.alt)
  })
  root.addEventListener('wheel', (e) => {
    e.preventDefault()
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }, { passive: false })
  root.addEventListener('pointerdown', (e) => {
    if (e.target !== img) return
    drag = { px: e.clientX, py: e.clientY, x, y, moved: false }
    img.setPointerCapture(e.pointerId)
  })
  root.addEventListener('pointermove', (e) => {
    if (!drag) return
    x = drag.x + e.clientX - drag.px
    y = drag.y + e.clientY - drag.py
    drag.moved = true
    apply()
  })
  root.addEventListener('pointerup', () => {
    drag = null
  })
  root.addEventListener('click', (e) => {
    if (e.target !== img) close()
  })
  img.addEventListener('dblclick', () => {
    scale = scale === 1 ? 2.5 : 1
    x = 0
    y = 0
    apply()
  })
  document.addEventListener('keydown', (e) => {
    if (root.classList.contains('hidden')) return
    if (e.key === 'Escape') close()
    else if (e.key === '+' || e.key === '=') zoom(1.25)
    else if (e.key === '-') zoom(0.8)
    else if (e.key === '0') {
      scale = 1
      x = 0
      y = 0
      apply()
    }
  })
}
