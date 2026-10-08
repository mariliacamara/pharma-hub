# 0008. Admin API in the core from the start; people sign in with Google

- Status: Accepted
- Date: 2026-10-08

## Context

Someone has to create stores, issue plugin tokens and set credentials. A separate
front end may be built later to see everything in one panel. People are a different kind
of principal from plugins: they log in from a browser and may reach more than one store.

## Decision

- The admin API is part of the core from day one. The panel UI can come later; until
  then the same routes are used from the command line.
- People sign in with Google (OpenID Connect, authorization code with PKCE). Only emails
  already registered in `users` are accepted; on first login the Google account id is
  bound to the user and used from then on.
- Sessions are server-side, in an http-only cookie, with sliding and absolute expiry.
- Access to stores is granted per person in `store_memberships`. Creating stores and
  managing users requires the platform admin role.
- Sensitive actions are written to `audit_events`.

## Consequences

- No passwords to store and no "forgot password" flow to defend.
- The second factor is delegated to Google: the hub cannot verify that a personal Google
  account has 2-step verification on. Every admin must enable it.
- Losing access to the Google account means losing access to the panel until another
  platform admin re-registers the person.
- Who uses the panel was settled later, in decision 0010.

## Alternatives rejected

- Own passwords plus a TOTP code: more code and more attack surface for a very small team.
- A long-lived admin token: no per-person accountability and nothing to revoke per person.
