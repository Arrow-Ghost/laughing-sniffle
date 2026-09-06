// The ONLY source of user-facing integrity wording (spec §102). No accusatory
// language anywhere: "review required", not "cheater". A lint rule bans the raw
// words in JSX; use these constants.

import type { RiskLevel, ReviewDecision } from '../domain/types.ts';

export const RISK_LABEL: Record<RiskLevel, string> = {
  LOW: 'Low — no action indicated',
  MODERATE: 'Moderate — worth a look',
  HIGH: 'High — human review recommended',
  CRITICAL: 'Critical — human review required before any result is published',
};

export const RECOMMENDATION: Record<RiskLevel, string> = {
  LOW: 'No action indicated. Recorded for completeness.',
  MODERATE: 'A reviewer may wish to skim the flagged segments. Not on its own a concern.',
  HIGH: 'A human reviewer should examine the flagged segments and evidence before any result is finalised.',
  CRITICAL:
    'Do not publish a result for this session until a human reviewer has examined the evidence and recorded a decision.',
};

export const NOT_PROVED_NOTE =
  'This evidence indicates that a human should look, not that any wrongdoing occurred. ' +
  'Similarity to a source can mean research, common knowledge, or coincidence. ' +
  'Unauthorised AI use cannot be established from these signals alone and must never be ' +
  'presented as proven unless a human reviewer explicitly confirms it.';

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  dismiss: 'Dismiss — no concern',
  monitor: 'Monitor — note it, no action now',
  investigate: 'Investigate — needs a closer look',
  confirm: 'Confirm a policy violation (reviewer decision)',
};

export const PUBLIC_STATUS: Record<string, string> = {
  pending_review: 'Under review',
  dismissed: 'Cleared',
  monitoring: 'Under review',
  investigating: 'Under review',
  confirmed: 'Decision recorded',
};
