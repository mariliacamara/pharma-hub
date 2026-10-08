# 0014. A neutral technical name, and a client-facing name per store

- Status: Accepted
- Date: 2026-10-08

## Context

"Pharma Hub" (decision 0009) is generic, and the client group wanted its own name on the
tool. Candidates were "ZincoGroup PharmaHub", "Zinco PharmaHub" and "ZincoGroup Hub".
Putting a client's name in the code, the repository and the URLs would tie the service to
that client and suggest it belongs to them.

## Decision

- The technical name stays Pharma Hub (`pharma-hub`, `pharma_hub`). It is used in code,
  repository, database and infrastructure, and is never shown to a client.
- The name a client sees in the panel and in the plugin is data: `stores.brand_name`.
- For ZincoGroup's stores the name is "ZincoGroup Hub".

## Consequences

- ZincoGroup gets its own name on the tool, and another client could get theirs without
  renaming anything.
- The name is stored per store, so stores of the same group must be given the same value.
  If groups with many stores appear, a group entity would be the cleaner place for it.
- Screens shown before the store is known (the login page) cannot use a client's name and
  show a neutral default.
- Interface texts must take the product name from the setting, never hard-code it.

## Alternatives rejected

- "ZincoGroup PharmaHub": long, reads like a department.
- "Zinco PharmaHub": sounds like a product, but "zinco" is also the mineral, and the tool
  is internal to the group rather than a product to sell under that name.
- One name everywhere, containing the client's name: ties code and infrastructure to one client.
