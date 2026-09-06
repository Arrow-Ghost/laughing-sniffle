// AIGateway — the one place Gemini is called (spec §26). Every method:
//   • builds a compact prompt from structured state, not raw transcript spam (§25)
//   • walks a model fallback list on 404 / 503
//   • for JSON methods: validate → repair-retry → typed fallback, never throws
//     into the request path (§27, §73)
//   • caches stable results by content hash (§83)
//   • logs { model, ms, ok, tokens, estCost } for budget visibility (§81)
//
// Judge / Integrity / Similarity methods land here in their phases; the model
// routing table already reserves their slots.

import { createHash } from 'node:crypto';
import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { extractJson, asObject, asString, asStringArray, AiValidationError } from './validate.ts';
import {
  transcribeParts,
  transcribeStructuredParts,
  TRANSCRIBE_EMPTY_RE,
  TRANSCRIBE_STRUCT_REPAIR,
} from './prompts/transcribe.ts';
import { coachParts, COACH_REPAIR_HINT, type CoachInput } from './prompts/coach.ts';
import { judgeCriterionParts, JUDGE_REPAIR_HINT, type JudgeCriterionInput } from './prompts/judge.ts';
import { translateParts } from './prompts/translate.ts';
import { coachPlanParts, COACH_PLAN_REPAIR, type CoachPlanInput } from './prompts/coach-plan.ts';
import { drillPromptParts, type DrillPromptInput } from './prompts/drill.ts';
import { opponentTurnParts, type OpponentTurnInput } from './prompts/opponent.ts';
import { gradeDrillParts, GRADE_DRILL_REPAIR, type GradeDrillInput } from './prompts/grade-drill.ts';
import type { Confidence, EvidenceRef } from '../domain/types.ts';

export interface AIGatewayConfig {
  apiKey: string;
  models: {
    transcribe: string[];
    coach: string[];
    judge: string[];
    similarity: string[];
    summarize: string[];
  };
  /** Test seam — replaces the Gemini SDK call. Not used in production. */
  _call?: (model: string, parts: Part[]) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

export interface CallLog {
  at: number;
  op: string;
  model: string;
  ms: number;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

export interface CoachResult {
  summary: string;
  notes: string[];
}

export interface CriterionAiResult {
  evaluated: boolean; // false = automated evaluation was unavailable, needs a human score
  score: number;
  confidence: Confidence;
  evidence: EvidenceRef[];
  strengths: string[];
  weaknesses: string[];
  reasoning: string;
}

const PRICE_PER_MTOK = { in: 0.1, out: 0.4 }; // rough flash-lite tier, USD per 1M tokens

interface RawResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class AIGateway {
  private readonly client: GoogleGenerativeAI | null;
  private readonly models: AIGatewayConfig['models'];
  private readonly call: AIGatewayConfig['_call'] | null;
  private readonly cache = new Map<string, unknown>();
  readonly log: CallLog[] = [];

  constructor(cfg: AIGatewayConfig) {
    this.call = cfg._call ?? null;
    this.client = this.call ? null : cfg.apiKey ? new GoogleGenerativeAI(cfg.apiKey) : null;
    this.models = cfg.models;
  }

  enabled(): boolean {
    return this.client !== null || this.call !== null;
  }

  // --- transcription (text out) -------------------------------------------
  async transcribe(pcm16: Buffer, sampleRate = 16_000): Promise<string> {
    const wav = pcm16ToWavBase64(pcm16, sampleRate);
    const { text } = await this.raw('transcribe', transcribeParts(wav), this.models.transcribe);
    if (TRANSCRIBE_EMPTY_RE.test(text)) return '';
    return text;
  }

