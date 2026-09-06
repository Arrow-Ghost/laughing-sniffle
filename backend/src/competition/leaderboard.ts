// Event leaderboard (spec §53, §88).
//
// Two views from one computation. The PUBLIC view carries exactly one integrity
// field — a status label, "clear" or "under-review" — and never a risk level, a
// signal, a score spread, or a judge's name. The ADMIN view adds the detail
// block. Ranking is by mean consensus overall across the participant's scored
// sessions; ties are left for the tie-break engine, not silently ordered here.

import type { StorageProvider } from '../storage/StorageProvider.ts';
import type {
  Id,
  IntegrityStatusLabel,
  Leaderboard,
  LeaderboardRow,
  RiskLevel,
} from '../domain/types.ts';
import { computeConsensus } from './consensus.ts';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const RISK_ORDER: RiskLevel[] = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

export function buildLeaderboard(
  storage: StorageProvider,
  eventId: Id,
  view: 'public' | 'admin',
): Leaderboard {
  const event = storage.getEvent(eventId);
  if (!event) throw new Error('event not found');

  const participants = storage.listParticipantsByEvent(eventId);
  const sessions = storage.listSessions({ eventId });
  const cases = storage.listIntegrityCasesByEvent(eventId);

  let scaleMax = 0;

  const rows: LeaderboardRow[] = participants.map((p) => {
    const own = sessions.filter((s) => s.participantId === p.id);
    const consensuses = own
      .map((s) => computeConsensus(storage, s.id))
      .filter((c) => c.judgeCount > 0);

    for (const c of consensuses) if (c.scaleMax > scaleMax) scaleMax = c.scaleMax;

    const overallScore =
      consensuses.length > 0
        ? round2(consensuses.reduce((a, c) => a + c.overallMean, 0) / consensuses.length)
        : null;

    // Integrity status: any case that a reviewer has NOT dismissed → under review.
    const openCases = cases.filter((c) => c.participantId === p.id && c.status !== 'dismissed');
    const integrityStatus: IntegrityStatusLabel = openCases.length > 0 ? 'under-review' : 'clear';

    const row: LeaderboardRow = {
      rank: 0,
      participantId: p.id,
      participantLabel: p.displayName,
      sessionsScored: consensuses.length,
      overallScore,
      scaleMax: consensuses[0]?.scaleMax ?? 0,
      integrityStatus,
    };

    if (view === 'admin') {
      const perCritMap = new Map<string, number[]>();
      for (const c of consensuses) {
        for (const cc of c.criteria) {
          const arr = perCritMap.get(cc.criterionName) ?? [];
          arr.push(cc.mean);
          perCritMap.set(cc.criterionName, arr);
        }
      }
      const risks = openCases
        .map((c) => c.riskLevel)
        .sort((a, b) => RISK_ORDER.indexOf(b) - RISK_ORDER.indexOf(a));
      row.admin = {
        judgeCount: consensuses.reduce((a, c) => a + c.judgeCount, 0),
        consensusSpread:
          consensuses.length > 0
            ? round2(consensuses.reduce((a, c) => a + c.overallSpread, 0) / consensuses.length)
            : null,
        agreement: consensuses[0]?.agreement ?? null,
        integrityRisk: risks[0] ?? null,
        openCaseIds: openCases.map((c) => c.id),
        perCriterion: [...perCritMap.entries()].map(([criterionName, xs]) => ({
          criterionName,
          mean: round2(xs.reduce((a, b) => a + b, 0) / xs.length),
        })),
      };
    }

    return row;
  });

  // Rank: scored participants by descending score, unscored last (rank null-ish).
  const scored = rows.filter((r) => r.overallScore != null).sort((a, b) => b.overallScore! - a.overallScore!);
  const unscored = rows.filter((r) => r.overallScore == null);
  scored.forEach((r, i) => {
    r.rank = i > 0 && scored[i - 1]!.overallScore === r.overallScore ? scored[i - 1]!.rank : i + 1;
  });
  unscored.forEach((r) => (r.rank = scored.length + 1));

  const ordered = [...scored, ...unscored];

  return {
    eventId,
    eventName: event.name,
    view,
    generatedAt: Date.now(),
    scaleMax,
    rows: ordered,
    note:
      view === 'public'
        ? 'Public view. Integrity status is a label only — "under-review" means a human is looking, not that anything is proven.'
        : 'Admin view. Consensus spread and integrity risk are shown for reviewer context and must not be published.',
  };
}
