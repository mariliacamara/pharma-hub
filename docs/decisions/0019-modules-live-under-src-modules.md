# 0019. Each topic is a folder under `src/modules`

- Status: Accepted
- Date: 2026-10-08

## Context

The foundation kept code in `src/core/<thing>` and `src/<integration>`. The owner asked
for one convention: everything about a topic in one place, under `src/modules`.

## Decision

```
src/modules/<topic>/
  <topic>.module.ts
  controllers/    HTTP routes
  services/       what the module does; database access lives here
  domain/         pure rules: no database, no network, no framework
  guards/, decorators/   only where the topic needs them
```

- An integration is a module named after the external system: `kuantokusta` today,
  `fourdpharma` later.
- The parts every integration shares are modules too: `stores`, `api-tokens`,
  `credentials`, `audit`, `health`.
- `src/infra` holds what is not a topic: configuration, the database client, the HTTP
  plumbing (error shape, request id), id generation.
- Tests mirror the same tree under `tests/unit`.

## Consequences

- A module may import another module's service through its Nest module (`kuantokusta`
  uses `credentials` and `api-tokens`). It never reads another module's tables directly;
  that rule is unchanged.
- `domain/` code is the part with the strict coverage threshold.

## Alternatives rejected

- Folders by kind (`src/controllers`, `src/services`): a change to one integration would
  touch every folder.
