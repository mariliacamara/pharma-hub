import type { CredentialKey } from '#/infra/config/env'

/**
 * The master keys available to this process.
 *
 * New credentials are always encrypted with the active key. Older keys stay
 * only so that credentials encrypted before a rotation can still be read.
 */
export class CredentialKeyring {
  private readonly byVersion = new Map<number, Buffer>()

  constructor(
    readonly active: CredentialKey,
    previous: readonly CredentialKey[] = []
  ) {
    for (const { version, key } of [active, ...previous]) {
      this.byVersion.set(version, key)
    }
  }

  /** The key of that version, or null when this process does not hold it. */
  find(version: number): Buffer | null {
    return this.byVersion.get(version) ?? null
  }
}
