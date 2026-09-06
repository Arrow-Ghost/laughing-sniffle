import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRubric, normalizeWeights, rubricFromPreset, RUBRIC_PRESETS, DEFAULT_ANCHORS } from './rubrics.ts';
import { ValidationError } from './entities.ts';

test('every preset normalises to weights summing to 1', () => {
  for (const key of Object.keys(RUBRIC_PRESETS)) {
    const r = rubricFromPreset(key);
    const total = r.criteria.reduce((a, c) => a + c.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${key} sums to ${total}`);
    assert.ok(r.criteria.every((c) => c.scaleMin === 1 && c.scaleMax === 10));
    assert.deepEqual(r.criteria[0]!.anchors, DEFAULT_ANCHORS);
  }
});

test('createRubric rejects bad input', () => {
  assert.throws(() => createRubric({ name: '', eventType: 'debate', criteria: [{ name: 'X', weight: 1, description: '' }] }), ValidationError);
  assert.throws(() => createRubric({ name: 'R', eventType: 'karaoke', criteria: [{ name: 'X', weight: 1, description: '' }] }), ValidationError);
  assert.throws(() => createRubric({ name: 'R', eventType: 'debate', criteria: [] }), ValidationError);
  assert.throws(
    () => createRubric({ name: 'R', eventType: 'debate', criteria: [{ name: 'X', weight: 0, description: '' }] }),
    ValidationError,
  );
});

test('normalizeWeights scales any positive total to 1; rejects a non-positive one', () => {
  const base = [
    { id: 'a', name: 'A', weight: 3, description: '', scaleMin: 1, scaleMax: 10, anchors: {}, evaluationRules: '', dimension: null },
    { id: 'b', name: 'B', weight: 1, description: '', scaleMin: 1, scaleMax: 10, anchors: {}, evaluationRules: '', dimension: null },
  ];
  const n = normalizeWeights(base);
  assert.ok(Math.abs(n[0]!.weight - 0.75) < 1e-9);
  assert.ok(Math.abs(n.reduce((a, c) => a + c.weight, 0) - 1) < 1e-9);
  // percentages scale to the same ratio
  const pct = normalizeWeights(base.map((c) => ({ ...c, weight: c.weight * 25 })));
  assert.ok(Math.abs(pct[0]!.weight - 0.75) < 1e-9);
  assert.throws(() => normalizeWeights(base.map((c) => ({ ...c, weight: 0 }))), ValidationError);
});

test('a custom rubric accepts percentages (spec §17) and round-trips', () => {
  const r = createRubric({
    name: 'MUN — position',
    eventType: 'mun',
    criteria: [
      { name: 'Diplomacy', weight: 60, description: 'tone and coalition-building' },
      { name: 'Policy grounding', weight: 40, description: 'accuracy to the assigned nation' },
    ],
  });
  assert.equal(r.criteria.length, 2);
  assert.ok(Math.abs(r.criteria[0]!.weight - 0.6) < 1e-9);
});
