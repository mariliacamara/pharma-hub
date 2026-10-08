# 0020. Operator commands, until the admin API exists

- Status: Accepted
- Date: 2026-10-08

## Context

A plugin route needs a token, a token belongs to a store, and both have to be created by
someone. The plan is an admin API behind Google sign-in (decision 0008), which is not
built yet. The first store still has to be created somehow.

## Decision

A command-line entry point in the same image: `node dist/cli.js <command>`.

| Command | Does |
|---|---|
| `store:create`, `store:list` | Creates and lists stores |
| `token:issue`, `token:list`, `token:revoke` | Manages plugin tokens |
| `kk:set-key` | Asks for the KuantoKusta key, checks it with KuantoKusta, stores it encrypted |
| `kk:sync-offers` | Copies the store's offers from KuantoKusta now |
| `kk:status`, `kk:check-keys` | Show the state; reveal nothing |

- The commands call the same services as the HTTP routes. There is no second
  implementation of anything.
- They run inside the service's container, as the same database role. Whoever can run
  them could already reach the database, so they open no new door.
- Every change is written to `audit_events` with the actor `system` / `cli`.
- A secret is never an argument. `kk:set-key` asks for the key without showing it, or
  reads it from standard input (`printf %s "$KEY" | node dist/cli.js kk:set-key ...`),
  because arguments end up in the shell history and in the process list.
- A token is printed once, when issued, and cannot be shown again.

## Consequences

- Until the admin API exists, creating a store or a token needs shell access to the
  running service.
- The audit log cannot say which person ran a command, only that it was the command line.
- The copy of the offers runs inside the command, in the foreground. It moves into the
  scheduled worker in the next step; the command stays as a manual trigger.
- When the admin API exists these commands remain as a recovery tool; creating stores
  and tokens moves to the panel.

## Alternatives rejected

- Build sign-in first: weeks of work before anything about prices could be tried.
- Create the first store from environment variables at start-up: a secret-bearing side
  effect of booting, easy to trigger twice and hard to audit.
- A setup route protected by a shared secret: a permanent public door for a job done once.
