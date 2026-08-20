import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  MessageType,
  POSE_FLOATS,
  PoseIndex
} from '../shared/protocol.js';

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.strictEqual(typeof PROTOCOL_VERSION, 'number');
  assert.ok(PROTOCOL_VERSION > 0);
  assert.strictEqual(PROTOCOL_VERSION, Math.floor(PROTOCOL_VERSION));
});

test('MessageType is frozen with expected keys and values', () => {
  assert.ok(Object.isFrozen(MessageType));

  const expectedKeys = ['HELLO', 'PING', 'PONG', 'RESET', 'THROW'];
  const actualKeys = Object.keys(MessageType);
  assert.deepStrictEqual(actualKeys.sort(), expectedKeys.sort());

  assert.strictEqual(MessageType.HELLO, 'hello');
  assert.strictEqual(MessageType.PING, 'ping');
  assert.strictEqual(MessageType.PONG, 'pong');
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
