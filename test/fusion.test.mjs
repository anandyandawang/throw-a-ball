import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quatConjugate,
  quatMultiply,
  quatRotateVector,
  quatFromAxisAngle,
  quatAngleRad
} from '../shared/quat.js';
import {
  ARM_LENGTH_M,
  GRAVITY_M_S2,
  TILT_GAIN,
  ACCEL_TRUST_BAND_M_S2,
  VELOCITY_LEAK_LAMBDA,
  ACCEL_HIGHPASS_ALPHA,
  REST_GYRO_MAX_RAD_S,
  REST_ACCEL_BAND_M_S2,
  REST_HOLD_MS,
  YAW_PULL_MAX_ANGLE_RAD,
  YAW_PULL_GAIN,
  SYNC_GRAVITY_CONE_DEG,
  SYNC_ACCEL_MIN_M_S2,
  SYNC_ACCEL_MAX_M_S2,
  createFusion,
  fusionInitialized,
  fusionSnapshot,
  fuseMotionSample,
  checkSyncHold,
  captureSyncReference,
  setSyncReference,
  resetFusionMotion
} from '../phone/js/fusion.js';

const FRAME_MS = 16.6667;
const FAST_STEP_MS = 5;
const DEG_PER_RAD = 180 / Math.PI;
const WORLD_UP = { x: 0, y: 0, z: 1 };
const DEVICE_UP_AT_CANONICAL_HOLD = { x: 0, y: -1, z: 0 };
const CANONICAL_REST_ACCEL = { x: 0, y: -GRAVITY_M_S2, z: 0 };
const FLAT_REST_ACCEL = { x: 0, y: 0, z: GRAVITY_M_S2 };
const CANONICAL_REST_QUATERNION = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

function sample(overrides) {
  return {
    dtMs: FRAME_MS,
    gyroRadPerS: null,
    accel: null,
    accelIncludingGravity: null,
    ...overrides
  };
}

function feed(fusion, count, overrides) {
  let snapshot = fusionSnapshot(fusion);
  for (let index = 0; index < count; index += 1) {
    snapshot = fuseMotionSample(fusion, sample(overrides));
  }
  return snapshot;
}

function initializedAt(accelIncludingGravity) {
  const fusion = createFusion();
  fuseMotionSample(fusion, sample({ accelIncludingGravity }));
  return fusion;
}

function tiltErrorDeg(fusion, expectedDeviceUp) {
  const predictedUp = quatRotateVector(quatConjugate(fusion.q), WORLD_UP);
  const dot = predictedUp.x * expectedDeviceUp.x
    + predictedUp.y * expectedDeviceUp.y
    + predictedUp.z * expectedDeviceUp.z;
  return Math.acos(Math.min(1, Math.max(-1, dot))) * DEG_PER_RAD;
}

function tiltedAccel(offsetDeg) {
  const offset = offsetDeg / DEG_PER_RAD;
  return {
    x: Math.sin(offset) * GRAVITY_M_S2,
    y: -Math.cos(offset) * GRAVITY_M_S2,
    z: 0
  };
}

test('constants keep the values the rest of the app builds against', () => {
  assert.equal(ARM_LENGTH_M, 0.3);
  assert.equal(GRAVITY_M_S2, 9.81);
  assert.equal(VELOCITY_LEAK_LAMBDA, 0.98);
  assert.equal(ACCEL_HIGHPASS_ALPHA, 0.02);
  assert.equal(REST_GYRO_MAX_RAD_S, 0.15);
  assert.equal(REST_ACCEL_BAND_M_S2, 0.6);
  assert.equal(REST_HOLD_MS, 120);
  assert.equal(YAW_PULL_GAIN, 0.02);
  assert.equal(SYNC_GRAVITY_CONE_DEG, 30);
  assert.equal(SYNC_ACCEL_MIN_M_S2, 7);
  assert.equal(SYNC_ACCEL_MAX_M_S2, 13);
  assert.ok(TILT_GAIN > 0);
  assert.ok(ACCEL_TRUST_BAND_M_S2 > 0);
  assert.ok(YAW_PULL_MAX_ANGLE_RAD > 0.4 && YAW_PULL_MAX_ANGLE_RAD < 0.5);
});

