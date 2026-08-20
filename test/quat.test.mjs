import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUAT_IDENTITY,
  CANONICAL_HOLD_DEVICE_TO_GAME,
  quatMultiply,
  quatConjugate,
  quatNormalize,
  quatDot,
  quatRotateVector,
  quatFromAxisAngle,
  quatSlerp,
  quatAngleRad,
  armRotationFromPose,
  gameRotationToDeviceDelta
} from '../shared/quat.js';

const TIGHT = 1e-12;
const NEUTRAL_ARM = { x: 0, y: -1, z: 0 };
const CANONICAL_REST = quatFromAxisAngle({ x: 1 }, -Math.PI / 2);

function assertVectorClose(actual, expected, tolerance = TIGHT) {
  assert.ok(Math.abs(actual.x - expected.x) < tolerance, `x ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < tolerance, `y ${actual.y} vs ${expected.y}`);
  assert.ok(Math.abs(actual.z - expected.z) < tolerance, `z ${actual.z} vs ${expected.z}`);
}

function assertQuatClose(actual, expected, tolerance = TIGHT) {
  const aligned = quatDot(actual, expected) < 0
    ? { x: -expected.x, y: -expected.y, z: -expected.z, w: -expected.w }
    : expected;
  assert.ok(Math.abs(actual.x - aligned.x) < tolerance, `x ${actual.x} vs ${aligned.x}`);
  assert.ok(Math.abs(actual.y - aligned.y) < tolerance, `y ${actual.y} vs ${aligned.y}`);
  assert.ok(Math.abs(actual.z - aligned.z) < tolerance, `z ${actual.z} vs ${aligned.z}`);
  assert.ok(Math.abs(actual.w - aligned.w) < tolerance, `w ${actual.w} vs ${aligned.w}`);
}

test('identity is frozen and neutral under multiplication', () => {
  assert.ok(Object.isFrozen(QUAT_IDENTITY));
  assert.deepEqual({ ...QUAT_IDENTITY }, { x: 0, y: 0, z: 0, w: 1 });
  const q = quatFromAxisAngle({ x: 0.3, y: -0.7, z: 0.2 }, 0.9);
  assertQuatClose(quatMultiply(QUAT_IDENTITY, q), q);
  assertQuatClose(quatMultiply(q, QUAT_IDENTITY), q);
});

test('conjugate cancels a rotation', () => {
  const q = quatNormalize(quatFromAxisAngle({ x: 1, y: 2, z: -3 }, 1.4));
  assertQuatClose(quatMultiply(q, quatConjugate(q)), QUAT_IDENTITY);
});

test('normalize returns unit length and falls back to identity', () => {
  const q = quatNormalize({ x: 0, y: 0, z: 3, w: 3 });
  assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < TIGHT);
  assert.deepEqual(quatNormalize({ x: 0, y: 0, z: 0, w: 0 }), { x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(quatNormalize(null), { x: 0, y: 0, z: 0, w: 1 });
});

test('axis-angle accepts non-unit and partial axes', () => {
  const scaled = quatFromAxisAngle({ x: 0, y: 0, z: 5 }, Math.PI / 2);
  assertQuatClose(scaled, { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
  assertQuatClose(quatFromAxisAngle({ x: 1 }, Math.PI / 2), { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
  assert.deepEqual(quatFromAxisAngle({ x: 0, y: 0, z: 0 }, 1), { x: 0, y: 0, z: 0, w: 1 });
});

test('rotating a vector follows the right-hand rule', () => {
  const aboutZ = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  assertVectorClose(quatRotateVector(aboutZ, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 });
  const aboutX = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
  assertVectorClose(quatRotateVector(aboutX, NEUTRAL_ARM), { x: 0, y: 0, z: -1 });
});

test('canonical hold maps the device basis onto the pinned game axes', () => {
  const hold = CANONICAL_HOLD_DEVICE_TO_GAME;
  assert.ok(Object.isFrozen(hold));
  assert.deepEqual({ ...hold }, { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2, w: 0 });
  assert.ok(Math.abs(Math.hypot(hold.x, hold.y, hold.z, hold.w) - 1) < TIGHT);
  assertVectorClose(quatRotateVector(hold, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
  assertVectorClose(quatRotateVector(hold, { x: 0, y: 1, z: 0 }), { x: 0, y: -1, z: 0 });
  assertVectorClose(quatRotateVector(hold, { x: 0, y: 0, z: 1 }), { x: -1, y: 0, z: 0 });
});

test('unsynced poses leave the arm neutral', () => {
  const q = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.8);
  assert.deepEqual(armRotationFromPose(q, null), { x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(armRotationFromPose(q, undefined), { x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(armRotationFromPose(null, QUAT_IDENTITY), { x: 0, y: 0, z: 0, w: 1 });
});

test('resting in the canonical hold keeps the arm at the side', () => {
  const rotation = armRotationFromPose(CANONICAL_REST, CANONICAL_REST);
  assertVectorClose(quatRotateVector(rotation, NEUTRAL_ARM), NEUTRAL_ARM);
});

test('a ninety degree forward swing points the arm at the target', () => {
  const forwardSwing = quatFromAxisAngle({ x: 0, y: -1, z: 0 }, Math.PI / 2);
  const q = quatMultiply(forwardSwing, CANONICAL_REST);
  const rotation = armRotationFromPose(q, CANONICAL_REST);
  assertQuatClose(rotation, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2), 1e-9);
  const arm = quatRotateVector(rotation, NEUTRAL_ARM);
  assert.ok(Math.abs(arm.z + 1) < 1e-9, `z ${arm.z}`);
  assert.ok(Math.abs(arm.y) < 1e-9, `y ${arm.y}`);
  assert.ok(Math.abs(arm.x) < 1e-9, `x ${arm.x}`);
});

test('half a forward swing lifts the arm forward and up', () => {
  const forwardSwing = quatFromAxisAngle({ x: 0, y: -1, z: 0 }, Math.PI / 4);
  const rotation = armRotationFromPose(quatMultiply(forwardSwing, CANONICAL_REST), CANONICAL_REST);
  const arm = quatRotateVector(rotation, NEUTRAL_ARM);
  assert.ok(arm.z < -0.5, `z ${arm.z}`);
  assert.ok(arm.y < 0, `y ${arm.y}`);
});

test('game rotation converts back to a device delta and round-trips', () => {
  const gameRotation = quatNormalize(quatFromAxisAngle({ x: 0.4, y: -0.2, z: 0.9 }, 1.1));
  const deviceDelta = gameRotationToDeviceDelta(gameRotation);
  assertQuatClose(armRotationFromPose(deviceDelta, QUAT_IDENTITY), gameRotation, 1e-9);
  assert.deepEqual(gameRotationToDeviceDelta(null), { x: 0, y: 0, z: 0, w: 1 });
});

test('angle between quaternions ignores sign', () => {
  const a = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 0);
  const b = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  assert.ok(quatAngleRad(a, a) < TIGHT);
  assert.ok(Math.abs(quatAngleRad(a, b) - Math.PI / 2) < 1e-9);
  const negated = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  assert.ok(Math.abs(quatAngleRad(a, negated) - Math.PI / 2) < 1e-9);
});

test('slerp hits both endpoints and the midpoint', () => {
  const a = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 0);
  const b = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  assertQuatClose(quatSlerp(a, b, 0), a, 1e-12);
  assertQuatClose(quatSlerp(a, b, 1), b, 1e-12);
  const middle = quatSlerp(a, b, 0.5);
  assertQuatClose(middle, quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 4), 1e-9);
  assert.ok(Math.abs(Math.hypot(middle.x, middle.y, middle.z, middle.w) - 1) < TIGHT);
});

test('slerp takes the short way around a negated target', () => {
  const a = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.4);
  const b = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.8);
  const negated = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  assertQuatClose(quatSlerp(a, negated, 0.5), quatSlerp(a, b, 0.5), 1e-12);
});

test('slerp stays stable for nearly parallel inputs', () => {
  const a = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.2);
  const b = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.2 + 1e-7);
  const middle = quatSlerp(a, b, 0.5);
  assert.ok(Number.isFinite(middle.w));
  assert.ok(quatAngleRad(middle, a) < 1e-6);
});
