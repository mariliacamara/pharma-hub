# 0001. Link offers through the Seller API and read product pages; do not use the site search

- Status: Accepted
- Date: 2026-10-08

## Context

The goal is to compare a store's prices with competitors on KuantoKusta. There is no
official API for competitor prices. The first plan was to find each product by searching
the site for its EAN.

Two facts ruled that out. The site's robots.txt disallows `/search`, and only 374 of
Zincomed's 2,314 products have an EAN.

## Decision

Use the official Seller API (`GET /v2/kms/offers`) to list the store's offers; each offer
carries the URL of its KuantoKusta product page. Read those pages, which robots.txt
allows, to get the other stores' prices.

## Consequences

- No EAN is needed to find the page.
- Coverage is limited to products the store already lists on KuantoKusta.
- Each store needs its own Seller API key.
- Reading pages depends on the site's structure and on its bot protection staying
  tolerant. Permission from KuantoKusta is still pending.

## Alternatives rejected

- Site search by EAN: disallowed by robots.txt.
- Third-party scrapers (Apify): they run the same disallowed search from another server.
- Ignoring robots.txt or imitating a browser: the stores are commercial partners of
  KuantoKusta, and the risk to the seller account outweighs the gain.
- `isTopBox` from the API as the competitiveness signal: it disagreed with the page in
  2 of 20 cases.
