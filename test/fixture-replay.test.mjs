import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFusion,
  fuseMotionSample,
  checkSyncHold
} from '../phone/js/fusion.js';
import { armRotationFromPose, quatAngleRad, quatRotateVector } from '../shared/quat.js';

const FRAME_MS = 1000 / 60;
const DEG_PER_RAD = 180 / Math.PI;
const ORIENTATION_RETURN_TOLERANCE_DEG = 12;
const REST_SEARCH_INDEX = 50;

const tracePath = new URL('../fixtures/synthetic-swing.json', import.meta.url);
const trace = JSON.parse(readFileSync(tracePath, 'utf8'));

function replayTrace(samples) {
  const fusion = createFusion();
  const snapshots = [];
  let initializedAtIndex = -1;
  let peakSpeed = 0;
  let peakSpeedIndex = -1;
  for (let index = 0; index < samples.length; index += 1) {
    const entry = samples[index];
    const dtMs = index === 0 ? FRAME_MS : entry.timeStamp - samples[index - 1].timeStamp;
    const snapshot = fuseMotionSample(fusion, {
      dtMs,
      gyroRadPerS: entry.rotationRate,
      accel: entry.acceleration,
      accelIncludingGravity: entry.accelerationIncludingGravity
    });
    if (initializedAtIndex === -1 && snapshot.initialized) {
      initializedAtIndex = index;
    }
    if (snapshot.speed > peakSpeed) {
      peakSpeed = snapshot.speed;
      peakSpeedIndex = index;
    }
    snapshots.push(snapshot);
  }
  return { snapshots, initializedAtIndex, peakSpeed, peakSpeedIndex };
}

test('fusion initializes during the trace opening rest', () => {
  const { initializedAtIndex } = replayTrace(trace);
  assert.ok(initializedAtIndex >= 0, 'fusion never initialized');
  assert.ok(initializedAtIndex < 72, `initialized too late at index ${initializedAtIndex}`);
});

test('checkSyncHold accepts a rest sample from the opening hold', () => {
  const restSample = trace[REST_SEARCH_INDEX];
  const result = checkSyncHold(restSample.accelerationIncludingGravity);
  assert.deepEqual(result, { ok: true });
});

test('peak speed during the swings reaches at least 2 m/s', () => {
  const { peakSpeed } = replayTrace(trace);
  assert.ok(peakSpeed >= 2, `peak speed was ${peakSpeed}`);
});

test('ZUPT brings speed back to zero at the final rest', () => {
  const { snapshots } = replayTrace(trace);
  const last = snapshots[snapshots.length - 1];
  assert.equal(last.atRest, true);
  assert.equal(last.speed, 0);
});

test('final orientation returns close to the initial hold', () => {
  const { snapshots, initializedAtIndex } = replayTrace(trace);
  const initial = snapshots[initializedAtIndex];
  const last = snapshots[snapshots.length - 1];
  const angleDeg = quatAngleRad(initial.quaternion, last.quaternion) * DEG_PER_RAD;
  assert.ok(angleDeg < ORIENTATION_RETURN_TOLERANCE_DEG, `angle was ${angleDeg} deg`);
});

test('armRotationFromPose swings the neutral arm forward at peak swing', () => {
  const { snapshots, initializedAtIndex, peakSpeedIndex } = replayTrace(trace);
  const initial = snapshots[initializedAtIndex];
  const peak = snapshots[peakSpeedIndex];
  const armGame = armRotationFromPose(peak.quaternion, initial.quaternion);
  const forward = quatRotateVector(armGame, { x: 0, y: -1, z: 0 });
  assert.ok(forward.z < -0.5, `forward.z was ${forward.z}`);
});
