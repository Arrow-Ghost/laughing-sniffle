// CoachEngine (spec §54-60, §89-92). Consumes the Judge Engine's EXACT
// weaknesses — verbatim, not re-generated — and turns them into a plan, drills,
// an AI opponent, retry comparison and a progress series over the participant's
// own history. Nothing here produces an integrity signal.

import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.ts';
import { audit } from '../audit.ts';
import type { StorageProvider } from '../storage/StorageProvider.ts';
import type { AIGateway } from '../ai/AIGateway.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';
import type {
  BeforeAfter,
  CoachPersona,
  CoachPlan,
  CoachWeakness,
  Drill,
  DrillDifficulty,
  DrillExchange,
  DrillType,
  Id,
  JudgeEvaluation,
  OpponentConfig,
  ProgressPoint,
} from '../domain/types.ts';
import { drillForWeakness, drillTimeSec, nextDifficulty, DRILL_CATALOG } from './drills.ts';
import { isPersona } from './personas.ts';

const DEFAULT_OPPONENT: OpponentConfig = {
  difficulty: 'intermediate',
  aggression: 'firm',
  domain: 'general',
  style: 'analytical',
  language: 'en',
};

export class CoachEngine {
  private readonly storage: StorageProvider;
  private readonly ai: AIGateway;

  constructor(storage: StorageProvider, ai: AIGateway) {
    this.storage = storage;
    this.ai = ai;
  }

  // --- plan (spec §54, §89) --------------------------------------------
  async plan(input: { sessionId: Id; evaluationId?: Id; persona?: unknown }): Promise<CoachPlan> {
    const session = this.storage.getSession(input.sessionId);
    if (!session) throw new HttpError(404, 'session not found');
    const persona: CoachPersona = isPersona(input.persona) ? input.persona : 'supportive';

    const evals = this.storage.listEvaluations(input.sessionId);
    const evaluation = input.evaluationId
      ? evals.find((e) => e.id === input.evaluationId)
      : evals.filter((e) => e.status === 'final').at(-1) ?? evals.at(-1);
    if (!evaluation) throw new HttpError(422, 'run a judge evaluation first — coaching is built from its findings');

    const eventType = session.eventId
      ? (this.storage.getEvent(session.eventId)?.type ?? 'debate')
      : session.mode === 'interview-prep'
        ? 'interview'
        : session.mode === 'speech-coaching'
          ? 'speech'
          : 'debate';

    // Weaknesses come straight from the Judge — verbatim (spec §89).
    const weaknesses: CoachWeakness[] = [];
    for (const c of evaluation.criteria) {
      for (const w of c.weaknesses) {
        weaknesses.push({
          criterionId: c.criterionId,
          criterionName: c.criterionName,
          score: c.score,
          weaknessText: w,
          evidence: c.evidence.map((e) => ({ startMs: e.startMs, endMs: e.endMs, quote: e.quote })).slice(0, 2),
          suggestedDrill: drillForWeakness(w, c.criterionName, eventType),
        });
      }
    }

    const focusAreas = [...evaluation.criteria]
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((c) => c.criterionName);
    const strengths = evaluation.criteria.flatMap((c) => c.strengths).slice(0, 5);

    const gen = await this.ai.coachSummary({
      persona,
      eventType,
      overallScore: evaluation.overallScore,
      scaleMax: evaluation.scaleMax,
      strengths,
      weaknesses: weaknesses.map((w) => ({ criterionName: w.criterionName, score: w.score, text: w.weaknessText })),
    });

    const record: CoachPlan = {
      id: randomUUID(),
      createdAt: Date.now(),
      sessionId: input.sessionId,
      participantId: session.participantId,
      evaluationId: evaluation.id,
      persona,
      overallScore: evaluation.overallScore,
      scaleMax: evaluation.scaleMax,
      focusAreas,
      weaknesses,
      summary: gen.summary,
      keepDoing: gen.keepDoing,
    };
    this.storage.createCoachPlan(record);
    audit(this.storage, { action: 'coach.plan.created', objectType: 'coach_plan', objectId: record.id, sessionId: input.sessionId, next: { weaknesses: weaknesses.length, persona } });
    return record;
  }

