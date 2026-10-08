# Security

Status: the database-level protections are built and tested; token handling, credential
encryption and the admin sign-in are designed and not built yet. Last updated 2026-10-08.

## What is being protected

| Secret | Why it matters |
|---|---|
| KuantoKusta Seller API key (one per store) | Besides reading offers, the same API changes price and stock and approves or cancels orders. It is the most valuable secret in the system. |
| Plugin tokens | Give access to a store's report and to the "regenerate" action. |
| Admin sessions | Reach every store the person is a member of, including credential management. |

## Rules

### The KuantoKusta key lives only in the hub

The store admin types the key in the plugin settings; the plugin forwards it once and does
not store it. The hub needs the key anyway (the scheduled collection runs without the
plugin), so a second copy in WordPress would add exposure and no value.

In the hub the key is encrypted by the application (AES-256-GCM) with a master key kept in
the environment, never in the database. `key_version` allows rotating the master key.
No endpoint returns the key; the UI shows only "configured, ends in 1234".

### Plugin token

In the hub:

- Only the SHA-256 hash is stored. The token is random (256 bits), so a fast hash is
  enough and a database leak yields nothing usable.
- The store is derived from the token, never from the request.
- Each token has scopes (`prices:read`, `prices:refresh`, `credentials:write`). A token
  for the price report cannot trigger jobs of another module.
- Tokens can be revoked and expire optionally. Two tokens may be active at once, so a
  token can be replaced without downtime.

In WordPress:

- The token is stored in `wp-config.php`, or encrypted in the database with a key from
  `wp-config.php`.
- Calls to the hub are made by PHP, server to server. The token never reaches the browser.
- Secret fields are write-only in the settings screen.
- The token travels in the `Authorization` header over HTTPS, never in a URL.
- The page requires a store-management capability, and every action carries a nonce.

### Admin panel

People sign in with Google (decision 0008). There are no passwords in the hub.

- OpenID Connect, authorization code flow with PKCE. The `state` value is random and
  single-use, the redirect URI is an exact match, and the ID token's issuer, audience,
  expiry and `email_verified` are checked on every login.
- Only emails already registered in `users` are accepted. On first login the Google
  account id (`sub`) is bound to the user, and later logins match on it, so a recycled
  email address cannot take over an account.
- Sessions are server-side, in a cookie that JavaScript cannot read, with sliding and
  absolute expiry. Only the hash of the session id is stored. Logging out deletes the row.
- The panel is used by the owner and by clients (decision 0010). Access to a store is
  granted per person in `store_memberships`, with a role: `viewer`, `operator` or `manager`.
  A client is a member of their own store only. Creating stores and managing users
  requires the platform admin role, which no client has.
- Sensitive actions are recorded in `audit_events`: issuing or revoking a token,
  replacing a credential, triggering a run, changing a membership. The log never contains
  a secret, and the application role cannot update or delete its rows.
- Panel and API should be served from the same site, so cookies can be `SameSite` and the
  CORS allowlist is a single origin. Until the panel exists the service sends no CORS
  headers at all: its only client, the plugin, calls from a server (decision 0018).
- The API reference (`/docs`) is not served in production.

### Reading third-party pages

The KuantoKusta collector parses HTML from a site the project does not control. The
embedded JSON is treated as untrusted input: it is parsed, mapped to a fixed set of
fields, and stored. Nothing from it is executed or used to build URLs to fetch.

## Limits of this design

- Anyone with administrator access to a store's WordPress, or to its server, can obtain
  that store's plugin token. This cannot be prevented, so the token is limited instead:
  it reads its own store's comparisons, requests a refresh and replaces the KuantoKusta
  key. It cannot read the key or change prices.
- Anyone with access to both the database and the master key can decrypt the credentials.
- The second factor is delegated to Google. The hub cannot verify that a personal Google
  account has 2-step verification enabled, so every admin must turn it on.
- The hub holds a key that could change prices on KuantoKusta. Version 1 only calls
  read endpoints (`GET /v2/kms/offers`). Calling a write endpoint is a separate decision.
