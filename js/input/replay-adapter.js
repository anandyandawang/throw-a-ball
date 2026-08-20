import {
  createFusion,
  fuseMotionSample,
  checkSyncHold,
  captureSyncReference,
} from '../../phone/js/fusion.js'
import { HandInputEvent, createHandInputEmitter } from './hand-input.js'

const NOMINAL_DT_MS = 16.667
const MIN_DT_MS = 1
const MAX_DT_MS = 50
const TICK_MS = 4
const MAX_SAMPLES_PER_TICK = 240
const MAX_LAG_MS = 250

function isSample(entry) {
  return entry !== null && typeof entry === 'object' && Number.isFinite(entry.timeStamp)
}

function traceSamples(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray(payload.samples)
      ? payload.samples
      : []
  return entries.filter(isSample)
}

async function loadTrace(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`replay trace ${url} failed: ${response.status}`)
  }
  return traceSamples(await response.json())
}

function clampDtMs(dtMs) {
  return Math.min(MAX_DT_MS, Math.max(MIN_DT_MS, dtMs))
}

export function createReplayAdapter({ url, loop = true }) {
  const emitter = createHandInputEmitter()

  let samples = []
  let index = 0
  let seq = 0
  let fusion = createFusion()
  let syncEmitted = false
  let previousTimeStampMs = null
  let traceOriginMs = 0
  let traceSpanMs = NOMINAL_DT_MS
  let loopStartMs = 0
  let running = false
  let timer = null

  function dueTimeMs(sampleIndex) {
    return loopStartMs + (samples[sampleIndex].timeStamp - traceOriginMs)
  }

  function sampleDtMs(timeStampMs) {
    const dtMs = previousTimeStampMs === null
      ? NOMINAL_DT_MS
      : clampDtMs(timeStampMs - previousTimeStampMs)
    previousTimeStampMs = timeStampMs
    return dtMs
  }

  function tryEmitSync(sample) {
    if (syncEmitted || !checkSyncHold(sample.accelerationIncludingGravity).ok) {
      return
    }
    const qRef = captureSyncReference(fusion)
    if (qRef === null) {
      return
    }
    syncEmitted = true
    emitter.emit(HandInputEvent.SYNC, { qRef })
  }

  function processSample(sample) {
    const snapshot = fuseMotionSample(fusion, {
      dtMs: sampleDtMs(sample.timeStamp),
      gyroRadPerS: sample.rotationRate,
      accel: sample.acceleration,
      accelIncludingGravity: sample.accelerationIncludingGravity,
    })
    if (!snapshot.initialized) {
      return
    }
    tryEmitSync(sample)
    if (snapshot.quaternion === null) {
      return
    }
    seq += 1
    emitter.emit(HandInputEvent.POSE, {
      quaternion: snapshot.quaternion,
      speed: snapshot.speed,
      seq,
      timestampMs: sample.timeStamp,
    })
  }

  function startNextLoop() {
    index = 0
    loopStartMs += traceSpanMs
    fusion = createFusion()
    syncEmitted = false
    previousTimeStampMs = null
  }

  function scheduleNextTick() {
    if (!running || index >= samples.length) {
      return
    }
    const waitMs = Math.min(TICK_MS, Math.max(0, dueTimeMs(index) - performance.now()))
    timer = setTimeout(tick, waitMs)
  }

  function catchUp(nowMs) {
    if (index >= samples.length) {
      return
    }
    const lagMs = nowMs - dueTimeMs(index)
    if (lagMs > MAX_LAG_MS) {
      loopStartMs += lagMs
    }
  }

  function tick() {
    timer = null
    if (!running) {
      return
    }
    const nowMs = performance.now()
    let processed = 0
    while (running && index < samples.length && dueTimeMs(index) <= nowMs && processed < MAX_SAMPLES_PER_TICK) {
      processSample(samples[index])
      index += 1
      processed += 1
      if (index >= samples.length) {
        if (!loop) {
          running = false
          return
        }
        startNextLoop()
      }
    }
    catchUp(nowMs)
    scheduleNextTick()
  }

  async function start() {
    if (running) {
      return
    }
    running = true
    const loaded = await loadTrace(url)
    if (!running) {
      return
    }
    if (loaded.length === 0) {
      running = false
      throw new Error(`replay trace ${url} has no usable samples`)
    }
    samples = loaded
    index = 0
    seq = 0
    fusion = createFusion()
    syncEmitted = false
    previousTimeStampMs = null
    traceOriginMs = samples[0].timeStamp
    traceSpanMs = samples[samples.length - 1].timeStamp - traceOriginMs + NOMINAL_DT_MS
    loopStartMs = performance.now()
    tick()
  }

  function stop() {
    running = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { start, stop, on: emitter.on, traceUrl: url }
}
