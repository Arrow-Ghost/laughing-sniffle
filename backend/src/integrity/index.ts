// IntegrityEngine (spec §28-46, §62). Orchestrates source matching,
// cross-participant similarity, per-speaker style deviation, preparedness,
// session-integrity checks and signal aggregation; gates on Event Policy; and
// produces an IntegrityCase for human review — or, when the policy allows AI, an
// analytics row and no case (spec §97). Only review() moves a case to
// "confirmed". Appeals and the source graph live here too.

import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { audit } from '../audit.ts';
import type { StorageProvider } from '../storage/StorageProvider.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';
import { DEFAULT_POLICY } from '../domain/types.ts';
import type {
  AppealResponse,
  EventPolicy,
  Id,
  IntegrityAnalytics,
  IntegrityAppeal,
  IntegrityCase,
  IntegritySignal,
  ParticipantMatch,
  PreparednessAnalysis,
  ReviewDecision,
  SessionIntegrityReport,
  SourceGraph,
  SourceMatch,
  StyleDeviation,
  TranscriptSegment,
} from '../domain/types.ts';
import {
  classifyQuotation,
  clamp01,
  containment,
  distinctivePhrases,
  isAttributed,
  isCommonPhrase,
  jaccard,
  sentences,
  shingles,
} from './text.ts';
import { CREDIBILITY } from './source-search/SourceSearchProvider.ts';
import type { SourceSearchProvider } from './source-search/SourceSearchProvider.ts';
import { languageProfile } from '../i18n/language.ts';
import type { AIGateway } from '../ai/AIGateway.ts';
import { aggregate } from './signals.ts';
import { NOT_PROVED_NOTE, RECOMMENDATION } from './copy.ts';
import { computeStyleBaseline, styleDeviation } from './style.ts';
import { analyzePreparedness } from './preparedness.ts';
import { checkSessionIntegrity } from './session-integrity.ts';
import { buildSourceGraph } from './graph.ts';

const DECISION_STATUS: Record<ReviewDecision, IntegrityCase['status']> = {
  dismiss: 'dismissed',
  monitor: 'monitoring',
  investigate: 'investigating',
  confirm: 'confirmed',
};

export interface IntegrityResult {
  case: IntegrityCase | null;
  analytics: IntegrityAnalytics | null;
}

export class IntegrityEngine {
  private readonly storage: StorageProvider;
  private readonly provider: SourceSearchProvider;
  private readonly ai: AIGateway | null;

  constructor(storage: StorageProvider, provider: SourceSearchProvider, ai: AIGateway | null = null) {
    this.storage = storage;
    this.provider = provider;
    this.ai = ai;
  }

