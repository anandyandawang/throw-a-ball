export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
  TAP: 'tap',
  RESET: 'reset',
  THROW: 'throw',
  SYNC: 'sync'
});

export const POSE_FLOATS = 7;

export const POSE_BYTES = POSE_FLOATS * 4;

export const PoseIndex = Object.freeze({
  QUATERNION_X: 0,
  QUATERNION_Y: 1,
  QUATERNION_Z: 2,
  QUATERNION_W: 3,
  HAND_SPEED_PROXY: 4,
  SEQUENCE: 5,
  TIMESTAMP: 6
});

export function encodeControlMessage(message) {
  return JSON.stringify(message);
}

export function decodeControlMessage(data) {
  if (typeof data !== 'string') {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  if (typeof parsed.type !== 'string') {
    return null;
  }

  return parsed;
}

export function makeHello() {
  return { type: MessageType.HELLO, version: PROTOCOL_VERSION };
}

export function helloVersionMatches(message) {
  return message.version === PROTOCOL_VERSION;
}

export function makePing(seq, sentAt) {
  return { type: MessageType.PING, seq, sentAt };
}

export function makePong(ping) {
  return { type: MessageType.PONG, seq: ping.seq, sentAt: ping.sentAt };
}

export function makeTap(id, sentAt) {
  return { type: MessageType.TAP, id, sentAt };
}

function isFiniteQuaternion(quaternion) {
  return (
    quaternion !== null &&
    typeof quaternion === 'object' &&
    Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)
  );
}

export function encodePose({ quaternion, speed, seq, timestampMs }) {
  const floats = new Float32Array(POSE_FLOATS);
  floats[PoseIndex.QUATERNION_X] = quaternion.x;
  floats[PoseIndex.QUATERNION_Y] = quaternion.y;
  floats[PoseIndex.QUATERNION_Z] = quaternion.z;
  floats[PoseIndex.QUATERNION_W] = quaternion.w;
  floats[PoseIndex.HAND_SPEED_PROXY] = speed;
  floats[PoseIndex.SEQUENCE] = seq;
  floats[PoseIndex.TIMESTAMP] = timestampMs;
  return floats;
}

function poseFloatsFrom(data) {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength !== POSE_BYTES) {
      return null;
    }
    return new Float32Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength !== POSE_BYTES) {
      return null;
    }
    return new Float32Array(data.buffer, data.byteOffset, POSE_FLOATS);
  }
  return null;
}

export function decodePose(data) {
  const floats = poseFloatsFrom(data);
  if (floats === null) {
    return null;
  }
  for (let i = 0; i < POSE_FLOATS; i += 1) {
    if (!Number.isFinite(floats[i])) {
      return null;
    }
  }
  return {
    quaternion: {
      x: floats[PoseIndex.QUATERNION_X],
      y: floats[PoseIndex.QUATERNION_Y],
      z: floats[PoseIndex.QUATERNION_Z],
      w: floats[PoseIndex.QUATERNION_W]
    },
    speed: floats[PoseIndex.HAND_SPEED_PROXY],
    seq: floats[PoseIndex.SEQUENCE],
    timestampMs: floats[PoseIndex.TIMESTAMP]
  };
}

export function isPoseData(data) {
  if (data instanceof ArrayBuffer) {
    return data.byteLength === POSE_BYTES;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength === POSE_BYTES;
  }
  return false;
}

export function makeSync(qRef) {
  return { type: MessageType.SYNC, qRef: { x: qRef.x, y: qRef.y, z: qRef.z, w: qRef.w } };
}

export function syncReference(message) {
  if (message === null || typeof message !== 'object' || !isFiniteQuaternion(message.qRef)) {
    return null;
  }
  const { x, y, z, w } = message.qRef;
  return { x, y, z, w };
}
