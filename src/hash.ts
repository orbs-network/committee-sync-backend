import { createHash } from 'crypto';

/**
 * Deterministic hash of committee+config payload for deduplication.
 * Sorts members by address before stringifying.
 */
export function committeeHash(payload: {
  members: Array<{ ethAddress: string;[key: string]: unknown }>;
  config?: unknown[];
}): string {
  const sorted = {
    members: [...payload.members].sort((a, b) =>
      (a.ethAddress || '').toLowerCase().localeCompare((b.ethAddress || '').toLowerCase())
    ),
    config: payload.config ?? [],
  };
  const canonical = JSON.stringify(sorted);
  return createHash('sha256').update(canonical).digest('hex');
}
