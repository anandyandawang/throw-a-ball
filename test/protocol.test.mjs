import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  MessageType,
  POSE_FLOATS,
  PoseIndex,
  encodeControlMessage,
  decodeControlMessage,
  makeHello,
  helloVersionMatches,
  makePing,
  makePong,
  makeTap
} from '../shared/protocol.js';
import {
  SIGNALING_PARAM_KEYS,
  peerOptionsFromSearch,
  signalingQueryEntries
} from '../shared/peer-config.js';

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.strictEqual(typeof PROTOCOL_VERSION, 'number');
  assert.ok(PROTOCOL_VERSION > 0);
  assert.strictEqual(PROTOCOL_VERSION, Math.floor(PROTOCOL_VERSION));
});

test('MessageType is frozen with expected keys and values', () => {
  assert.ok(Object.isFrozen(MessageType));

  const expectedKeys = ['HELLO', 'PING', 'PONG', 'TAP', 'RESET', 'THROW'];
  const actualKeys = Object.keys(MessageType);
  assert.deepStrictEqual(actualKeys.sort(), expectedKeys.sort());

  assert.strictEqual(MessageType.HELLO, 'hello');
  assert.strictEqual(MessageType.PING, 'ping');
  assert.strictEqual(MessageType.PONG, 'pong');
  assert.strictEqual(MessageType.TAP, 'tap');
  assert.strictEqual(MessageType.RESET, 'reset');
  assert.strictEqual(MessageType.THROW, 'throw');
});

test('POSE_FLOATS equals the number of PoseIndex entries', () => {
  const poseIndexCount = Object.keys(PoseIndex).length;
  assert.strictEqual(POSE_FLOATS, poseIndexCount);
});

test('PoseIndex is frozen', () => {
  assert.ok(Object.isFrozen(PoseIndex));
});

test('PoseIndex slots are unique integers 0..6', () => {
  const expectedSlots = [0, 1, 2, 3, 4, 5, 6];
  const actualSlots = Object.values(PoseIndex).sort((a, b) => a - b);

  assert.deepStrictEqual(actualSlots, expectedSlots);

  Object.values(PoseIndex).forEach(slot => {
    assert.strictEqual(typeof slot, 'number');
    assert.ok(Number.isInteger(slot));
    assert.ok(slot >= 0 && slot <= 6);
  });
});

test('encodeControlMessage/decodeControlMessage round-trip', () => {
  const message = { type: MessageType.PING, seq: 3, sentAt: 123.456 };
  const encoded = encodeControlMessage(message);
  assert.strictEqual(typeof encoded, 'string');
  assert.deepStrictEqual(decodeControlMessage(encoded), message);
});

test('decodeControlMessage returns null for non-string input', () => {
  assert.strictEqual(decodeControlMessage(undefined), null);
  assert.strictEqual(decodeControlMessage(null), null);
  assert.strictEqual(decodeControlMessage(42), null);
  assert.strictEqual(decodeControlMessage({ type: 'hello' }), null);
  assert.strictEqual(decodeControlMessage(new Uint8Array([1, 2, 3])), null);
});

test('decodeControlMessage returns null for invalid JSON', () => {
  assert.strictEqual(decodeControlMessage('not json'), null);
  assert.strictEqual(decodeControlMessage('{unterminated'), null);
});

test('decodeControlMessage returns null for JSON scalars, arrays, and null', () => {
  assert.strictEqual(decodeControlMessage('42'), null);
  assert.strictEqual(decodeControlMessage('"hello"'), null);
  assert.strictEqual(decodeControlMessage('true'), null);
  assert.strictEqual(decodeControlMessage('null'), null);
  assert.strictEqual(decodeControlMessage('[]'), null);
  assert.strictEqual(decodeControlMessage('[{"type":"hello"}]'), null);
});

test('decodeControlMessage returns null for objects without a string type', () => {
  assert.strictEqual(decodeControlMessage('{}'), null);
  assert.strictEqual(decodeControlMessage('{"type":1}'), null);
  assert.strictEqual(decodeControlMessage('{"type":null}'), null);
  assert.strictEqual(decodeControlMessage('{"foo":"bar"}'), null);
});

test('makeHello returns the current protocol version', () => {
  const hello = makeHello();
  assert.deepStrictEqual(hello, { type: MessageType.HELLO, version: PROTOCOL_VERSION });
});

test('helloVersionMatches matches the current version and rejects others', () => {
  assert.strictEqual(helloVersionMatches(makeHello()), true);
  assert.strictEqual(helloVersionMatches({ type: MessageType.HELLO, version: PROTOCOL_VERSION + 1 }), false);
});

test('makePing/makePong echo semantics', () => {
  const ping = makePing(7, 999.5);
  assert.deepStrictEqual(ping, { type: MessageType.PING, seq: 7, sentAt: 999.5 });

  const pong = makePong(ping);
  assert.deepStrictEqual(pong, { type: MessageType.PONG, seq: 7, sentAt: 999.5 });
});

test('makeTap shape', () => {
  const tap = makeTap(2, 1500.25);
  assert.deepStrictEqual(tap, { type: MessageType.TAP, id: 2, sentAt: 1500.25 });
});

test('peerOptionsFromSearch returns {} for an empty search string', () => {
  assert.deepStrictEqual(peerOptionsFromSearch(''), {});
});

test('peerOptionsFromSearch parses host, port, path, and insecure', () => {
  const options = peerOptionsFromSearch('?host=127.0.0.1&port=9100&path=/&insecure=1');
  assert.deepStrictEqual(options, { host: '127.0.0.1', port: 9100, path: '/', secure: false });
  assert.strictEqual(typeof options.port, 'number');
});

test('peerOptionsFromSearch omits absent keys and secure when insecure is absent', () => {
  const options = peerOptionsFromSearch('?host=example.com&key=abc');
  assert.deepStrictEqual(options, { host: 'example.com', key: 'abc' });
  assert.ok(!('port' in options));
  assert.ok(!('path' in options));
  assert.ok(!('secure' in options));
});

test('peerOptionsFromSearch returns {} when host is absent', () => {
  assert.deepStrictEqual(peerOptionsFromSearch('?foo=1'), {});
});

test('signalingQueryEntries returns [] for an empty search string', () => {
  assert.deepStrictEqual(signalingQueryEntries(''), []);
});

test('signalingQueryEntries returns only SIGNALING_PARAM_KEYS pairs, in order', () => {
  const entries = signalingQueryEntries('?foo=1&insecure=1&path=/&host=127.0.0.1&bar=2&port=9100');
  assert.deepStrictEqual(entries, [
    ['host', '127.0.0.1'],
    ['port', '9100'],
    ['path', '/'],
    ['insecure', '1']
  ]);
  assert.deepStrictEqual(SIGNALING_PARAM_KEYS, ['host', 'port', 'path', 'key', 'insecure']);
});