test('a fresh fusion has nothing to report', () => {
  const fusion = createFusion();
  assert.equal(fusionInitialized(fusion), false);
  const snapshot = fusionSnapshot(fusion);
  assert.equal(snapshot.quaternion, null);
  assert.equal(snapshot.qRef, null);
  assert.equal(snapshot.speed, 0);
  assert.equal(snapshot.atRest, false);
  assert.equal(snapshot.initialized, false);
});

test('initialization waits for a gravity-sized reading', () => {
  const fusion = createFusion();
  feed(fusion, 5, { accelIncludingGravity: { x: 0, y: -30, z: 0 } });
  assert.equal(fusionInitialized(fusion), false);
  feed(fusion, 5, { accelIncludingGravity: null, accel: { x: 1, y: 1, z: 1 } });
  assert.equal(fusionInitialized(fusion), false);
  const snapshot = fuseMotionSample(fusion, sample({ accelIncludingGravity: CANONICAL_REST_ACCEL }));
  assert.equal(fusionInitialized(fusion), true);
  assert.ok(snapshot.quaternion !== null);
});

test('initialization aligns measured up with world up and no yaw', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  assert.ok(tiltErrorDeg(fusion, DEVICE_UP_AT_CANONICAL_HOLD) < 1e-4);
  assert.ok(quatAngleRad(fusion.q, CANONICAL_REST_QUATERNION) < 1e-6);
  const flat = initializedAt(FLAT_REST_ACCEL);
  assert.ok(quatAngleRad(flat.q, { x: 0, y: 0, z: 0, w: 1 }) < 1e-6);
});

test('a null delta time is a no-op', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const before = fusionSnapshot(fusion);
  fuseMotionSample(fusion, sample({ dtMs: null, gyroRadPerS: { x: 5, y: 0, z: 0 } }));
  fuseMotionSample(fusion, sample({ dtMs: 0, gyroRadPerS: { x: 5, y: 0, z: 0 } }));
  fuseMotionSample(fusion, { dtMs: FRAME_MS });
  assert.deepEqual(fusionSnapshot(fusion).quaternion, before.quaternion);
});

test('snapshots are copies, never live state', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  captureSyncReference(fusion);
  const snapshot = fusionSnapshot(fusion);
  snapshot.quaternion.x = 42;
  snapshot.qRef.w = 42;
  assert.notEqual(fusion.q.x, 42);
  assert.notEqual(fusion.qRef.w, 42);
});

test('gyro-only integration turns ninety degrees about each device axis', () => {
  const axes = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ];
  const rateRadPerS = Math.PI / 2;
  const steps = 200;
  for (const axis of axes) {
    const fusion = initializedAt(FLAT_REST_ACCEL);
    feed(fusion, steps, {
      dtMs: FAST_STEP_MS,
      gyroRadPerS: {
        x: axis.x * rateRadPerS,
        y: axis.y * rateRadPerS,
        z: axis.z * rateRadPerS
      }
    });
    const errorDeg = quatAngleRad(fusion.q, quatFromAxisAngle(axis, Math.PI / 2)) * DEG_PER_RAD;
    assert.ok(errorDeg <= 1, `axis ${JSON.stringify(axis)} error ${errorDeg}`);
  }
});

test('tilt correction pulls a twenty degree error back to level', () => {
  const fusion = initializedAt(tiltedAccel(20));
  assert.ok(Math.abs(tiltErrorDeg(fusion, DEVICE_UP_AT_CANONICAL_HOLD) - 20) < 1e-6);
  feed(fusion, 180, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.ok(tiltErrorDeg(fusion, DEVICE_UP_AT_CANONICAL_HOLD) < 2);
});

test('violent accelerations are distrusted by the tilt correction', () => {
  const fusion = initializedAt(tiltedAccel(20));
  feed(fusion, 180, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: { x: 0, y: -40, z: 0 }
  });
  assert.ok(Math.abs(tiltErrorDeg(fusion, DEVICE_UP_AT_CANONICAL_HOLD) - 20) < 0.01);
});

