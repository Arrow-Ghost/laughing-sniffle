// JudgeEngine — turns a rubric + a session's transcript/metrics/timeline into a
// JudgeEvaluation where every criterion carries a score, confidence, evidence,
// strengths, weaknesses and reasoning (spec §19, §20). AI proposes; a human
// can override each criterion; both scores are kept (spec §50, §94). Carries no
// integrity signal — performance only (spec §101).

import { randomUUID } from 'node:crypto';
import type { AIGateway } from '../ai/AIGateway.ts';
import type { StorageProvider } from '../storage/StorageProvider.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';
import { HttpError } from '../errors.ts';
import { audit } from '../audit.ts';
import { createTimelineEvent } from '../domain/entities.ts';
import { languageProfile } from '../i18n/language.ts';
import { guardConfidence } from './confidence.ts';
import type {
  Confidence,
  CriterionScore,
  Id,
  JudgeEvaluation,
  Rubric,
  TimelineEvent,
  TranscriptSegment,
} from '../domain/types.ts';

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const CONF_NAME: readonly Confidence[] = ['low', 'medium', 'high'];

export class JudgeEngine {
  private readonly storage: StorageProvider;
  private readonly ai: AIGateway;

  constructor(storage: StorageProvider, ai: AIGateway) {
    this.storage = storage;
    this.ai = ai;
  }

  async evaluate(opts: { sessionId: Id; rubric: Rubric; judgeId?: string | null }): Promise<JudgeEvaluation> {
    const { sessionId, rubric } = opts;
    const segments = this.storage.listSegments(sessionId);
    const snap = (this.storage.latestMetric(sessionId)?.snapshot ?? null) as SpeechSnapshot | null;
    const timeline = this.storage.listTimeline(sessionId);

    const transcriptLines = fmtTranscript(segments);
    const wordCount = snap?.transcript.wordCount ?? countWords(segments);
    const speakingSeconds = snap?.delivery.speakingSecondsTotal ?? 0;
    const metricsDigest = fmtMetrics(snap);
    const timelineDigest = fmtTimeline(timeline);

    // If the answer isn't primarily English, give the judge an English gloss
    // ALONGSIDE the authoritative original (spec §12).
    const lang = languageProfile(segments.filter((s) => s.isFinal));
    let glossText: string | undefined;
    if (lang.primary !== 'und' && !lang.primary.startsWith('en')) {
      try {
        glossText = (await this.ai.translate(segments.filter((s) => s.isFinal).map((s) => s.text).join(' '), 'en')).slice(0, 12_000) || undefined;
      } catch {
        glossText = undefined;
      }
    }

    const scores: CriterionScore[] = [];
    for (const c of rubric.criteria) {
      const r = await this.ai.judgeCriterion({
        criterion: c,
        eventType: rubric.eventType,
        transcriptLines,
        metricsDigest,
        timelineDigest,
        glossText,
        primaryLang: lang.primary,
      });
      const guard = guardConfidence(r.confidence, {
        wordCount,
        speakingSeconds,
        evidenceCount: r.evidence.length,
        evaluated: r.evaluated,
      });
      scores.push({
        criterionId: c.id,
        criterionName: c.name,
        weight: c.weight,
        score: r.score,
        aiScore: r.evaluated ? r.score : null,
        humanScore: null,
        confidence: guard.confidence,
        confidenceReasons: guard.reasons,
        evidence: r.evidence,
        strengths: r.strengths,
        weaknesses: r.weaknesses,
        reasoning: r.reasoning,
        overriddenBy: null,
        overrideReason: null,
      });
    }

    const scaleMax = rubric.criteria[0]?.scaleMax ?? 10;
    const evaluation: JudgeEvaluation = {
      id: randomUUID(),
      createdAt: Date.now(),
      sessionId,
      rubricId: rubric.id,
      rubricName: rubric.name,
      judgeType: 'ai',
      judgeId: opts.judgeId ?? null,
      status: 'draft',
      scaleMax,
      overallScore: overallScore(scores),
      overallConfidence: overallConfidence(scores),
      criteria: scores,
      notes: null,
    };
    this.storage.createEvaluation(evaluation);
    this.mirrorEvidenceToTimeline(sessionId, scores);
    audit(this.storage, {
      action: 'evaluation.created',
      objectType: 'evaluation',
      objectId: evaluation.id,
      sessionId,
      next: { overallScore: evaluation.overallScore, overallConfidence: evaluation.overallConfidence, rubric: rubric.name },
    });
    return evaluation;
  }

  applyOverride(opts: {
    evaluationId: Id;
    criterionId: string;
    humanScore: number;
    reason?: string;
    reviewer?: string;
  }): JudgeEvaluation {
    const ev = this.storage.getEvaluation(opts.evaluationId);
    if (!ev) throw new HttpError(404, 'evaluation not found');
    if (ev.status === 'final') throw new HttpError(409, 'evaluation is finalised; reopen it first');
    const cs = ev.criteria.find((c) => c.criterionId === opts.criterionId);
    if (!cs) throw new HttpError(404, 'criterion not on this evaluation');

    const rubric = this.storage.getRubric(ev.rubricId);
    const bounds = rubric?.criteria.find((c) => c.id === opts.criterionId);
    const min = bounds?.scaleMin ?? 1;
    const max = bounds?.scaleMax ?? ev.scaleMax;
    if (typeof opts.humanScore !== 'number' || !Number.isFinite(opts.humanScore)) {
      throw new HttpError(400, 'humanScore must be a number');
    }
    const human = Math.min(max, Math.max(min, Math.round(opts.humanScore)));

    const prev = { score: cs.score, humanScore: cs.humanScore };
    cs.humanScore = human;
    cs.score = human;
    cs.overriddenBy = opts.reviewer ?? 'human';
    cs.overrideReason = opts.reason ?? null;

    ev.overallScore = overallScore(ev.criteria);
    ev.overallConfidence = overallConfidence(ev.criteria);
    ev.judgeType = 'human';
    this.storage.updateEvaluation(ev);
    audit(this.storage, {
      action: 'evaluation.override',
      objectType: 'evaluation',
      objectId: ev.id,
      sessionId: ev.sessionId,
      actor: opts.reviewer ?? 'human',
      prev,
      next: { criterion: cs.criterionName, humanScore: human, reason: opts.reason ?? null },
    });
    return ev;
  }

