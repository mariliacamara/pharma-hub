# 0026. A refusal by the website stops every store, and the daily schedule is off until agreed

- Status: Accepted
- Date: 2026-10-08

## Context

KuantoKusta has not yet said whether a daily automated read of product pages is accepted
(`open-questions.md`). The site uses bot protection, and one test run was refused.
Insisting after a refusal risks the address the hub runs from, and with it the standing
of the stores, who are KuantoKusta's customers.

## Decision

How the hub reads the website:

- It says who it is. The name is a setting (`KK_COLLECTOR_USER_AGENT`), and the service
  refuses to start with one that imitates a browser.
- It reads `robots.txt` before any page, on every collection that needs a page. If the
  rules cannot be obtained, or what comes is not a robots.txt, nothing is read.
- It reads product pages only, on the one configured site. A redirect is followed once,
  and only to the same product on the same site.
- One page at a time, five seconds apart or what `robots.txt` asks if that is more.

When the website says no:

- Three refusals in a row end the collection as `blocked`. A refusal is a 403, a 429, or
  a challenge page whatever its status. A refusal is never retried.
- For the next 30 minutes no collection of any store goes to the website at all.
- A person cannot ask for a new collection for an hour after a refusal, or after any
  failure that came from the website. After a good collection the wait is 15 minutes;
  after a failure on the hub's side, one minute.
- Ten pages in a row that came back unusable without being refused also end the
  collection: the site changed its pages (`page_layout_changed`) or is in trouble
  (`site_unavailable`). Reading on would be hundreds of requests for nothing.

The schedule:

- The daily collection is **off** unless `KK_COLLECTION_DAILY_AT` is set. Until
  KuantoKusta agrees, a collection runs only when a person asks for one.

## Consequences

- The worst the hub does to a website that refuses it is three requests and a look at
  `robots.txt`, then nothing for half an hour, for all stores together.
- An operator who wants to try again sooner (after KuantoKusta allows the hub, say) has
  to wait out the 30 minutes; `--ignore-wait` only skips the per-store wait.
- A collection stopped this way still compares the pages it had read.
- The report is not refreshed daily until the variable is set.

## Alternatives rejected

- Retry a refused page with a longer pause: it is still insisting.
- Imitate a browser, rotate addresses or solve the challenge: getting around a refusal
  is not something this project does.
- Turn the schedule on by default: it would start daily reads on the first deploy,
  before anyone agreed to them.
