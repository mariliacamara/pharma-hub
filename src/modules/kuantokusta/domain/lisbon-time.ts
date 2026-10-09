/**
 * The Seller API sends times without an offset ("2026-10-08 00:49:45").
 * They are read as Portugal time (docs/decisions/0012).
 *
 * Lisbon is UTC+0 in winter and UTC+1 in summer, so the offset depends on
 * the date. It is taken from the runtime's time zone data rather than from a
 * rule written here, which would go stale if the law changed.
 */
const PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

const LISBON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Lisbon',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

/** How far Lisbon's clock is ahead of UTC at that instant, in ms. */
function lisbonOffsetAt(instantMs: number): number {
  const parts: Record<string, number> = {}
  for (const { type, value } of LISBON.formatToParts(new Date(instantMs))) {
    if (type !== 'literal') parts[type] = Number(value)
  }
  const shownAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return shownAsUtc - Math.floor(instantMs / 1000) * 1000
}

/**
 * Converts a Lisbon wall-clock time to the instant it names, or null when
 * the text is not a real date and time.
 *
 * Two wall-clock hours a year are special. The hour skipped in spring does
 * not exist; it is read as if the clock had not moved yet. The hour repeated
 * in autumn is read as its second occurrence (winter time).
 */
export function lisbonWallTimeToInstant(value: string): Date | null {
  const match = PATTERN.exec(value)
  if (!match) return null

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)

  // Date.UTC rolls impossible values over (month 13, 30 February, hour 25).
  // If the parts do not survive the round trip, the text was not a date.
  const check = new Date(wallAsUtc)
  const real
    = check.getUTCFullYear() === year
      && check.getUTCMonth() === month - 1
      && check.getUTCDate() === day
      && check.getUTCHours() === hour
      && check.getUTCMinutes() === minute
      && check.getUTCSeconds() === second
  if (!real) return null

  // The offset depends on the instant, which is what is being computed, so:
  // assume UTC, read the offset there, and correct once.
  const firstGuess = wallAsUtc - lisbonOffsetAt(wallAsUtc)
  return new Date(wallAsUtc - lisbonOffsetAt(firstGuess))
}

/** The calendar date in Lisbon at that instant, as YYYY-MM-DD. */
export function lisbonDateOf(instant: Date): string {
  const parts: Record<string, string> = {}
  for (const { type, value } of LISBON.formatToParts(instant)) {
    parts[type] = value
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * The instant at which a daily job set for `time` (HH:MM, Lisbon) is due on
 * the Lisbon day that contains `now`.
 *
 * Written in Lisbon time, so it stays at the same hour on the clock all
 * year. A schedule written in UTC would move by an hour twice a year.
 */
export function lisbonDailyInstant(now: Date, time: string): Date {
  const due = lisbonWallTimeToInstant(`${lisbonDateOf(now)} ${time}:00`)
  if (!due) throw new RangeError(`Not a time of day: ${time}`)
  return due
}
