import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { peerOptionsFromSearch } from '../shared/peer-config.js'
import { QUAT_IDENTITY, armRotationFromPose, quatSlerp } from '../shared/quat.js'
import { buildScene } from './scene.js'
import { createHud } from './hud.js'
import { createDesktopPairing, PairingState } from './pairing.js'
import { HandInputEvent } from './input/hand-input.js'
import { createPhoneAdapter } from './input/phone-adapter.js'
import { createReplayAdapter } from './input/replay-adapter.js'
import { createScriptedAdapter } from './input/scripted-adapter.js'

const HandInputMode = Object.freeze({
  PHONE: 'phone',
  REPLAY: 'replay',
  SCRIPTED: 'scripted',
})

const DEFAULT_TRACE_NAME = 'synthetic-swing'
const SMOOTHING_REMAINDER_PER_SECOND = 1e-10
const MAX_FRAME_SECONDS = 0.1

console.log(`throw-a-ball desktop M3 booting, protocol v${PROTOCOL_VERSION}`)

const search = new URLSearchParams(location.search)

function resolveInputMode(raw) {
  if (raw === HandInputMode.REPLAY || raw === HandInputMode.SCRIPTED) {
    return raw
  }
  return HandInputMode.PHONE
}

const inputMode = resolveInputMode(search.get('input'))
const traceName = search.get('trace') || DEFAULT_TRACE_NAME
const traceUrl = `fixtures/${traceName}.json`

const { scene, camera, renderer, ball, armRig } = buildScene()
document.body.appendChild(renderer.domElement)

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', handleResize)

const pairingStatus = {
  state: null,
  detail: null,
  peerId: null,
  phoneLink: null,
  latencyMs: null,
  tapCount: 0,
}

const hand = {
  mode: inputMode,
  poseCount: 0,
  seq: null,
  timestampMs: null,
  speed: 0,
  quaternion: null,
  target: null,
  applied: { ...QUAT_IDENTITY },
  qRef: null,
}

window.__throwABall = { scene, camera, renderer, ball, armRig, pairing: pairingStatus, hand }

const hud = createHud()

let targetQuaternion = { ...QUAT_IDENTITY }
let appliedQuaternion = { ...QUAT_IDENTITY }
let lastFrameMs = null

function smoothingFactor(dtSeconds) {
  return 1 - Math.pow(SMOOTHING_REMAINDER_PER_SECOND, dtSeconds)
}

function render(nowMs) {
  requestAnimationFrame(render)
  const dtSeconds = lastFrameMs === null
    ? 0
    : Math.min(MAX_FRAME_SECONDS, Math.max(0, (nowMs - lastFrameMs) / 1000))
  lastFrameMs = nowMs
  if (dtSeconds > 0) {
    appliedQuaternion = quatSlerp(appliedQuaternion, targetQuaternion, smoothingFactor(dtSeconds))
    armRig.setRotation(appliedQuaternion)
    hand.applied = appliedQuaternion
  }
  renderer.render(scene, camera)
}
requestAnimationFrame(render)

function createAdapter() {
  if (inputMode === HandInputMode.REPLAY) {
    return createReplayAdapter({ url: traceUrl })
  }
  if (inputMode === HandInputMode.SCRIPTED) {
    return createScriptedAdapter(search)
  }
  return createPhoneAdapter()
}

const adapter = createAdapter()

adapter.on(HandInputEvent.SYNC, (event) => {
  hand.qRef = event && event.qRef ? { ...event.qRef } : null
})

adapter.on(HandInputEvent.POSE, (pose) => {
  hand.poseCount += 1
  hand.seq = pose.seq
  hand.timestampMs = pose.timestampMs
  hand.speed = pose.speed
  hand.quaternion = pose.quaternion
  targetQuaternion = armRotationFromPose(pose.quaternion, hand.qRef)
  hand.target = targetQuaternion
  hud.setHandSpeed(pose.speed)
})

function setPairingStatus(state, detail) {
  pairingStatus.state = state
  pairingStatus.detail = detail
  hud.setState(state, detail)
}

function localInputDetail() {
  return inputMode === HandInputMode.REPLAY
    ? `input: replay (${traceName})`
    : `input: ${inputMode}`
}

function startPairing() {
  const pairing = createDesktopPairing({
    peerOptions: peerOptionsFromSearch(location.search),
    callbacks: {
      onStateChange(state, detail) {
        setPairingStatus(state, detail)
      },
      onPeerId(peerId, phoneLink) {
        pairingStatus.peerId = peerId
        pairingStatus.phoneLink = phoneLink
        hud.setPairing(peerId, phoneLink)
      },
      onLatency(rttMs) {
        pairingStatus.latencyMs = rttMs
        hud.setLatency(rttMs)
      },
      onTap() {
        pairingStatus.tapCount += 1
        hud.flashTap(pairingStatus.tapCount)
      },
      onPoseData(data) {
        adapter.ingestPoseData(data)
      },
      onSync(qRef) {
        adapter.ingestSync(qRef)
      },
    },
  })
  pairing.start()
}

function startAdapter() {
  const started = adapter.start()
  if (started === null || started === undefined || typeof started.catch !== 'function') {
    return
  }
  started.catch((error) => {
    const reason = error && error.message ? error.message : String(error)
    setPairingStatus(PairingState.RETRYING, `input: ${inputMode} failed — ${reason}`)
  })
}

if (inputMode === HandInputMode.PHONE) {
  startAdapter()
  startPairing()
} else {
  setPairingStatus(PairingState.CONNECTED, localInputDetail())
  startAdapter()
}
