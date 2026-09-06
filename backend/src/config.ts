import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

function list(envValue: string | undefined, ...fallbacks: string[]): string[] {
  const head = (envValue ?? '').trim();
  return [...new Set([head, ...fallbacks].filter(Boolean))];
}

const transcription = (process.env.TRANSCRIPTION ?? 'auto').toLowerCase();

const transcribeModels = list(process.env.GEMINI_TRANSCRIBE_MODEL, 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite');
const textModels = list(process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash');

export const config = {
  port: Number(process.env.PORT) || 8787,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:4321',
  databaseUrl: process.env.DATABASE_URL || 'file:./data/shadowadj.db',
  searchProvider: (process.env.SEARCH_PROVIDER || 'mock') as 'mock' | 'exa' | 'brave' | 'bing',
  // 'auto' -> server transcription when a key is present; 'browser' -> force Web Speech API
  transcription: (transcription === 'browser' ? 'browser' : 'auto') as 'auto' | 'browser',
  // 'auto' (multilingual when the session/event names a non-English language or >1 speaker)
  // | 'always' (structured multilingual transcription for every server session)
  // | 'off'   (English-only, the Phase 1-4 behaviour)
  multilingual: ((process.env.MULTILINGUAL || 'auto').toLowerCase() === 'off'
    ? 'off'
    : (process.env.MULTILINGUAL || 'auto').toLowerCase() === 'always'
      ? 'always'
      : 'auto') as 'auto' | 'always' | 'off',
  translateTo: process.env.TRANSLATE_TO || 'en',
  // Phase 7: when set, REST auth + RBAC are enforced. Unset => dev mode: every
  // request runs as a synthetic admin so the reflection console keeps working.
  authSecret: process.env.AUTH_SECRET || '',
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // Model routing table (spec §82). Head is primary; rest are 404/503 fallbacks.
    models: {
      transcribe: transcribeModels,
      coach: textModels,
      judge: list(process.env.GEMINI_JUDGE_MODEL, ...textModels),
      similarity: list(process.env.GEMINI_SIMILARITY_MODEL, 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'),
      summarize: list(process.env.GEMINI_SUMMARIZE_MODEL, ...textModels),
    },
    // kept for anything still reading the old names
    transcribeModels,
    textModels,
    get enabled(): boolean {
      return this.apiKey.length > 0;
    },
  },
};

export const serverTranscription = config.transcription === 'auto' && config.gemini.enabled;

console.log(
  serverTranscription
    ? `[shadowadj] transcription: server via ${config.gemini.models.transcribe[0]} · coach ${config.gemini.models.coach[0]}`
    : '[shadowadj] transcription: browser Web Speech API (no key, or TRANSCRIPTION=browser)',
);
console.log(`[shadowadj] storage: ${config.databaseUrl}`);
