// Append-only audit trail helper (spec §72). One call site, structured entries.

import { createAuditEvent } from './domain/entities.ts';
import type { StorageProvider } from './storage/StorageProvider.ts';
import type { Id } from './domain/types.ts';

export function audit(
  storage: StorageProvider,
  input: {
    action: string;
    objectType: string;
    objectId: Id;
    actor?: string;
    sessionId?: Id | null;
    eventId?: Id | null;
    prev?: unknown;
    next?: unknown;
  },
): void {
  try {
    storage.appendAudit(createAuditEvent(input));
  } catch (err) {
    // Auditing must never break the request path.
    console.error('[audit] failed to record', input.action, err);
  }
}
