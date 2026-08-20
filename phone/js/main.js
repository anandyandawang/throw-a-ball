import { PROTOCOL_VERSION, encodePose } from '../../shared/protocol.js';
import { peerOptionsFromSearch } from '../../shared/peer-config.js';
import { createPhoneConnection } from './connection.js';
import { createSensorCapture } from './capture.js';

const NO_PEER_PARAM_DETAIL = 'open this link from the QR code on the desktop page';
const PRESS_FEEDBACK_MS = 160;

const statusElement = document.querySelector('[data-status]');
const detailElement = document.querySelector('[data-status-detail]');
const tapCountElement = document.querySelector('[data-phone-taps]');
const tapZone = document.getElementById('tap-zone');
const footer = document.getElementById('footer');

const phone = { state: 'waiting', detail: '', tapCount: 0 };
window.__phone = phone;

footer.textContent = `protocol v${PROTOCOL_VERSION}`;

function renderState(state, detail) {
  phone.state = state;
  phone.detail = detail;
  statusElement.textContent = state;
  statusElement.dataset.state = state;
  detailElement.textContent = detail;
  tapZone.disabled = state !== 'connected';
}

function renderTapCount(count) {
  phone.tapCount = count;
  tapCountElement.textContent = String(count);
}

function flashPress() {
  tapZone.classList.add('pressed');
  setTimeout(() => tapZone.classList.remove('pressed'), PRESS_FEEDBACK_MS);
}

renderTapCount(0);

const desktopPeerId = new URLSearchParams(location.search).get('peer');

let connection = null;

if (desktopPeerId === null) {
  renderState('waiting', NO_PEER_PARAM_DETAIL);
} else {
  connection = createPhoneConnection({
    desktopPeerId,
    peerOptions: peerOptionsFromSearch(location.search),
    callbacks: { onStateChange: renderState, onTapSent: renderTapCount }
  });

  tapZone.addEventListener('pointerdown', () => {
    flashPress();
    connection.sendTap();
  });

  connection.start();
}

const Screen = Object.freeze({
  HOME: 'home',
  DENIED: 'denied',
  SAFETY: 'safety',
  CAPTURE: 'capture'
});

const EMPTY_VALUE = '—';
const QUATERNION_DIGITS = 3;
const QUATERNION_WIDTH = 6;
const VECTOR_DIGITS = 2;
const VECTOR_WIDTH = 8;
const RATE_DIGITS = 1;
const RATE_WIDTH = 6;
const RECORD_LABEL = 'record trace';
const STOP_LABEL = 'stop + save';
const ZERO_COUNT = '0';
const EMPTY_TEXT = '';
const NO_SENSOR_DATA_NOTE = 'no sensor data — this browser may be blocking motion sensors';
const NO_SENSOR_DATA_GRACE_MS = 2000;
const SYNC_NOTE_UNSYNCED = 'not synced yet — hold the phone upside-down at your side and sync';
const SYNC_NOTE_SYNCED = 'synced — arm reference stored';
const SYNC_NOTE_RESTORED = 'synced — using the stored arm reference';
const SyncNoteState = Object.freeze({
  UNSYNCED: 'unsynced',
  SYNCED: 'synced',
  REJECTED: 'rejected'
});
const HAND_SPEED_DIGITS = 2;
const HAND_SPEED_WIDTH = 6;

const screenElements = Object.freeze({
  [Screen.HOME]: document.getElementById('screen-home'),
  [Screen.DENIED]: document.getElementById('screen-denied'),
  [Screen.SAFETY]: document.getElementById('screen-safety'),
  [Screen.CAPTURE]: document.getElementById('screen-capture')
});

