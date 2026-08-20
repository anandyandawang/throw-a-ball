export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
  TAP: 'tap',
  RESET: 'reset',
  THROW: 'throw'
});

export const POSE_FLOATS = 7;

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
