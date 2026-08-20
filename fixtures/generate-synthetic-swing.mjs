import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  quatMultiply,
  quatConjugate,
  quatRotateVector,
  quatFromAxisAngle
} from '../shared/quat.js';

const FRAME_MS = 1000 / 60;
const FRAME_DT_S = 1 / 60;
const GRAVITY_M_S2 = 9.81;
const DEG_TO_RAD = Math.PI / 180;
const DECIMAL_SCALE = 1e8;

const WORLD_UP = Object.freeze({ x: 0, y: 0, z: 1 });
const SWING_AXIS = Object.freeze({ x: 0, y: -1, z: 0 });
const REST_AXIS = Object.freeze({ x: 1, y: 0, z: 0 });

const WINDUP_DEG = 35;
const WHIP_DEG = 120;
const WINDUP_FRAMES = 21;
const WHIP_FRAMES = 25;
const RETURN_FRAMES = 36;
const REST_START_FRAMES = 72;
const REST_BETWEEN_FRAMES = 48;
const REST_END_FRAMES = 72;

const WINDUP_RAD = WINDUP_DEG * DEG_TO_RAD;
const WHIP_RAD = WHIP_DEG * DEG_TO_RAD;

const CANONICAL_REST_QUATERNION = quatFromAxisAngle(REST_AXIS, -Math.PI / 2);

function raisedCosineDisplacement(amplitudeRad, durationS, uS) {
  return (amplitudeRad / 2) * (1 - Math.cos((Math.PI * uS) / durationS));
}

function raisedCosineRate(amplitudeRad, durationS, uS) {
  return (amplitudeRad / 2) * (Math.PI / durationS) * Math.sin((Math.PI * uS) / durationS);
}

function restPhase() {
  return { theta: 0, thetaDot: 0 };
}

function windupPhase(frameIndex) {
  const uS = frameIndex * FRAME_DT_S;
  const durationS = WINDUP_FRAMES * FRAME_DT_S;
  return {
    theta: -raisedCosineDisplacement(WINDUP_RAD, durationS, uS),
    thetaDot: -raisedCosineRate(WINDUP_RAD, durationS, uS)
  };
}

function whipPhase(frameIndex) {
  const uS = frameIndex * FRAME_DT_S;
  const durationS = WHIP_FRAMES * FRAME_DT_S;
  const amplitudeRad = WINDUP_RAD + WHIP_RAD;
  return {
    theta: -WINDUP_RAD + raisedCosineDisplacement(amplitudeRad, durationS, uS),
    thetaDot: raisedCosineRate(amplitudeRad, durationS, uS)
  };
}

function returnPhase(frameIndex) {
  const uS = frameIndex * FRAME_DT_S;
  const durationS = RETURN_FRAMES * FRAME_DT_S;
  return {
    theta: WHIP_RAD - raisedCosineDisplacement(WHIP_RAD, durationS, uS),
    thetaDot: -raisedCosineRate(WHIP_RAD, durationS, uS)
  };
}

function buildSchedule() {
  const schedule = [];
  const pushPhase = (frameCount, phaseFn) => {
    for (let index = 0; index < frameCount; index += 1) {
      schedule.push(phaseFn(index));
    }
  };
  pushPhase(REST_START_FRAMES, restPhase);
  pushPhase(WINDUP_FRAMES, windupPhase);
  pushPhase(WHIP_FRAMES, whipPhase);
  pushPhase(RETURN_FRAMES, returnPhase);
  pushPhase(REST_BETWEEN_FRAMES, restPhase);
  pushPhase(WINDUP_FRAMES, windupPhase);
  pushPhase(WHIP_FRAMES, whipPhase);
  pushPhase(RETURN_FRAMES, returnPhase);
  pushPhase(REST_END_FRAMES, restPhase);
  return schedule;
}

function rounded(value) {
  return Math.round(value * DECIMAL_SCALE) / DECIMAL_SCALE;
}

function roundedVector(v) {
  return { x: rounded(v.x), y: rounded(v.y), z: rounded(v.z) };
}

function sampleAt(theta, thetaDot, timeStampMs) {
  const qSwing = quatFromAxisAngle(SWING_AXIS, theta);
  const q = quatMultiply(qSwing, CANONICAL_REST_QUATERNION);
  const deviceUp = quatRotateVector(quatConjugate(q), WORLD_UP);
  return {
    timeStamp: rounded(timeStampMs),
    rotationRate: roundedVector({ x: 0, y: 0, z: -thetaDot }),
    accelerationIncludingGravity: roundedVector({
      x: deviceUp.x * GRAVITY_M_S2,
      y: deviceUp.y * GRAVITY_M_S2,
      z: deviceUp.z * GRAVITY_M_S2
    }),
    acceleration: { x: 0, y: 0, z: 0 },
    orientation: null
  };
}

function generateTrace() {
  return buildSchedule().map(({ theta, thetaDot }, index) => sampleAt(theta, thetaDot, index * FRAME_MS));
}

function main() {
  const trace = generateTrace();
  const outputPath = join(dirname(fileURLToPath(import.meta.url)), 'synthetic-swing.json');
  writeFileSync(outputPath, `${JSON.stringify(trace, null, 2)}\n`);
  process.stdout.write(`wrote ${trace.length} samples to ${outputPath}\n`);
}

main();
