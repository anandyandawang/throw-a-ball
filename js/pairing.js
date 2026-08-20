import {
  MessageType,
  decodeControlMessage,
  encodeControlMessage,
  helloVersionMatches,
  makeHello,
  makePing,
} from '../shared/protocol.js'
import { signalingQueryEntries } from '../shared/peer-config.js'

export const PairingState = Object.freeze({
  WAITING: 'waiting',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RETRYING: 'retrying',
})

const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]
const PING_INTERVAL_MS = 1000
const PING_EXPIRY_MS = 10000

const DETAIL_CREATING_PEER = 'creating a peer id...'
const DETAIL_WAITING_FOR_PHONE = 'waiting for your phone — scan the code'
const DETAIL_PHONE_FOUND = 'phone found — checking protocol'
const DETAIL_PHONE_CONNECTED = 'phone connected — latency is live'
const DETAIL_PHONE_DISCONNECTED = 'phone disconnected — scan again'
const DETAIL_VERSION_MISMATCH = 'protocol version mismatch — reload both pages'
const DETAIL_PEERJS_MISSING = 'peerjs failed to load — check the network and reload'

const CONNECTION_SCOPED_ERROR_TYPES = new Set(['peer-unavailable'])

function backoffDelayMs(attempt) {
  const index = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)
  return BACKOFF_DELAYS_MS[index]
}

function delaySeconds(delayMs) {
  return Math.round(delayMs / 1000)
}

function signalingLostDetail(delayMs) {
  return `signaling offline — retrying in ${delaySeconds(delayMs)}s`
}

function peerErrorDetail(errorType, delayMs) {
  return `signaling error (${errorType}) — retrying in ${delaySeconds(delayMs)}s`
}

function buildPhoneLink(peerId) {
  const phoneUrl = new URL('phone/', location.href)
  phoneUrl.searchParams.set('peer', peerId)
  for (const [key, value] of signalingQueryEntries(location.search)) {
    phoneUrl.searchParams.append(key, value)
  }
  return phoneUrl.href
}