  async analyzeSession(sessionId: Id): Promise<IntegrityResult> {
    const session = this.storage.getSession(sessionId);
    if (!session) throw new HttpError(404, 'session not found');
    const policy = session.eventId
      ? (this.storage.getEvent(session.eventId)?.policy ?? DEFAULT_POLICY)
      : DEFAULT_POLICY;

    const segments = this.storage.listSegments(sessionId).filter((s) => s.isFinal);
    const transcript = segments.map((s) => s.text).join(' ').trim();
    const snapshot = (this.storage.latestMetric(sessionId)?.snapshot ?? null) as SpeechSnapshot | null;
    const timeline = this.storage.listTimeline(sessionId);

    // Cross-language: if the answer isn't primarily English, translate it once and
    // match the translation against the (English) corpus, flagged lower-confidence
    // (spec §12). The original is never altered.
    const lang = languageProfile(segments, policy.languages);
    const nonEnglish = lang.primary !== 'und' && !lang.primary.startsWith('en');
    let searchText = transcript;
    let viaTranslation = false;
    if (nonEnglish && this.ai?.enabled()) {
      try {
        const t = await this.ai.translate(transcript, 'en');
        if (t.trim()) {
          searchText = t;
          viaTranslation = true;
        }
      } catch {
        /* fall back to the original text */
      }
    }
    const sourceMatches = await this.matchSources(searchText, segments, viaTranslation);
    const participantMatches = session.eventId
      ? this.matchParticipants(sessionId, session.eventId, transcript)
      : [];
    const phrasesChecked = distinctivePhrases(transcript).length;

    // --- Phase 4 analyses ---
    const style = this.styleAnalysisFor(session.participantId, sessionId, snapshot);
    const preparedness = snapshot
      ? analyzePreparedness(snapshot)
      : ({ classification: 'uncertain', rehearsedScore: 0, indicators: ['no metrics'], note: '' } as PreparednessAnalysis);
    const sessionIntegrity = checkSessionIntegrity({
      segments,
      snapshot,
      timeline,
      artifacts: this.storage.getSessionArtifacts(sessionId),
      reconnects: this.storage.getSessionArtifacts(sessionId)?.reconnects ?? 0,
      audioGaps: [],
    });

    const signals = buildSignals({ sourceMatches, participantMatches, style, preparedness, sessionIntegrity, policy });
    const agg = aggregate(signals, policy);

    // Policy gate (spec §97): AI allowed → analytics only, never a case.
    if (policy.aiAssistance === 'allowed') {
      const analytics: IntegrityAnalytics = {
        id: randomUUID(),
        createdAt: Date.now(),
        sessionId,
        eventId: session.eventId,
        sourceMatchCount: sourceMatches.length,
        crossParticipantMax: participantMatches.reduce((m, pm) => Math.max(m, pm.similarity), 0),
        distinctivePhrasesChecked: phrasesChecked,
        note: 'Event policy allows AI assistance — recorded as disclosure analytics, not a review case.',
      };
      this.storage.createIntegrityAnalytics(analytics);
      audit(this.storage, { action: 'integrity.analytics.recorded', objectType: 'integrity_analytics', objectId: analytics.id, sessionId, eventId: session.eventId });
      return { case: null, analytics };
    }

    const record: IntegrityCase = {
      id: randomUUID(),
      createdAt: Date.now(),
      sessionId,
      eventId: session.eventId,
      participantId: session.participantId,
      policySnapshot: policy,
      riskLevel: agg.riskLevel,
      confidence: agg.confidence,
      signals,
      sourceMatches,
      participantMatches,
      styleAnalysis: style,
      preparedness,
      sessionIntegrity,
      recommendation: RECOMMENDATION[agg.riskLevel],
      notProvedNote: NOT_PROVED_NOTE,
      searchCoverage: this.provider.coverageNote,
      status: 'pending_review',
      review: null,
    };
    this.storage.createIntegrityCase(record);
    audit(this.storage, {
      action: 'integrity.case.created',
      objectType: 'integrity_case',
      objectId: record.id,
      sessionId,
      eventId: session.eventId,
      next: { riskLevel: record.riskLevel, confidence: record.confidence, signals: signals.filter((s) => s.present).map((s) => s.key) },
    });
    return { case: record, analytics: null };
  }

  review(input: { caseId: Id; reviewerId: string; decision: ReviewDecision; reason?: string; notes?: string }): IntegrityCase {
    const c = this.storage.getIntegrityCase(input.caseId);
    if (!c) throw new HttpError(404, 'integrity case not found');
    if (!input.reviewerId || !String(input.reviewerId).trim()) {
      throw new HttpError(400, 'reviewerId is required — only a human reviewer can record a decision');
    }
    if (!DECISION_STATUS[input.decision]) {
      throw new HttpError(400, `decision must be one of ${Object.keys(DECISION_STATUS).join(', ')}`);
    }
    if (input.decision === 'confirm' && !String(input.reason ?? '').trim()) {
      throw new HttpError(400, 'confirming a violation requires a reason');
    }
    const prev = c.status;
    c.status = DECISION_STATUS[input.decision];
    c.review = {
      reviewerId: String(input.reviewerId).trim().slice(0, 120),
      decision: input.decision,
      reason: String(input.reason ?? '').slice(0, 4000),
      notes: input.notes ? String(input.notes).slice(0, 4000) : null,
      at: Date.now(),
    };
    this.storage.updateIntegrityCase(c);
    audit(this.storage, {
      action: 'integrity.case.reviewed',
      objectType: 'integrity_case',
      objectId: c.id,
      sessionId: c.sessionId,
      eventId: c.eventId,
      actor: c.review.reviewerId,
      prev: { status: prev },
      next: { status: c.status, decision: input.decision },
    });
    return c;
  }

