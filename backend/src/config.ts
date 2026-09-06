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

const groqKey = (process.env.GROQ_API_KEY ?? '').trim();
const geminiKey = (process.env.GEMINI_API_KEY ?? '').trim();
const provider = (process.env.AI_PROVIDER || (groqKey ? 'groq' : 'gemini')).toLowerCase() as 'groq' | 'gemini';

const groqTranscribeModels = list(process.env.GROQ_TRANSCRIBE_MODEL, 'whisper-large-v3-turbo', 'whisper-large-v3');
const groqTextModels = list(process.env.GROQ_MODEL, 'groq/compound', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b');

const transcribeModels = provider === 'groq'
  ? groqTranscribeModels
  : list(process.env.GEMINI_TRANSCRIBE_MODEL, 'gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite');

const textModels = provider === 'groq'
  ? groqTextModels
  : list(process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash');

const aiConfig = {
  provider,
  groqApiKey: groqKey,
  geminiApiKey: geminiKey,
  apiKey: provider === 'groq' ? groqKey : geminiKey,
  models: {
    transcribe: transcribeModels,
    coach: textModels,
    judge: list(provider === 'groq' ? process.env.GROQ_JUDGE_MODEL : process.env.GEMINI_JUDGE_MODEL, ...textModels),
    similarity: list(provider === 'groq' ? process.env.GROQ_SIMILARITY_MODEL : process.env.GEMINI_SIMILARITY_MODEL, provider === 'groq' ? 'llama-3.1-8b-instant' : 'gemini-3.5-flash-lite'),
    summarize: list(provider === 'groq' ? process.env.GROQ_SUMMARIZE_MODEL : process.env.GEMINI_SUMMARIZE_MODEL, ...textModels),
  },
  transcribeModels,
  textModels,
  get enabled(): boolean {
    return (this.provider === 'groq' ? this.groqApiKey : this.geminiApiKey).length > 0;
  },
};

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
  ai: aiConfig,
  get gemini() {
    return this.ai;
  },
};

export const serverTranscription = config.transcription === 'auto' && config.ai.enabled;

console.log(
  serverTranscription
    ? `[shadowadj] transcription: server via ${config.ai.provider} (${config.ai.models.transcribe[0]}) · coach ${config.ai.models.coach[0]}`
    : '[shadowadj] transcription: browser Web Speech API (no key, or TRANSCRIPTION=browser)',
);
console.log(`[shadowadj] storage: ${config.databaseUrl}`);