test('accelerometer corrections cannot observe yaw', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const truth = { ...fusion.q };
  const yawOffsetRad = 30 / DEG_PER_RAD;
  const yaw = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, yawOffsetRad);
  fusion.q = quatMultiply(yaw, truth);
  const offsetPose = { ...fusion.q };
  feed(fusion, 180, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.ok(tiltErrorDeg(fusion, DEVICE_UP_AT_CANONICAL_HOLD) < 1e-4);
  assert.ok(quatAngleRad(fusion.q, offsetPose) * DEG_PER_RAD < 0.01);
  assert.ok(Math.abs(quatAngleRad(fusion.q, truth) - yawOffsetRad) < 1e-4);
});

test('resting near the sync reference re-zeros yaw drift', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  captureSyncReference(fusion);
  const driftRad = 10 / DEG_PER_RAD;
  fusion.q = quatMultiply(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, driftRad), fusion.q);
  feed(fusion, 180, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.ok(quatAngleRad(fusion.q, fusion.qRef) * DEG_PER_RAD < 2);
});

test('a large offset from the reference is left alone', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  captureSyncReference(fusion);
  const driftRad = 40 / DEG_PER_RAD;
  fusion.q = quatMultiply(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, driftRad), fusion.q);
  feed(fusion, 180, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.ok(Math.abs(quatAngleRad(fusion.q, fusion.qRef) - driftRad) < 1e-3);
});

test('the tangential proxy reports arm speed under pure rotation', () => {
  const fusion = initializedAt(FLAT_REST_ACCEL);
  const rateRadPerS = 5;
  const snapshot = feed(fusion, 4, {
    gyroRadPerS: { x: 0, y: 0, z: rateRadPerS },
    accel: { x: 0, y: 0, z: 0 }
  });
  assert.ok(Math.abs(snapshot.speed - rateRadPerS * ARM_LENGTH_M) < 1e-12);
  assert.equal(snapshot.atRest, false);
});

test('a zero-velocity update kills drift after the rest hold', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const moving = feed(fusion, 20, {
    gyroRadPerS: { x: 0, y: 0, z: 1.5 },
    accel: { x: 0, y: 0, z: 8 },
    accelIncludingGravity: { x: 0, y: -GRAVITY_M_S2, z: 8 }
  });
  assert.ok(moving.speed > 0.5, `speed ${moving.speed}`);
  assert.equal(moving.atRest, false);

  const restSteps = Math.ceil(150 / FRAME_MS);
  const resting = feed(fusion, restSteps, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.equal(resting.speed, 0);
  assert.equal(resting.atRest, true);
  assert.equal(fusion.velocity.x, 0);
  assert.equal(fusion.velocity.y, 0);
  assert.equal(fusion.velocity.z, 0);
});

test('the rest hold is not reached before its dwell time', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const early = feed(fusion, 5, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.equal(early.atRest, false);
  const later = feed(fusion, 3, {
    gyroRadPerS: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: 0 },
    accelIncludingGravity: CANONICAL_REST_ACCEL
  });
  assert.equal(later.atRest, true);
});

test('velocity leaks away when the accelerometer goes quiet', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const driven = feed(fusion, 20, {
    accel: { x: 0, y: 0, z: 8 },
    accelIncludingGravity: { x: 0, y: -GRAVITY_M_S2, z: 8 }
  });
  const coasting = [];
  for (let index = 0; index < 30; index += 1) {
    coasting.push(fuseMotionSample(fusion, sample({ accel: { x: 0, y: 0, z: 0 } })).speed);
  }
  assert.ok(driven.speed > 0.5, `driven ${driven.speed}`);
  for (let index = 1; index < 5; index += 1) {
    assert.ok(coasting[index] < coasting[index - 1], `step ${index}: ${coasting[index]}`);
  }
  assert.ok(coasting[coasting.length - 1] < driven.speed * 0.5);
});

test('sync hold accepts the canonical grip', () => {
  assert.deepEqual(checkSyncHold(CANONICAL_REST_ACCEL), { ok: true });
  assert.equal(checkSyncHold(tiltedAccel(25)).ok, true);
  assert.equal(checkSyncHold({ x: 0, y: -9.2, z: 0 }).ok, true);
});

