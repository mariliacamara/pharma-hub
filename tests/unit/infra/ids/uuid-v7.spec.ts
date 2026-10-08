import { describe, it, expect } from '@jest/globals'

import { assertStoreId } from '#/infra/database/store-id'
import { uuidV7 } from '#/infra/ids/uuid-v7'

describe('uuidV7', () => {
  it('has the layout of a version 7 UUID', () => {
    expect(uuidV7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('is accepted wherever a store id is checked', () => {
    expect(() => assertStoreId(uuidV7())).not.toThrow()
  })

  it('starts with the time, so later ids sort after earlier ones', () => {
    const earlier = uuidV7(Date.UTC(2026, 9, 8, 12, 0, 0))
    const later = uuidV7(Date.UTC(2026, 9, 8, 12, 0, 1))

    expect(earlier.slice(0, 13)).toBe('01a11b62-7600')
    expect(later > earlier).toBe(true)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidV7(1)))

    expect(ids.size).toBe(5000)
  })
})
