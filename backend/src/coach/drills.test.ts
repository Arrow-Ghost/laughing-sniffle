import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drillForWeakness, nextDifficulty, DRILL_CATALOG, drillTimeSec } from './drills.ts';

test('drillForWeakness maps a weakness to the drill that trains it', () => {
  assert.equal(drillForWeakness('failed to engage the opponent’s strongest point', 'Rebuttal', 'debate'), 'rebuttal-sprint');
  assert.equal(drillForWeakness('third argument lacked supporting evidence', 'Evidence', 'debate'), 'evidence-challenge');
  assert.equal(drillForWeakness('answer was rambling and wordy', 'Communication', 'interview'), 'conciseness-drill');
  assert.equal(drillForWeakness('no roadmap; hard to follow the structure', 'Structure', 'speech'), 'signposting-drill');
  assert.equal(drillForWeakness('spoke far too fast in the final minute', 'Delivery', 'debate'), 'pace-drill');
  assert.equal(drillForWeakness('long response latency under questioning', 'Confidence', 'interview'), 'pressure-drill');
});

test('drillForWeakness falls back by event type when nothing matches', () => {
  assert.equal(drillForWeakness('unclear on the burden', 'Overall', 'interview'), 'interview-drill');
  assert.equal(drillForWeakness('unclear on the burden', 'Overall', 'speech'), 'signposting-drill');
  assert.equal(drillForWeakness('unclear on the burden', 'Overall', 'debate'), 'rebuttal-sprint');
});

test('nextDifficulty steps up when the target is met with margin, eases when it is missed badly', () => {
  assert.equal(nextDifficulty('intermediate', true, 0.3), 'advanced');
  assert.equal(nextDifficulty('intermediate', true, 0.05), 'intermediate'); // met but narrowly
  assert.equal(nextDifficulty('advanced', false, -0.4), 'intermediate');
  assert.equal(nextDifficulty('beginner', false, -0.4), 'beginner'); // floor
  assert.equal(nextDifficulty('expert', true, 0.5), 'expert'); // ceiling
});

test('every non-retry drill type has a catalogue entry with a time limit', () => {
  for (const [type, entry] of Object.entries(DRILL_CATALOG)) {
    assert.ok(entry.label && entry.goal && entry.defaultTimeSec > 0, type);
    assert.equal(drillTimeSec(type as keyof typeof DRILL_CATALOG), entry.defaultTimeSec);
  }
  assert.equal(drillTimeSec('retry'), 120);
});
