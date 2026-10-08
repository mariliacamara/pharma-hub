/**
 * Converts a price in euros, as KuantoKusta sends it (59.04), to integer cents (5904).
 *
 * All arithmetic in this module is done in cents: in floating point 0.30 - 0.20 is
 * 0.09999999999999998, which would make a 10-cent difference fail a "<= 10 cents" test.
 */
export function eurosToCents(euros: number): number {
  if (!Number.isFinite(euros) || euros < 0) {
    throw new RangeError('A price must be a finite, non-negative number')
  }
  return Math.round(euros * 100)
}
