import { describe, it, expect } from '@jest/globals'

import { assertStoreId, InvalidStoreIdError } from '#/infra/database/store-id'

describe('assertStoreId', () => {
  it.each([
    '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
    '3F2B8C1E-9A4D-4E6F-8B7A-1C2D3E4F5A6B'
  ])('accepts the UUID %s', (value) => {
    expect(() => assertStoreId(value)).not.toThrow()
  })

  it.each([
    undefined,
    null,
    '',
    42,
    'zincomed',
    '3f2b8c1e9a4d4e6f8b7a1c2d3e4f5a6b',
    '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b\'; DROP TABLE stores; --',
    ' 3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
    '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b\n'
  ])('rejects %j', (value) => {
    expect(() => assertStoreId(value)).toThrow(InvalidStoreIdError)
  })
})
