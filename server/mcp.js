// Serveur MCP (Model Context Protocol) : une IA (tout client
// MCP) travaille sur le coffre au nom de la personne qui a créé le jeton, avec ses droits.
// Transport « Streamable HTTP » sans état : POST /mcp, jeton dans Authorization: Bearer.
// Les écritures passent par le même chemin qu'un éditeur extérieur (Obsidian, Nextcloud) :
// version précédente gardée dans l'historique, éditeurs ouverts prévenus.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const INSTRUCTIONS = `Yariche: a vault of Markdown notes organised like an Obsidian vault, stored in Nextcloud.
- A page id is its path in the vault without extension, e.g. "R521/Concepts/MIMO". Folders are ids too.
- Links between pages use [[Name]] (or [[Folder/Name]] when the name is ambiguous); #tags work like Obsidian.
- update_page replaces or appends to the page body; the YAML front matter is kept. The previous version is kept in the page history, and people who have the page open are asked to reload.
- Write in the language of the existing notes (usually French). Prefer small, targeted edits: read the page first.`

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })
const id = z.string().min(1).max(500).describe('Page id: its path in the vault without extension, e.g. "R521/Concepts/MIMO"')

// ctx : fonctions du serveur (droits, lecture, écriture) — voir index.js
function buildServer(ctx, auth) {
  const { owner: email, scope, name: tokenName } = auth
  const server = new McpServer({ name: 'yariche', version: '1.0.0' }, { instructions: INSTRUCTIONS })
  const guard = (tool, fn) => async (args) => {
    try {
      ctx.log(`[mcp] ${tokenName} (${email}) ${tool}${args?.id ? ` ${args.id}` : args?.path ? ` ${args.path}` : ''}`)
      return await fn(args)
    } catch (err) {
      return fail(err.message)
    }
  }
  const readable = (pageId) => {
    if (!ctx.validId(pageId) || ctx.isTrashId(pageId) || !ctx.role(pageId, email)) throw new Error(`page introuvable : ${pageId}`)
  }

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List the pages and folders you can access (ids, types). Optionally only inside a folder.',
      inputSchema: {
        folder: z.string().max(500).optional().describe('Only items inside this folder id'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of items (default 1000)'),
      },
      annotations: { readOnlyHint: true },
    },
    guard('list_pages', async ({ folder, limit = 1000 }) => {
      const items = ctx
        .listPages(email)
        .filter((e) => !folder || e.id.startsWith(`${folder.replace(/\/+$/, '')}/`))
        .sort((a, b) => a.id.localeCompare(b.id, 'fr', { numeric: true }))
      const shown = items.slice(0, limit)
      return text(`${shown.map((e) => `${e.type}\t${e.id}`).join('\n')}${items.length > shown.length ? `\n… ${items.length - shown.length} de plus` : ''}` || 'aucune page')
    })
  )

  server.registerTool(
    'search_pages',
    {
      title: 'Search pages',
      description: 'Full-text search in the content of the pages (and database rows) you can access.',
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard('search_pages', async ({ query, limit = 20 }) => text(ctx.search(email, query, limit)))
  )

  server.registerTool(
    'read_page',
    {
      title: 'Read a page',
      description: 'Read a page: Markdown body and YAML front matter (databases: their rows; whiteboards: their notes).',
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    guard('read_page', async ({ id: pageId }) => {
      readable(pageId)
      return text({ id: pageId, role: ctx.role(pageId, email), ...ctx.readPage(pageId, email) })
    })
  )

  server.registerTool(
    'get_backlinks',
    {
      title: 'Backlinks',
      description: 'Pages that link to this page with [[…]].',
      inputSchema: { id },
      annotations: { readOnlyHint: true },
    },
    guard('get_backlinks', async ({ id: pageId }) => {
      readable(pageId)
      return text(ctx.backlinks(pageId, email))
    })
  )

  if (scope !== 'write') return server

  server.registerTool(
    'create_page',
    {
      title: 'Create a page or folder',
      description: 'Create a Markdown page (or a folder) at the given path. Missing parent folders are created.',
      inputSchema: {
        path: z.string().min(1).max(500).describe('New id, e.g. "R521/TP/TP05 Compte rendu"'),
        content: z.string().max(2_000_000).optional().describe('Markdown body of the new page'),
        type: z.enum(['doc', 'folder']).optional().describe('doc (default) or folder'),
      },
    },
    guard('create_page', async ({ path, content, type = 'doc' }) => {
      const created = ctx.createNode(path.normalize('NFC').replace(/^\/+|\/+$/g, ''), type, email)
      if (type === 'doc' && content) ctx.writeBody(created, content)
      return text({ ok: true, id: created })
    })
  )

  server.registerTool(
    'update_page',
    {
      title: 'Update a page',
      description: 'Replace the Markdown body of a page, or append to it. The YAML front matter is kept; the previous version stays in the page history.',
      inputSchema: {
        id,
        content: z.string().max(2_000_000),
        mode: z.enum(['replace', 'append']).optional().describe('replace (default) or append'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard('update_page', async ({ id: pageId, content, mode = 'replace' }) => {
      readable(pageId)
      if (!ctx.canEdit(ctx.role(pageId, email))) throw new Error('page en lecture seule pour ce compte')
      const page = ctx.readPage(pageId, email)
      if (page.type !== 'doc') throw new Error('seules les pages Markdown se modifient ici')
      const body = mode === 'append' ? `${page.content.replace(/\s*$/, '')}\n\n${content}` : content
      const changed = ctx.writeBody(pageId, body)
      return text({ ok: true, id: pageId, changed })
    })
  )

  server.registerTool(
    'move_page',
    {
      title: 'Rename or move',
      description: 'Rename or move a page or folder (with its content) to a new path. Links [[…]] pointing to it are updated.',
      inputSchema: { id, new_path: z.string().min(1).max(500) },
    },
    guard('move_page', async ({ id: pageId, new_path: to }) => {
      readable(pageId)
      return text({ ok: true, ...ctx.movePage(pageId, to.normalize('NFC').replace(/^\/+|\/+$/g, ''), email) })
    })
  )

  server.registerTool(
    'trash_page',
    {
      title: 'Move to trash',
      description: 'Move a page or folder (with its content) to the trash. Reversible from Yariche.',
      inputSchema: { id },
      annotations: { destructiveHint: true },
    },
    guard('trash_page', async ({ id: pageId }) => {
      readable(pageId)
      return text({ ok: true, trashId: ctx.trashPage(pageId, email) })
    })
  )

  return server
}

export function registerMcp(app, ctx) {
  app.post('/mcp', async (req, res) => {
    const header = String(req.get('authorization') || '')
    const auth = ctx.verifyToken(header.startsWith('Bearer ') ? header.slice(7).trim() : '')
    if (!auth) {
      res.set('WWW-Authenticate', 'Bearer realm="yariche"')
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'jeton manquant ou invalide' }, id: null })
    }
    const server = buildServer(ctx, auth)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      ctx.log(`[mcp] erreur : ${err.message}`)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'erreur interne' }, id: null })
    }
  })
  // Sans état : pas de flux SSE ni de session à fermer
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end())
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end())
}
