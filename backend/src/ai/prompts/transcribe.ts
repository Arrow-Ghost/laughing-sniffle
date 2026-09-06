// Prompt for streaming speech-to-text. One slice of a continuous stream.

import type { Part } from '@google/generative-ai';

export function transcribeParts(wavBase64: string): Part[] {
  return [
    { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
    {
      text:
        'Transcribe this audio segment verbatim in English. It is one slice of a longer ' +
        'continuous stream, so it may start or end mid-sentence — transcribe only what is ' +
        'audible, do not complete or guess. Keep filler words (um, uh, like, you know) and ' +
        'false starts exactly as spoken. Return ONLY the transcript text, or nothing if there ' +
        'is no speech.',
    },
  ];
}

export const TRANSCRIBE_EMPTY_RE = /^\s*(?:there is no speech|no speech|\(silence\)|\[[^\]]*\])\s*$/i;

/** Multilingual + best-effort diarization. Structured JSON out; the original
 *  language is preserved, NOT translated (spec §12, §13, §14). */
export function transcribeStructuredParts(
  wavBase64: string,
  opts: { languages?: string[]; expectSpeakers?: number } = {},
): Part[] {
  const langHint = opts.languages && opts.languages.length
    ? `Expected languages: ${opts.languages.join(', ')}. `
    : 'The language is not known in advance. ';
  const diar =
    (opts.expectSpeakers ?? 1) > 1
      ? 'Multiple speakers may be present — label each utterance with a stable speaker tag ("Speaker A", "Speaker B", "Moderator"). '
      : 'Assume a single speaker; use "Speaker A" for every utterance. ';
  return [
    { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
    {
      text:
        'Transcribe this audio segment VERBATIM in the language(s) actually spoken. ' +
        'Do NOT translate. Keep filler words and false starts. ' +
        langHint +
        diar +
        'It is one slice of a continuous stream and may start or end mid-sentence. ' +
        'Return STRICT JSON only:\n' +
        '{ "utterances": [ { "text": "<verbatim>", "lang": "<BCP-47, e.g. en, hi, es>", "speaker": "<tag>" } ] }\n' +
        'Return { "utterances": [] } if there is no speech.',
    },
  ];
}

export const TRANSCRIBE_STRUCT_REPAIR =
  'Your previous reply was not valid JSON of the form { "utterances": [ { "text", "lang", "speaker" } ] }. Reply again with only that JSON.';

