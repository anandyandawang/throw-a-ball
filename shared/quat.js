export const QUAT_IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export const CANONICAL_HOLD_DEVICE_TO_GAME = Object.freeze({
  x: Math.SQRT1_2,
  y: 0,
  z: -Math.SQRT1_2,
  w: 0
});

const SLERP_LINEAR_DOT = 0.9995;

function finiteOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function identityQuaternion() {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function isQuaternionLike(q) {
  return q !== null && typeof q === 'object'
    && Number.isFinite(q.x) && Number.isFinite(q.y)
    && Number.isFinite(q.z) && Number.isFinite(q.w);
}

export function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

export function quatConjugate(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function quatNormalize(q) {
  if (!isQuaternionLike(q)) {
    return identityQuaternion();
  }
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    return identityQuaternion();
  }
  return { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm };
}

export function quatRotateVector(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx
  };
}

export function quatFromAxisAngle(axis, angleRad) {
  const angle = finiteOrZero(angleRad);
  if (axis === null || typeof axis !== 'object') {
    return identityQuaternion();
  }
  const x = finiteOrZero(axis.x);
  const y = finiteOrZero(axis.y);
  const z = finiteOrZero(axis.z);
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) {
    return identityQuaternion();
  }
  const scale = Math.sin(angle / 2) / length;
  return { x: x * scale, y: y * scale, z: z * scale, w: Math.cos(angle / 2) };
}

function quatNegate(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
}

function quatBlend(a, b, scaleA, scaleB) {
  return {
    x: a.x * scaleA + b.x * scaleB,
    y: a.y * scaleA + b.y * scaleB,
    z: a.z * scaleA + b.z * scaleB,
    w: a.w * scaleA + b.w * scaleB
  };
}

export function quatSlerp(a, b, t) {
  const from = quatNormalize(a);
  const raw = quatNormalize(b);
  const rawDot = quatDot(from, raw);
  const to = rawDot < 0 ? quatNegate(raw) : raw;
  const dot = Math.min(1, Math.abs(rawDot));
  if (dot > SLERP_LINEAR_DOT) {
    return quatNormalize(quatBlend(from, to, 1 - t, t));
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  return quatNormalize(quatBlend(
    from,
    to,
    Math.sin((1 - t) * theta) / sinTheta,
    Math.sin(t * theta) / sinTheta
  ));
}

export function quatAngleRad(a, b) {
  const dot = quatDot(quatNormalize(a), quatNormalize(b));
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

export function armRotationFromPose(q, qRef) {
  if (!isQuaternionLike(q) || !isQuaternionLike(qRef)) {
    return identityQuaternion();
  }
  const gripRelative = quatMultiply(quatConjugate(quatNormalize(qRef)), quatNormalize(q));
  const inGameFrame = quatMultiply(
    quatMultiply(CANONICAL_HOLD_DEVICE_TO_GAME, gripRelative),
    quatConjugate(CANONICAL_HOLD_DEVICE_TO_GAME)
  );
  return quatNormalize(inGameFrame);
}

export function gameRotationToDeviceDelta(qGame) {
  if (!isQuaternionLike(qGame)) {
    return identityQuaternion();
  }
  const deviceDelta = quatMultiply(
    quatMultiply(quatConjugate(CANONICAL_HOLD_DEVICE_TO_GAME), quatNormalize(qGame)),
    CANONICAL_HOLD_DEVICE_TO_GAME
  );
  return quatNormalize(deviceDelta);
}
