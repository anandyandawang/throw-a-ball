export const PROTOCOL_VERSION = 1;

export const MessageType = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  PONG: 'pong',
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
