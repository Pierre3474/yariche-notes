# Privacy notice (template)

Copy this file, replace the bracketed parts and publish it where your users can read it. It
describes what Yariche itself stores. Add what your own infrastructure does (reverse proxy
logs, backups, e-mail, AI endpoint).

**Controller:** [name or organization, contact address]
**Data protection contact:** [address, if you have one]

## What is processed

| Data | Why | Where | How long |
|---|---|---|---|
| Username, display name, password (hashed with scrypt, never stored in clear), creation and last sign-in dates | Sign in and show who edited | `data/accounts.json` on the server | Until the account is deleted |
| Session identifier (cookie `connect.sid`, `HttpOnly`, 30 days) | Keep you signed in | Cookie and `data/.sessions/` | 30 days, or until sign-out |
| Notes, attachments, comments, mentions, page versions | The service itself | `data/vaults/<vault>/` (and the linked Nextcloud folder if any) | Until deleted by the owner or an administrator |
| Access tokens for AI clients (hash only) | Let a tool act with your permissions | `data/api-tokens.json` | Until revoked or the account is deleted |
| Guest name typed on a share link | Show who is editing | Session of the guest | Until the link is disabled or the session ends |
| Technical logs (IP address, requests) | Security and debugging | Server and reverse proxy logs | [your retention, for example 30 days] |

Yariche has no analytics, no advertising, no tracking pixel and does not load fonts, scripts or
images from other sites. It does not sell or share data.

## Legal basis

Performance of the service you asked for (account and notes), and the operator's legitimate
interest in security (logs). The session cookie is strictly necessary, so it needs no consent.

## Recipients

Only the operator and, for shared pages, the people you share them with. [List processors:
hosting provider, Nextcloud server, AI endpoint if you use one, backup storage.] If an AI
endpoint is configured, the text of the page you ask the assistant about is sent to it.

## Your rights

You can ask for access, correction, erasure, restriction, portability and object to processing.
On `/account` you can download your account data and delete a local account yourself.
Otherwise write to [contact]. You can also complain to your data protection authority (in
France, the CNIL: cnil.fr).

## Security

HTTPS, hashed passwords, rate limiting, a strict Content Security Policy and per-page access
control. See `SECURITY.md` for the details. A data breach affecting you will be notified as
required by law.
