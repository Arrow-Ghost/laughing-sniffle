import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rms,
  tokenize,
  syllables,
  mattr,
  longWordRate,
  countFillers,
  punctuationDensity,
  meanUnitLength,
  paceWpm,
  createVad,
  overlapFraction,
  percentile,
} from './metrics.js';
import { SessionAnalyzer } from './analyzer.js';

/* ------------------------------- helpers ------------------------------- */
function feed(a, { energy, ms, at }) {
  // push VIZ_FRAME_MS (200ms) chunks of constant energy
  for (let t = 0; t < ms; t += 200) a.pushAudio({ samples: new Float32Array(64).fill(energy), at: at + t });
}

/* ------------------------------- units ------------------------------- */
test('rms: silence 0, full-scale ~1', () => {
  assert.equal(rms(new Float32Array(64)), 0);
  assert.ok(Math.abs(rms(new Float32Array(64).fill(1)) - 1) < 1e-6);
});

test('tokenize keeps apostrophes, drops punctuation', () => {
  assert.deepEqual(tokenize("Hello, World! It's fine."), ['hello', 'world', "it's", 'fine']);
});

test('syllables: rough vowel-group count', () => {
  assert.equal(syllables('cat'), 1);
  assert.equal(syllables('policy'), 3);
  assert.ok(syllables('international') >= 4);
});

test('mattr is stable as text grows (not biased down)', () => {
  const short = 'the quick brown fox jumps over the lazy dog again today'.split(' ');
  const long = [...short, ...short, ...short];
  const a = mattr(short, 8);
  const b = mattr(long, 8);
  assert.ok(Math.abs(a - b) < 0.15, `mattr drifted: ${a} vs ${b}`);
});

test('longWordRate needs enough content words, else null', () => {
  assert.equal(longWordRate(tokenize('a the of to')), null);
  const r = longWordRate(tokenize('international development policy requires sustainable institutional cooperation between governments'));
  assert.ok(r > 0.3);
});

test('countFillers: hard vs soft, and "like" is context-gated', () => {
  const f = countFillers("So um, I was like, you know, uh I feel like we should, like, reconsider");
  assert.ok(f.hard.count >= 2, `hard: ${JSON.stringify(f.hard)}`);
  assert.ok(f.hard.tokens.includes('um'));
  // "I was like" (quotative) + ", like," (comma) count; "I feel like" does not.
  assert.ok(f.soft.tokens.filter((t) => t === 'like').length >= 1);
  assert.ok(f.soft.tokens.filter((t) => t === 'like').length <= 2);
  assert.ok(f.soft.tokens.includes('you know'));
});

test('countFillers does not flag lexical "like"/"actually"', () => {
  const f = countFillers('I would like to note that things like this actually matter to people');
  assert.equal(f.soft.tokens.filter((t) => t === 'like').length, 0);
});

test('punctuationDensity / meanUnitLength basis switch', () => {
  assert.ok(punctuationDensity('One two three. Four five.') > 0.02);
  assert.equal(meanUnitLength('One two three. Four five.').basis, 'punctuation');
  assert.equal(meanUnitLength('one two three four five six seven eight', [3, 5, 4]).basis, 'pauses');
});

test('paceWpm normalises by speaking seconds', () => {
  assert.equal(paceWpm(150, 60), 150);
  assert.equal(paceWpm(10, 0), null);
});

test('overlapFraction', () => {
  assert.equal(overlapFraction(0, 10, 5, 15), 0.5);
  assert.equal(overlapFraction(0, 10, 20, 30), 0);
});

/* --------------------------- streaming VAD --------------------------- */
test('percentile', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.2), 2);
  assert.equal(percentile([], 0.5), 0);
});

test('createVad opens on sustained energy and closes after the hangover', () => {
  const vad = createVad();
  const segs = [];
  let t = 0;
  const step = (e, n) => {
    for (let i = 0; i < n; i += 1) {
      const c = vad.push(e, t, t + 50);
      if (c) segs.push(c);
      t += 50;
    }
  };
  step(0.0008, 20); // 1s quiet
  step(0.05, 40); // 2s speech
  step(0.0008, 20); // 1s quiet -> closes speech (hangover 550ms)
  step(0.05, 10);
  const speech = segs.filter((s) => s.kind === 'speech');
  assert.equal(speech.length, 1, JSON.stringify(segs));
  const dur = speech[0].end - speech[0].start;
  assert.ok(dur > 1600 && dur < 2200, `speech dur ${dur}`);
});