const startSensorsButton = document.getElementById('start-sensors');
const retryPermissionsButton = document.getElementById('retry-permissions');
const beginCaptureButton = document.getElementById('begin-capture');
const exitCaptureButton = document.getElementById('exit-capture');
const recordTraceButton = document.getElementById('record-trace');
const deniedReasonElement = document.querySelector('[data-denied-reason]');
const traceCountElement = document.querySelector('[data-trace-count]');
const captureNoteElement = document.querySelector('[data-capture-note]');
const syncButton = document.getElementById('sync-hold');
const syncNoteElement = document.querySelector('[data-sync-note]');
const handSpeedElement = document.querySelector('[data-hand-speed]');

const readoutElements = Object.freeze({
  quaternion: document.querySelector('[data-quat]'),
  gyro: document.querySelector('[data-gyro]'),
  accel: document.querySelector('[data-accel]'),
  accelIncludingGravity: document.querySelector('[data-accel-g]'),
  motionRate: document.querySelector('[data-rate]'),
  orientationRate: document.querySelector('[data-orientation-rate]'),
  dt: document.querySelector('[data-dt]'),
  gyroUnit: document.querySelector('[data-gyro-unit]')
});

let currentScreen = Screen.HOME;
let captureBeganAtMs = null;

function showScreen(nextScreen) {
  currentScreen = nextScreen;
  for (const [name, element] of Object.entries(screenElements)) {
    element.hidden = name !== nextScreen;
  }
}

function formatNumber(value, digits, width) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return EMPTY_VALUE.padStart(width);
  }
  return value.toFixed(digits).padStart(width);
}

function formatVector(vector, digits, width) {
  if (vector === null || vector === undefined) {
    return EMPTY_VALUE;
  }
  return [
    formatNumber(vector.x, digits, width),
    formatNumber(vector.y, digits, width),
    formatNumber(vector.z, digits, width)
  ].join(' ');
}

function formatQuaternion(quaternion) {
  if (quaternion === null || quaternion === undefined) {
    return EMPTY_VALUE;
  }
  return [
    formatNumber(quaternion.x, QUATERNION_DIGITS, QUATERNION_WIDTH),
    formatNumber(quaternion.y, QUATERNION_DIGITS, QUATERNION_WIDTH),
    formatNumber(quaternion.z, QUATERNION_DIGITS, QUATERNION_WIDTH),
    formatNumber(quaternion.w, QUATERNION_DIGITS, QUATERNION_WIDTH)
  ].join(' ');
}

function formatScalar(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return formatNumber(value, RATE_DIGITS, RATE_WIDTH);
}

function formatText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return EMPTY_VALUE;
  }
  return value;
}

function renderTraceCount(count) {
  traceCountElement.textContent = String(count);
}

function sensorsSilent(motionCount) {
  if (captureBeganAtMs === null || motionCount !== 0) {
    return false;
  }
  return performance.now() - captureBeganAtMs > NO_SENSOR_DATA_GRACE_MS;
}

function renderCaptureNote(motionCount) {
  const silent = sensorsSilent(motionCount);
  captureNoteElement.textContent = silent ? NO_SENSOR_DATA_NOTE : EMPTY_TEXT;
  captureNoteElement.hidden = !silent;
}

function armCaptureNoteTimer() {
  captureBeganAtMs = performance.now();
  renderCaptureNote(null);
}

function renderReadout(snapshot) {
  if (snapshot === null || snapshot === undefined) {
    return;
  }
  readoutElements.quaternion.textContent = formatQuaternion(snapshot.quaternion);
  readoutElements.gyro.textContent = formatVector(
    snapshot.gyroDegPerS === null ? snapshot.gyroRaw : snapshot.gyroDegPerS,
    VECTOR_DIGITS,
    VECTOR_WIDTH
  );
  readoutElements.accel.textContent = formatVector(snapshot.accel, VECTOR_DIGITS, VECTOR_WIDTH);
  readoutElements.accelIncludingGravity.textContent = formatVector(
    snapshot.accelIncludingGravity,
    VECTOR_DIGITS,
    VECTOR_WIDTH
  );
  readoutElements.motionRate.textContent = formatScalar(snapshot.motionRateHz);
  readoutElements.orientationRate.textContent = formatScalar(snapshot.orientationRateHz);
  readoutElements.dt.textContent = formatScalar(snapshot.lastDtMs);
  readoutElements.gyroUnit.textContent = formatText(snapshot.gyroUnit);
  renderCaptureNote(snapshot.motionCount);
  if (capture.traceActive) {
    renderTraceCount(capture.traceSampleCount());
  }
}