export function createDesktopPairing({ peerOptions, callbacks }) {
  const noop = () => {}
  const listeners = callbacks || {}
  const onStateChange = listeners.onStateChange || noop
  const onPeerId = listeners.onPeerId || noop
  const onLatency = listeners.onLatency || noop
  const onTap = listeners.onTap || noop

  const outstandingPings = new Map()

  let peer = null
  let connection = null
  let helloExchanged = false
  let versionMismatch = false
  let stopped = false
  let peerAttempt = 0
  let reconnectAttempt = 0
  let retryTimer = null
  let pingTimer = null
  let pingSeq = 0

  function isConnectionOpen() {
    return connection !== null && Boolean(connection.open)
  }

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function scheduleRetry(action, delayMs) {
    clearRetryTimer()
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (stopped || versionMismatch) {
        return
      }
      action()
    }, delayMs)
  }

  function stopPingLoop() {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    outstandingPings.clear()
  }

  function prunePings(now) {
    for (const [seq, sentAt] of outstandingPings) {
      if (now - sentAt > PING_EXPIRY_MS) {
        outstandingPings.delete(seq)
      }
    }
  }

  function sendPing() {
    if (!isConnectionOpen()) {
      stopPingLoop()
      return
    }
    const sentAt = performance.now()
    prunePings(sentAt)
    pingSeq += 1
    outstandingPings.set(pingSeq, sentAt)
    connection.send(encodeControlMessage(makePing(pingSeq, sentAt)))
  }

  function startPingLoop() {
    stopPingLoop()
    pingSeq = 0
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS)
  }

  function enterVersionMismatch() {
    versionMismatch = true
    stopPingLoop()
    clearRetryTimer()
    onStateChange(PairingState.RETRYING, DETAIL_VERSION_MISMATCH)
  }

  function handleHello(message) {
    connection.send(encodeControlMessage(makeHello()))
    if (!helloVersionMatches(message)) {
      enterVersionMismatch()
      return
    }
    if (helloExchanged) {
      return
    }
    helloExchanged = true
    peerAttempt = 0
    reconnectAttempt = 0
    onStateChange(PairingState.CONNECTED, DETAIL_PHONE_CONNECTED)
    startPingLoop()
  }

  function handlePong(message) {
    if (!outstandingPings.has(message.seq)) {
      return
    }
    outstandingPings.delete(message.seq)
    onLatency(performance.now() - message.sentAt)
  }

  function handleData(source, data) {
    if (source !== connection || stopped || versionMismatch) {
      return
    }
    const message = decodeControlMessage(data)
    if (message === null) {
      return
    }
    if (message.type === MessageType.HELLO) {
      handleHello(message)
      return
    }
    if (message.type === MessageType.PONG) {
      handlePong(message)
      return
    }
    if (message.type === MessageType.TAP) {
      onTap(message)
    }
  }

  function handleConnectionLost(source) {
    if (source !== connection) {
      return
    }
    connection = null
    helloExchanged = false
    stopPingLoop()
    if (stopped || versionMismatch) {
      return
    }
    onStateChange(PairingState.WAITING, DETAIL_PHONE_DISCONNECTED)
  }

  function acceptConnection(incoming) {
    if (stopped || versionMismatch) {
      incoming.close()
      return
    }
    if (connection !== null && connection !== incoming) {
      const previous = connection
      connection = null
      previous.close()
    }
    connection = incoming
    helloExchanged = false
    stopPingLoop()
    onStateChange(PairingState.CONNECTING, DETAIL_PHONE_FOUND)
    incoming.on('data', (data) => handleData(incoming, data))
    incoming.on('close', () => handleConnectionLost(incoming))
    incoming.on('error', () => handleConnectionLost(incoming))
  }

  function destroyPeer() {
    stopPingLoop()
    connection = null
    helloExchanged = false
    if (peer !== null) {
      const doomed = peer
      peer = null
      doomed.destroy()
    }
  }

  function handlePeerDisconnected() {
    if (stopped || versionMismatch || peer === null) {
      return
    }
    if (isConnectionOpen()) {
      peer.reconnect()
      return
    }
    const delayMs = backoffDelayMs(reconnectAttempt)
    reconnectAttempt += 1
    onStateChange(PairingState.RETRYING, signalingLostDetail(delayMs))
    scheduleRetry(() => {
      if (peer === null || peer.destroyed) {
        createPeer()
        return
      }
      peer.reconnect()
    }, delayMs)
  }

  function handlePeerError(error) {
    if (stopped || versionMismatch) {
      return
    }
    const errorType = error && error.type ? error.type : 'unknown'
    if (CONNECTION_SCOPED_ERROR_TYPES.has(errorType)) {
      return
    }
    const delayMs = backoffDelayMs(peerAttempt)
    peerAttempt += 1
    onStateChange(PairingState.RETRYING, peerErrorDetail(errorType, delayMs))
    destroyPeer()
    scheduleRetry(createPeer, delayMs)
  }

  function handlePeerOpen(peerId) {
    peerAttempt = 0
    reconnectAttempt = 0
    onPeerId(peerId, buildPhoneLink(peerId))
    if (helloExchanged) {
      return
    }
    onStateChange(PairingState.WAITING, DETAIL_WAITING_FOR_PHONE)
  }

  function createPeer() {
    if (stopped || versionMismatch) {
      return
    }
    onStateChange(PairingState.WAITING, DETAIL_CREATING_PEER)
    const created = new window.Peer(peerOptions)
    peer = created
    created.on('open', (peerId) => {
      if (created !== peer || stopped) {
        return
      }
      handlePeerOpen(peerId)
    })
    created.on('connection', (incoming) => {
      if (created !== peer) {
        incoming.close()
        return
      }
      acceptConnection(incoming)
    })
    created.on('disconnected', () => {
      if (created !== peer) {
        return
      }
      handlePeerDisconnected()
    })
    created.on('error', (error) => {
      if (created !== peer) {
        return
      }
      handlePeerError(error)
    })
  }

  function start() {
    if (typeof window === 'undefined' || typeof window.Peer !== 'function') {
      onStateChange(PairingState.WAITING, DETAIL_PEERJS_MISSING)
      return
    }
    stopped = false
    createPeer()
  }

  function destroy() {
    stopped = true
    clearRetryTimer()
    destroyPeer()
  }

  return { start, destroy }
}
