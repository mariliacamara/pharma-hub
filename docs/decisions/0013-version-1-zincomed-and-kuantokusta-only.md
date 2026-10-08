# 0013. Version 1 covers Zincomed and KuantoKusta only

- Status: Accepted
- Date: 2026-10-08

## Context

The design grew to cover two stores and two integrations. The 4DPharma integration and the
Farmácia Nova Porto project do not exist yet and will be started later. The client is
waiting for one thing: the price comparison for Zincomed.

## Decision

Version 1 is the core plus the KuantoKusta module, for Zincomed. 4DPharma and Farmácia
Nova Porto are deferred. Nothing specific to them is designed or built now.

## Consequences

- The shape chosen in decision 0002 stays: one service, a core, one module per
  integration, several stores. It is already designed and costs little to keep, and it
  avoids redoing the foundations when the deferred work starts.
- What is removed is everything that existed only for the deferred work: the `fourdpharma`
  credential provider in the schema, and the open questions about 4DPharma and Nova Porto.
- The argument for a shared service (decision 0002) rested partly on 4DPharma. If that
  integration never happens, the service is simply a KuantoKusta backend with a little
  unused generality.

## Alternatives rejected

- Design the 4DPharma module now: its scope is unknown, so it would be guesswork.
- Strip the design down to a single store: removing multi-store support would save very
  little and would have to be redone for the second store.