  // --- appeals (spec §43) --------------------------------------------------
  appeal(input: { caseId: Id; submittedBy: string; statement: string; sourceAttribution?: string }): IntegrityAppeal {
    const c = this.storage.getIntegrityCase(input.caseId);
    if (!c) throw new HttpError(404, 'integrity case not found');
    if (c.status === 'dismissed') throw new HttpError(409, 'this case has already been cleared — no appeal is needed');
    if (!String(input.submittedBy ?? '').trim() || !String(input.statement ?? '').trim()) {
      throw new HttpError(400, 'submittedBy and statement are required');
    }
    const a: IntegrityAppeal = {
      id: randomUUID(),
      createdAt: Date.now(),
      caseId: c.id,
      sessionId: c.sessionId,
      submittedBy: String(input.submittedBy).trim().slice(0, 120),
      statement: String(input.statement).slice(0, 8000),
      sourceAttribution: input.sourceAttribution ? String(input.sourceAttribution).slice(0, 2000) : null,
      response: null,
    };
    this.storage.createAppeal(a);
    audit(this.storage, { action: 'integrity.appeal.submitted', objectType: 'integrity_appeal', objectId: a.id, sessionId: c.sessionId, actor: a.submittedBy });
    return a;
  }

  respondAppeal(input: { appealId: Id; reviewerId: string; decision: AppealResponse['decision']; reason: string }): IntegrityAppeal {
    const a = this.storage.getAppeal(input.appealId);
    if (!a) throw new HttpError(404, 'appeal not found');
    if (!String(input.reviewerId ?? '').trim()) throw new HttpError(400, 'reviewerId is required');
    if (!['upheld', 'partially-upheld', 'rejected'].includes(input.decision)) {
      throw new HttpError(400, 'decision must be upheld, partially-upheld or rejected');
    }
    a.response = {
      reviewerId: String(input.reviewerId).trim().slice(0, 120),
      decision: input.decision,
      reason: String(input.reason ?? '').slice(0, 4000),
      at: Date.now(),
    };
    this.storage.updateAppeal(a);

    // The reviewer's appeal outcome can move the case, but never to "confirmed".
    const c = this.storage.getIntegrityCase(a.caseId);
    if (c && c.status !== 'confirmed') {
      if (input.decision === 'upheld') c.status = 'dismissed';
      else if (input.decision === 'partially-upheld') c.status = 'monitoring';
      this.storage.updateIntegrityCase(c);
    }
    audit(this.storage, {
      action: 'integrity.appeal.responded',
      objectType: 'integrity_appeal',
      objectId: a.id,
      sessionId: a.sessionId,
      actor: a.response.reviewerId,
      next: { decision: input.decision, caseStatus: c?.status },
    });
    return a;
  }

  sourceGraph(caseId: Id): SourceGraph {
    const c = this.storage.getIntegrityCase(caseId);
    if (!c) throw new HttpError(404, 'integrity case not found');
    return buildSourceGraph(c);
  }

  /** Participant-facing view of a case (spec §43, §79): the evidence against
   *  them, without internal weighting or other participants' identities. */
  redactedCase(caseId: Id): unknown {
    const c = this.storage.getIntegrityCase(caseId);
    if (!c) throw new HttpError(404, 'integrity case not found');
    return {
      id: c.id,
      riskLevel: c.riskLevel,
      status: c.status,
      recommendation: c.recommendation,
      notProvedNote: c.notProvedNote,
      searchCoverage: c.searchCoverage,
      policy: c.policySnapshot,
      signals: c.signals.filter((s) => s.present).map((s) => ({ label: s.label, evidence: s.evidence })),
      sourceMatches: c.sourceMatches.map((m) => ({
        phrase: m.phrase,
        domain: m.domain,
        sourceType: m.sourceType,
        exactSimilarity: m.exactSimilarity,
        quotationClass: m.quotationClass,
        sourceUrl: m.sourceUrl,
      })),
      overlapWithOtherSubmissions: c.participantMatches.map((p) => ({ note: p.note, similarity: p.similarity })),
      styleAnalysis: c.styleAnalysis,
      preparedness: c.preparedness,
      sessionIntegrity: { anomalies: c.sessionIntegrity.anomalies, note: c.sessionIntegrity.note },
      review: c.review ? { decision: c.review.decision, reason: c.review.reason, at: c.review.at } : null,
      appeals: this.storage.listAppealsByCase(c.id),
    };
  }

  // --- style, source, cross-participant (internal) -----------------------
  private styleAnalysisFor(participantId: Id | null, sessionId: Id, current: SpeechSnapshot | null): StyleDeviation | null {
    if (!participantId || !current) return null;
    const priors = this.storage
      .listSessions({ limit: 500 })
      .filter((s) => s.participantId === participantId && s.id !== sessionId && s.status === 'ended')
      .map((s) => this.storage.latestMetric(s.id)?.snapshot as SpeechSnapshot | undefined)
      .filter((x): x is SpeechSnapshot => Boolean(x));

    const base = computeStyleBaseline(participantId, priors);
    if (base.sessionsUsed > 0) {
      this.storage.upsertStyleBaseline({ id: randomUUID(), createdAt: Date.now(), ...base });
    }
    return styleDeviation(current, base.sessionsUsed > 0 ? { id: '', createdAt: 0, ...base } : null);
  }

