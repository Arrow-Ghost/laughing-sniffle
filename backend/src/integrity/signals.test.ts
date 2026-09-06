import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, SINGLE_CONTRIBUTION_CAP } from './signals.ts';
import { DEFAULT_POLICY } from '../domain/types.ts';
import type { EventPolicy, IntegritySignal } from '../domain/types.ts';

const sig = (over: Partial<IntegritySignal>): IntegritySignal => ({
  key: 'external-source-similarity',
  label: 'x',
  present: true,
  strength: 1,
  origin: 'source-search',
  evidence: ['e'],
  ...over,
});

const ALLOW_INTERNET: EventPolicy = { ...DEFAULT_POLICY, internet: 'allowed', externalSources: 'allowed' };

test('no single signal can reach HIGH on its own (spec §39)', () => {
  for (const key of ['external-source-similarity', 'cross-participant-similarity', 'unattributed-distinctive-match']) {
    const a = aggregate([sig({ key, strength: 1 })], DEFAULT_POLICY);
    assert.ok(a.internalScore <= SINGLE_CONTRIBUTION_CAP, `${key} scored ${a.internalScore}`);
    assert.ok(a.riskLevel === 'LOW' || a.riskLevel === 'MODERATE', `${key} → ${a.riskLevel}`);
  }
});

test('two independent strong signals reach HIGH', () => {
  const a = aggregate(
    [sig({ key: 'external-source-similarity', strength: 1 }), sig({ key: 'cross-participant-similarity', origin: 'cross-participant', strength: 1 })],
    ALLOW_INTERNET,
  );
  assert.equal(a.riskLevel, 'HIGH');
});

test('policy tilt: prohibiting internet raises the weight of source signals', () => {
  const lo = aggregate([sig({ strength: 0.6 })], ALLOW_INTERNET).internalScore;
  const hi = aggregate([sig({ strength: 0.6 })], { ...DEFAULT_POLICY, internet: 'prohibited' }).internalScore;
  assert.ok(hi > lo);
});

test('absent / zero-strength signals contribute nothing → LOW', () => {
  const a = aggregate(
    [sig({ present: false, strength: 1 }), sig({ key: 'cross-participant-similarity', origin: 'cross-participant', strength: 0 })],
    DEFAULT_POLICY,
  );
  assert.equal(a.internalScore, 0);
  assert.equal(a.riskLevel, 'LOW');
});

test('confidence needs multiple corroborated signals from independent origins', () => {
  const oneOrigin = aggregate(
    [
      sig({ key: 'external-source-similarity', strength: 0.8 }),
      sig({ key: 'unattributed-distinctive-match', strength: 0.8 }),
      sig({ key: 'quotation-without-attribution', strength: 0.8 }),
    ],
    ALLOW_INTERNET,
  );
  assert.notEqual(oneOrigin.confidence, 'high', 'all from source-search → not high');

  const twoOrigins = aggregate(
    [
      sig({ key: 'external-source-similarity', strength: 0.8 }),
      sig({ key: 'unattributed-distinctive-match', strength: 0.8 }),
      sig({ key: 'quotation-without-attribution', strength: 0.8 }),
      sig({ key: 'cross-participant-similarity', origin: 'cross-participant', strength: 0.8 }),
    ],
    ALLOW_INTERNET,
  );
  assert.equal(twoOrigins.confidence, 'high');
});