  // --- drills (spec §56, §58) -----------------------------------------
  async startDrill(input: { planId: Id; type?: unknown; difficulty?: unknown; weaknessIndex?: number }): Promise<Drill> {
    const plan = this.storage.getCoachPlan(input.planId);
    if (!plan) throw new HttpError(404, 'coach plan not found');
    const session = this.storage.getSession(plan.sessionId);
    const eventType = session?.mode === 'interview-prep' ? 'interview' : 'debate';
    const lang = session?.languages[0] ?? 'en';

    const w = plan.weaknesses[input.weaknessIndex ?? 0];
    const type = (asDrillType(input.type) ?? w?.suggestedDrill ?? 'rebuttal-sprint') as Exclude<DrillType, 'retry'>;
    const difficulty = asDifficulty(input.difficulty) ?? 'intermediate';
    const fromWeakness = w?.weaknessText ?? plan.focusAreas[0] ?? 'general performance';

    let prompt: string;
    try {
      prompt = await this.ai.generateDrillPrompt({
        type,
        difficulty,
        fromWeakness,
        eventType,
        language: lang,
        evidenceQuote: w?.evidence[0]?.quote,
      });
    } catch {
      // AI unavailable — a deterministic prompt from the catalogue still runs the drill.
      const cat = DRILL_CATALOG[type];
      prompt = `${cat.label} (${difficulty}). Targeting: "${fromWeakness}". In ${drillTimeSec(type)}s, ${cat.goal}.`;
    }
    if (!prompt.trim()) {
      const cat = DRILL_CATALOG[type];
      prompt = `${cat.label} (${difficulty}). Targeting: "${fromWeakness}". ${cat.goal}.`;
    }

    const drill: Drill = {
      id: randomUUID(),
      createdAt: Date.now(),
      planId: plan.id,
      sessionId: plan.sessionId,
      participantId: plan.participantId,
      type,
      difficulty,
      fromWeakness,
      prompt,
      timeLimitSec: drillTimeSec(type),
      status: 'ready',
      responseSessionId: null,
      exchanges: [],
      grade: null,
    };
    this.storage.createDrill(drill);
    audit(this.storage, { action: 'coach.drill.started', objectType: 'drill', objectId: drill.id, sessionId: plan.sessionId, next: { type, difficulty } });
    return drill;
  }

  attachResponse(input: { drillId: Id; responseSessionId: Id }): Drill {
    const drill = this.mustDrill(input.drillId);
    if (!this.storage.getSession(input.responseSessionId)) throw new HttpError(404, 'response session not found');
    drill.responseSessionId = input.responseSessionId;
    drill.status = 'active';
    this.storage.updateDrill(drill);
    return drill;
  }

  async gradeDrill(input: { drillId: Id }): Promise<Drill> {
    const drill = this.mustDrill(input.drillId);
    if (!drill.responseSessionId) throw new HttpError(422, 'attach a recorded response session first');
    const segs = this.storage.listSegments(drill.responseSessionId).filter((s) => s.isFinal);
    const snap = (this.storage.latestMetric(drill.responseSessionId)?.snapshot ?? null) as SpeechSnapshot | null;
    const scaleMax = this.storage.getCoachPlan(drill.planId ?? '')?.scaleMax ?? 10;

    const g = await this.ai.gradeDrill({
      type: drill.type as Exclude<DrillType, 'retry'>,
      fromWeakness: drill.fromWeakness,
      prompt: drill.prompt,
      responseTranscript: segs.map((s) => s.text).join(' '),
      metricsDigest: metricsDigest(snap),
      scaleMax,
    });

    const margin = (g.score - scaleMax * 0.6) / scaleMax; // above/below a "meets" bar of 60%
    drill.grade = {
      score: g.score,
      scaleMax,
      targetMet: g.targetMet,
      feedback: g.feedback,
      suggestedNextDifficulty: nextDifficulty(drill.difficulty, g.targetMet, margin),
    };
    drill.status = 'complete';
    this.storage.updateDrill(drill);
    audit(this.storage, { action: 'coach.drill.graded', objectType: 'drill', objectId: drill.id, sessionId: drill.sessionId, next: { score: g.score, targetMet: g.targetMet } });
    return drill;
  }

  // --- AI opponent (spec §57) ---------------------------------------
  async opponentTurn(input: { drillId: Id; lastArgument: string; config?: Partial<OpponentConfig>; topic?: string }): Promise<Drill> {
    const drill = this.mustDrill(input.drillId);
    if (!String(input.lastArgument ?? '').trim()) throw new HttpError(400, 'lastArgument is required');
    const config: OpponentConfig = { ...DEFAULT_OPPONENT, difficulty: drill.difficulty, ...(input.config ?? {}) };
    const topic = input.topic ?? drill.fromWeakness;

    drill.exchanges.push({ role: 'participant', text: String(input.lastArgument).slice(0, 4000), at: Date.now() });
    let reply: string;
    try {
      reply = await this.ai.opponentTurn({ config, topic, exchanges: drill.exchanges, lastArgument: String(input.lastArgument).slice(0, 4000) });
    } catch {
      reply = '(the AI opponent is unavailable right now — try again in a moment)';
    }
    drill.exchanges.push({ role: 'opponent', text: reply, at: Date.now() });
    this.storage.updateDrill(drill);
    return drill;
  }

