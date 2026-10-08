/** True when the database refused a write because of a UNIQUE constraint. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002'
  )
}
