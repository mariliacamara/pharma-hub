import { describe, it, expect } from '@jest/globals'
import { eurosToCents } from '#/modules/kuantokusta/domain/money'

describe('eurosToCents', () => {
  it.each([
    [0, 0],
    [9.34, 934],
    [0.07, 7],
    [59.04, 5904],
    [232.47, 23247]
  ])('converts %s EUR to %s cents', (euros, cents) => {
    expect(eurosToCents(euros)).toBe(cents)
  })

  it.each([NaN, Infinity, -0.01])('rejects %s', (value) => {
    expect(() => eurosToCents(value)).toThrow(RangeError)
  })
})
