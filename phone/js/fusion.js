import {
  quatMultiply,
  quatConjugate,
  quatNormalize,
  quatRotateVector,
  quatFromAxisAngle,
  quatSlerp,
  quatAngleRad
} from '../../shared/quat.js';

export const ARM_LENGTH_M = 0.3;
export const GRAVITY_M_S2 = 9.81;
export const TILT_GAIN = 1.2;
export const ACCEL_TRUST_BAND_M_S2 = 2.5;
export const VELOCITY_LEAK_LAMBDA = 0.98;
export const ACCEL_HIGHPASS_ALPHA = 0.02;
export const REST_GYRO_MAX_RAD_S = 0.15;
export const REST_ACCEL_BAND_M_S2 = 0.6;
export const REST_HOLD_MS = 120;
export const YAW_PULL_MAX_ANGLE_RAD = 0.44;
export const YAW_PULL_GAIN = 0.02;
export const SYNC_GRAVITY_CONE_DEG = 30;
export const SYNC_ACCEL_MIN_M_S2 = 7;
export const SYNC_ACCEL_MAX_M_S2 = 13;

const MS_PER_S = 1000;
const FRAME_MS = 16.667;
const DEG_PER_RAD = 180 / Math.PI;
const ANTIPARALLEL_DOT = -1 + 1e-9;

const WORLD_UP = Object.freeze({ x: 0, y: 0, z: 1 });
const CANONICAL_HOLD_UP_DEVICE = Object.freeze({ x: 0, y: -1, z: 0 });

const SyncRejection = Object.freeze({
  NO_READING: 'no motion reading yet — hold still and sync again',
  NOT_STILL: 'hold the phone still while syncing',
  WRONG_HOLD: 'hold it upside-down at your side and re-sync'
});

