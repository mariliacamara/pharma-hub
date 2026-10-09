# 0029. The plugin changes the easy-adjust threshold with the `prices:refresh` scope

- Status: Accepted
- Date: 2026-10-09

## Context

The "easy adjust" threshold is per store (`kk_store_settings.easy_adjust_cents`, 10 cents
by default) and is read on every request of the report, so changing it needs no
recalculation. The plugin needs a route to read and change it. Tokens have three scopes:
`prices:read`, `prices:refresh` and `credentials:write`. The roles planned for people
(`architecture.md`) put "trigger runs" and "change report settings" in the same role,
`operator`.

## Decision

- `GET /v1/plugin/kuantokusta/settings/easy-adjust` needs `prices:read`.
- `PUT /v1/plugin/kuantokusta/settings/easy-adjust` needs `prices:refresh`, the scope
  that already asks for collections.
- A change is written to the audit log (`kk_settings.easy_adjust_changed`, with the old
  and the new value), from the plugin and from `kk:configure` alike. Setting the value
  it already has records nothing.
- The settings row was first created only when the store's identity on KuantoKusta was
  known, so the route answered 409 `kk_settings_missing` before a first collection.
  Changed on 2026-10-09: the threshold can be set at any time. A row without an
  identity holds only the threshold, and the first collection adds the identity to it.
  Before any change, reading answers the default.

## Consequences

- Zincomed's token, issued with every scope, keeps working. (One migration came
  later, to let the row exist before the identity is known.)
- A token that can ask for collections can also change the threshold. The threshold only
  changes which rows are highlighted; it changes no price and reads nothing from
  KuantoKusta, so the extra power is small.

## Alternatives rejected

- A new scope (`prices:configure`): cleaner on paper, but it needs a migration of the
  `CHECK` on `api_tokens.scopes` and a new token for Zincomed, for a power that is
  smaller than the one `prices:refresh` already gives.
- `credentials:write`: it guards a secret; mixing a display setting into it would push
  every plugin to hold the most powerful scope.
