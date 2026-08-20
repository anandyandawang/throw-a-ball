import {
  MessageType,
  decodeControlMessage,
  encodeControlMessage,
  helloVersionMatches,
  makeHello,
  makePong,
  makeTap
} from '../../shared/protocol.js';

const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);

const PhoneState = Object.freeze({
  WAITING: 'waiting',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RETRYING: 'retrying'
});

const Detail = Object.freeze({
  CONTACTING_SERVICE: 'contacting the pairing service...',
  CALLING_DESKTOP: 'calling the desktop page...',
  SAYING_HELLO: 'saying hello to the desktop page...',
  PAIRED: 'paired — tap away',
  DESKTOP_NOT_FOUND: 'desktop not found — leave this open, retrying',
  VERSION_MISMATCH: 'protocol version mismatch — reload both pages',
  PEER_SCRIPT_MISSING: 'pairing service script failed to load — check your connection and reload'
});

const RAW_STRING_SERIALIZATION = 'raw';

const CONNECTION_OPTIONS = Object.freeze({ reliable: false, serialization: RAW_STRING_SERIALIZATION });

const FATAL_PEER_ERROR_TYPES = Object.freeze([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'network',
  'server-error',
  'socket-error',
  'socket-closed',
  'ssl-unavailable',
  'unavailable-id',
  'webrtc'
]);

function retryDelayAt(attemptIndex) {
  const lastIndex = RETRY_DELAYS_MS.length - 1;
  return RETRY_DELAYS_MS[Math.min(attemptIndex, lastIndex)];
}

function retryDetail(reason, delayMs) {
  return `${reason} — retrying in ${Math.round(delayMs / 1000)}s`;
}

function peerConstructor() {
  return typeof globalThis.Peer === 'function' ? globalThis.Peer : null;
}

function isFatalPeerError(error) {
  const type = error && error.type ? error.type : '';
  return FATAL_PEER_ERROR_TYPES.indexOf(type) !== -1;
}

export function createPhoneConnection({ desktopPeerId, peerOptions, callbacks }) {
  const handlers = callbacks || {};

  let peer = null;
  let connection = null;
  let state = PhoneState.WAITING;
  let retryAttempt = 0;
  let retryTimer = null;
  let tapCount = 0;
  let deadEnded = false;
  let torndown = false;

  function setState(nextState, detail) {
    state = nextState;
    if (typeof handlers.onStateChange === 'function') {
      handlers.onStateChange(nextState, detail);
    }
  }

  function isLive(candidate) {
    return !torndown && !deadEnded && candidate === connection;
  }

  function send(message) {
    if (connection === null || connection.open !== true) {
      return;
    }
    connection.send(encodeControlMessage(message));
  }

  function dropConnection() {
    if (connection === null) {
      return;
    }
    const closing = connection;
    connection = null;
    try {
      closing.close();
    } catch {
      return;
    }
  }

  function dropPeer() {
    if (peer === null) {
      return;
    }
    const closing = peer;
    peer = null;
    try {
      closing.destroy();
    } catch {
      return;
    }
  }

  function deadEnd(detail) {
    deadEnded = true;
    clearRetry();
    dropConnection();
    dropPeer();
    setState(PhoneState.RETRYING, detail);
  }

  function clearRetry() {
    if (retryTimer === null) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(detail, delayMs) {
    if (torndown || deadEnded || retryTimer !== null) {
      return;
    }
    retryTimer = setTimeout(resume, delayMs);
    setState(PhoneState.RETRYING, detail);
  }

  function retryAfterFailure(reason) {
    if (torndown || deadEnded || retryTimer !== null) {
      return;
    }
    const delayMs = retryDelayAt(retryAttempt);
    retryAttempt += 1;
    scheduleRetry(reason === Detail.DESKTOP_NOT_FOUND ? reason : retryDetail(reason, delayMs), delayMs);
  }

  function resume() {
    retryTimer = null;
    if (torndown || deadEnded) {
      return;
    }
    if (peer === null) {
      openPeer();
      return;
    }
    if (peer.disconnected === true) {
      setState(PhoneState.CONNECTING, Detail.CONTACTING_SERVICE);
      peer.reconnect();
      return;
    }
    openConnection();
  }

  function openPeer() {
    const PeerClass = peerConstructor();
    if (PeerClass === null) {
      deadEnd(Detail.PEER_SCRIPT_MISSING);
      return;
    }
    setState(PhoneState.CONNECTING, Detail.CONTACTING_SERVICE);
    peer = new PeerClass(peerOptions);
    peer.on('open', () => {
      if (torndown || deadEnded) {
        return;
      }
      openConnection();
    });
    peer.on('disconnected', handlePeerDisconnected);
    peer.on('error', handlePeerError);
  }

  function openConnection() {
    if (peer === null) {
      return;
    }
    dropConnection();
    setState(PhoneState.CONNECTING, Detail.CALLING_DESKTOP);
    const opening = peer.connect(desktopPeerId, CONNECTION_OPTIONS);
    connection = opening;
    opening.on('open', () => {
      if (!isLive(opening)) {
        return;
      }
      setState(PhoneState.CONNECTING, Detail.SAYING_HELLO);
      send(makeHello());
    });
    opening.on('data', (data) => {
      if (!isLive(opening)) {
        return;
      }
      handleMessage(decodeControlMessage(data));
    });
    opening.on('close', () => {
      if (!isLive(opening)) {
        return;
      }
      connection = null;
      retryAfterFailure('desktop connection closed');
    });
    opening.on('error', (error) => {
      if (!isLive(opening)) {
        return;
      }
      connection = null;
      retryAfterFailure(errorReason(error));
    });
  }

  function errorReason(error) {
    if (error && error.type === 'peer-unavailable') {
      return Detail.DESKTOP_NOT_FOUND;
    }
    return 'connection failed';
  }

  function handleMessage(message) {
    if (message === null) {
      return;
    }
    if (message.type === MessageType.HELLO) {
      handleHello(message);
      return;
    }
    if (message.type === MessageType.PING) {
      send(makePong(message));
    }
  }

  function handleHello(message) {
    if (!helloVersionMatches(message)) {
      deadEnd(Detail.VERSION_MISMATCH);
      return;
    }
    retryAttempt = 0;
    setState(PhoneState.CONNECTED, Detail.PAIRED);
  }

  function handlePeerDisconnected() {
    if (torndown || deadEnded) {
      return;
    }
    if (peer !== null && connection !== null && connection.open === true) {
      peer.reconnect();
      return;
    }
    retryAfterFailure('pairing service dropped the line');
  }

  function handlePeerError(error) {
    if (torndown || deadEnded) {
      return;
    }
    if (error && error.type === 'peer-unavailable') {
      connection = null;
      retryAfterFailure(Detail.DESKTOP_NOT_FOUND);
      return;
    }
    if (!isFatalPeerError(error)) {
      return;
    }
    dropConnection();
    dropPeer();
    retryAfterFailure('pairing service error');
  }

  function start() {
    if (torndown || deadEnded || peer !== null) {
      return;
    }
    openPeer();
  }

  function sendTap() {
    if (state !== PhoneState.CONNECTED) {
      return;
    }
    const nextCount = tapCount + 1;
    send(makeTap(nextCount, performance.now()));
    tapCount = nextCount;
    if (typeof handlers.onTapSent === 'function') {
      handlers.onTapSent(tapCount);
    }
  }

  function destroy() {
    torndown = true;
    clearRetry();
    dropConnection();
    dropPeer();
  }

  return { start, sendTap, destroy };
}
