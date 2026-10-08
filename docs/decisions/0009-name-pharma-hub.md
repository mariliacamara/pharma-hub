# 0009. The service is named Pharma Hub

- Status: Accepted. Refined by decision 0014: this is the technical name; clients see their own.
- Date: 2026-10-08

## Context

The service started as a KuantoKusta price middleware and became a hub for several
integrations (decision 0002), so its name should not mention KuantoKusta. It needs a name
for the repository, the deployment and the WordPress plugins that talk to it.

## Decision

The service is named Pharma Hub: "Pharma Hub" in prose, `pharma-hub` in repository,
package and URL names, `pharma_hub` in database identifiers.

## Consequences

- The name says what the service is without explanation and covers any future integration
  for a pharmacy store.
- It ties the service to the pharmacy sector. Serving another kind of store would make the
  name misleading.
- The name is generic and has not been checked against existing brands or domains. That
  only matters if the service is ever offered publicly under this name.

## Alternatives rejected

- Mortar: a nicer double meaning, but it needs explaining.
- Camorim Connect: ties the service to the agency rather than to what it does.
- Relay: sector-neutral, but says nothing about the service.