function isVector(v) {
  return v !== null && typeof v === 'object'
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteVectorOrNull(v) {
  return isVector(v) ? { x: v.x, y: v.y, z: v.z } : null;
}

function vectorMagnitude(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function scaledVector(v, scale) {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale };
}

function crossProduct(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dotProduct(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function zeroVector() {
  return { x: 0, y: 0, z: 0 };
}

function normalizedOrNull(v) {
  const magnitude = vectorMagnitude(v);
  return magnitude > 0 ? scaledVector(v, 1 / magnitude) : null;
}

function fallbackPerpendicular(v) {
  return Math.abs(v.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
}

function shortestArcQuaternion(from, to) {
  const dot = dotProduct(from, to);
  if (dot < ANTIPARALLEL_DOT) {
    const axis = crossProduct(from, fallbackPerpendicular(from));
    return quatFromAxisAngle(axis, Math.PI);
  }
  const axis = crossProduct(from, to);
  return quatNormalize({ x: axis.x, y: axis.y, z: axis.z, w: 1 + dot });
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function perFrameDecay(perFrameFactor, dtMs) {
  return Math.pow(perFrameFactor, dtMs / FRAME_MS);
}

function perFrameBlend(perFrameAlpha, dtMs) {
  return 1 - Math.pow(1 - perFrameAlpha, dtMs / FRAME_MS);
}

export function createFusion() {
  return {
    q: null,
    initialized: false,
    velocity: zeroVector(),
    accelBias: zeroVector(),
    restMs: 0,
    atRest: false,
    qRef: null,
    speed: 0
  };
}

export function fusionInitialized(fusion) {
  return fusion.initialized === true && fusion.q !== null;
}

export function fusionSnapshot(fusion) {
  return {
    quaternion: fusion.q === null ? null : { ...fusion.q },
    speed: fusion.speed,
    atRest: fusion.atRest,
    initialized: fusionInitialized(fusion),
    qRef: fusion.qRef === null ? null : { ...fusion.qRef }
  };
}

function tryInitialize(fusion, accelIncludingGravity) {
  if (accelIncludingGravity === null) {
    return false;
  }
  const magnitude = vectorMagnitude(accelIncludingGravity);
  if (magnitude < SYNC_ACCEL_MIN_M_S2 || magnitude > SYNC_ACCEL_MAX_M_S2) {
    return false;
  }
  const measuredUp = scaledVector(accelIncludingGravity, 1 / magnitude);
  fusion.q = quatNormalize(shortestArcQuaternion(measuredUp, WORLD_UP));
  fusion.initialized = true;
  return true;
}

function integrateGyro(fusion, gyroRadPerS, dtSeconds) {
  const rate = vectorMagnitude(gyroRadPerS);
  if (!(rate > 0)) {
    return;
  }
  const deviceDelta = quatFromAxisAngle(gyroRadPerS, rate * dtSeconds);
  fusion.q = quatNormalize(quatMultiply(fusion.q, deviceDelta));
}

function correctTilt(fusion, accelIncludingGravity, dtSeconds) {
  const magnitude = vectorMagnitude(accelIncludingGravity);
  if (!(magnitude > 0)) {
    return;
  }
  const trust = clampUnit(1 - Math.abs(magnitude - GRAVITY_M_S2) / ACCEL_TRUST_BAND_M_S2);
  if (trust <= 0) {
    return;
  }
  const measuredUp = scaledVector(accelIncludingGravity, 1 / magnitude);
  const predictedUp = quatRotateVector(quatConjugate(fusion.q), WORLD_UP);
  const errorAxis = crossProduct(measuredUp, predictedUp);
  const errorSine = vectorMagnitude(errorAxis);
  if (!(errorSine > 0)) {
    return;
  }
  const errorAngle = Math.atan2(errorSine, dotProduct(measuredUp, predictedUp));
  const step = TILT_GAIN * trust * dtSeconds * errorAngle;
  fusion.q = quatNormalize(quatMultiply(fusion.q, quatFromAxisAngle(errorAxis, step)));
}

function worldLinearAccel(fusion, accel, accelIncludingGravity) {
  if (accel !== null) {
    return quatRotateVector(fusion.q, accel);
  }
  if (accelIncludingGravity === null) {
    return null;
  }
  const world = quatRotateVector(fusion.q, accelIncludingGravity);
  return { x: world.x, y: world.y, z: world.z - GRAVITY_M_S2 };
}

function highPassed(fusion, worldAccel, dtMs) {
  const blend = perFrameBlend(ACCEL_HIGHPASS_ALPHA, dtMs);
  fusion.accelBias = {
    x: fusion.accelBias.x + blend * (worldAccel.x - fusion.accelBias.x),
    y: fusion.accelBias.y + blend * (worldAccel.y - fusion.accelBias.y),
    z: fusion.accelBias.z + blend * (worldAccel.z - fusion.accelBias.z)
  };
  return {
    x: worldAccel.x - fusion.accelBias.x,
    y: worldAccel.y - fusion.accelBias.y,
    z: worldAccel.z - fusion.accelBias.z
  };
}

function integrateVelocity(fusion, linearAccel, dtMs, dtSeconds) {
  const leak = perFrameDecay(VELOCITY_LEAK_LAMBDA, dtMs);
  const accel = linearAccel === null ? zeroVector() : highPassed(fusion, linearAccel, dtMs);
  fusion.velocity = {
    x: fusion.velocity.x * leak + accel.x * dtSeconds,
    y: fusion.velocity.y * leak + accel.y * dtSeconds,
    z: fusion.velocity.z * leak + accel.z * dtSeconds
  };
}

function isStill(gyroMagnitude, accelIncludingGravity) {
  if (gyroMagnitude >= REST_GYRO_MAX_RAD_S || accelIncludingGravity === null) {
    return false;
  }
  const offset = Math.abs(vectorMagnitude(accelIncludingGravity) - GRAVITY_M_S2);
  return offset < REST_ACCEL_BAND_M_S2;
}

function pullYawTowardReference(fusion, dtMs) {
  if (fusion.qRef === null) {
    return;
  }
  if (quatAngleRad(fusion.q, fusion.qRef) >= YAW_PULL_MAX_ANGLE_RAD) {
    return;
  }
  fusion.q = quatSlerp(fusion.q, fusion.qRef, perFrameBlend(YAW_PULL_GAIN, dtMs));
}

function applyZeroVelocityUpdate(fusion, gyroMagnitude, accelIncludingGravity, dtMs) {
  fusion.restMs = isStill(gyroMagnitude, accelIncludingGravity) ? fusion.restMs + dtMs : 0;
  fusion.atRest = fusion.restMs >= REST_HOLD_MS;
  if (!fusion.atRest) {
    return;
  }
  fusion.velocity = zeroVector();
  fusion.speed = 0;
  pullYawTowardReference(fusion, dtMs);
}

export function fuseMotionSample(fusion, sample) {
  const dtMs = sample === null || sample === undefined ? null : sample.dtMs;
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return fusionSnapshot(fusion);
  }

  const gyroRadPerS = finiteVectorOrNull(sample.gyroRadPerS);
  const accel = finiteVectorOrNull(sample.accel);
  const accelIncludingGravity = finiteVectorOrNull(sample.accelIncludingGravity);

  if (!fusionInitialized(fusion)) {
    tryInitialize(fusion, accelIncludingGravity);
    return fusionSnapshot(fusion);
  }

  const dtSeconds = dtMs / MS_PER_S;

  if (gyroRadPerS !== null) {
    integrateGyro(fusion, gyroRadPerS, dtSeconds);
  }
  if (accelIncludingGravity !== null) {
    correctTilt(fusion, accelIncludingGravity, dtSeconds);
  }

  integrateVelocity(fusion, worldLinearAccel(fusion, accel, accelIncludingGravity), dtMs, dtSeconds);

  const gyroMagnitude = gyroRadPerS === null ? 0 : vectorMagnitude(gyroRadPerS);
  const tangentialSpeed = gyroRadPerS === null ? 0 : gyroMagnitude * ARM_LENGTH_M;
  fusion.speed = Math.max(vectorMagnitude(fusion.velocity), tangentialSpeed);

  applyZeroVelocityUpdate(fusion, gyroMagnitude, accelIncludingGravity, dtMs);

  return fusionSnapshot(fusion);
}

export function checkSyncHold(accelIncludingGravity) {
  const reading = finiteVectorOrNull(accelIncludingGravity);
  if (reading === null) {
    return { ok: false, reason: SyncRejection.NO_READING };
  }
  const magnitude = vectorMagnitude(reading);
  if (magnitude < SYNC_ACCEL_MIN_M_S2 || magnitude > SYNC_ACCEL_MAX_M_S2) {
    return { ok: false, reason: SyncRejection.NOT_STILL };
  }
  const measuredUp = normalizedOrNull(reading);
  if (measuredUp === null) {
    return { ok: false, reason: SyncRejection.NOT_STILL };
  }
  const coneDeg = Math.acos(Math.min(1, Math.max(-1, dotProduct(measuredUp, CANONICAL_HOLD_UP_DEVICE)))) * DEG_PER_RAD;
  if (coneDeg > SYNC_GRAVITY_CONE_DEG) {
    return { ok: false, reason: SyncRejection.WRONG_HOLD };
  }
  return { ok: true };
}

export function captureSyncReference(fusion) {
  if (!fusionInitialized(fusion)) {
    return null;
  }
  fusion.qRef = quatNormalize(fusion.q);
  return { ...fusion.qRef };
}

export function setSyncReference(fusion, qRef) {
  if (qRef === null || typeof qRef !== 'object') {
    return null;
  }
  if (!Number.isFinite(qRef.x) || !Number.isFinite(qRef.y)
    || !Number.isFinite(qRef.z) || !Number.isFinite(qRef.w)) {
    return null;
  }
  if (!(Math.hypot(qRef.x, qRef.y, qRef.z, qRef.w) > 0)) {
    return null;
  }
  fusion.qRef = quatNormalize(qRef);
  return { ...fusion.qRef };
}

export function resetFusionMotion(fusion) {
  fusion.velocity = zeroVector();
  fusion.accelBias = zeroVector();
  fusion.restMs = 0;
  fusion.atRest = false;
  fusion.speed = 0;
  return fusion;
}
