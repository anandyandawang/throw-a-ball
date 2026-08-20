import {
  QUAT_IDENTITY,
  quatAngleRad,
  quatFromAxisAngle,
  quatMultiply,
  gameRotationToDeviceDelta,
} from '../../shared/quat.js'
import { ARM_LENGTH_M } from '../../phone/js/fusion.js'
import { HandInputEvent, createHandInputEmitter } from './hand-input.js'

export const ScriptedDefaults = Object.freeze({
  swingDeg: 110,
  windupDeg: 35,
  periodMs: 1600,
  restMs: 700,
  axis: 'x',
})

const GAME_PITCH_AXIS = Object.freeze({ x: 1, y: 0, z: 0 })
const GAME_YAW_AXIS = Object.freeze({ x: 0, y: 1, z: 0 })

const WINDUP_PHASE_END = 0.3
const WHIP_PHASE_END = 0.6
const MIN_PERIOD_MS = 200
const STEP_MS = 1000 / 60
const TICK_MS = 16
const MAX_STEPS_PER_TICK = 8
const MAX_LAG_MS = 200
const DRAG_YAW_MAX_RAD = Math.PI / 2
const DRAG_PITCH_MAX_RAD = (3 * Math.PI) / 4
const RESUME_DELAY_MS = 800
const DEG_TO_RAD = Math.PI / 180

function raisedCosine(t) {
  const clamped = Math.min(1, Math.max(0, t))
  return (1 - Math.cos(Math.PI * clamped)) / 2
}

