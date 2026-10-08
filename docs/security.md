# Security

Status: the database-level protections, plugin tokens, credential encryption and the
Seller API client are built and tested. The admin sign-in is designed and not built yet.
An independent review of the code was done on 2026-10-08; what it found and what was
done about it is at the end. Last updated 2026-10-08.

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

As built:

- Each encryption uses a new random 96-bit nonce. The 16-byte authentication tag is
  stored with the ciphertext and required on decryption, so altered data, or the wrong
  master key, fails instead of yielding garbage.
- The store, the provider and the key version are authenticated with the ciphertext. A
  ciphertext copied into another store's row does not decrypt there.
- A key is stored only after KuantoKusta has accepted it. A refused key, or one that
  could not be checked, is not stored and the previous one stays.
- At most 5 keys a minute can be tried per store. Each try makes the hub call
  KuantoKusta once, with a key the caller chose; without a cap, a stolen plugin token
  could make the hub knock on that API until the hub's address is blocked for everyone.
- The key is a parameter of each outbound call. It is never logged, never put in an
  error, never in the audit log, and never accepted as a command-line argument.

### The Seller API client only reads

The same key changes prices and stock and approves or cancels orders. The client can
send one kind of request: `GET /v2/kms/offers`. It refuses to follow a redirect, so the
key cannot be carried to another address, and in production the configured address must
be on `kuantokusta.pt`. A test fails if any request other than that GET is sent.

### The product page URL

The Seller API returns, for each offer, the URL of its product page on KuantoKusta. The
price collection will fetch that URL, so it is the one field through which a faulty or
hostile API answer could make the hub request an arbitrary address.

Only a plain product page is accepted: `https://www.kuantokusta.pt/p/<id>/<slug>`, with
the slug limited to letters, digits and `-._~`. The text must already be that URL,
character for character. A URL parser forgives a great deal (backslashes, tabs and line
breaks inside, a missing slash, a host written in another alphabet), and a different
parser may read the same forgiving text as a different host. Nothing forgiving is
stored. All 347 real URLs seen on 2026-10-08 satisfy the rule.

The URL of the product on the store's own site is never fetched by the hub. It is stored
in normalised form for the plugin, which must treat it as untrusted text.

### Plugin token

In the hub:

- A token is `phk_` followed by 256 random bits. The fixed start lets a secret scanner
  recognise a leaked token.
- Only the SHA-256 hash is stored. The token is random (256 bits), so a fast hash is
  enough and a database leak yields nothing usable.
- It is accepted only in the `Authorization: Bearer` header. An unknown, a revoked and an
  expired token get the same answer; the log says which it was.
- Every route is closed unless it is marked public (decision 0022).
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

### Every answer

- An error the service raises on purpose carries a stable code and a message written for
  the caller. Anything unexpected is answered with `internal_error` and nothing else;
  the detail goes to the log, under the request id the caller received.
- Validation errors name the field and the rule, never the value sent.
- The log line of a request has the route pattern, the status, the store and the token
  prefix. It has no query string, no body and no token.

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
- Losing the master key makes every stored credential unreadable. Each store then has to
  enter its key again. There is no command yet that re-encrypts every credential after a
  rotation, so an old master key has to be kept until each store's key was set again.
- Nothing ties a KuantoKusta key to a store. A key of store B entered for store A is
  accepted, and A's offers would then be B's. The offers API returns no seller identity
  to check against.
- The limits on outbound calls (per key, and per store for key attempts) are counted in
  the memory of one process. A restart resets them, a second instance would count on its
  own, and an operator command is a separate process. The handling of KuantoKusta's own
  429 answer is the safety net.
- There is no limit yet on how many requests a token, or an address, may make.
- Until the admin API exists, creating stores and tokens needs shell access to the
  service, and the audit log records "the command line", not a person (decision 0020).
- On Railway the owner's database connection is present in the running service's
  environment, because the migration step shares the service's variables. The service
  never reads it.

## Independent review, 2026-10-08

The code of this step was reviewed by a second pass that had not written it, for
security and for failure in production. No way for one store to read or change another
store's data was found. What it did find:

| Finding | Done |
|---|---|
| The product page URL was checked with a forgiving parser and stored as received | Fixed: see "The product page URL" |
| The token guard was applied per controller, so a new controller could be left open | Fixed: decision 0022 |
| An empty or cut-short answer from KuantoKusta would mark the whole catalogue as delisted | Fixed: a large disappearance is held back until confirmed (`kuantokusta.md`) |
| A NUL character in a product name made the database refuse the whole batch, on every run | Fixed: text is made printable before it is stored |
| A 403 page from a firewall was reported as "KuantoKusta refused the key" | Fixed: only the API's own error format means that |
| Verifying a key retried up to three times; the client kept a rate counter per key forever; many large pages could add up without limit | Fixed: one attempt, a bounded table, a limit on the whole list and a deadline |
| A body larger than the limit was answered as an internal error | Fixed |
| Without `NODE_ENV`, the service ran in development mode, with the API reference public | Fixed: production is the default |
| In production the Seller API address was only required to be https | Fixed: it must be on `kuantokusta.pt` |
| A failed copy was logged without its cause; refused tokens without a reason; a broken database connection not at all | Fixed |
| A wrong master key was only noticed at the next collection | `kk:check-keys` |
| The shared product row takes its name from the last store that wrote it | Accepted and documented in `architecture.md` |
| No seller identity check; in-memory limits; no request throttling; no re-encryption command | Listed under "Limits of this design" and in `open-questions.md` |

