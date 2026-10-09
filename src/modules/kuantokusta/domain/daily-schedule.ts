import { lisbonDailyInstant } from './lisbon-time'

/**
 * Whether today's scheduled collection still has to be asked for.
 *
 * It is due from the scheduled time until the end of the Lisbon day, once
 * per day. If the service was down at the scheduled time, the run is asked
 * for when it comes back, as long as it is still the same day.
 */
export function isDailyRunDue(
  now: Date,
  /** HH:MM, Portugal time. */
  time: string,
  /** When a scheduled run was last asked for, if ever. */
  lastScheduledAt: Date | null
): boolean {
  const dueAt = lisbonDailyInstant(now, time)
  if (now.getTime() < dueAt.getTime()) return false
  return lastScheduledAt === null || lastScheduledAt.getTime() < dueAt.getTime()
}