let poseSeq = 0;
let synced = false;

function renderHandSpeed(speed) {
  handSpeedElement.textContent = formatNumber(speed, HAND_SPEED_DIGITS, HAND_SPEED_WIDTH);
}

function renderSyncNote(text, state) {
  syncNoteElement.textContent = text;
  syncNoteElement.dataset.syncState = state;
}

function streamPose(fused) {
  renderHandSpeed(fused.speed);
  if (connection === null || fused.quaternion === null) {
    return;
  }
  poseSeq += 1;
  connection.sendPose(
    encodePose({
      quaternion: fused.quaternion,
      speed: fused.speed,
      seq: poseSeq,
      timestampMs: fused.timestampMs
    })
  );
}

const capture = createSensorCapture({ onReadout: renderReadout, onFusedSample: streamPose });

function publishSyncReference(qRef) {
  if (connection === null || qRef === null) {
    return;
  }
  connection.sendSync(qRef);
}

function runSync() {
  const result = capture.syncNow();
  if (!result.ok) {
    renderSyncNote(result.reason, SyncNoteState.REJECTED);
    return;
  }
  synced = true;
  renderSyncNote(SYNC_NOTE_SYNCED, SyncNoteState.SYNCED);
  publishSyncReference(result.qRef);
}

function adoptStoredSyncReference() {
  const stored = capture.syncState();
  if (!stored.synced) {
    renderSyncNote(SYNC_NOTE_UNSYNCED, SyncNoteState.UNSYNCED);
    return;
  }
  synced = true;
  renderSyncNote(SYNC_NOTE_RESTORED, SyncNoteState.SYNCED);
  publishSyncReference(stored.qRef);
}

syncButton.addEventListener('click', runSync);
renderHandSpeed(null);
adoptStoredSyncReference();

function applyActivation(activation) {
  if (activation.granted) {
    showScreen(Screen.SAFETY);
    return;
  }
  deniedReasonElement.textContent = formatText(activation.reason);
  showScreen(Screen.DENIED);
}

function activationFailure(error) {
  const message = error && error.message ? String(error.message) : 'activation failed';
  return { granted: false, reason: message };
}

function runActivation() {
  capture
    .requestActivation()
    .then(applyActivation, (error) => applyActivation(activationFailure(error)));
}

function resetTraceControls() {
  recordTraceButton.textContent = RECORD_LABEL;
  traceCountElement.textContent = ZERO_COUNT;
}

startSensorsButton.addEventListener('click', runActivation);
retryPermissionsButton.addEventListener('click', runActivation);

beginCaptureButton.addEventListener('click', () => {
  resetTraceControls();
  armCaptureNoteTimer();
  showScreen(Screen.CAPTURE);
  capture.beginCapture();
});

exitCaptureButton.addEventListener('click', () => {
  capture.endCapture();
  resetTraceControls();
  showScreen(Screen.HOME);
});

recordTraceButton.addEventListener('click', () => {
  if (capture.traceActive) {
    renderTraceCount(capture.stopTraceAndDownload());
    recordTraceButton.textContent = RECORD_LABEL;
    return;
  }
  capture.startTrace();
  renderTraceCount(0);
  recordTraceButton.textContent = STOP_LABEL;
});

window.__phoneSensors = {
  get screen() {
    return currentScreen;
  },
  snapshot() {
    return capture.snapshot();
  },
  get traceActive() {
    return capture.traceActive;
  },
  traceSampleCount() {
    return capture.traceSampleCount();
  },
  get synced() {
    return synced;
  },
  get poseSeq() {
    return poseSeq;
  }
};

showScreen(Screen.HOME);
