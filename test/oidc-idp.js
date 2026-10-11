// Faux fournisseur OpenID Connect pour les tests : signe de vrais jetons, connecte
// le compte choisi par setNextLogin() (« compte:nom » = compte sans email).
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

export async function startIdp() {
  let nextLogin = null
  let idpUrl
  const codes = new Map()
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, idpUrl)
    const json = (v, s = 200) => {
      res.writeHead(s, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(v))
    }
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer: idpUrl,
        authorization_endpoint: `${idpUrl}/authorize`,
        token_endpoint: `${idpUrl}/token`,
        userinfo_endpoint: `${idpUrl}/userinfo`,
        jwks_uri: `${idpUrl}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      })
    if (url.pathname === '/jwks') return json({ keys: [jwk] })
    if (url.pathname === '/authorize') {
      const code = `code-${Math.random().toString(36).slice(2)}`
      codes.set(code, nextLogin)
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state'))
      res.writeHead(302, { Location: back.href })
      return res.end()
    }
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of req) body += chunk
      const email = codes.get(new URLSearchParams(body).get('code'))
      const idToken = await new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idpUrl)
        .setAudience('yariche')
        .setSubject(email)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      return json({ access_token: `at:${email}`, token_type: 'Bearer', expires_in: 300, id_token: idToken })
    }
    if (url.pathname === '/userinfo') {
      const who = (req.headers.authorization || '').replace('Bearer at:', '')
      // « compte:nom » : compte SSO sans email, seulement un identifiant
      if (who.startsWith('compte:')) return json({ sub: who, preferred_username: who.slice(7), name: 'Sans Email' })
      return json({ sub: who, email: who, name: who.split('@')[0] })
    }
    json({}, 404)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  idpUrl = `http://127.0.0.1:${server.address().port}`
  return {
    url: idpUrl,
    setNextLogin: (who) => {
      nextLogin = who
    },
    close: () => server.close(),
  }
}
