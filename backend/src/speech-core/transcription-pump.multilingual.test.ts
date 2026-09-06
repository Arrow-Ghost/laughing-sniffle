import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway } from '../ai/AIGateway.ts';
import { TranscriptionPump, dedupeJoin } from './transcription-pump.ts';

const MODELS = { transcribe: ['t'], coach: ['c'], judge: ['j'], similarity: ['s'], summarize: ['sm'] };

function pcm(seconds: number): Buffer {
  return Buffer.alloc(16_000 * 2 * seconds); // silent, size is what matters to the pump
}

test('multilingual pump: emits deltas with dominant language + latest speaker', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => ({
      text: JSON.stringify({
        utterances: [
          { text: 'lekin asli sawaal yah hai ki niti se kise faayda hota hai', lang: 'hi', speaker: 'Speaker A' },
          { text: 'aur yahi mera mukhya tark hai', lang: 'hi', speaker: 'Speaker A' },
          { text: 'so in conclusion the policy fails', lang: 'en', speaker: 'Speaker B' },
        ],
      }),
    }),
  });

  const deltas: Array<{ text: string; meta?: { lang?: string; speaker?: string } }> = [];
  const pump = new TranscriptionPump(
    ai,
    { onDelta: (text, meta) => deltas.push({ text, meta }), onFallback: () => {} },
    16_000,
    { multilingual: true, languages: ['en', 'hi'], expectSpeakers: 2 },
  );

  pump.push(pcm(7)); // over the 6s minimum
  await pump.flush();

  assert.equal(deltas.length, 1);
  assert.match(deltas[0]!.text, /asli sawaal/);
  assert.equal(deltas[0]!.meta?.lang, 'hi', 'Hindi is the dominant language of the chunk');
  assert.equal(deltas[0]!.meta?.speaker, 'Speaker B', 'latest speaker tag carried on the delta');
});

test('multilingual pump: malformed structured reply → repair → still yields text', async () => {
  let n = 0;
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => {
      n += 1;
      return n === 1
        ? { text: 'not json' }
        : { text: '{"utterances":[{"text":"okay here we go","lang":"en","speaker":"Speaker A"}]}' };
    },
  });
  const deltas: string[] = [];
  const pump = new TranscriptionPump(ai, { onDelta: (t) => deltas.push(t), onFallback: () => {} }, 16_000, { multilingual: true });
  pump.push(pcm(7));
  await pump.flush();
  assert.equal(n, 2);
  assert.deepEqual(deltas, ['okay here we go']);
});

test('dedupeJoin still trims the overlap seam in multilingual text', () => {
  const merged = dedupeJoin('niti se kise faayda hota hai', 'faayda hota hai aur yahi mera tark');
  assert.equal(merged, 'niti se kise faayda hota hai aur yahi mera tark');
});