  // --- multilingual transcription + diarization (JSON out) --------------
  async transcribeStructured(
    pcm16: Buffer,
    sampleRate = 16_000,
    opts: { languages?: string[]; expectSpeakers?: number } = {},
  ): Promise<{ text: string; utterances: Array<{ text: string; lang: string; speaker: string }> }> {
    const wav = pcm16ToWavBase64(pcm16, sampleRate);
    const result = await this.callJson<Array<{ text: string; lang: string; speaker: string }>>({
      op: 'transcribe-structured',
      parts: transcribeStructuredParts(wav, opts),
      models: this.models.transcribe,
      repairHint: TRANSCRIBE_STRUCT_REPAIR,
      validate: (v) => {
        const o = asObject(v);
        if (!Array.isArray(o.utterances)) throw new AiValidationError('utterances must be an array');
        return o.utterances
          .map((raw) => {
            const u = asObject(raw);
            return {
              text: asString(u.text ?? '', 'utterance.text', 8000).trim(),
              lang: asString(u.lang ?? 'und', 'utterance.lang', 12).toLowerCase(),
              speaker: asString(u.speaker ?? 'Speaker A', 'utterance.speaker', 40),
            };
          })
          .filter((u) => u.text.length > 0);
      },
      fallback: [],
    });
    return { text: result.map((u) => u.text).join(' ').trim(), utterances: result };
  }

  // --- translation (text out, kept ALONGSIDE the original) -------------
  async translate(text: string, target = 'en'): Promise<string> {
    if (!text.trim()) return '';
    const { text: out } = await this.raw('translate', translateParts(text, target), this.models.summarize);
    return out;
  }

  // --- coaching notes (JSON out, validated) -----------------------------
  async generateCoach(input: CoachInput): Promise<CoachResult> {
    return this.callJson<CoachResult>({
      op: 'coach',
      parts: coachParts(input),
      models: this.models.coach,
      repairHint: COACH_REPAIR_HINT,
      validate: (v) => {
        const o = asObject(v);
        return { summary: asString(o.summary, 'summary', 2000), notes: asStringArray(o.notes, 'notes', 8) };
      },
      fallback: { summary: 'Coaching notes are unavailable right now.', notes: [] },
    });
  }

  // --- judge one criterion (JSON out, validated) ----------------------
  async judgeCriterion(input: JudgeCriterionInput): Promise<CriterionAiResult> {
    const { scaleMin, scaleMax } = input.criterion;
    const clampScore = (n: unknown): number => {
      const v = typeof n === 'number' && Number.isFinite(n) ? n : scaleMin;
      return Math.min(scaleMax, Math.max(scaleMin, Math.round(v)));
    };
    const asConfidence = (v: unknown): Confidence =>
      v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
    const asEvidence = (v: unknown): EvidenceRef[] => {
      if (!Array.isArray(v)) return [];
      return v.slice(0, 4).map((raw) => {
        const o = asObject(raw);
        return {
          startMs: typeof o.startMs === 'number' ? Math.max(0, o.startMs) : 0,
          endMs: typeof o.endMs === 'number' ? Math.max(0, o.endMs) : 0,
          quote: asString(o.quote, 'evidence.quote', 600),
          reason: asString(o.reason ?? '', 'evidence.reason', 600),
        };
      });
    };

    return this.callJson<CriterionAiResult>({
      op: 'judge',
      parts: judgeCriterionParts(input),
      models: this.models.judge,
      repairHint: JUDGE_REPAIR_HINT,
      validate: (v) => {
        const o = asObject(v);
        return {
          evaluated: true,
          score: clampScore(o.score),
          confidence: asConfidence(o.confidence),
          evidence: asEvidence(o.evidence),
          strengths: asStringArray(o.strengths ?? [], 'strengths', 4),
          weaknesses: asStringArray(o.weaknesses ?? [], 'weaknesses', 4),
          reasoning: asString(o.reasoning ?? '', 'reasoning', 3000),
        };
      },
      fallback: {
        evaluated: false,
        score: scaleMin,
        confidence: 'low',
        evidence: [],
        strengths: [],
        weaknesses: [],
        reasoning: 'Automated evaluation was unavailable for this criterion — it needs a human score.',
      },
    });
  }

  // --- coaching (Phase 6) ------------------------------------------------
  async coachSummary(input: CoachPlanInput): Promise<{ summary: string; keepDoing: string[] }> {
    return this.callJson({
      op: 'coach-plan',
      parts: coachPlanParts(input),
      models: this.models.coach,
      repairHint: COACH_PLAN_REPAIR,
      validate: (v) => {
        const o = asObject(v);
        return { summary: asString(o.summary ?? '', 'summary', 3000), keepDoing: asStringArray(o.keepDoing ?? [], 'keepDoing', 3) };
      },
      fallback: { summary: 'Coaching summary is unavailable right now — the weaknesses below are still your focus.', keepDoing: [] },
    });
  }

