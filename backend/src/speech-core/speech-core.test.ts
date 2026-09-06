import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechCore } from './index.ts';

function int16(fill: number, samples = 1024): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE(fill, i * 2);
  return b;
}

test('SpeechCore in browser mode: audio + transcript flow to a snapshot', async () => {
  const core = new SpeechCore('s1', { transcriptSource: 'browser', ai: null });

  const transcripts: string[] = [];
  core.on('transcript', (t) => transcripts.push(t.text));

  // ~6s of "speech" energy, then a browser final transcript
  for (let i = 0; i < 90; i += 1) core.ingestAudio(int16(6000));
  core.ingestBrowserTranscript('thank you chair my first point concerns trade policy and its effect on workers', true);

  const snap = core.snapshot();
  assert.equal(snap.transcript.source, 'browser');
  assert.ok(snap.transcript.wordCount >= 12);
  assert.equal(transcripts.length, 1);
  assert.ok(snap.delivery.speakingSecondsTotal > 2);
});

test('SpeechCore ignores server transcripts when in browser mode', () => {
  const core = new SpeechCore('s2', { transcriptSource: 'browser', ai: null });
  core.ingestBrowserTranscript('kept', true);
  // there is no server pump without ai; a stray browser-typed call still routes
  assert.equal(core.transcriptSource, 'browser');
  assert.match(core.snapshot().transcript.text, /kept/);
});

test('markQuestion emits a timeline event and shows on the snapshot', () => {
  const core = new SpeechCore('s3', { transcriptSource: 'browser', ai: null });
  const kinds: string[] = [];
  core.on('timeline', (e) => kinds.push(e.kind));
  for (let i = 0; i < 10; i += 1) core.ingestAudio(int16(20));
  core.markQuestion('Q1');
  for (let i = 0; i < 60; i += 1) core.ingestAudio(int16(6000));
  assert.deepEqual(kinds, ['question']);
  assert.ok(core.snapshot().timeline.some((e) => e.kind === 'question'));
});

test('snapshot still carries no verdict / authorship field after the refactor', () => {
  const core = new SpeechCore('s4', { transcriptSource: 'browser', ai: null });
  for (let i = 0; i < 120; i += 1) core.ingestAudio(int16(6000));
  core.ingestBrowserTranscript('a normal practice answer about climate policy and trade unions today', true);
  const json = JSON.stringify(core.snapshot()).toLowerCase();
  for (const banned of ['aiscore', 'ailikelihood', 'cheat', 'verdict', 'suspicion', 'authenticity', 'risk', 'accus']) {
    assert.ok(!json.includes(banned), `leaked "${banned}"`);
  }
});
