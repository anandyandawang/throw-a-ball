import {
  applyMotionSample,
  applyOrientationSample,
  createPipeline,
  createTraceRecorder,
  forceGyroUnitDecision,
  pipelineSnapshot,
  recordTraceSample,
  resetTiming,
  traceSampleCount as recordedSampleCount,
  traceToJson
} from './sensor-pipeline.js';

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

export function createSensorCapture(callbacks) {
  const handlers = callbacks || {};
  const pipeline = createPipeline();

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
    if (recording) {
      recordTraceSample(recorder, sample, latestOrientationEuler);
    }
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
    const json = traceToJson(recorder, forceGyroUnitDecision(pipeline));
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

  document.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    requestActivation,
    beginCapture,
    endCapture,
    startTrace,
    stopTraceAndDownload,
    snapshot,
    traceSampleCount,
    get traceActive() {
      return recording;
    }
  };
}