test('VAD holds one phrase together through a brief inter-word dip', () => {
  const vad = createVad();
  let t = 0;
  const segs = [];
  const push = (e) => {
    const c = vad.push(e, t, t + 50);
    if (c) segs.push(c);
    t += 50;
  };
  for (let i = 0; i < 15; i += 1) push(0.0008);
  for (let i = 0; i < 20; i += 1) push(0.05);
  for (let i = 0; i < 6; i += 1) push(0.002); // 300ms gap between words — under the 550ms hangover
  for (let i = 0; i < 20; i += 1) push(0.05);
  for (let i = 0; i < 20; i += 1) push(0.0008); // 1s quiet -> now it closes
  const speech = segs.filter((s) => s.kind === 'speech');
  assert.equal(speech.length, 1, `expected 1 unbroken phrase, got ${speech.length}: ${JSON.stringify(segs)}`);
});

/* --------------------------- analyzer end-to-end --------------------------- */
test('snapshot gates noisy metrics until there is enough evidence', () => {
  const a = new SessionAnalyzer();
  a.setTranscriptSource('browser');
  feed(a, { energy: 0.05, ms: 2000, at: 0 });
  a.pushTranscript({ text: 'short opener here', isFinal: true });
  const snap = a.snapshot();
  assert.equal(snap.pace.wpm, null, 'pace should not show on 2s of audio');
  assert.equal(snap.pace.ready, false);
  assert.equal(snap.fillers.hardPerMin, null);
});

test('pace becomes available and is bounded with realistic input', () => {
  const a = new SessionAnalyzer();
  a.setTranscriptSource('browser');
  // 20s of speech, ~50 words trickled in 5 finals of 10 words each.
  for (let k = 0; k < 5; k += 1) {
    feed(a, { energy: 0.06, ms: 4000, at: k * 4000 });
    a.pushTranscript({ text: Array(10).fill('word').join(' '), isFinal: true });
  }
  const snap = a.snapshot();
  assert.ok(snap.pace.ready, JSON.stringify(snap.pace));
  assert.ok(snap.pace.wpm > 60 && snap.pace.wpm < 320, `wpm out of range: ${snap.pace.wpm}`);
  assert.ok(snap.delivery.speakingSecondsTotal >= 15, `speaking total ${snap.delivery.speakingSecondsTotal}`);
  assert.ok(snap.delivery.talkRatio > 0.7);
});

test('detects a mid-answer pause of the right length', () => {
  const a = new SessionAnalyzer();
  feed(a, { energy: 0.06, ms: 3000, at: 0 });
  feed(a, { energy: 0.0008, ms: 1400, at: 3000 }); // ~1.4s pause
  feed(a, { energy: 0.06, ms: 3000, at: 4400 });
  const snap = a.snapshot();
  assert.equal(snap.pauses.count, 1, JSON.stringify(snap.timeline));
  assert.ok(snap.pauses.longestMs > 900 && snap.pauses.longestMs < 1800, `pause ${snap.pauses.longestMs}`);
});

test('answerLatency: question then silence then speech', () => {
  const a = new SessionAnalyzer();
  feed(a, { energy: 0.0008, ms: 1000, at: 0 });
  a.markQuestion({ label: 'Q1', at: 800 });
  feed(a, { energy: 0.0008, ms: 1200, at: 1000 });
  feed(a, { energy: 0.06, ms: 3000, at: 2200 });
  const lat = a.snapshot().answerLatency;
  assert.equal(lat.pending, false, JSON.stringify(lat));
  assert.ok(!('alreadySpeaking' in lat));
  assert.ok(lat.latencyMs >= 800 && lat.latencyMs < 2200, `latency ${lat.latencyMs}`);
});

test('answerLatency reports alreadySpeaking when marked mid-phrase', () => {
  const a = new SessionAnalyzer();
  feed(a, { energy: 0.06, ms: 4000, at: 0 });
  a.markQuestion({ label: 'Q1', at: 2000 });
  feed(a, { energy: 0.06, ms: 2000, at: 4000 });
  const lat = a.snapshot().answerLatency;
  assert.equal(lat.alreadySpeaking, true, JSON.stringify(lat));
});

test('snapshot never contains a verdict / authorship field', () => {
  const a = new SessionAnalyzer();
  a.setTranscriptSource('browser');
  feed(a, { energy: 0.06, ms: 12000, at: 0 });
  a.pushTranscript({ text: 'This is a normal practice answer about climate policy and trade unions.', isFinal: true });
  const json = JSON.stringify(a.snapshot()).toLowerCase();
  for (const banned of ['aiscore', 'ailikelihood', 'cheat', 'verdict', 'suspicion', 'authenticity', 'risk', 'accus']) {
    assert.ok(!json.includes(banned), `snapshot leaked "${banned}"`);
  }
});
