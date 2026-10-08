const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidStoreIdError extends Error {
  constructor() {
    super('Store id must be a UUID')
    this.name = 'InvalidStoreIdError'
  }
}

/**
 * Guards the value that scopes every tenant query. A store id always comes
 * from an authenticated principal, but it is validated again here because this
 * is the last stop before it reaches the database session.
 */
export function assertStoreId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidStoreIdError()
  }
}