function numberParam(searchParams, name, fallback) {
  if (searchParams === null || typeof searchParams !== 'object' || typeof searchParams.get !== 'function') {
    return fallback
  }
  const raw = searchParams.get(name)
  if (raw === null || raw === '') {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function scriptedParams(searchParams) {
  const axisRaw = searchParams !== null && typeof searchParams === 'object' && typeof searchParams.get === 'function'
    ? searchParams.get('axis')
    : null
  return {
    swingDeg: numberParam(searchParams, 'swingDeg', ScriptedDefaults.swingDeg),
    windupDeg: numberParam(searchParams, 'windupDeg', ScriptedDefaults.windupDeg),
    periodMs: Math.max(MIN_PERIOD_MS, numberParam(searchParams, 'periodMs', ScriptedDefaults.periodMs)),
    restMs: Math.max(0, numberParam(searchParams, 'restMs', ScriptedDefaults.restMs)),
    axis: axisRaw === 'y' ? 'y' : ScriptedDefaults.axis,
  }
}

export function swingAngleRad(elapsedMs, params) {
  const cycleMs = params.periodMs + params.restMs
  const phaseMs = ((elapsedMs % cycleMs) + cycleMs) % cycleMs
  if (phaseMs >= params.periodMs) {
    return 0
  }
  const phase = phaseMs / params.periodMs
  const windupRad = -params.windupDeg * DEG_TO_RAD
  const swingRad = params.swingDeg * DEG_TO_RAD
  if (phase < WINDUP_PHASE_END) {
    return windupRad * raisedCosine(phase / WINDUP_PHASE_END)
  }
  if (phase < WHIP_PHASE_END) {
    const whipProgress = (phase - WINDUP_PHASE_END) / (WHIP_PHASE_END - WINDUP_PHASE_END)
    return windupRad + (swingRad - windupRad) * raisedCosine(whipProgress)
  }
  const returnProgress = (phase - WHIP_PHASE_END) / (1 - WHIP_PHASE_END)
  return swingRad * (1 - raisedCosine(returnProgress))
}

export function swingGameRotation(angleRad, axis) {
  return quatFromAxisAngle(axis === 'y' ? GAME_YAW_AXIS : GAME_PITCH_AXIS, angleRad)
}

export function dragGameRotation(yawRad, pitchRad) {
  return quatMultiply(
    quatFromAxisAngle(GAME_YAW_AXIS, yawRad),
    quatFromAxisAngle(GAME_PITCH_AXIS, pitchRad)
  )
}

function clampUnitRange(value) {
  return Math.min(1, Math.max(-1, value))
}

function angularSpeed(fromRotation, toRotation, dtMs) {
  return (quatAngleRad(fromRotation, toRotation) / (dtMs / 1000)) * ARM_LENGTH_M
}

export function createScriptedAdapter(searchParams) {
  const params = scriptedParams(searchParams)
  const emitter = createHandInputEmitter()

  let timer = null
  let seq = 0
  let swingStartMs = 0
  let nextStepMs = 0
  let resumeAtMs = null
  let lastGameRotation = { ...QUAT_IDENTITY }
  let dragging = false
  let dragOriginX = 0
  let dragOriginY = 0
  let dragPointerX = 0
  let dragPointerY = 0

  function viewportWidth() {
    return typeof window === 'undefined' || !(window.innerWidth > 0) ? 1280 : window.innerWidth
  }

  function viewportHeight() {
    return typeof window === 'undefined' || !(window.innerHeight > 0) ? 720 : window.innerHeight
  }

  function emitPose(gameRotation, speed, timestampMs) {
    seq += 1
    lastGameRotation = gameRotation
    emitter.emit(HandInputEvent.POSE, {
      quaternion: gameRotationToDeviceDelta(gameRotation),
      speed,
      seq,
      timestampMs,
    })
  }

  function currentDragRotation() {
    const yawRad = clampUnitRange((dragPointerX - dragOriginX) / viewportWidth()) * DRAG_YAW_MAX_RAD
    const pitchRad = clampUnitRange((dragOriginY - dragPointerY) / viewportHeight()) * DRAG_PITCH_MAX_RAD
    return dragGameRotation(yawRad, pitchRad)
  }

  function stepDrag(stepMs) {
    const gameRotation = currentDragRotation()
    emitPose(gameRotation, angularSpeed(lastGameRotation, gameRotation, STEP_MS), stepMs)
  }

  function stepSwing(stepMs) {
    const elapsedMs = stepMs - swingStartMs
    const angleRad = swingAngleRad(elapsedMs, params)
    const previousAngleRad = swingAngleRad(elapsedMs - STEP_MS, params)
    const speed = (Math.abs(angleRad - previousAngleRad) / (STEP_MS / 1000)) * ARM_LENGTH_M
    emitPose(swingGameRotation(angleRad, params.axis), speed, stepMs)
  }

  function step(stepMs) {
    if (dragging) {
      stepDrag(stepMs)
      return
    }
    if (resumeAtMs !== null) {
      if (stepMs < resumeAtMs) {
        emitPose(lastGameRotation, 0, stepMs)
        return
      }
      resumeAtMs = null
      swingStartMs = stepMs
    }
    stepSwing(stepMs)
  }

  function tick() {
    const nowMs = performance.now()
    let steps = 0
    while (nextStepMs <= nowMs && steps < MAX_STEPS_PER_TICK) {
      step(nextStepMs)
      nextStepMs += STEP_MS
      steps += 1
    }
    if (nowMs - nextStepMs > MAX_LAG_MS) {
      nextStepMs = nowMs
    }
  }

  function handlePointerDown(event) {
    dragging = true
    resumeAtMs = null
    dragOriginX = event.clientX
    dragOriginY = event.clientY
    dragPointerX = event.clientX
    dragPointerY = event.clientY
  }

  function handlePointerMove(event) {
    if (!dragging) {
      return
    }
    dragPointerX = event.clientX
    dragPointerY = event.clientY
  }

  function handlePointerUp() {
    if (!dragging) {
      return
    }
    dragging = false
    resumeAtMs = performance.now() + RESUME_DELAY_MS
  }

  function attachPointerHandlers() {
    if (typeof window === 'undefined') {
      return
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }

  function detachPointerHandlers() {
    if (typeof window === 'undefined') {
      return
    }
    window.removeEventListener('pointerdown', handlePointerDown)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
  }

  function start() {
    if (timer !== null) {
      return
    }
    dragging = false
    resumeAtMs = null
    lastGameRotation = { ...QUAT_IDENTITY }
    swingStartMs = performance.now()
    nextStepMs = swingStartMs
    emitter.emit(HandInputEvent.SYNC, { qRef: { ...QUAT_IDENTITY } })
    attachPointerHandlers()
    timer = setInterval(tick, TICK_MS)
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    detachPointerHandlers()
  }

  return { start, stop, on: emitter.on, params }
}
