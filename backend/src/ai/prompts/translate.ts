// Translation runs ALONGSIDE the original, never replacing it (spec §12). Used
// only to give an English gloss to a human reviewer / as judging context — the
// engines always analyse the original text.

import type { Part } from '@google/generative-ai';

export function translateParts(text: string, target = 'en'): Part[] {
  return [
    {
      text:
        `Translate the following into ${target}. Keep it faithful and plain — this is a reference gloss, ` +
        'not a polished rewrite. Preserve meaning over fluency. Return only the translation, no notes.\n\n' +
        text,
    },
  ];
}
