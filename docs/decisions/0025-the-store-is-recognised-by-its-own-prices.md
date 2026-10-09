# 0025. The store is recognised on the pages by its own prices

- Status: Accepted
- Date: 2026-10-08

## Context

To compare, the hub must know which of the stores listed on a product page is its own.
The page identifies stores by a name in the address (`storeSlug`) and a number
(`sellerId`). The Seller API returns neither. Asking someone to look it up and type it
in is one more step to forget, and a typo makes every comparison wrong without any
error.

## Decision

- The hub works it out. It knows the store's price for each offer (Seller API) and sees
  every store's price on each page. The hub's store is the one whose price on the page
  equals the store's own price on nearly every page.
- The answer is accepted only when it is clear: at least 5 readable pages, a match on at
  least 60% of them, and at least twice as many matches as the next store.
- Once found, the name and the number are stored (`kk_store_settings`) and used from
  then on. The number is preferred; it is learned later if the pages did not show it.
- An operator can set or correct it: `kk:configure --kk-slug ...`.
- When it cannot be worked out, the collection ends as `store_identity_unknown`, nothing
  is compared, and the pages already read are kept. After `kk:configure`, the next
  collection compares from those same readings.
- Two stores of the hub can never have the same name or number. If that would happen,
  the second is not recognised, and is told only that.
- A name or number read from a page is third-party text. It is stored only if it has
  the shape of one.

## Consequences

- A new store needs no extra setup step for this.
- A store with fewer than five offers in stock has to be configured by hand.
- 60%, not 100%: after a price change the page keeps the old price until KuantoKusta
  re-imports the catalogue, and the store is sometimes absent from a page.
- The first collection of a store trusts the pages of that one day. `kk:status` shows
  what was recognised, so a wrong guess is visible.

## Alternatives rejected

- Search the page for the store's name: names repeat inside other names, and the
  displayed name can change.
- Require it to be typed in before the first collection: an avoidable step, and the
  mistake is silent.
