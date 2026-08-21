import { decodePose } from '../../shared/protocol.js'
import { HandInputEvent, createHandInputEmitter } from './hand-input.js'

const SEQ_RESTART_GAP = 1000

export function createSeqGate() {
  let lastSeq = null

  function accept(seq) {
    if (!Number.isFinite(seq)) {
      return false
    }
    const isFresh = lastSeq === null || seq > lastSeq
    const isRestart = lastSeq !== null && seq < lastSeq - SEQ_RESTART_GAP
    if (!isFresh && !isRestart) {
      return false
    }
    lastSeq = seq
    return true
  }

  function reset() {
    lastSeq = null
  }

  return { accept, reset }
}

function finiteQuaternionCopy(q) {
  if (q === null || typeof q !== 'object') {
    return null
  }
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
    return null
  }
  return { x: q.x, y: q.y, z: q.z, w: q.w }
}

export function createPhoneAdapter() {
  const emitter = createHandInputEmitter()
  const seqGate = createSeqGate()
  let running = false

  function ingestPoseData(data) {
    if (!running) {
      return
    }
    const pose = decodePose(data)
    if (pose === null || !seqGate.accept(pose.seq)) {
      return
    }
    emitter.emit(HandInputEvent.POSE, pose)
  }

  function ingestSync(qRef) {
    if (!running) {
      return
    }
    seqGate.reset()
    emitter.emit(HandInputEvent.SYNC, { qRef: finiteQuaternionCopy(qRef) })
  }

  function start() {
    running = true
    seqGate.reset()
  }

  function stop() {
    running = false
  }

  return { start, stop, on: emitter.on, ingestPoseData, ingestSync }
}
