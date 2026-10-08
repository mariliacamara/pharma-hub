# 0003. The KuantoKusta key is stored only in the hub

- Status: Accepted
- Date: 2026-10-08

## Context

Each store has its own Seller API key. The same key can change prices and stock and
approve or cancel orders. The plugin is where a store admin naturally configures things,
and WordPress is the most exposed part of the system.

## Decision

The key is typed in the plugin, forwarded once to the hub and not stored in WordPress.
The hub keeps it encrypted, one row per store and provider (`store_credentials`), with the
master key in the environment. No endpoint returns it.

## Consequences

- One copy of the key instead of two.
- The scheduled collection works without the plugin.
- Replacing the key means typing it again; it cannot be read back from anywhere.

## Alternatives rejected

- Key stored in the plugin and sent on every request: the scheduled job runs without the
  plugin, so the hub would need its own copy anyway.
