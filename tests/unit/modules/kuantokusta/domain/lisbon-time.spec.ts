import { describe, it, expect } from '@jest/globals'

import { lisbonWallTimeToInstant } from '#/modules/kuantokusta/domain/lisbon-time'

const iso = (value: string) => lisbonWallTimeToInstant(value)?.toISOString()

describe('lisbonWallTimeToInstant', () => {
  it('reads a summer time as UTC+1', () => {
    expect(iso('2026-10-08 00:49:45')).toBe('2026-10-07T23:49:45.000Z')
    expect(iso('2026-07-15 12:00:00')).toBe('2026-07-15T11:00:00.000Z')
  })

  it('reads a winter time as UTC', () => {
    expect(iso('2026-01-15 12:00:00')).toBe('2026-01-15T12:00:00.000Z')
    expect(iso('2026-12-31 23:59:59')).toBe('2026-12-31T23:59:59.000Z')
  })

  it('changes offset at the right minute, in spring and in autumn', () => {
    // 29 March 2026: 01:00 becomes 02:00.
    expect(iso('2026-03-29 00:59:59')).toBe('2026-03-29T00:59:59.000Z')
    expect(iso('2026-03-29 02:00:00')).toBe('2026-03-29T01:00:00.000Z')
    // 25 October 2026: 02:00 becomes 01:00.
    expect(iso('2026-10-25 00:59:59')).toBe('2026-10-24T23:59:59.000Z')
    expect(iso('2026-10-25 02:00:00')).toBe('2026-10-25T02:00:00.000Z')
  })

  it('gives an instant, not an error, for the two ambiguous hours', () => {
    // 01:30 on 29 March does not exist; 01:30 on 25 October happens twice.
    expect(iso('2026-03-29 01:30:00')).toBe('2026-03-29T01:30:00.000Z')
    expect(iso('2026-10-25 01:30:00')).toBe('2026-10-25T01:30:00.000Z')
  })

  it.each([
    '',
    '2026-10-08',
    '2026-10-08T00:49:45',
    '2026-10-08 00:49:45Z',
    '2026-10-08 00:49',
    '2026-13-01 00:00:00',
    '2026-02-30 00:00:00',
    '2026-10-08 24:00:00',
    '2026-10-08 00:60:00',
    '08/10/2026 00:49:45',
    ' 2026-10-08 00:49:45'
  ])('returns null for %j', (value) => {
    expect(lisbonWallTimeToInstant(value)).toBeNull()
  })
})
