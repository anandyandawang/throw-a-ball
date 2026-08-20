import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePose } from '../shared/protocol.js';
import {
  QUAT_IDENTITY,
  armRotationFromPose,
  gameRotationToDeviceDelta,
  quatRotateVector,
  quatAngleRad
} from '../shared/quat.js';
import { HandInputEvent, createHandInputEmitter } from '../js/input/hand-input.js';
import { createSeqGate, createPhoneAdapter } from '../js/input/phone-adapter.js';
import {
  ScriptedDefaults,
  scriptedParams,
  swingAngleRad,
  swingGameRotation,
  dragGameRotation
} from '../js/input/scripted-adapter.js';

const NEUTRAL_ARM = { x: 0, y: -1, z: 0 };
const DEG_TO_RAD = Math.PI / 180;

function poseData(seq) {
  return encodePose({ quaternion: QUAT_IDENTITY, speed: 1.5, seq, timestampMs: seq * 16 });
}

test('event names are frozen and cover the wire events', () => {
  assert.ok(Object.isFrozen(HandInputEvent));
  assert.deepEqual({ ...HandInputEvent }, { POSE: 'pose', SYNC: 'sync', THROW: 'throw' });
});

test('emitter fans out to every handler in registration order', () => {
  const emitter = createHandInputEmitter();
  const seen = [];
  emitter.on(HandInputEvent.POSE, (payload) => seen.push(`first:${payload.seq}`));
  emitter.on(HandInputEvent.POSE, (payload) => seen.push(`second:${payload.seq}`));
  emitter.emit(HandInputEvent.POSE, { seq: 7 });
  assert.deepEqual(seen, ['first:7', 'second:7']);
});

test('emitter keeps events separate and tolerates unknown events', () => {
  const emitter = createHandInputEmitter();
  const poses = [];
  const syncs = [];
  emitter.on(HandInputEvent.POSE, (payload) => poses.push(payload));
  emitter.on(HandInputEvent.SYNC, (payload) => syncs.push(payload));
  emitter.emit(HandInputEvent.SYNC, { qRef: null });
  emitter.emit(HandInputEvent.THROW, {});
  assert.equal(poses.length, 0);
  assert.equal(syncs.length, 1);
});

test('emitter unsubscribes a single handler and ignores non-functions', () => {
  const emitter = createHandInputEmitter();
  const seen = [];
  const off = emitter.on(HandInputEvent.POSE, (payload) => seen.push(payload));
  emitter.on(HandInputEvent.POSE, null);
  emitter.emit(HandInputEvent.POSE, 1);
  off();
  emitter.emit(HandInputEvent.POSE, 2);
  assert.deepEqual(seen, [1]);
});

test('seq gate accepts the first packet and every newer one', () => {
  const gate = createSeqGate();
  assert.equal(gate.accept(0), true);
  assert.equal(gate.accept(1), true);
  assert.equal(gate.accept(9), true);
});

test('seq gate drops repeated and stale packets', () => {
  const gate = createSeqGate();
  gate.accept(500);
  assert.equal(gate.accept(500), false);
  assert.equal(gate.accept(499), false);
  assert.equal(gate.accept(1), false);
  assert.equal(gate.accept(501), true);
});

test('seq gate re-anchors when the phone restarts far behind', () => {
  const gate = createSeqGate();
  gate.accept(5000);
  assert.equal(gate.accept(4000), false);
  assert.equal(gate.accept(3999), true);
  assert.equal(gate.accept(4000), true);
});

test('seq gate rejects non-finite sequence numbers and resets', () => {
  const gate = createSeqGate();
  assert.equal(gate.accept(Number.NaN), false);
  assert.equal(gate.accept(Number.POSITIVE_INFINITY), false);
  assert.equal(gate.accept(10), true);
  assert.equal(gate.accept(2), false);
  gate.reset();
  assert.equal(gate.accept(2), true);
});

test('phone adapter stays silent until started and after stopping', () => {
  const adapter = createPhoneAdapter();
  const poses = [];
  adapter.on(HandInputEvent.POSE, (pose) => poses.push(pose));
  adapter.ingestPoseData(poseData(1));
  assert.equal(poses.length, 0);
  adapter.start();
  adapter.ingestPoseData(poseData(2));
  assert.equal(poses.length, 1);
  adapter.stop();
  adapter.ingestPoseData(poseData(3));
  assert.equal(poses.length, 1);
});

test('phone adapter decodes poses and drops stale packets', () => {
  const adapter = createPhoneAdapter();
  const poses = [];
  adapter.on(HandInputEvent.POSE, (pose) => poses.push(pose));
  adapter.start();
  adapter.ingestPoseData(poseData(4));
  adapter.ingestPoseData(poseData(3));
  adapter.ingestPoseData(poseData(5));
  adapter.ingestPoseData(new Float32Array(3));
  assert.deepEqual(poses.map((pose) => pose.seq), [4, 5]);
  assert.equal(poses[0].speed, 1.5);
  assert.equal(poses[1].timestampMs, 80);
  assert.deepEqual(poses[0].quaternion, { x: 0, y: 0, z: 0, w: 1 });
});

