export const DT_MIN_MS = 1;
export const DT_MAX_MS = 50;
export const DEG_PER_RAD = 180 / Math.PI;

export const GyroUnit = Object.freeze({
  UNKNOWN: 'unknown',
  DEG_PER_S: 'deg/s',
  RAD_PER_S: 'rad/s'
});

const MS_PER_S = 1000;
const DT_EMA_ALPHA = 0.1;
const TRAVEL_EPSILON = 1e-6;
const AUTO_DECISION_TRAVEL_DEG = 30;
const FORCED_DECISION_TRAVEL_DEG = 5;
const RAD_PER_S_RATIO = 8;
const TRACE_SAMPLE_CAP = 20000;

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function storedVector(vector) {
  if (vector === null || typeof vector !== 'object') {
    return null;
  }
  return { x: finiteOrNull(vector.x), y: finiteOrNull(vector.y), z: finiteOrNull(vector.z) };
}

function storedEuler(euler) {
  if (euler === null || typeof euler !== 'object') {
    return null;
  }
  return {
    alpha: finiteOrNull(euler.alpha),
    beta: finiteOrNull(euler.beta),
    gamma: finiteOrNull(euler.gamma)
  };
}

function vectorMagnitude(vector) {
  if (vector === null || vector.x === null || vector.y === null || vector.z === null) {
    return null;
  }
  return Math.hypot(vector.x, vector.y, vector.z);
}

function scaledVector(vector, scale) {
  if (vector === null) {
    return null;
  }
  return {
    x: vector.x === null ? null : vector.x * scale,
    y: vector.y === null ? null : vector.y * scale,
    z: vector.z === null ? null : vector.z * scale
  };
}

function multiplyQuaternions(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function quaternionAboutZ(halfAngleRad) {
  return { x: 0, y: 0, z: Math.sin(halfAngleRad), w: Math.cos(halfAngleRad) };
}

function quaternionAboutX(halfAngleRad) {
  return { x: Math.sin(halfAngleRad), y: 0, z: 0, w: Math.cos(halfAngleRad) };
}

function quaternionAboutY(halfAngleRad) {
  return { x: 0, y: Math.sin(halfAngleRad), z: 0, w: Math.cos(halfAngleRad) };
}

function halfAngleRadFromDeg(angleDeg) {
  return angleDeg / (2 * DEG_PER_RAD);
}

export function clampDtMs(rawDtMs) {
  const dtMs = finiteOrNull(rawDtMs);
  if (dtMs === null || dtMs <= 0) {
    return null;
  }
  return Math.min(DT_MAX_MS, Math.max(DT_MIN_MS, dtMs));
}

export function quaternionFromDeviceOrientation(alphaDeg, betaDeg, gammaDeg) {
  const alpha = finiteOrNull(alphaDeg);
  const beta = finiteOrNull(betaDeg);
  const gamma = finiteOrNull(gammaDeg);
  if (alpha === null || beta === null || gamma === null) {
    return null;
  }
  const yaw = quaternionAboutZ(halfAngleRadFromDeg(alpha));
  const pitch = quaternionAboutX(halfAngleRadFromDeg(beta));
  const roll = quaternionAboutY(halfAngleRadFromDeg(gamma));
  return multiplyQuaternions(multiplyQuaternions(yaw, pitch), roll);
}

export function quaternionAngleDeg(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) {
    return null;
  }
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return 2 * Math.acos(Math.min(1, Math.abs(dot))) * DEG_PER_RAD;
}

export function rotationRateToRadPerS(value, unit) {
  const rate = finiteOrNull(value);
  if (rate === null) {
    return null;
  }
  return unit === GyroUnit.RAD_PER_S ? rate : rate / DEG_PER_RAD;
}

function createTiming() {
  return { previousTimeStampMs: null, dtEmaMs: null };
}

function advanceTiming(timing, timeStampMs) {
  const stamp = finiteOrNull(timeStampMs);
  if (stamp === null) {
    return null;
  }
  const previous = timing.previousTimeStampMs;
  timing.previousTimeStampMs = stamp;
  if (previous === null) {
    return null;
  }
  const rawDeltaMs = finiteOrNull(stamp - previous);
  if (rawDeltaMs === null || rawDeltaMs <= 0) {
    return null;
  }
  timing.dtEmaMs = timing.dtEmaMs === null
    ? rawDeltaMs
    : timing.dtEmaMs + DT_EMA_ALPHA * (rawDeltaMs - timing.dtEmaMs);
  return clampDtMs(rawDeltaMs);
}

function timingRateHz(timing) {
  return timing.dtEmaMs === null ? null : MS_PER_S / timing.dtEmaMs;
}

export function createPipeline() {
  return {
    quaternion: null,
    travelAnchorQuaternion: null,
    orientationEuler: null,
    gyroRaw: null,
    accel: null,
    accelIncludingGravity: null,
    motionCount: 0,
    orientationCount: 0,
    lastDtMs: null,
    motionTiming: createTiming(),
    orientationTiming: createTiming(),
    gyroTravel: 0,
    orientationTravelDeg: 0,
    gyroUnit: GyroUnit.UNKNOWN
  };
}

export function applyMotionSample(pipeline, sample) {
  pipeline.gyroRaw = storedVector(sample.rotationRate);
  pipeline.accel = storedVector(sample.acceleration);
  pipeline.accelIncludingGravity = storedVector(sample.accelerationIncludingGravity);
  pipeline.motionCount += 1;

  const dtMs = advanceTiming(pipeline.motionTiming, sample.timeStampMs);
  if (dtMs !== null) {
    pipeline.lastDtMs = dtMs;
  }

  const magnitude = vectorMagnitude(pipeline.gyroRaw);
  if (magnitude === null) {
    return pipeline;
  }
  if (dtMs !== null) {
    pipeline.gyroTravel += magnitude * (dtMs / MS_PER_S);
  }
  return pipeline;
}