  async generateDrillPrompt(input: DrillPromptInput): Promise<string> {
    const { text } = await this.raw('drill-prompt', drillPromptParts(input), this.models.coach);
    return text;
  }

  async opponentTurn(input: OpponentTurnInput): Promise<string> {
    const { text } = await this.raw('opponent-turn', opponentTurnParts(input), this.models.judge);
    return text;
  }

  async gradeDrill(input: GradeDrillInput): Promise<{ score: number; targetMet: boolean; feedback: string }> {
    return this.callJson({
      op: 'grade-drill',
      parts: gradeDrillParts(input),
      models: this.models.judge,
      repairHint: GRADE_DRILL_REPAIR,
      validate: (v) => {
        const o = asObject(v);
        const raw = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : 1;
        return {
          score: Math.min(input.scaleMax, Math.max(1, Math.round(raw))),
          targetMet: o.targetMet === true,
          feedback: asString(o.feedback ?? '', 'feedback', 3000),
        };
      },
      fallback: { score: 1, targetMet: false, feedback: 'Automated grading was unavailable for this attempt.' },
    });
  }

  costSummary() {
    const calls = this.log.length;
    const est = this.log.reduce((a, c) => a + c.estCostUsd, 0);
    const inTok = this.log.reduce((a, c) => a + c.inputTokens, 0);
    const outTok = this.log.reduce((a, c) => a + c.outputTokens, 0);
    return { calls, inputTokens: inTok, outputTokens: outTok, estCostUsd: Number(est.toFixed(5)) };
  }

  // --- internals -------------------------------------------------------
  private async raw(op: string, parts: Part[], models: string[]): Promise<RawResult> {
    if (!this.client && !this.call) throw new Error('AIGateway: no API key configured');
    let lastErr: unknown;
    for (const model of models) {
      const t0 = Date.now();
      try {
        let text: string;
        let inTok: number;
        let outTok: number;
        if (this.call) {
          const r = await this.call(model, parts);
          text = r.text.trim();
          inTok = r.inputTokens ?? 0;
          outTok = r.outputTokens ?? 0;
        } else {
          const res = await this.client!.getGenerativeModel({ model }).generateContent(parts);
          const usage = res.response.usageMetadata;
          inTok = usage?.promptTokenCount ?? 0;
          outTok = usage?.candidatesTokenCount ?? 0;
          text = res.response.text().trim();
        }
        this.record(op, model, Date.now() - t0, true, inTok, outTok);
        return { text, model, inputTokens: inTok, outputTokens: outTok };
      } catch (err) {
        lastErr = err;
        this.record(op, model, Date.now() - t0, false, 0, 0);
        if (!/\b(404|503)\b/.test(String((err as Error)?.message ?? ''))) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('AIGateway: all models failed');
  }

  private async callJson<T>(args: {
    op: string;
    parts: Part[];
    models: string[];
    validate: (v: unknown) => T;
    repairHint: string;
    fallback: T;
  }): Promise<T> {
    const key = hash(args.op + JSON.stringify(args.parts));
    if (this.cache.has(key)) return this.cache.get(key) as T;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const parts =
          attempt === 0 ? args.parts : [...args.parts, { text: args.repairHint } as Part];
        const { text } = await this.raw(args.op, parts, args.models);
        const value = args.validate(extractJson(text));
        this.cache.set(key, value);
        return value;
      } catch (err) {
        if (err instanceof AiValidationError || /\bJSON\b/.test(String((err as Error)?.message ?? ''))) {
          continue; // retry once with the repair hint
        }
        // transport / config error — give up on AI, return the typed fallback
        break;
      }
    }
    return args.fallback;
  }

  private record(op: string, model: string, ms: number, ok: boolean, inTok: number, outTok: number) {
    const estCostUsd = (inTok / 1e6) * PRICE_PER_MTOK.in + (outTok / 1e6) * PRICE_PER_MTOK.out;
    const entry: CallLog = { at: Date.now(), op, model, ms, ok, inputTokens: inTok, outputTokens: outTok, estCostUsd };
    this.log.push(entry);
    if (this.log.length > 1000) this.log.shift();
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function pcm16ToWavBase64(pcm16: Buffer, sampleRate: number): string {
  const b = Buffer.alloc(44 + pcm16.length);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + pcm16.length, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(pcm16.length, 40);
  pcm16.copy(b, 44);
  return b.toString('base64');
}