  finalize(opts: { evaluationId: Id; reviewer?: string; notes?: string }): JudgeEvaluation {
    const ev = this.storage.getEvaluation(opts.evaluationId);
    if (!ev) throw new HttpError(404, 'evaluation not found');
    const unresolved = ev.criteria.filter((c) => c.aiScore == null && c.humanScore == null);
    if (unresolved.length > 0) {
      throw new HttpError(
        422,
        `${unresolved.length} criteria have no automated or human score yet: ${unresolved.map((c) => c.criterionName).join(', ')}`,
      );
    }
    ev.status = 'final';
    if (opts.notes) ev.notes = String(opts.notes).slice(0, 4000);
    this.storage.updateEvaluation(ev);
    audit(this.storage, {
      action: 'evaluation.finalized',
      objectType: 'evaluation',
      objectId: ev.id,
      sessionId: ev.sessionId,
      actor: opts.reviewer ?? 'human',
      next: { overallScore: ev.overallScore, judgeType: ev.judgeType },
    });
    return ev;
  }

  private mirrorEvidenceToTimeline(sessionId: Id, scores: CriterionScore[]): void {
    for (const s of scores) {
      const kind = s.weaknesses.length > 0 && s.strengths.length === 0 ? 'weakness' : 'strong-moment';
      for (const ev of s.evidence.slice(0, 2)) {
        try {
          this.storage.appendTimelineEvent(
            createTimelineEvent({
              sessionId,
              atMs: ev.startMs,
              endMs: ev.endMs || null,
              type: kind,
              severity: 'notable',
              confidence: s.confidence,
              source: 'judge',
              description: `${s.criterionName}: ${ev.reason}`.slice(0, 300),
              linkedText: ev.quote,
            }),
          );
        } catch {
          /* non-fatal */
        }
      }
    }
  }
}

/* ------------------------------- helpers ------------------------------- */

function overallScore(scores: CriterionScore[]): number {
  const total = scores.reduce((a, c) => a + c.weight, 0) || 1;
  const sum = scores.reduce((a, c) => a + c.score * c.weight, 0);
  return Math.round((sum / total) * 10) / 10;
}

function overallConfidence(scores: CriterionScore[]): Confidence {
  if (scores.length === 0) return 'low';
  // A low-confidence result on any heavily-weighted criterion drags the whole down.
  if (scores.some((c) => c.weight >= 0.2 && c.confidence === 'low')) return 'low';
  const total = scores.reduce((a, c) => a + c.weight, 0) || 1;
  const mean = scores.reduce((a, c) => a + CONF_RANK[c.confidence] * c.weight, 0) / total;
  return CONF_NAME[Math.min(2, Math.max(0, Math.round(mean)))]!;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function countWords(segments: TranscriptSegment[]): number {
  return segments.reduce((a, s) => a + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
}

function fmtTranscript(segments: TranscriptSegment[], maxChars = 14_000): string {
  const lines = segments.filter((s) => s.isFinal).map((s) => `[${mmss(s.t0)}] ${s.text.trim()}`);
  let out = lines.join('\n');
  if (out.length > maxChars) out = `…\n${out.slice(out.length - maxChars)}`;
  return out;
}

function fmtMetrics(snap: SpeechSnapshot | null): string {
  if (!snap) return '(no metrics captured)';
  const p = snap.pace;
  const pa = snap.pauses;
  const f = snap.fillers;
  const d = snap.delivery;
  const v = snap.vocabulary;
  return [
    `duration ${Math.round(snap.elapsedMs / 1000)}s; speaking ${d.speakingSecondsTotal}s (${pct(d.talkRatio)} talk)`,
    `pace ${p.wpm ?? '—'} wpm${p.descriptor ? ` (${p.descriptor})` : ''}`,
    `pauses ${pa.count}${pa.longestMs ? ` (longest ${(pa.longestMs / 1000).toFixed(1)}s)` : ''}`,
    `hard fillers ${f.hardPerMin ?? '—'}/min; discourse fillers ${f.softPerMin ?? '—'}/min`,
    `vocabulary variety ${v.variety == null ? '—' : pct(v.variety)}; ~${num(v.meanUnitLength)} words per ${v.meanUnitBasis === 'punctuation' ? 'sentence' : 'phrase'}`,
    `answer latency ${latency(snap.answerLatency)}`,
  ].join('\n');
}

function fmtTimeline(events: TimelineEvent[], maxLines = 50): string {
  return events
    .slice(-maxLines)
    .map((e) => `[${mmss(e.atMs)}] ${e.type}${e.description ? `: ${e.description}` : ''}`)
    .join('\n');
}

const pct = (x: number | null): string => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x: number | null): string => (x == null ? '—' : x.toFixed(1));
function latency(l: SpeechSnapshot['answerLatency']): string {
  if (!l) return 'n/a';
  if ('alreadySpeaking' in l) return 'was already speaking';
  if (l.pending) return `pending (${Math.round(l.sinceMs / 1000)}s)`;
  return `${(l.latencyMs / 1000).toFixed(1)}s`;
}
