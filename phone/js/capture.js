import {
  AccelSign,
  GyroUnit,
  applyMotionSample,
  applyOrientationSample,
  createPipeline,
  createTraceRecorder,
  forceGyroUnitDecision,
  pipelineSnapshot,
  recordTraceSample,
  resetTiming,
  resolvedAccelSign,
  resolvedGyroUnit,
  rotationRateToRadPerS,
  traceSampleCount as recordedSampleCount,
  traceToJson
} from './sensor-pipeline.js';
import {
  captureSyncReference,
  checkSyncHold,
  createFusion,
  fuseMotionSample,
  resetFusionMotion,
  setSyncReference
} from './fusion.js';

const PERMISSION_GRANTED = 'granted';
const PERMISSION_UNAVAILABLE = 'unavailable';
const MOTION_SENSOR_NAME = 'motion';
const ORIENTATION_SENSOR_NAME = 'orientation';
const WAKE_LOCK_TYPE = 'screen';
const PORTRAIT_LOCK = 'portrait';
const CAPTURE_ACTIVE_CLASS = 'capture-active';
const VISIBLE_STATE = 'visible';
const TRACE_MIME_TYPE = 'application/json';
const TRACE_FILE_PREFIX = 'imu-trace-';
const TRACE_FILE_SUFFIX = '.json';
const BLOCKING_TOUCH_OPTIONS = Object.freeze({ passive: false });
const SYNC_REFERENCE_STORAGE_KEY = 'throwaball.qref.v1';
const GRANTED_ACTIVATION = Object.freeze({ granted: true, reason: PERMISSION_GRANTED });

function errorMessage(error) {
  if (error === null || error === undefined) {
    return 'unknown error';
  }
  return error.message ? String(error.message) : String(error);
}

function deniedActivation(reason) {
  return { granted: false, reason };
}

function permissionStateReason(sensorName, state) {
  const shown = typeof state === 'string' && state.length > 0 ? state : PERMISSION_UNAVAILABLE;
  return `${sensorName} permission ${shown}`;
}

function permissionErrorReason(sensorName, error) {
  return `${sensorName} permission failed: ${errorMessage(error)}`;
}

function initiatePermission(eventConstructor) {
  if (
    eventConstructor === null ||
    eventConstructor === undefined ||
    typeof eventConstructor.requestPermission !== 'function'
  ) {
    return Promise.resolve(PERMISSION_GRANTED);
  }
  try {
    return Promise.resolve(eventConstructor.requestPermission());
  } catch (error) {
    return Promise.reject(error);
  }
}

function settlePermission(pending) {
  return pending.then(
    (state) => ({ state, error: null }),
    (error) => ({ state: null, error })
  );
}

function nullableNumber(value) {
  return typeof value === 'number' ? value : null;
}

function toVector(source) {
  if (source === null || source === undefined) {
    return null;
  }
  return {
    x: nullableNumber(source.x),
    y: nullableNumber(source.y),
    z: nullableNumber(source.z)
  };
}

function rotationRateToVector(source) {
  if (source === null || source === undefined) {
    return null;
  }
  return {
    x: nullableNumber(source.beta),
    y: nullableNumber(source.gamma),
    z: nullableNumber(source.alpha)
  };
}

function lockPortrait() {
  const orientation = globalThis.screen ? globalThis.screen.orientation : null;
  if (orientation === null || orientation === undefined || typeof orientation.lock !== 'function') {
    return;
  }
  try {
    Promise.resolve(orientation.lock(PORTRAIT_LOCK)).catch(ignoreFailure);
  } catch {
    return;
  }
}

function enterFullscreenThenLockPortrait() {
  const root = document.documentElement;
  if (root === null || typeof root.requestFullscreen !== 'function') {
    lockPortrait();
    return;
  }
  try {
    Promise.resolve(root.requestFullscreen()).then(lockPortrait, lockPortrait);
  } catch {
    lockPortrait();
  }
}

function exitFullscreen() {
  if (document.fullscreenElement === null || document.fullscreenElement === undefined) {
    return;
  }
  if (typeof document.exitFullscreen !== 'function') {
    return;
  }
  try {
    Promise.resolve(document.exitFullscreen()).catch(ignoreFailure);
  } catch {
    return;
  }
}

function ignoreFailure() {
  return null;
}

function traceFileName() {
  return `${TRACE_FILE_PREFIX}${Date.now()}${TRACE_FILE_SUFFIX}`;
}

