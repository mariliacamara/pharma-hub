# 0007. Do not build on StockGrid

- Status: Accepted
- Date: 2026-10-08

## Context

StockGrid is an existing backend on the same stack. Much of it is undocumented and it
has become hard to follow.

## Decision

Start a new service. Do not add these integrations to StockGrid.

## Consequences

- No inherited undocumented behaviour.
- Shared needs are rebuilt. To avoid ending in the same place, this repository records
  every decision, keeps one README per module and puts invariants in the schema.

## Alternatives rejected

- Add modules to StockGrid: rejected by the owner because of its current state.
