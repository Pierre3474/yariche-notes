// Outils d'administration en ligne de commande (dans le conteneur) :
//   node server/cli.js token create <compte> <nom> [read|write]   → affiche le jeton (une fois)
//   node server/cli.js token list [compte]
//   node server/cli.js token revoke <id>
//   node server/cli.js user create <identifiant> [nom]   → mot de passe lu sur l'entrée standard
//   node server/cli.js user passwd <identifiant>         → idem
//   node server/cli.js user list | user delete <identifiant>
import path from 'path'
import { fileURLToPath } from 'url'
import { initApiTokens, createApiToken, listApiTokens, revokeApiToken } from './api-tokens.js'
import { initAccounts, createAccount, setPassword, removeAccount, listAccounts } from './accounts.js'
import { initSettings, getSettings, updateSettings } from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'))
initApiTokens(DATA_DIR)
initAccounts(DATA_DIR)
initSettings(DATA_DIR)

const [, , area, action, ...args] = process.argv
const usage = () => {
  console.error('usage : node server/cli.js token create <compte> <nom> [read|write] | token list [compte] | token revoke <id>')
  console.error('        node server/cli.js user create <identifiant> [nom] | user passwd <identifiant> | user list | user delete <identifiant>')
  process.exit(2)
}
const readPassword = async () => {
  if (process.env.YARICHE_PASSWORD) return process.env.YARICHE_PASSWORD
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  return input.replace(/\r?\n$/, '')
}
if (area === 'user') {
  try {
    if (action === 'create') {
      if (!args[0]) usage()
      const account = await createAccount({ username: args[0], name: args.slice(1).join(' '), password: await readPassword() })
      if (listAccounts().length === 1 && !getSettings().firstUser) updateSettings({ firstUser: account.username })
      console.log(`compte créé : ${account.username}`)
    } else if (action === 'passwd') {
      if (!args[0]) usage()
      await setPassword(args[0], await readPassword())
      console.log('mot de passe changé')
    } else if (action === 'list') {
      for (const u of listAccounts()) console.log(`${u.username}\t${u.name}\t${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '-'}`)
    } else if (action === 'delete') {
      if (!args[0]) usage()
      console.log(removeAccount(args[0]) ? 'supprimé' : 'introuvable')
    } else usage()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  process.exit(0)
}
if (area !== 'token') usage()
if (action === 'create') {
  const [owner, name, scope = 'read'] = args
  if (!owner || !name) usage()
  process.stdout.write(`${createApiToken(owner.toLowerCase(), name, scope).token}\n`)
} else if (action === 'list') {
  for (const t of listApiTokens(args[0]?.toLowerCase())) console.log(`${t.id}\t${t.owner}\t${t.scope}\t${t.name}\t${t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : '-'}`)
} else if (action === 'revoke') {
  if (!args[0]) usage()
  console.log(revokeApiToken(null, args[0]) ? 'révoqué' : 'introuvable')
} else usage()
