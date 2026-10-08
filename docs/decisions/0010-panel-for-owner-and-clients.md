# 0010. The panel is used by the owner and by clients, each client limited to their store

- Status: Accepted
- Date: 2026-10-08

## Context

Decision 0008 left open who signs in to the panel. The answer is the owner and the
clients. A client must see their own store and nothing else, and should not be able to
touch the things that connect the store to the hub.

## Decision

- Every person is a row in `users`. Access to a store comes only from a row in
  `store_memberships`.
- Three roles, each including the previous: `viewer` (reads reports and runs), `operator`
  (also triggers runs and changes report settings), `manager` (also replaces credentials
  and issues or revokes plugin tokens).
- A client is a member of their own store only, with the `operator` role: they see the
  report and refresh it, and cannot replace credentials or revoke tokens. Confirmed by
  the owner.
- The owner is a platform admin and a `manager` of each store. The platform admin role
  creates stores and manages users; it does not by itself give access to store data.

## Consequences

- Roles and memberships are needed in version 1, not later.
- A client can refresh their report but cannot break the integration by replacing a key
  or revoking a token. If a client should manage those too, make them a `manager`.
- The panel now has users outside the team, so the store isolation in the database
  (decision 0004) is what stands between two clients' data.
- Every client needs a Google account to sign in (decision 0008). The owner confirmed the
  current clients have one.
- The panel's interface must be in Portuguese for clients, even though code and
  documentation are in English.

## Alternatives rejected

- Panel for the owner only, clients use the WordPress plugin: rejected by the owner.
- Two roles (`viewer`, `manager`): a client who should refresh the report would have to be
  a `manager` and could then replace credentials.
