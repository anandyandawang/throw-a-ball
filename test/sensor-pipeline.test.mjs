import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DT_MIN_MS,
  DT_MAX_MS,
  DEG_PER_RAD,
  AccelSign,
  GyroUnit,
  clampDtMs,
  quaternionFromDeviceOrientation,
  quaternionAngleDeg,
  rotationRateToRadPerS,
  createPipeline,
  applyMotionSample,
  applyOrientationSample,
  resetTiming,
  resolvedAccelSign,
  resolvedGyroUnit,
  forceGyroUnitDecision,
  pipelineSnapshot,
  createTraceRecorder,
  recordTraceSample,
  traceSampleCount,
  traceToJson
} from '../phone/js/sensor-pipeline.js';

const FRAME_MS = 16.6667;
const ONE_RAD_PER_S_IN_DEG = 57.2958;

function halfRad(angleDeg) {
  return (angleDeg * Math.PI) / 360;
}

function axisQuaternion(axis, angleDeg) {
  const s = Math.sin(halfRad(angleDeg));
  const w = Math.cos(halfRad(angleDeg));
  return {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w
  };
}

function hamilton(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function assertQuaternionClose(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual.x - expected.x) < tolerance, `x ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < tolerance, `y ${actual.y} vs ${expected.y}`);
  assert.ok(Math.abs(actual.z - expected.z) < tolerance, `z ${actual.z} vs ${expected.z}`);
  assert.ok(Math.abs(actual.w - expected.w) < tolerance, `w ${actual.w} vs ${expected.w}`);
}

function motionSample(timeStampMs, rotationRate, options = {}) {
  return {
    timeStampMs,
    rotationRate,
    accelerationIncludingGravity: options.accelerationIncludingGravity ?? { x: 0, y: 0, z: -9.81 },
    acceleration: options.acceleration ?? null
  };
}

function feedZRotationStream(pipeline, claimedRateZ, sampleCount) {
  for (let index = 0; index < sampleCount; index += 1) {
    const timeStampMs = index * FRAME_MS;
    const seconds = timeStampMs / 1000;
    applyOrientationSample(pipeline, {
      timeStampMs,
      alpha: ONE_RAD_PER_S_IN_DEG * seconds,
      beta: 0,
      gamma: 0
    });
    applyMotionSample(pipeline, motionSample(timeStampMs, { x: 0, y: 0, z: claimedRateZ }));
  }
}

test('clampDtMs clamps into the integration window', () => {
  assert.strictEqual(clampDtMs(0.5), DT_MIN_MS);
  assert.strictEqual(clampDtMs(200), DT_MAX_MS);
  assert.strictEqual(clampDtMs(16.7), 16.7);
});

test('clampDtMs rejects non-positive and non-finite deltas', () => {
  assert.strictEqual(clampDtMs(0), null);
  assert.strictEqual(clampDtMs(-5), null);
  assert.strictEqual(clampDtMs(Number.NaN), null);
  assert.strictEqual(clampDtMs(Number.POSITIVE_INFINITY), null);
  assert.strictEqual(clampDtMs(Number.NEGATIVE_INFINITY), null);
  assert.strictEqual(clampDtMs(null), null);
  assert.strictEqual(clampDtMs(undefined), null);
});

test('quaternionFromDeviceOrientation returns identity for zero angles', () => {
  assertQuaternionClose(quaternionFromDeviceOrientation(0, 0, 0), { x: 0, y: 0, z: 0, w: 1 });
});

test('quaternionFromDeviceOrientation maps single axes to their spec rotations', () => {
  assertQuaternionClose(quaternionFromDeviceOrientation(90, 0, 0), axisQuaternion('z', 90));
  assertQuaternionClose(quaternionFromDeviceOrientation(0, 90, 0), axisQuaternion('x', 90));
  assertQuaternionClose(quaternionFromDeviceOrientation(0, 0, 90), axisQuaternion('y', 90));
});

test('quaternionFromDeviceOrientation composes Z then X then Y', () => {
  const expected = hamilton(hamilton(axisQuaternion('z', 30), axisQuaternion('x', 40)), axisQuaternion('y', 50));
  assertQuaternionClose(quaternionFromDeviceOrientation(30, 40, 50), expected);
});

test('quaternionFromDeviceOrientation returns a unit quaternion', () => {
  const q = quaternionFromDeviceOrientation(30, 40, 50);
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  assert.ok(Math.abs(length - 1) < 1e-12);
});

test('quaternionFromDeviceOrientation returns null for absent angles', () => {
  assert.strictEqual(quaternionFromDeviceOrientation(null, 0, 0), null);
  assert.strictEqual(quaternionFromDeviceOrientation(0, null, 0), null);
  assert.strictEqual(quaternionFromDeviceOrientation(0, 0, null), null);
  assert.strictEqual(quaternionFromDeviceOrientation(Number.NaN, 0, 0), null);
  assert.strictEqual(quaternionFromDeviceOrientation(0, Number.NaN, 0), null);
  assert.strictEqual(quaternionFromDeviceOrientation(0, 0, Number.NaN), null);
});

test('quaternionAngleDeg measures the angular distance between orientations', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const quarterTurn = axisQuaternion('z', 90);
  assert.ok(Math.abs(quaternionAngleDeg(identity, quarterTurn) - 90) < 1e-9);
  assert.ok(Math.abs(quaternionAngleDeg(identity, identity)) < 1e-9);
});

test('quaternionAngleDeg treats a quaternion and its negation as the same orientation', () => {
  const q = quaternionFromDeviceOrientation(30, 40, 50);
  const negated = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
  assert.ok(Math.abs(quaternionAngleDeg(q, negated)) < 1e-9);
});

test('rotationRateToRadPerS honours the claimed unit', () => {
  assert.ok(Math.abs(rotationRateToRadPerS(ONE_RAD_PER_S_IN_DEG, GyroUnit.DEG_PER_S) - 1) < 1e-5);
  assert.strictEqual(rotationRateToRadPerS(1.25, GyroUnit.RAD_PER_S), 1.25);
  assert.ok(Math.abs(rotationRateToRadPerS(ONE_RAD_PER_S_IN_DEG, GyroUnit.UNKNOWN) - 1) < 1e-5);
  assert.strictEqual(rotationRateToRadPerS(null, GyroUnit.DEG_PER_S), null);
});

test('motion sample rate EMA settles on the true sample rate', () => {
  const pipeline = createPipeline();
  for (let index = 0; index < 300; index += 1) {
    applyMotionSample(pipeline, motionSample(index * FRAME_MS, { x: 0, y: 0, z: 0 }));
    if (index > 0) {
      assert.ok(pipeline.lastDtMs >= DT_MIN_MS && pipeline.lastDtMs <= DT_MAX_MS);
    }
  }
  const snapshot = pipelineSnapshot(pipeline);
  assert.strictEqual(snapshot.motionCount, 300);
  assert.ok(snapshot.motionRateHz > 59 && snapshot.motionRateHz < 61, `rate ${snapshot.motionRateHz}`);
});

test('the sample rate EMA reports the real device rate below the clamp floor', () => {
  const pipeline = createPipeline();
  const slowCadenceMs = 66;
  for (let index = 0; index < 300; index += 1) {
    applyMotionSample(pipeline, motionSample(index * slowCadenceMs, { x: 0, y: 0, z: 0 }));
  }
  const snapshot = pipelineSnapshot(pipeline);
  assert.ok(snapshot.motionRateHz > 14.5 && snapshot.motionRateHz < 16, `rate ${snapshot.motionRateHz}`);
  assert.strictEqual(snapshot.lastDtMs, DT_MAX_MS);
});

test('a long stall clamps dt to the integration ceiling', () => {
  const pipeline = createPipeline();
  applyMotionSample(pipeline, motionSample(0, { x: 0, y: 0, z: 0 }));
  applyMotionSample(pipeline, motionSample(500, { x: 0, y: 0, z: 0 }));
  assert.strictEqual(pipeline.lastDtMs, DT_MAX_MS);
});

test('an out-of-order timestamp skips timing but still stores values', () => {
  const pipeline = createPipeline();
  applyMotionSample(pipeline, motionSample(0, { x: 0, y: 0, z: 0 }));
  applyMotionSample(pipeline, motionSample(FRAME_MS, { x: 0, y: 0, z: 0 }));
  applyMotionSample(pipeline, motionSample(2 * FRAME_MS, { x: 0, y: 0, z: 0 }));
  const dtBefore = pipeline.lastDtMs;

  applyMotionSample(pipeline, motionSample(20, { x: 1, y: 2, z: 3 }));

  assert.strictEqual(pipeline.lastDtMs, dtBefore);
  assert.ok(pipeline.lastDtMs >= DT_MIN_MS && pipeline.lastDtMs <= DT_MAX_MS);
  assert.deepStrictEqual(pipeline.gyroRaw, { x: 1, y: 2, z: 3 });
  assert.strictEqual(pipeline.motionCount, 4);
});

test('a motion sample with null vectors still counts and stores absence', () => {
  const pipeline = createPipeline();
  applyMotionSample(pipeline, {
    timeStampMs: 0,
    rotationRate: null,
    accelerationIncludingGravity: null,
    acceleration: null
  });
  applyMotionSample(pipeline, {
    timeStampMs: FRAME_MS,
    rotationRate: { x: 1, y: null, z: 3 },
    accelerationIncludingGravity: { x: 0, y: 0, z: -9.81 },
    acceleration: null
  });

  assert.strictEqual(pipeline.motionCount, 2);
  assert.deepStrictEqual(pipeline.gyroRaw, { x: 1, y: null, z: 3 });
  assert.strictEqual(pipeline.accel, null);
  assert.strictEqual(pipeline.gyroTravel, 0);
});

test('orientation samples accumulate travel and their own rate', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 61);
  const snapshot = pipelineSnapshot(pipeline);

  assert.strictEqual(snapshot.orientationCount, 61);
  assert.ok(Math.abs(snapshot.orientationTravelDeg - ONE_RAD_PER_S_IN_DEG) < 1e-3);
  assert.ok(snapshot.orientationRateHz > 59 && snapshot.orientationRateHz < 61);
  assert.deepStrictEqual(snapshot.orientationEuler.beta, 0);
});

test('a rad/s device is calibrated from the travel ratio', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 61);

  assert.strictEqual(resolvedGyroUnit(pipeline), GyroUnit.RAD_PER_S);

  const snapshot = pipelineSnapshot(pipeline);
  assert.ok(Math.abs(snapshot.calibrationRatio - ONE_RAD_PER_S_IN_DEG) < ONE_RAD_PER_S_IN_DEG * 0.2);
});

test('a deg/s device is calibrated from the travel ratio', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, ONE_RAD_PER_S_IN_DEG, 61);

  assert.strictEqual(resolvedGyroUnit(pipeline), GyroUnit.DEG_PER_S);

  const snapshot = pipelineSnapshot(pipeline);
  assert.ok(Math.abs(snapshot.calibrationRatio - 1) < 0.2);
});

test('resolvedGyroUnit stays unknown before enough orientation travel', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 10);
  assert.strictEqual(resolvedGyroUnit(pipeline), GyroUnit.UNKNOWN);
  assert.strictEqual(pipelineSnapshot(pipeline).gyroUnit, GyroUnit.UNKNOWN);
});

test('forceGyroUnitDecision answers deg/s provisionally without storing it', () => {
  const restNoise = createPipeline();
  applyMotionSample(restNoise, motionSample(0, { x: 0, y: 0, z: 0.01 }));
  applyMotionSample(restNoise, motionSample(FRAME_MS, { x: 0, y: 0, z: 0.02 }));

  assert.strictEqual(forceGyroUnitDecision(restNoise), GyroUnit.DEG_PER_S);
  assert.strictEqual(restNoise.gyroUnit, GyroUnit.UNKNOWN);
  assert.strictEqual(resolvedGyroUnit(restNoise), GyroUnit.UNKNOWN);

  const untouched = createPipeline();
  assert.strictEqual(forceGyroUnitDecision(untouched), GyroUnit.DEG_PER_S);
  assert.strictEqual(untouched.gyroUnit, GyroUnit.UNKNOWN);
});

test('a provisional deg/s answer still loses to later rad/s ratio evidence', () => {
  const pipeline = createPipeline();
  applyMotionSample(pipeline, motionSample(0, { x: 0, y: 0, z: 0.01 }));
  assert.strictEqual(forceGyroUnitDecision(pipeline), GyroUnit.DEG_PER_S);

  resetTiming(pipeline);
  feedZRotationStream(pipeline, 1, 61);

  assert.strictEqual(resolvedGyroUnit(pipeline), GyroUnit.RAD_PER_S);
  assert.strictEqual(forceGyroUnitDecision(pipeline), GyroUnit.RAD_PER_S);
});

test('forceGyroUnitDecision keeps an already decided unit', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 61);
  assert.strictEqual(resolvedGyroUnit(pipeline), GyroUnit.RAD_PER_S);
  assert.strictEqual(forceGyroUnitDecision(pipeline), GyroUnit.RAD_PER_S);
});

test('forceGyroUnitDecision uses weak ratio evidence when it exists', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 12);
  assert.ok(pipeline.orientationTravelDeg > 5 && pipeline.orientationTravelDeg < 30);
  assert.strictEqual(forceGyroUnitDecision(pipeline), GyroUnit.RAD_PER_S);
});

test('resetTiming clears the timing state and keeps everything else', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 61);
  const unitBefore = resolvedGyroUnit(pipeline);
  const motionCountBefore = pipeline.motionCount;
  const travelBefore = pipeline.orientationTravelDeg;

  resetTiming(pipeline);

  assert.strictEqual(pipelineSnapshot(pipeline).motionRateHz, null);
  assert.strictEqual(pipelineSnapshot(pipeline).orientationRateHz, null);
  assert.strictEqual(pipeline.motionCount, motionCountBefore);
  assert.strictEqual(pipeline.gyroUnit, unitBefore);
  assert.strictEqual(pipeline.orientationTravelDeg, travelBefore);
  assert.notStrictEqual(pipeline.quaternion, null);

  const resumeAtMs = 60000;
  for (let index = 0; index < 30; index += 1) {
    applyMotionSample(pipeline, motionSample(resumeAtMs + index * FRAME_MS, { x: 0, y: 0, z: 1 }));
  }
  const snapshot = pipelineSnapshot(pipeline);
  assert.ok(snapshot.motionRateHz > 59 && snapshot.motionRateHz < 61, `rate ${snapshot.motionRateHz}`);
  assert.strictEqual(snapshot.gyroUnit, unitBefore);
});

test('a large orientation jump straight after resetTiming adds no travel', () => {
  const pipeline = createPipeline();
  feedZRotationStream(pipeline, 1, 61);
  const travelBefore = pipeline.orientationTravelDeg;

  resetTiming(pipeline);

  applyOrientationSample(pipeline, { timeStampMs: 60000, alpha: 170, beta: 0, gamma: 0 });
  assert.strictEqual(pipeline.orientationTravelDeg, travelBefore);
  assertQuaternionClose(pipeline.quaternion, quaternionFromDeviceOrientation(170, 0, 0));

  applyOrientationSample(pipeline, { timeStampMs: 60000 + FRAME_MS, alpha: 180, beta: 0, gamma: 0 });
  assert.ok(
    Math.abs(pipeline.orientationTravelDeg - (travelBefore + 10)) < 1e-9,
    `travel ${pipeline.orientationTravelDeg} vs ${travelBefore + 10}`
  );
});

test('pipelineSnapshot withholds deg/s gyro until the unit is decided', () => {
  const pipeline = createPipeline();
  applyMotionSample(pipeline, motionSample(0, { x: 0, y: 0, z: 1 }));
  assert.strictEqual(pipelineSnapshot(pipeline).gyroDegPerS, null);

  feedZRotationStream(pipeline, 1, 61);
  const snapshot = pipelineSnapshot(pipeline);
  assert.strictEqual(snapshot.gyroUnit, GyroUnit.RAD_PER_S);
  assert.ok(Math.abs(snapshot.gyroDegPerS.z - ONE_RAD_PER_S_IN_DEG) < 1e-3);
  assert.strictEqual(snapshot.gyroDegPerS.x, 0);
  assert.deepStrictEqual(snapshot.gyroRaw, { x: 0, y: 0, z: 1 });
  assert.strictEqual(snapshot.lastDtMs !== null, true);
});

test('pipelineSnapshot of a fresh pipeline is all-empty', () => {
  const snapshot = pipelineSnapshot(createPipeline());
  assert.deepStrictEqual(snapshot, {
    quaternion: null,
    orientationEuler: null,
    gyroRaw: null,
    gyroDegPerS: null,
    accel: null,
    accelIncludingGravity: null,
    motionRateHz: null,
    orientationRateHz: null,
    lastDtMs: null,
    motionCount: 0,
    orientationCount: 0,
    gyroUnit: GyroUnit.UNKNOWN,
    accelSign: AccelSign.UNKNOWN,
    calibrationRatio: null,
    orientationTravelDeg: 0
  });
});

function feedFlatRestStream(pipeline, gravityZ, sampleCount) {
  for (let index = 0; index < sampleCount; index += 1) {
    const timeStampMs = index * FRAME_MS;
    applyOrientationSample(pipeline, { timeStampMs, alpha: 0, beta: 0, gamma: 0 });
    applyMotionSample(
      pipeline,
      motionSample(timeStampMs, { x: 0, y: 0, z: 0 }, {
        accelerationIncludingGravity: { x: 0, y: 0, z: gravityZ }
      })
    );
  }
}

test('a spec-sign device resolves AccelSign.SPEC at rest', () => {
  const pipeline = createPipeline();
  feedFlatRestStream(pipeline, 9.81, 15);
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.SPEC);
  assert.strictEqual(pipelineSnapshot(pipeline).accelSign, AccelSign.SPEC);
});

test('an inverted-sign device resolves AccelSign.INVERTED at rest', () => {
  const pipeline = createPipeline();
  feedFlatRestStream(pipeline, -9.81, 15);
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.INVERTED);
});

test('the accel sign stays unknown without orientation events', () => {
  const pipeline = createPipeline();
  for (let index = 0; index < 30; index += 1) {
    applyMotionSample(
      pipeline,
      motionSample(index * FRAME_MS, { x: 0, y: 0, z: 0 }, {
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 }
      })
    );
  }
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.UNKNOWN);
});

test('the accel sign ignores samples far from one g', () => {
  const pipeline = createPipeline();
  feedFlatRestStream(pipeline, 25, 30);
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.UNKNOWN);
});

test('a decided accel sign is sticky through later shaking', () => {
  const pipeline = createPipeline();
  feedFlatRestStream(pipeline, -9.81, 15);
  feedFlatRestStream(pipeline, 9.81, 40);
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.INVERTED);
});

test('a tilted inverted-sign device still resolves AccelSign.INVERTED', () => {
  const pipeline = createPipeline();
  for (let index = 0; index < 15; index += 1) {
    const timeStampMs = index * FRAME_MS;
    applyOrientationSample(pipeline, { timeStampMs, alpha: 0, beta: 90, gamma: 0 });
    applyMotionSample(
      pipeline,
      motionSample(timeStampMs, { x: 0, y: 0, z: 0 }, {
        accelerationIncludingGravity: { x: 0, y: -9.81, z: 0 }
      })
    );
  }
  assert.strictEqual(resolvedAccelSign(pipeline), AccelSign.INVERTED);
});

test('trace recorder normalizes to rad/s with relative timestamps', () => {
  const recorder = createTraceRecorder();
  const euler = { alpha: 10, beta: 20, gamma: 30 };

  assert.strictEqual(recordTraceSample(recorder, motionSample(1000, { x: 0, y: 0, z: DEG_PER_RAD }), euler), 1);
  assert.strictEqual(recordTraceSample(recorder, motionSample(1016, { x: DEG_PER_RAD, y: null, z: 0 }), null), 2);
  assert.strictEqual(recordTraceSample(recorder, motionSample(1032, null, { acceleration: { x: 1, y: 2, z: 3 } }), euler), 3);
  assert.strictEqual(traceSampleCount(recorder), 3);

  const samples = JSON.parse(traceToJson(recorder, GyroUnit.DEG_PER_S));
  assert.strictEqual(Array.isArray(samples), true);
  assert.strictEqual(samples.length, 3);
  assert.strictEqual(samples[0].timeStamp, 0);
  assert.strictEqual(samples[1].timeStamp, 16);
  assert.strictEqual(samples[2].timeStamp, 32);

  assert.ok(Math.abs(samples[0].rotationRate.z - 1) < 1e-9);
  assert.strictEqual(samples[0].rotationRate.x, 0);
  assert.ok(Math.abs(samples[1].rotationRate.x - 1) < 1e-9);
  assert.strictEqual(samples[1].rotationRate.y, null);
  assert.strictEqual(samples[2].rotationRate, null);

  assert.deepStrictEqual(samples[0].accelerationIncludingGravity, { x: 0, y: 0, z: -9.81 });
  assert.strictEqual(samples[0].acceleration, null);
  assert.deepStrictEqual(samples[2].acceleration, { x: 1, y: 2, z: 3 });

  assert.deepStrictEqual(samples[0].orientation, euler);
  assert.strictEqual(samples[1].orientation, null);
});

test('trace recorder keeps raw rad/s values unchanged for a rad/s device', () => {
  const recorder = createTraceRecorder();
  recordTraceSample(recorder, motionSample(0, { x: 0.5, y: -1.5, z: 2 }), null);
  const samples = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S));
  assert.deepStrictEqual(samples[0].rotationRate, { x: 0.5, y: -1.5, z: 2 });
});

test('trace recorder caps at 20000 samples', () => {
  const recorder = createTraceRecorder();
  let lastCount = 0;
  for (let index = 0; index < 20001; index += 1) {
    lastCount = recordTraceSample(recorder, motionSample(index, { x: 0, y: 0, z: 0 }), null);
  }
  assert.strictEqual(lastCount, 20000);
  assert.strictEqual(traceSampleCount(recorder), 20000);
  assert.strictEqual(JSON.parse(traceToJson(recorder, GyroUnit.DEG_PER_S)).length, 20000);
});

test('traceToJson takes its origin from the first finite timestamp', () => {
  const recorder = createTraceRecorder();
  recordTraceSample(recorder, motionSample(null, { x: 0, y: 0, z: 0 }), null);
  recordTraceSample(recorder, motionSample(2000, { x: 0, y: 0, z: 0 }), null);
  recordTraceSample(recorder, motionSample(2016, { x: 0, y: 0, z: 0 }), null);

  const samples = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S));
  assert.strictEqual(samples[0].timeStamp, null);
  assert.strictEqual(samples[1].timeStamp, 0);
  assert.strictEqual(samples[2].timeStamp, 16);
});

test('traceToJson emits null timestamps when no sample carries a finite one', () => {
  const recorder = createTraceRecorder();
  recordTraceSample(recorder, motionSample(null, { x: 0, y: 0, z: 0 }), null);
  recordTraceSample(recorder, motionSample(Number.NaN, { x: 0, y: 0, z: 0 }), null);

  const samples = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S));
  assert.strictEqual(samples.length, 2);
  assert.strictEqual(samples[0].timeStamp, null);
  assert.strictEqual(samples[1].timeStamp, null);
});

test('traceToJson of an empty recorder is an empty array', () => {
  assert.strictEqual(traceToJson(createTraceRecorder(), GyroUnit.DEG_PER_S), '[]');
});

test('traceToJson negates accel vectors for an inverted-sign device', () => {
  const recorder = createTraceRecorder();
  recordTraceSample(
    recorder,
    {
      timeStampMs: 0,
      rotationRate: { x: 0, y: 0, z: 1 },
      accelerationIncludingGravity: { x: 0.5, y: -9.81, z: null },
      acceleration: { x: -0.25, y: 0, z: 1 }
    },
    null
  );
  const inverted = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S, AccelSign.INVERTED))[0];
  assert.deepStrictEqual(inverted.accelerationIncludingGravity, { x: -0.5, y: 9.81, z: null });
  assert.deepStrictEqual(inverted.acceleration, { x: 0.25, y: 0, z: -1 });
  assert.deepStrictEqual(inverted.rotationRate, { x: 0, y: 0, z: 1 });

  const spec = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S, AccelSign.SPEC))[0];
  assert.deepStrictEqual(spec.accelerationIncludingGravity, { x: 0.5, y: -9.81, z: null });

  const unknown = JSON.parse(traceToJson(recorder, GyroUnit.RAD_PER_S))[0];
  assert.deepStrictEqual(unknown.acceleration, { x: -0.25, y: 0, z: 1 });
});

test('DEG_PER_RAD converts a radian to degrees', () => {
  assert.ok(Math.abs(DEG_PER_RAD - ONE_RAD_PER_S_IN_DEG) < 1e-4);
});