function downloadJson(json, fileName) {
  const blob = new Blob([json], { type: TRACE_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function localStorageOrNull() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readStoredSyncReference() {
  const storage = localStorageOrNull();
  if (storage === null) {
    return null;
  }
  try {
    const raw = storage.getItem(SYNC_REFERENCE_STORAGE_KEY);
    return raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStoredSyncReference(qRef) {
  const storage = localStorageOrNull();
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(
      SYNC_REFERENCE_STORAGE_KEY,
      JSON.stringify({ x: qRef.x, y: qRef.y, z: qRef.z, w: qRef.w, savedAtMs: Date.now() })
    );
  } catch {
    return;
  }
}

const ACCEL_SIGN_WAIT_MAX_SAMPLES = 60;

function gyroUnitForFusion(pipeline) {
  const unit = resolvedGyroUnit(pipeline);
  return unit === GyroUnit.UNKNOWN ? GyroUnit.DEG_PER_S : unit;
}

function accelSignSettled(pipeline) {
  return (
    resolvedAccelSign(pipeline) !== AccelSign.UNKNOWN ||
    pipeline.motionCount > ACCEL_SIGN_WAIT_MAX_SAMPLES
  );
}

function specSignAccelVector(vector, accelSign) {
  if (vector === null || accelSign !== AccelSign.INVERTED) {
    return vector;
  }
  return {
    x: vector.x === null ? null : -vector.x,
    y: vector.y === null ? null : -vector.y,
    z: vector.z === null ? null : -vector.z
  };
}

function rotationRateVectorToRadPerS(rotationRate, unit) {
  if (rotationRate === null) {
    return null;
  }
  return {
    x: rotationRateToRadPerS(rotationRate.x, unit),
    y: rotationRateToRadPerS(rotationRate.y, unit),
    z: rotationRateToRadPerS(rotationRate.z, unit)
  };
}

export function createSensorCapture(callbacks) {
  const handlers = callbacks || {};
  const pipeline = createPipeline();
  const fusion = createFusion();

  let latestAccelIncludingGravity = null;
  let synced = setSyncReference(fusion, readStoredSyncReference()) !== null;
  let recorder = createTraceRecorder();
  let recording = false;
  let capturing = false;
  let everCaptured = false;
  let latestOrientationEuler = null;
  let frameHandle = null;
  let wakeLock = null;
  let wakeLockWanted = false;
  let wakeLockRequestInFlight = false;

  function emitReadout(snapshot) {
    if (typeof handlers.onReadout === 'function') {
      handlers.onReadout(snapshot);
    }
  }

  function releaseSentinel(sentinel) {
    if (typeof sentinel.removeEventListener === 'function') {
      sentinel.removeEventListener('release', handleWakeLockRelease);
    }
    if (typeof sentinel.release !== 'function') {
      return;
    }
    try {
      Promise.resolve(sentinel.release()).catch(ignoreFailure);
    } catch {
      return;
    }
  }

  function adoptWakeLock(sentinel) {
    wakeLockRequestInFlight = false;
    if (sentinel === null || sentinel === undefined) {
      return null;
    }
    if (!wakeLockWanted) {
      releaseSentinel(sentinel);
      return null;
    }
    wakeLock = sentinel;
    if (typeof sentinel.addEventListener === 'function') {
      sentinel.addEventListener('release', handleWakeLockRelease);
    }
    return sentinel;
  }

  function abandonWakeLockRequest() {
    wakeLockRequestInFlight = false;
    return null;
  }

  function requestWakeLock() {
    if (wakeLock !== null || wakeLockRequestInFlight) {
      return;
    }
    const manager = navigator.wakeLock;
    if (manager === null || manager === undefined || typeof manager.request !== 'function') {
      return;
    }
    wakeLockRequestInFlight = true;
    try {
      Promise.resolve(manager.request(WAKE_LOCK_TYPE)).then(
        adoptWakeLock,
        abandonWakeLockRequest
      );
    } catch {
      wakeLockRequestInFlight = false;
    }
  }

  function handleWakeLockRelease() {
    wakeLock = null;
    if (wakeLockWanted && document.visibilityState === VISIBLE_STATE) {
      requestWakeLock();
    }
  }

  function releaseWakeLock() {
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel === null) {
      return;
    }
    releaseSentinel(sentinel);
  }

  async function requestActivation() {
    wakeLockWanted = true;
    const motionPermission = settlePermission(initiatePermission(globalThis.DeviceMotionEvent));
    const orientationPermission = settlePermission(
      initiatePermission(globalThis.DeviceOrientationEvent)
    );
    requestWakeLock();
    enterFullscreenThenLockPortrait();

    const motion = await motionPermission;
    const orientation = await orientationPermission;

    if (motion.error !== null) {
      return deniedActivation(permissionErrorReason(MOTION_SENSOR_NAME, motion.error));
    }
    if (motion.state !== PERMISSION_GRANTED) {
      return deniedActivation(permissionStateReason(MOTION_SENSOR_NAME, motion.state));
    }
    if (orientation.error !== null) {
      return deniedActivation(permissionErrorReason(ORIENTATION_SENSOR_NAME, orientation.error));
    }
    if (orientation.state !== PERMISSION_GRANTED) {
      return deniedActivation(permissionStateReason(ORIENTATION_SENSOR_NAME, orientation.state));
    }
    return GRANTED_ACTIVATION;
  }

  function handleDeviceMotion(event) {
    const sample = {
      timeStampMs: event.timeStamp,
      rotationRate: rotationRateToVector(event.rotationRate),
      accelerationIncludingGravity: toVector(event.accelerationIncludingGravity),
      acceleration: toVector(event.acceleration)
    };
    applyMotionSample(pipeline, sample);
    latestAccelIncludingGravity = specSignAccelVector(
      sample.accelerationIncludingGravity,
      resolvedAccelSign(pipeline)
    );
    if (recording) {
      recordTraceSample(recorder, sample, latestOrientationEuler);
    }
    fuseLatestMotion(sample);
  }

  function emitFusedSample(fused, timestampMs) {
    if (typeof handlers.onFusedSample !== 'function') {
      return;
    }
    handlers.onFusedSample({
      quaternion: fused.quaternion,
      speed: fused.speed,
      atRest: fused.atRest,
      timestampMs
    });
  }

  function fuseLatestMotion(sample) {
    if (!accelSignSettled(pipeline)) {
      return;
    }
    const unit = gyroUnitForFusion(pipeline);
    const accelSign = resolvedAccelSign(pipeline);
    const fused = fuseMotionSample(fusion, {
      dtMs: pipeline.lastDtMs,
      gyroRadPerS: rotationRateVectorToRadPerS(sample.rotationRate, unit),
      accel: specSignAccelVector(sample.acceleration, accelSign),
      accelIncludingGravity: specSignAccelVector(sample.accelerationIncludingGravity, accelSign)
    });
    if (!fused.initialized) {
      return;
    }
    emitFusedSample(fused, sample.timeStampMs);
  }

  function handleDeviceOrientation(event) {
    const euler = {
      alpha: nullableNumber(event.alpha),
      beta: nullableNumber(event.beta),
      gamma: nullableNumber(event.gamma)
    };
    latestOrientationEuler = euler;
    applyOrientationSample(pipeline, {
      timeStampMs: event.timeStamp,
      alpha: euler.alpha,
      beta: euler.beta,
      gamma: euler.gamma
    });
  }

  function blockTouchScroll(event) {
    event.preventDefault();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === VISIBLE_STATE) {
      if (wakeLockWanted && wakeLock === null) {
        requestWakeLock();
      }
      return;
    }
    if (capturing) {
      resetTiming(pipeline);
      resetFusionMotion(fusion);
    }
  }

  function renderFrame() {
    frameHandle = requestAnimationFrame(renderFrame);
    emitReadout(pipelineSnapshot(pipeline));
  }

  function beginCapture() {
    if (capturing) {
      return;
    }
    capturing = true;
    everCaptured = true;
    window.addEventListener('devicemotion', handleDeviceMotion);
    window.addEventListener('deviceorientation', handleDeviceOrientation);
    document.addEventListener('touchmove', blockTouchScroll, BLOCKING_TOUCH_OPTIONS);
    document.body.classList.add(CAPTURE_ACTIVE_CLASS);
    if (document.visibilityState === VISIBLE_STATE) {
      requestWakeLock();
    }
    frameHandle = requestAnimationFrame(renderFrame);
  }

  function endCapture() {
    if (!capturing) {
      return;
    }
    capturing = false;
    recording = false;
    wakeLockWanted = false;
    recorder = createTraceRecorder();
    window.removeEventListener('devicemotion', handleDeviceMotion);
    window.removeEventListener('deviceorientation', handleDeviceOrientation);
    document.removeEventListener('touchmove', blockTouchScroll, BLOCKING_TOUCH_OPTIONS);
    document.body.classList.remove(CAPTURE_ACTIVE_CLASS);
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    releaseWakeLock();
    exitFullscreen();
  }

  function startTrace() {
    recorder = createTraceRecorder();
    recording = true;
  }

  function stopTraceAndDownload() {
    recording = false;
    const count = recordedSampleCount(recorder);
    const json = traceToJson(recorder, forceGyroUnitDecision(pipeline), resolvedAccelSign(pipeline));
    downloadJson(json, traceFileName());
    recorder = createTraceRecorder();
    return count;
  }

  function snapshot() {
    return everCaptured ? pipelineSnapshot(pipeline) : null;
  }

  function traceSampleCount() {
    return recordedSampleCount(recorder);
  }

  function syncNow() {
    const hold = checkSyncHold(latestAccelIncludingGravity);
    if (!hold.ok) {
      return hold;
    }
    const qRef = captureSyncReference(fusion);
    if (qRef === null) {
      return checkSyncHold(null);
    }
    writeStoredSyncReference(qRef);
    synced = true;
    return { ok: true, qRef };
  }

  function syncState() {
    return { synced, qRef: fusion.qRef === null ? null : { ...fusion.qRef } };
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    requestActivation,
    beginCapture,
    endCapture,
    startTrace,
    stopTraceAndDownload,
    snapshot,
    syncNow,
    syncState,
    traceSampleCount,
    get traceActive() {
      return recording;
    }
  };
}