test('sync hold rejects a shaken phone and a wrong grip differently', () => {
  const shaken = checkSyncHold({ x: 0, y: -20, z: 0 });
  const weak = checkSyncHold({ x: 0, y: -3, z: 0 });
  const wrongHold = checkSyncHold({ x: 0, y: GRAVITY_M_S2, z: 0 });
  const tippedOver = checkSyncHold(tiltedAccel(35));
  assert.equal(shaken.ok, false);
  assert.equal(weak.ok, false);
  assert.equal(wrongHold.ok, false);
  assert.equal(tippedOver.ok, false);
  assert.equal(shaken.reason, weak.reason);
  assert.equal(wrongHold.reason, tippedOver.reason);
  assert.notEqual(shaken.reason, wrongHold.reason);
  assert.ok(shaken.reason.length > 0 && wrongHold.reason.length > 0);
});

test('sync hold rejects missing or broken readings', () => {
  const missing = checkSyncHold(null);
  assert.equal(missing.ok, false);
  assert.ok(missing.reason.length > 0);
  assert.equal(checkSyncHold(undefined).ok, false);
  assert.equal(checkSyncHold({ x: 0, y: Number.NaN, z: 0 }).ok, false);
  assert.equal(checkSyncHold({ x: 0, y: -9.81 }).ok, false);
});

test('capturing a reference needs an initialized pose', () => {
  const fusion = createFusion();
  assert.equal(captureSyncReference(fusion), null);
  assert.equal(fusion.qRef, null);
  fuseMotionSample(fusion, sample({ accelIncludingGravity: CANONICAL_REST_ACCEL }));
  const qRef = captureSyncReference(fusion);
  assert.ok(Math.abs(Math.hypot(qRef.x, qRef.y, qRef.z, qRef.w) - 1) < 1e-12);
  assert.ok(quatAngleRad(qRef, CANONICAL_REST_QUATERNION) < 1e-6);
  qRef.x = 99;
  assert.notEqual(fusion.qRef.x, 99);
  assert.deepEqual(fusionSnapshot(fusion).qRef, fusion.qRef);
});

test('a restored reference is validated and normalized', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  const stored = setSyncReference(fusion, { x: 0, y: 0, z: 0, w: 2 });
  assert.deepEqual(stored, { x: 0, y: 0, z: 0, w: 1 });
  assert.deepEqual(fusion.qRef, { x: 0, y: 0, z: 0, w: 1 });
  for (const invalid of [null, undefined, 'nope', 7, {}, { x: 0, y: 0, z: 0, w: 0 }, { x: Number.NaN, y: 0, z: 0, w: 1 }]) {
    assert.equal(setSyncReference(fusion, invalid), null);
    assert.deepEqual(fusion.qRef, { x: 0, y: 0, z: 0, w: 1 });
  }
});

test('a reference can be set before the pose is initialized', () => {
  const fusion = createFusion();
  assert.deepEqual(setSyncReference(fusion, CANONICAL_REST_QUATERNION), fusion.qRef);
  assert.equal(fusionInitialized(fusion), false);
});

test('resetting motion clears the integrators but keeps the pose', () => {
  const fusion = initializedAt(CANONICAL_REST_ACCEL);
  captureSyncReference(fusion);
  const pose = { ...fusion.q };
  feed(fusion, 20, {
    accel: { x: 0, y: 0, z: 8 },
    accelIncludingGravity: { x: 0, y: -GRAVITY_M_S2, z: 8 }
  });
  resetFusionMotion(fusion);
  const snapshot = fusionSnapshot(fusion);
  assert.equal(snapshot.speed, 0);
  assert.equal(snapshot.atRest, false);
  assert.deepEqual(fusion.velocity, { x: 0, y: 0, z: 0 });
  assert.deepEqual(fusion.accelBias, { x: 0, y: 0, z: 0 });
  assert.equal(fusion.restMs, 0);
  assert.deepEqual(snapshot.quaternion, pose);
  assert.deepEqual(snapshot.qRef, fusion.qRef);
});
