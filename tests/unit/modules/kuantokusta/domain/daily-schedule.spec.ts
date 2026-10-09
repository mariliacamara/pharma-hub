import { describe, it, expect } from '@jest/globals'

import { isDailyRunDue } from '#/modules/kuantokusta/domain/daily-schedule'

const at = (iso: string) => new Date(iso)

// 8 October 2026 is in summer time: 06:30 in Lisbon is 05:30 UTC.
describe('isDailyRunDue', () => {
  it('is not due before the time of day', () => {
    expect(isDailyRunDue(at('2026-10-08T05:29:59Z'), '06:30', null)).toBe(false)
  })

  it('is due from the time of day on, when nothing ran today', () => {
    expect(isDailyRunDue(at('2026-10-08T05:30:00Z'), '06:30', null)).toBe(true)
    expect(
      isDailyRunDue(at('2026-10-08T05:30:00Z'), '06:30', at('2026-10-07T05:30:10Z'))
    ).toBe(true)
  })

  it('is not due again once today\'s run was asked for', () => {
    expect(
      isDailyRunDue(at('2026-10-08T09:00:00Z'), '06:30', at('2026-10-08T05:30:20Z'))
    ).toBe(false)
  })

  it('catches up later the same day if the service was down at the time', () => {
    expect(
      isDailyRunDue(at('2026-10-08T21:00:00Z'), '06:30', at('2026-10-07T05:30:10Z'))
    ).toBe(true)
  })

  it('follows the clock in Portugal across the change of hour', () => {
    // In winter 06:30 in Lisbon is 06:30 UTC.
    expect(isDailyRunDue(at('2026-12-01T05:45:00Z'), '06:30', null)).toBe(false)
    expect(isDailyRunDue(at('2026-12-01T06:30:00Z'), '06:30', null)).toBe(true)
  })

  it('uses the Lisbon day, not the UTC day', () => {
    // 23:30 UTC on the 7th is already 00:30 on the 8th in Lisbon.
    expect(
      isDailyRunDue(at('2026-10-07T23:30:00Z'), '00:15', at('2026-10-06T23:20:00Z'))
    ).toBe(true)
    expect(
      isDailyRunDue(at('2026-10-07T23:30:00Z'), '00:15', at('2026-10-07T23:16:00Z'))
    ).toBe(false)
  })
})
