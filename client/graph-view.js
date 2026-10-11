// Vue graphe minimaliste : simulation de forces maison (pas de dependance
// type d3-force), rendu canvas. Suffisant pour quelques dizaines de pages.
export function renderGraph(canvas, { nodes, edges }, onNodeClick) {
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)
  const W = rect.width
  const H = rect.height

  const nodeList = nodes.map((id, i) => ({
    id,
    x: W / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * 120,
    y: H / 2 + Math.sin((i / nodes.length) * Math.PI * 2) * 120,
    vx: 0,
    vy: 0,
  }))
  const byId = Object.fromEntries(nodeList.map((n) => [n.id, n]))
  const edgeList = edges
    .map((e) => ({ a: byId[e.from], b: byId[e.to] }))
    .filter((e) => e.a && e.b)

  function step() {
    // Repulsion entre tous les noeuds
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i]
        const b = nodeList[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distSq = Math.max(dx * dx + dy * dy, 1)
        const force = 1800 / distSq
        const dist = Math.sqrt(distSq)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    // Attraction le long des aretes
    for (const e of edgeList) {
      const dx = e.b.x - e.a.x
      const dy = e.b.y - e.a.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const force = (dist - 90) * 0.02
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      e.a.vx += fx
      e.a.vy += fy
      e.b.vx -= fx
      e.b.vy -= fy
    }
    // Recentrage doux + damping + integration
    for (const n of nodeList) {
      n.vx += (W / 2 - n.x) * 0.001
      n.vy += (H / 2 - n.y) * 0.001
      n.vx *= 0.85
      n.vy *= 0.85
      n.x += n.vx
      n.y += n.vy
      n.x = Math.max(30, Math.min(W - 30, n.x))
      n.y = Math.max(30, Math.min(H - 30, n.y))
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H)
    const styles = getComputedStyle(document.documentElement)
    const border = styles.getPropertyValue('--border').trim() || '#888'
    const accent = styles.getPropertyValue('--ai-accent').trim() || '#7c5cff'
    const text = styles.getPropertyValue('--text').trim() || '#333'

    ctx.strokeStyle = border
    ctx.lineWidth = 1
    for (const e of edgeList) {
      ctx.beginPath()
      ctx.moveTo(e.a.x, e.a.y)
      ctx.lineTo(e.b.x, e.b.y)
      ctx.stroke()
    }
    for (const n of nodeList) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = accent
      ctx.fill()
      ctx.fillStyle = text
      ctx.font = '12px -apple-system, sans-serif'
      // Nœud = chemin dans le coffre ; étiquette = nom de la page
      ctx.fillText(n.id.slice(n.id.lastIndexOf('/') + 1), n.x + 12, n.y + 4)
    }
  }

  let frame = 0
  let raf
  function loop() {
    frame++
    if (frame < 220) step() // laisse la simulation se stabiliser puis se fige
    draw()
    raf = requestAnimationFrame(loop)
  }
  loop()

  function handleClick(ev) {
    const bounds = canvas.getBoundingClientRect()
    const x = ev.clientX - bounds.left
    const y = ev.clientY - bounds.top
    for (const n of nodeList) {
      if (Math.hypot(n.x - x, n.y - y) < 14) {
        onNodeClick(n.id)
        return
      }
    }
  }
  canvas.addEventListener('click', handleClick)

  return () => {
    cancelAnimationFrame(raf)
    canvas.removeEventListener('click', handleClick)
  }
}