export function applyOrientationSample(pipeline, sample) {
  pipeline.orientationEuler = storedEuler(sample);
  pipeline.orientationCount += 1;

  const quaternion = quaternionFromDeviceOrientation(sample.alpha, sample.beta, sample.gamma);
  if (quaternion !== null) {
    const travelDeg = quaternionAngleDeg(pipeline.travelAnchorQuaternion, quaternion);
    if (travelDeg !== null) {
      pipeline.orientationTravelDeg += travelDeg;
    }
    pipeline.travelAnchorQuaternion = quaternion;
    pipeline.quaternion = quaternion;
  }

  advanceTiming(pipeline.orientationTiming, sample.timeStampMs);
  return pipeline;
}

export function resetTiming(pipeline) {
  pipeline.motionTiming = createTiming();
  pipeline.orientationTiming = createTiming();
  pipeline.travelAnchorQuaternion = null;
  return pipeline;
}

function travelRatio(pipeline) {
  if (pipeline.gyroTravel <= TRAVEL_EPSILON || pipeline.orientationTravelDeg <= 0) {
    return null;
  }
  return pipeline.orientationTravelDeg / pipeline.gyroTravel;
}

function unitFromRatio(ratio) {
  return ratio >= RAD_PER_S_RATIO ? GyroUnit.RAD_PER_S : GyroUnit.DEG_PER_S;
}

export function resolvedGyroUnit(pipeline) {
  if (pipeline.gyroUnit !== GyroUnit.UNKNOWN) {
    return pipeline.gyroUnit;
  }
  if (pipeline.orientationTravelDeg < AUTO_DECISION_TRAVEL_DEG) {
    return GyroUnit.UNKNOWN;
  }
  const ratio = travelRatio(pipeline);
  if (ratio === null) {
    return GyroUnit.UNKNOWN;
  }
  pipeline.gyroUnit = unitFromRatio(ratio);
  return pipeline.gyroUnit;
}

export function forceGyroUnitDecision(pipeline) {
  if (pipeline.gyroUnit !== GyroUnit.UNKNOWN) {
    return pipeline.gyroUnit;
  }
  const ratio = pipeline.orientationTravelDeg > FORCED_DECISION_TRAVEL_DEG ? travelRatio(pipeline) : null;
  if (ratio === null) {
    return GyroUnit.DEG_PER_S;
  }
  pipeline.gyroUnit = unitFromRatio(ratio);
  return pipeline.gyroUnit;
}

function gyroInDegPerS(gyroRaw, unit) {
  if (gyroRaw === null || unit === GyroUnit.UNKNOWN) {
    return null;
  }
  return scaledVector(gyroRaw, unit === GyroUnit.RAD_PER_S ? DEG_PER_RAD : 1);
}

export function pipelineSnapshot(pipeline) {
  const gyroUnit = resolvedGyroUnit(pipeline);
  return {
    quaternion: pipeline.quaternion,
    orientationEuler: pipeline.orientationEuler,
    gyroRaw: pipeline.gyroRaw,
    gyroDegPerS: gyroInDegPerS(pipeline.gyroRaw, gyroUnit),
    accel: pipeline.accel,
    accelIncludingGravity: pipeline.accelIncludingGravity,
    motionRateHz: timingRateHz(pipeline.motionTiming),
    orientationRateHz: timingRateHz(pipeline.orientationTiming),
    lastDtMs: pipeline.lastDtMs,
    motionCount: pipeline.motionCount,
    orientationCount: pipeline.orientationCount,
    gyroUnit,
    calibrationRatio: travelRatio(pipeline),
    orientationTravelDeg: pipeline.orientationTravelDeg
  };
}

export function createTraceRecorder() {
  return { samples: [] };
}

export function recordTraceSample(recorder, motionSample, orientationEulerOrNull) {
  if (recorder.samples.length >= TRACE_SAMPLE_CAP) {
    return recorder.samples.length;
  }
  recorder.samples.push({
    timeStampMs: finiteOrNull(motionSample.timeStampMs),
    rotationRate: storedVector(motionSample.rotationRate),
    accelerationIncludingGravity: storedVector(motionSample.accelerationIncludingGravity),
    acceleration: storedVector(motionSample.acceleration),
    orientation: storedEuler(orientationEulerOrNull)
  });
  return recorder.samples.length;
}

export function traceSampleCount(recorder) {
  return recorder.samples.length;
}

function vectorToRadPerS(vector, unit) {
  if (vector === null) {
    return null;
  }
  return {
    x: rotationRateToRadPerS(vector.x, unit),
    y: rotationRateToRadPerS(vector.y, unit),
    z: rotationRateToRadPerS(vector.z, unit)
  };
}

function firstFiniteTimeStampMs(samples) {
  for (const sample of samples) {
    if (sample.timeStampMs !== null) {
      return sample.timeStampMs;
    }
  }
  return null;
}

export function traceToJson(recorder, gyroUnit) {
  const originMs = firstFiniteTimeStampMs(recorder.samples);
  const samples = recorder.samples.map((sample) => ({
    timeStamp: sample.timeStampMs === null || originMs === null ? null : sample.timeStampMs - originMs,
    rotationRate: vectorToRadPerS(sample.rotationRate, gyroUnit),
    accelerationIncludingGravity: sample.accelerationIncludingGravity,
    acceleration: sample.acceleration,
    orientation: sample.orientation
  }));
  return JSON.stringify(samples);
}
