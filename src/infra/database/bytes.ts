/**
 * Copies binary data into the exact type Prisma accepts for a `bytea`
 * column. A Node Buffer may be a view over shared memory, which Prisma's
 * types refuse; the copy is not.
 */
export function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data)
}
