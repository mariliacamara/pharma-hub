# 0012. Portugal time everywhere a person or a schedule sees a time

- Status: Accepted
- Date: 2026-10-08

## Context

The stores and KuantoKusta operate in Portugal. The owner works from Brazil, and the
service runs on servers whose clock is UTC. The Seller API returns `updatedAt` without a
time zone. Without a rule, the same moment would appear with three different hours
depending on where it is read.

## Decision

The business time zone is `Europe/Lisbon`. It applies to:

- every time shown in the plugin, the panel and exported files, always labelled as
  Portugal time, whatever the viewer's own time zone;
- schedules: the daily collection is defined as an hour in Portugal;
- day boundaries in reports ("today's collection", "last 7 days");
- timestamps received without an offset, such as the Seller API's `updatedAt`.

Storage does not change: columns stay `timestamptz`, which records the absolute instant.
The conversion to Portugal time happens when reading and when scheduling.

## Consequences

- Everyone sees the same hour for the same event.
- Portugal changes its clocks twice a year. Storing the instant, not the local hour, keeps
  the history correct across those changes: a local hour stored without zone is ambiguous
  for one hour in October and does not exist for one hour in March.
- A schedule written in UTC would drift by an hour between summer and winter, so the
  scheduler must be given the time zone, not a fixed UTC hour.
- Reading the API's `updatedAt` as Portugal time is an assumption. It has not been
  confirmed with KuantoKusta.

## Alternatives rejected

- Store local Portugal time in `timestamp` columns: breaks on clock changes and makes
  intervals wrong.
- Show times in each viewer's own time zone: the owner in Brazil and a client in Portugal
  would read different hours for the same collection.
