import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage } from './protocol.ts';

test('accepts the known client messages', () => {
  assert.deepEqual(parseClientMessage('{"type":"hello","transcriptSource":"server"}'), {
    type: 'hello',
    transcriptSource: 'server',
  });
  assert.deepEqual(parseClientMessage('{"type":"hello"}'), { type: 'hello', transcriptSource: undefined });
  assert.deepEqual(parseClientMessage('{"type":"transcript","text":"hi","isFinal":true}'), {
    type: 'transcript',
    text: 'hi',
    isFinal: true,
  });
  assert.deepEqual(parseClientMessage('{"type":"question","label":"Q2"}'), { type: 'question', label: 'Q2' });
  assert.deepEqual(parseClientMessage('{"type":"end"}'), { type: 'end' });
});

test('rejects malformed or unknown messages by returning null', () => {
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('[]'), null);
  assert.equal(parseClientMessage('{"type":"bogus"}'), null);
  assert.equal(parseClientMessage('{"type":"transcript"}'), null); // missing text
  assert.equal(parseClientMessage('{"type":"hello","transcriptSource":"telepathy"}'), null);
});

test('trims an over-long question label', () => {
  const m = parseClientMessage(JSON.stringify({ type: 'question', label: 'x'.repeat(200) }));
  assert.equal(m?.type === 'question' && m.label?.length, 80);
});