  private async matchSources(transcript: string, segments: TranscriptSegment[], viaTranslation = false): Promise<SourceMatch[]> {
    if (!transcript) return [];
    const phrases = distinctivePhrases(transcript, { limit: 12, minUniqueness: 0.4 });
    const out: SourceMatch[] = [];
    for (const ph of phrases) {
      const hits = await this.provider.search(ph.text, { limit: 3 });
      const pGrams = shingles(ph.text, 3);
      const attributed = isAttributed(transcript, ph.text);
      const atMs = viaTranslation ? null : segmentTimeFor(segments, ph.text);
      for (const h of hits) {
        const exactSimilarity = containment(pGrams, shingles(h.text, 3));
        if (exactSimilarity < 0.2) continue;
        const credibility = CREDIBILITY[h.sourceType] ?? 0.4;
        const quotationClass = classifyQuotation(exactSimilarity, attributed, ph.uniqueness);
        let significance = 0.5 * exactSimilarity + 0.3 * ph.uniqueness + 0.2 * credibility;
        if (attributed) significance *= 0.35;
        if (viaTranslation) significance *= 0.7; // translation adds noise (spec §12)
        significance = clamp01(significance);
        if (significance < 0.25) continue;
        out.push({
          phrase: ph.text.slice(0, 400),
          atMs,
          sourceUrl: h.url,
          domain: h.domain,
          title: h.title,
          sourceType: h.sourceType,
          credibility,
          exactSimilarity: round(exactSimilarity),
          phraseUniqueness: round(ph.uniqueness),
          quotationClass,
          significance: round(significance),
          viaTranslation,
        });
      }
    }
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.significance - a.significance)
      .filter((m) => {
        const k = `${m.phrase}|${m.sourceUrl}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 10);
  }

  private matchParticipants(sessionId: Id, eventId: Id, transcript: string): ParticipantMatch[] {
    const others = this.storage.listSessions({ eventId }).filter((s) => s.id !== sessionId);
    if (others.length === 0 || !transcript) return [];
    const myGrams = shingles(filterCommon(transcript), 4);
    const myPhrases = distinctivePhrases(transcript, { limit: 20, minUniqueness: 0.45 }).map((ph) => norm(ph.text));
    const out: ParticipantMatch[] = [];
    for (const o of others) {
      const oText = this.storage.listSegments(o.id).filter((s) => s.isFinal).map((s) => s.text).join(' ');
      if (!oText.trim()) continue;
      const similarity = jaccard(myGrams, shingles(filterCommon(oText), 4));
      const oPhrases = new Set(distinctivePhrases(oText, { limit: 40, minUniqueness: 0.4 }).map((ph) => norm(ph.text)));
      const shared = myPhrases.filter((ph) => oPhrases.has(ph));
      if (similarity < 0.14 && shared.length < 2) continue;
      out.push({
        otherSessionId: o.id,
        otherLabel: o.label,
        sharedDistinctivePhrases: shared.slice(0, 5),
        similarity: round(similarity),
        note: shared.length >= 2 ? `${shared.length} distinctive phrases appear in both submissions` : 'elevated overall phrasing overlap',
      });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }
}

/* ------------------------------- helpers ------------------------------- */

function buildSignals(x: {
  sourceMatches: SourceMatch[];
  participantMatches: ParticipantMatch[];
  style: StyleDeviation | null;
  preparedness: PreparednessAnalysis;
  sessionIntegrity: SessionIntegrityReport;
  policy: EventPolicy;
}): IntegritySignal[] {
  const nonAttrib = x.sourceMatches.filter((m) => m.quotationClass !== 'quoted' && m.quotationClass !== 'attributed');
  const copied = x.sourceMatches.filter((m) => m.quotationClass === 'copied');
  const unattributedDistinctive = nonAttrib.filter(
    (m) => m.phraseUniqueness >= 0.5 && (m.quotationClass === 'copied' || m.quotationClass === 'paraphrased'),
  );
  const ext = nonAttrib.reduce((mx, m) => Math.max(mx, m.significance), 0);
  const crossMax = x.participantMatches.reduce((mx, p) => Math.max(mx, p.similarity), 0);
  const crossShared = x.participantMatches.reduce((mx, p) => Math.max(mx, p.sharedDistinctivePhrases.length), 0);

  const core: IntegritySignal[] = [
    {
      key: 'external-source-similarity',
      label: 'Similarity to an external source',
      present: ext >= 0.3,
      strength: clamp01(ext),
      origin: 'source-search',
      evidence: nonAttrib.slice(0, 3).map((m) => `“${m.phrase.slice(0, 90)}…” ~ ${m.domain} (${Math.round(m.exactSimilarity * 100)}% overlap)`),
    },
    {
      key: 'unattributed-distinctive-match',
      label: 'Distinctive wording matched without attribution',
      present: unattributedDistinctive.length >= 1,
      strength: clamp01(0.35 * unattributedDistinctive.length + 0.5 * (unattributedDistinctive[0]?.significance ?? 0)),
      origin: 'source-search',
      evidence: unattributedDistinctive.slice(0, 3).map((m) => `“${m.phrase.slice(0, 90)}…” (${m.domain}, uniqueness ${Math.round(m.phraseUniqueness * 100)}%)`),
    },
    {
      key: 'quotation-without-attribution',
      label: 'Verbatim source wording, no attribution',
      present: copied.some((m) => m.exactSimilarity >= 0.7),
      strength: clamp01(copied.reduce((mx, m) => Math.max(mx, m.exactSimilarity), 0)),
      origin: 'source-search',
      evidence: copied.filter((m) => m.exactSimilarity >= 0.7).slice(0, 2).map((m) => `“${m.phrase.slice(0, 90)}…” verbatim from ${m.domain}`),
    },
    {
      key: 'cross-participant-similarity',
      label: 'Overlap with another submission in this event',
      present: crossMax >= 0.16 || crossShared >= 2,
      strength: clamp01(Math.max(crossMax * 1.3, crossShared >= 2 ? 0.5 + 0.1 * crossShared : 0)),
      origin: 'cross-participant',
      evidence: x.participantMatches.slice(0, 3).map((p) => `${p.otherLabel}: ${p.note}`),
    },
  ];

  // style discontinuity — weak, corroborating only (spec §37)
  const styleSignal: IntegritySignal = {
    key: 'style-discontinuity',
    label: 'Delivery differs from this speaker’s own baseline',
    present: Boolean(x.style?.hasBaseline) && (x.style?.overallShift ?? 0) >= 0.4 && (x.style?.reasons.length ?? 0) >= 1,
    strength: clamp01((x.style?.overallShift ?? 0) * 0.8),
    origin: 'style-baseline',
    evidence: [...(x.style?.reasons ?? []), x.style?.caveat ?? ''].filter(Boolean),
  };

  // session-integrity anomalies point to review, not guilt (spec §45, §46)
  const notableAnoms = x.sessionIntegrity.anomalies.filter((a) => a.severity !== 'info');
  const anomalySignal: IntegritySignal = {
    key: 'session-integrity-anomaly',
    label: 'Recorded session shows an internal inconsistency',
    present: notableAnoms.length >= 1,
    strength: clamp01(0.3 * notableAnoms.length + (notableAnoms.some((a) => a.severity === 'concern') ? 0.4 : 0)),
    origin: 'session-integrity',
    evidence: notableAnoms.slice(0, 3).map((a) => `${a.type}: ${a.detail}`),
  };

  const signals = [...core, styleSignal, anomalySignal];

  // preparedness only becomes a signal where notes are prohibited AND something
  // else already points to review (spec §38, §101). "Prepared" alone is nothing.
  const somethingElse = signals.some((s) => s.present);
  const prepSignal: IntegritySignal = {
    key: 'preparedness-under-prohibition',
    label: 'Looks rehearsed in an event that prohibits prepared material',
    present:
      x.policy.preparedNotes === 'prohibited' &&
      x.preparedness.rehearsedScore >= 0.6 &&
      somethingElse,
    strength: clamp01(x.preparedness.rehearsedScore * 0.6),
    origin: 'preparedness',
    evidence: [...x.preparedness.indicators, x.preparedness.note],
  };
  signals.push(prepSignal);

  return signals;
}

function filterCommon(text: string): string {
  return sentences(text).filter((s) => !isCommonPhrase(s)).join(' ');
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
function segmentTimeFor(segments: TranscriptSegment[], phrase: string): number | null {
  const probe = norm(phrase).slice(0, 30);
  for (const s of segments) if (norm(s.text).includes(probe)) return s.t0;
  return null;
}