test('phone adapter forwards sync references and clears on null', () => {
  const adapter = createPhoneAdapter();
  const syncs = [];
  adapter.on(HandInputEvent.SYNC, (event) => syncs.push(event.qRef));
  adapter.start();
  adapter.ingestSync({ x: 0, y: 0, z: 0.5, w: 0.5 });
  adapter.ingestSync(null);
  adapter.ingestSync({ x: Number.NaN, y: 0, z: 0, w: 1 });
  assert.deepEqual(syncs, [{ x: 0, y: 0, z: 0.5, w: 0.5 }, null, null]);
});

test('scripted params fall back to the documented defaults', () => {
  assert.deepEqual(scriptedParams(new URLSearchParams('')), { ...ScriptedDefaults });
  assert.deepEqual(scriptedParams(null), { ...ScriptedDefaults });
  assert.deepEqual(scriptedParams(new URLSearchParams('swingDeg=abc&axis=z')), { ...ScriptedDefaults });
});

test('scripted params read every knob from the query string', () => {
  const params = scriptedParams(
    new URLSearchParams('swingDeg=90&windupDeg=20&periodMs=1200&restMs=300&axis=y')
  );
  assert.deepEqual(params, {
    swingDeg: 90,
    windupDeg: 20,
    periodMs: 1200,
    restMs: 300,
    axis: 'y'
  });
});

test('the swing profile winds up, whips past the target and rests at zero', () => {
  const params = scriptedParams(new URLSearchParams(''));
  assert.ok(Math.abs(swingAngleRad(0, params)) < 1e-12);
  assert.ok(swingAngleRad(params.periodMs * 0.3, params) < -30 * DEG_TO_RAD);
  assert.ok(
    Math.abs(swingAngleRad(params.periodMs * 0.6, params) - params.swingDeg * DEG_TO_RAD) < 1e-12
  );
  assert.ok(Math.abs(swingAngleRad(params.periodMs, params)) < 1e-12);
  assert.equal(swingAngleRad(params.periodMs + params.restMs / 2, params), 0);
});

test('the swing profile repeats every cycle and stays C1 continuous', () => {
  const params = scriptedParams(new URLSearchParams(''));
  const cycleMs = params.periodMs + params.restMs;
  assert.ok(Math.abs(swingAngleRad(400, params) - swingAngleRad(400 + cycleMs, params)) < 1e-12);
  let maxSecondDifference = 0;
  for (let ms = 1; ms < cycleMs; ms += 1) {
    const secondDifference = Math.abs(
      swingAngleRad(ms + 1, params) - 2 * swingAngleRad(ms, params) + swingAngleRad(ms - 1, params)
    );
    maxSecondDifference = Math.max(maxSecondDifference, secondDifference);
  }
  assert.ok(maxSecondDifference < 2e-4, `second difference ${maxSecondDifference}`);
});

test('a positive swing angle lifts the arm forward toward the target', () => {
  const halfway = quatRotateVector(swingGameRotation(45 * DEG_TO_RAD, 'x'), NEUTRAL_ARM);
  assert.ok(halfway.z < -0.5, `z ${halfway.z}`);
  assert.ok(halfway.y > NEUTRAL_ARM.y, `y ${halfway.y}`);
  const peak = quatRotateVector(swingGameRotation(110 * DEG_TO_RAD, 'x'), NEUTRAL_ARM);
  assert.ok(peak.z < -0.5, `z ${peak.z}`);
  assert.ok(peak.y > 0, `y ${peak.y}`);
});

test('the yaw axis swings the arm sideways instead of forward', () => {
  const rotation = swingGameRotation(90 * DEG_TO_RAD, 'y');
  assert.ok(Math.abs(quatAngleRad(rotation, QUAT_IDENTITY) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(quatRotateVector(rotation, { x: 0, y: 0, z: -1 }).x + 1) < 1e-9);
});

test('scripted game rotations round-trip through the wire shape', () => {
  const params = scriptedParams(new URLSearchParams(''));
  for (const ms of [0, 240, 700, 960, 1500, 2100]) {
    const gameRotation = swingGameRotation(swingAngleRad(ms, params), params.axis);
    const wireQuaternion = gameRotationToDeviceDelta(gameRotation);
    assert.ok(
      quatAngleRad(armRotationFromPose(wireQuaternion, QUAT_IDENTITY), gameRotation) < 1e-6,
      `round trip failed at ${ms}ms`
    );
  }
});

test('dragging up pitches the arm forward and dragging sideways yaws it', () => {
  const pitched = quatRotateVector(dragGameRotation(0, 45 * DEG_TO_RAD), NEUTRAL_ARM);
  assert.ok(pitched.z < -0.5, `z ${pitched.z}`);
  assert.ok(pitched.y > NEUTRAL_ARM.y, `y ${pitched.y}`);
  const yawed = dragGameRotation(90 * DEG_TO_RAD, 0);
  assert.ok(Math.abs(quatAngleRad(yawed, QUAT_IDENTITY) - Math.PI / 2) < 1e-9);
  assert.deepEqual(dragGameRotation(0, 0), { x: 0, y: 0, z: 0, w: 1 });
});