  // --- retry: before/after (spec §91) -----------------------------
  compare(input: { beforeSessionId: Id; afterSessionId: Id }): BeforeAfter {
    const before = this.latestEval(input.beforeSessionId);
    const after = this.latestEval(input.afterSessionId);
    const names = new Set<string>();
    for (const e of [before, after]) e?.criteria.forEach((c) => names.add(c.criterionName));

    const criteria = [...names].map((name) => {
      const b = before?.criteria.find((c) => c.criterionName === name)?.score ?? null;
      const a = after?.criteria.find((c) => c.criterionName === name)?.score ?? null;
      return { criterionName: name, before: b, after: a, delta: b != null && a != null ? round(a - b) : null };
    });

    const bs = this.finalSnap(input.beforeSessionId);
    const as = this.finalSnap(input.afterSessionId);
    const metric = (label: string, get: (s: SpeechSnapshot) => number | null) => {
      const b = bs ? get(bs) : null;
      const a = as ? get(as) : null;
      return { metric: label, before: b, after: a, delta: b != null && a != null ? round(a - b) : null };
    };
    const metrics = [
      metric('wpm', (s) => s.pace.wpm),
      metric('hard fillers /min', (s) => s.fillers.hardPerMin),
      metric('pauses', (s) => s.pauses.count),
      metric('talk ratio', (s) => s.delivery.talkRatio),
      metric('vocabulary variety', (s) => s.vocabulary.variety),
    ];

    return {
      beforeSessionId: input.beforeSessionId,
      afterSessionId: input.afterSessionId,
      criteria,
      metrics,
      overall: {
        before: before?.overallScore ?? null,
        after: after?.overallScore ?? null,
        delta: before && after ? round(after.overallScore - before.overallScore) : null,
      },
    };
  }

  // --- progress (spec §90, §92) --------------------------------
  progress(participantId: Id): { participantId: Id; series: ProgressPoint[]; trend: Record<string, number | null> } {
    const sessions = this.storage
      .listSessions({ limit: 500 })
      .filter((s) => s.participantId === participantId && s.status === 'ended')
      .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));

    const series: ProgressPoint[] = sessions.map((s) => {
      const ev = this.latestEval(s.id);
      const snap = this.finalSnap(s.id);
      return {
        sessionId: s.id,
        at: s.endedAt ?? s.createdAt,
        label: s.label,
        overallScore: ev?.overallScore ?? null,
        scaleMax: ev?.scaleMax ?? null,
        wpm: snap?.pace.wpm ?? null,
        fillerPerMin: snap?.fillers.hardPerMin ?? null,
        pausePerMin: snap ? round(snap.pauses.count / Math.max(1, snap.elapsedMs / 60_000)) : null,
        vocabularyVariety: snap?.vocabulary.variety ?? null,
      };
    });

    const delta = (pick: (p: ProgressPoint) => number | null): number | null => {
      const vals = series.map(pick).filter((v): v is number => v != null);
      return vals.length >= 2 ? round(vals[vals.length - 1]! - vals[0]!) : null;
    };
    return {
      participantId,
      series,
      trend: {
        overallScore: delta((p) => p.overallScore),
        wpm: delta((p) => p.wpm),
        fillerPerMin: delta((p) => p.fillerPerMin),
        vocabularyVariety: delta((p) => p.vocabularyVariety),
      },
    };
  }

  // --- internals ------------------------------------------------
  private mustDrill(id: Id): Drill {
    const d = this.storage.getDrill(id);
    if (!d) throw new HttpError(404, 'drill not found');
    return d;
  }
  private latestEval(sessionId: Id): JudgeEvaluation | undefined {
    const es = this.storage.listEvaluations(sessionId);
    return es.filter((e) => e.status === 'final').at(-1) ?? es.at(-1);
  }
  private finalSnap(sessionId: Id): SpeechSnapshot | null {
    return (this.storage.latestMetric(sessionId)?.snapshot ?? null) as SpeechSnapshot | null;
  }
}

/* ------------------------------- helpers ------------------------------- */

function asDrillType(v: unknown): Exclude<DrillType, 'retry'> | undefined {
  return typeof v === 'string' && v in DRILL_CATALOG ? (v as Exclude<DrillType, 'retry'>) : undefined;
}
function asDifficulty(v: unknown): DrillDifficulty | undefined {
  return v === 'beginner' || v === 'intermediate' || v === 'advanced' || v === 'expert' ? v : undefined;
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
function metricsDigest(s: SpeechSnapshot | null): string {
  if (!s) return '(no metrics)';
  return `pace ${s.pace.wpm ?? '—'} wpm (${s.pace.descriptor ?? '—'}); hard fillers ${s.fillers.hardPerMin ?? '—'}/min; pauses ${s.pauses.count}; talk ratio ${s.delivery.talkRatio ?? '—'}; ${Math.round(s.elapsedMs / 1000)}s`;
}
