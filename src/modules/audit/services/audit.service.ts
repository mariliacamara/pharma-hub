import { Injectable } from '@nestjs/common'

import type { Prisma } from '#/generated/prisma/client'

/** Who did it. A machine is named by its token prefix, never by the token. */
export type AuditActor
  = | { type: 'api_token', tokenId: string, tokenPrefix: string }
    | { type: 'system', label: string }

export interface AuditEvent {
  actor: AuditActor
  /** `<thing>.<what_happened>`, for example `api_token.issued`. */
  action: string
  storeId: string | null
  target?: string
  /** Facts about the action. Never a secret, a token or a credential. */
  details?: Record<
    string,
    string | number | boolean | null | string[] | Record<string, number>
  >
}

/**
 * Appends to the audit log.
 *
 * The caller passes the database client of the action being recorded, so the
 * entry is written in the same transaction: either both happen or neither.
 * The application role can insert and read these rows but never change them.
 */
@Injectable()
export class AuditService {
  async record(db: Prisma.TransactionClient, event: AuditEvent): Promise<void> {
    const { actor } = event
    await db.audit_events.create({
      data: {
        actor_type: actor.type,
        actor_token_id: actor.type === 'api_token' ? actor.tokenId : null,
        actor_label: actor.type === 'api_token'
          ? actor.tokenPrefix
          : actor.label,
        store_id: event.storeId,
        action: event.action,
        target: event.target ?? null,
        details: event.details ?? {}
      }
    })
  }
}
