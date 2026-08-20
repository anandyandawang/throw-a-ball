#!/usr/bin/env node
import { createRequire } from 'node:module'
import { execSync, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(HERE)
const OUT_DIR = path.join(HERE, 'out')
const CACHE_DIR = path.join(HERE, '.cache')
const VIDEO_ROOT = path.join(OUT_DIR, 'video-hand')

const CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/'
const PACKAGE_SUBDIR = 'package'
const CDN_PACKAGES = Object.freeze([
  { name: 'three', version: '0.185.1', entryRel: path.join('build', 'three.module.js') },
  { name: 'peerjs', version: '1.5.5', entryRel: path.join('dist', 'peerjs.min.js') },
  { name: 'qrcodejs', version: '1.0.0', entryRel: 'qrcode.min.js' },
])

const VIEWPORT = { width: 1280, height: 720 }
const TRACE_NAME = 'synthetic-swing'

const OVERALL_TIMEOUT_MS = 420000
const GOTO_TIMEOUT_MS = 30000
const READY_TIMEOUT_MS = 20000
const POSE_TIMEOUT_MS = 20000

const SCRIPTED_WARMUP_MS = 900
const SCRIPTED_OBSERVE_MS = 7000
const SCRIPTED_RESUME_OBSERVE_MS = 3200
const REPLAY_WARMUP_MS = 900
const REPLAY_OBSERVE_MS = 7000

const DRAG_START = { x: 200, y: 650 }
const DRAG_HOLD = { x: 1100, y: 100 }
const DRAG_SECOND = { x: 400, y: 600 }
const DRAG_STEPS = 24
const DRAG_SETTLE_MS = 450
const DRAG_HOLD_MS = 550
const DRAG_RELEASE_WAIT_MS = 1500

const MIN_REPLAY_POSE_COUNT = 100
const MIN_REPLAY_PEAK_SPEED = 2
const MAX_REPLAY_REST_SPEED = 0.2
const MIN_REPLAY_TARGET_ANGLE_DEG = 45
const MIN_REPLAY_APPLIED_ANGLE_DEG = 45

const MIN_SCRIPTED_POSE_RATE_HZ = 50
const SWING_HIGH_ANGLE_DEG = 60
const SWING_LOW_ANGLE_DEG = 15
const MIN_SWING_PEAKS = 2
const MIN_SWING_CYCLES = 2
const MIN_DRAG_ANGLE_DEG = 40
const MAX_DRAG_HOLD_DRIFT_DEG = 4
const MIN_DRAG_MOVE_DELTA_DEG = 10
const MIN_RESUMED_ANGLE_SPAN_DEG = 30

const QUATERNION_NORM_TOLERANCE = 1e-5
const MIN_DISTINCT_SPEED_TEXTS = 4

const VIDEO_SCRIPTED_INTRO_MS = 1200
const VIDEO_SCRIPTED_TAIL_MS = 1200
const VIDEO_REPLAY_TAIL_MS = 1200
const ENCODED_HEIGHT = 720
const ENCODED_FPS = 30
const MIN_VIDEO_SECONDS = 18

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

function errorMessage(err) {
  if (err == null) {
    return 'unknown error'
  }
  return err.message ? err.message : String(err)
}

function resolvePlaywright() {
  const require = createRequire(import.meta.url)
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function ensureNpmPackage({ name, version, entryRel }) {
  const versionDir = path.join(CACHE_DIR, name, version)
  const packageDir = path.join(versionDir, PACKAGE_SUBDIR)
  const entryPath = path.join(packageDir, entryRel)
  if (fs.existsSync(entryPath)) {
    return packageDir
  }
  fs.mkdirSync(versionDir, { recursive: true })
  const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
  const response = await fetch(tarballUrl)
  if (!response.ok) {
    throw new Error(`fetch ${tarballUrl} failed: ${response.status} ${response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const tarballPath = path.join(os.tmpdir(), `${name}-${version}-${process.pid}.tgz`)
  fs.writeFileSync(tarballPath, buffer)
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', versionDir])
  } finally {
    fs.rmSync(tarballPath, { force: true })
  }
  if (!fs.existsSync(entryPath)) {
    throw new Error(`expected ${entryPath} after extracting ${tarballUrl}`)
  }
  return packageDir
}

async function ensureCdnPackages() {
  const byPrefix = new Map()
  for (const pkg of CDN_PACKAGES) {
    const packageDir = await ensureNpmPackage(pkg)
    byPrefix.set(`${CDN_PREFIX}${pkg.name}@${pkg.version}/`, packageDir)
  }
  return byPrefix
}

function handleStaticRequest(req, res, rootDir) {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1')
  const pathname = decodeURIComponent(parsedUrl.pathname)
  const requestedPath = path.join(rootDir, pathname)
  if (!isPathInside(requestedPath, rootDir)) {
    res.writeHead(403)
    res.end()
    return
  }
  fs.stat(requestedPath, (statErr, stats) => {
    if (statErr) {
      res.writeHead(404)
      res.end()
      return
    }
    const filePath = stats.isDirectory() ? path.join(requestedPath, 'index.html') : requestedPath
    if (!isPathInside(filePath, rootDir)) {
      res.writeHead(403)
      res.end()
      return
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) })
      res.end(data)
    })
  })
}

function startStaticServer(rootDir) {
  const server = http.createServer((req, res) => handleStaticRequest(req, res, rootDir))
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch()
  } catch (err) {
    if (!/executable doesn't exist/i.test(errorMessage(err))) {
      throw err
    }
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  }
}

async function installExternalRouting(context, cdnPackageDirs, ownAbortedUrls) {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    for (const [prefix, packageDir] of cdnPackageDirs) {
      if (!url.startsWith(prefix)) {
        continue
      }
      const relPath = url.slice(prefix.length).split('?')[0]
      const filePath = path.join(packageDir, relPath)
      if (isPathInside(filePath, packageDir) && fs.existsSync(filePath)) {
        await route.fulfill({
          contentType: contentTypeFor(filePath),
          body: fs.readFileSync(filePath),
        })
        return
      }
      ownAbortedUrls.add(url)
      await route.abort()
      return
    }
    if (url.startsWith('http://127.0.0.1:')) {
      await route.continue()
      return
    }
    ownAbortedUrls.add(url)
    await route.abort()
  })
}

async function installPeerGuard(context) {
  await context.addInitScript(() => {
    let implementation
    window.__peerConstructions = 0
    window.__peerAssigned = false
    Object.defineProperty(window, 'Peer', {
      configurable: true,
      get() {
        return implementation
      },
      set(value) {
        window.__peerAssigned = true
        implementation = new Proxy(value, {
          construct(target, args) {
            window.__peerConstructions += 1
            return Reflect.construct(target, args)
          },
        })
      },
    })
  })
}

function attachDiagnostics(page, label, ownAbortedUrls) {
  const consoleErrors = []
  const pageErrors = []
  const requestFailures = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') {
      return
    }
    if (ownAbortedUrls.has(msg.location().url)) {
      return
    }
    consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    pageErrors.push(errorMessage(err))
  })
  page.on('requestfailed', (request) => {
    if (ownAbortedUrls.has(request.url())) {
      return
    }
    const failure = request.failure()
    requestFailures.push(`${request.url()} :: ${failure ? failure.errorText : 'unknown failure'}`)
  })
  return { label, consoleErrors, pageErrors, requestFailures }
}

function diagnosticsProblems(diagnostics) {
  return [
    ...diagnostics.consoleErrors.map((entry) => `${diagnostics.label} console error: ${entry}`),
    ...diagnostics.pageErrors.map((entry) => `${diagnostics.label} page error: ${entry}`),
    ...diagnostics.requestFailures.map((entry) => `${diagnostics.label} request failure: ${entry}`),
  ]
}

function createChecklist() {
  const entries = []
  function record(name, ok, note) {
    const entry = { name, ok, note: note == null ? '' : String(note) }
    entries.push(entry)
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.note === '' ? '' : ` :: ${entry.note}`}`)
  }
  async function run(name, body) {
    try {
      record(name, true, await body())
    } catch (err) {
      record(name, false, errorMessage(err))
      throw err
    }
  }
  function report() {
    const passed = entries.filter((entry) => entry.ok).length
    const lines = ['', `--- hand summary: ${passed}/${entries.length} checks passed ---`]
    for (const entry of entries) {
      if (!entry.ok) {
        lines.push(`failed: ${entry.name} :: ${entry.note}`)
      }
    }
    return lines.join('\n')
  }
  function failed() {
    return entries.length === 0 || entries.some((entry) => !entry.ok)
  }
  return { run, report, failed }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function installHandProbe(page) {
  return page.evaluate(() => {
    const RAD_TO_DEG = 180 / Math.PI
    const MAX_ENTRIES = 6000
    const series = []

    function quaternionNorm(q) {
      return Math.hypot(q.x, q.y, q.z, q.w)
    }

    function angleFromIdentityDeg(q) {
      if (q === null || q === undefined) {
        return null
      }
      const norm = quaternionNorm(q)
      if (!(norm > 0)) {
        return null
      }
      return 2 * Math.acos(Math.min(1, Math.abs(q.w) / norm)) * RAD_TO_DEG
    }

    function sample() {
      const state = window.__throwABall
      if (state && state.hand && series.length < MAX_ENTRIES) {
        const hand = state.hand
        const speedElement = document.querySelector('[data-hand-speed]')
        series.push({
          tMs: performance.now(),
          poseCount: hand.poseCount,
          seq: hand.seq,
          speed: hand.speed,
          appliedNorm: hand.applied ? quaternionNorm(hand.applied) : null,
          appliedAngleDeg: angleFromIdentityDeg(hand.applied),
          targetAngleDeg: angleFromIdentityDeg(hand.target),
          hasQRef: hand.qRef !== null && hand.qRef !== undefined,
          speedText: speedElement === null ? null : speedElement.textContent.trim(),
        })
      }
      requestAnimationFrame(sample)
    }

    window.__handProbe = {
      drain() {
        const copy = series.slice()
        series.length = 0
        return copy
      },
    }
    requestAnimationFrame(sample)
  })
}

async function collectSeries(page, durationMs) {
  await page.evaluate(() => window.__handProbe.drain())
  await page.waitForTimeout(durationMs)
  return page.evaluate(() => window.__handProbe.drain())
}

function summarizeSeries(series) {
  const summary = {
    count: series.length,
    spanMs: series.length < 2 ? 0 : series[series.length - 1].tMs - series[0].tMs,
    poseDelta: series.length < 2 ? 0 : series[series.length - 1].poseCount - series[0].poseCount,
    maxSpeed: 0,
    minSpeed: Number.POSITIVE_INFINITY,
    maxAppliedAngleDeg: 0,
    minAppliedAngleDeg: Number.POSITIVE_INFINITY,
    maxTargetAngleDeg: 0,
    maxNormError: 0,
    qRefSeen: false,
    speedTexts: [],
  }
  const seenTexts = new Set()
  for (const entry of series) {
    if (Number.isFinite(entry.speed)) {
      summary.maxSpeed = Math.max(summary.maxSpeed, entry.speed)
      summary.minSpeed = Math.min(summary.minSpeed, entry.speed)
    }
    if (entry.appliedAngleDeg !== null) {
      summary.maxAppliedAngleDeg = Math.max(summary.maxAppliedAngleDeg, entry.appliedAngleDeg)
      summary.minAppliedAngleDeg = Math.min(summary.minAppliedAngleDeg, entry.appliedAngleDeg)
    }
    if (entry.targetAngleDeg !== null) {
      summary.maxTargetAngleDeg = Math.max(summary.maxTargetAngleDeg, entry.targetAngleDeg)
    }
    if (entry.appliedNorm !== null) {
      summary.maxNormError = Math.max(summary.maxNormError, Math.abs(entry.appliedNorm - 1))
    }
    if (entry.hasQRef) {
      summary.qRefSeen = true
    }
    if (entry.speedText !== null && !seenTexts.has(entry.speedText)) {
      seenTexts.add(entry.speedText)
      summary.speedTexts.push(entry.speedText)
    }
  }
  if (summary.minSpeed === Number.POSITIVE_INFINITY) {
    summary.minSpeed = 0
  }
  if (summary.minAppliedAngleDeg === Number.POSITIVE_INFINITY) {
    summary.minAppliedAngleDeg = 0
  }
  return summary
}

function restSpeedAfterPeak(series) {
  let peakIndex = -1
  let peak = Number.NEGATIVE_INFINITY
  for (let index = 0; index < series.length; index += 1) {
    if (Number.isFinite(series[index].speed) && series[index].speed > peak) {
      peak = series[index].speed
      peakIndex = index
    }
  }
  let rest = Number.POSITIVE_INFINITY
  for (let index = peakIndex + 1; index < series.length; index += 1) {
    if (Number.isFinite(series[index].speed)) {
      rest = Math.min(rest, series[index].speed)
    }
  }
  return { peak: peak === Number.NEGATIVE_INFINITY ? 0 : peak, rest }
}

function countSwingCycles(series, highDeg, lowDeg) {
  let above = false
  let peaks = 0
  let cycles = 0
  for (const entry of series) {
    if (entry.appliedAngleDeg === null) {
      continue
    }
    if (!above && entry.appliedAngleDeg > highDeg) {
      above = true
      peaks += 1
    } else if (above && entry.appliedAngleDeg < lowDeg) {
      above = false
      cycles += 1
    }
  }
  return { peaks, cycles }
}

function poseRateHz(summary) {
  return summary.spanMs <= 0 ? 0 : (summary.poseDelta * 1000) / summary.spanMs
}

async function readHud(page) {
  return page.evaluate(() => {
    const status = document.querySelector('[data-status]')
    const detail = document.querySelector('[data-status-detail]')
    const speed = document.querySelector('[data-hand-speed]')
    const pairing = document.getElementById('pairing')
    return {
      state: status === null ? null : status.dataset.state,
      text: status === null ? null : status.textContent.trim(),
      detail: detail === null ? null : detail.textContent.trim(),
      handSpeed: speed === null ? null : speed.textContent.trim(),
      pairingHidden: pairing === null ? null : pairing.classList.contains('hidden'),
    }
  })
}

async function armAngleDeg(page) {
  return page.evaluate(() => {
    const q = window.__throwABall.hand.applied
    const norm = Math.hypot(q.x, q.y, q.z, q.w)
    if (!(norm > 0)) {
      return 0
    }
    return 2 * Math.acos(Math.min(1, Math.abs(q.w) / norm)) * (180 / Math.PI)
  })
}

async function openMode(browser, { baseUrl, query, label, cdnPackageDirs, recordDir }) {
  const abortedUrls = new Set()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: recordDir === null ? undefined : { dir: recordDir, size: VIEWPORT },
  })
  const page = await context.newPage()
  const diagnostics = attachDiagnostics(page, label, abortedUrls)
  await installExternalRouting(context, cdnPackageDirs, abortedUrls)
  await installPeerGuard(context)
  await page.goto(`${baseUrl}/?${query}`, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
  await page.waitForFunction(
    () => window.__throwABall != null && window.__throwABall.hand != null,
    undefined,
    { timeout: READY_TIMEOUT_MS }
  )
  await installHandProbe(page)
  return { context, page, diagnostics }
}

async function closeMode(mode, recording) {
  const videoPath = recording ? await mode.page.video().path() : null
  await mode.context.close()
  return videoPath
}

function ffprobeVideo(filePath) {
  const raw = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      filePath,
    ],
    { encoding: 'utf8' }
  )
  const parsed = JSON.parse(raw)
  const streams = parsed.streams || []
  const videoStream = streams.find((stream) => stream.codec_type === 'video') || null
  const duration = parsed.format && parsed.format.duration ? Number(parsed.format.duration) : 0
  return { videoStream, duration }
}

function encodeHandVideo(segmentPaths, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const args = ['-y']
  for (const segment of segmentPaths) {
    args.push('-i', segment)
  }
  const scaled = segmentPaths.map(
    (_, index) => `[${index}:v]scale=-2:${ENCODED_HEIGHT},fps=${ENCODED_FPS},setsar=1[v${index}]`
  )
  const chained = segmentPaths.map((_, index) => `[v${index}]`).join('')
  args.push(
    '-filter_complex',
    `${scaled.join(';')};${chained}concat=n=${segmentPaths.length}:v=1:a=0[out]`,
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(ENCODED_FPS),
    '-movflags',
    '+faststart',
    outPath
  )
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
}

function parseArgs(argv) {
  const videoIndex = argv.indexOf('--video')
  if (videoIndex === -1) {
    return { videoOutPath: null }
  }
  const value = argv[videoIndex + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--video needs an output path, e.g. --video test/out/m3-hand.mp4')
  }
  return { videoOutPath: path.resolve(process.cwd(), value) }
}

async function runScripted(checks, mode, recording) {
  const { page } = mode

  await checks.run('scripted mode boots without pairing', async () => {
    await page.waitForFunction(() => window.__throwABall.hand.poseCount > 0, undefined, {
      timeout: POSE_TIMEOUT_MS,
    })
    const state = await page.evaluate(() => ({
      mode: window.__throwABall.hand.mode,
      peerId: window.__throwABall.pairing.peerId,
      peerConstructions: window.__peerConstructions,
      peerAssigned: window.__peerAssigned,
    }))
    assertTrue(state.mode === 'scripted', `hand.mode is "${state.mode}", expected "scripted"`)
    assertTrue(state.peerId === null, `pairing.peerId is ${JSON.stringify(state.peerId)}, expected null`)
    assertTrue(
      state.peerConstructions === 0,
      `PeerJS was constructed ${state.peerConstructions} times for a local input mode`
    )
    return `peer script ${state.peerAssigned ? 'loaded' : 'not assigned'}, 0 Peer constructions`
  })

  await checks.run('scripted HUD reports the input mode', async () => {
    const hud = await readHud(page)
    assertTrue(hud.state === 'connected', `[data-status] state is "${hud.state}", expected connected`)
    assertTrue(
      hud.detail === 'input: scripted',
      `[data-status-detail] is "${hud.detail}", expected "input: scripted"`
    )
    assertTrue(hud.pairingHidden === true, '#pairing is still visible in scripted mode')
    return `"${hud.text}" / "${hud.detail}"`
  })

  if (recording) {
    await page.waitForTimeout(VIDEO_SCRIPTED_INTRO_MS)
  }
  await page.waitForTimeout(SCRIPTED_WARMUP_MS)

  const swingSeries = await collectSeries(page, SCRIPTED_OBSERVE_MS)
  const swingSummary = summarizeSeries(swingSeries)
  const cycles = countSwingCycles(swingSeries, SWING_HIGH_ANGLE_DEG, SWING_LOW_ANGLE_DEG)

  await checks.run('scripted poses stream at about 60 Hz', async () => {
    const rateHz = poseRateHz(swingSummary)
    assertTrue(
      rateHz >= MIN_SCRIPTED_POSE_RATE_HZ,
      `scripted pose rate is ${rateHz.toFixed(1)} Hz, expected at least ${MIN_SCRIPTED_POSE_RATE_HZ}`
    )
    assertTrue(
      swingSummary.maxNormError <= QUATERNION_NORM_TOLERANCE,
      `applied quaternion norm drifted by ${swingSummary.maxNormError}`
    )
    return `${swingSummary.poseDelta} poses in ${(swingSummary.spanMs / 1000).toFixed(2)}s = ${rateHz.toFixed(1)} Hz`
  })

  await checks.run('scripted arm swings past 60 deg and returns below 15 deg', async () => {
    assertTrue(
      cycles.peaks >= MIN_SWING_PEAKS,
      `arm crossed ${SWING_HIGH_ANGLE_DEG} deg only ${cycles.peaks} times, expected at least ${MIN_SWING_PEAKS}`
    )
    assertTrue(
      cycles.cycles >= MIN_SWING_CYCLES,
      `arm completed ${cycles.cycles} swing cycles, expected at least ${MIN_SWING_CYCLES}`
    )
    assertTrue(
      swingSummary.minAppliedAngleDeg < SWING_LOW_ANGLE_DEG,
      `arm never returned below ${SWING_LOW_ANGLE_DEG} deg (min ${swingSummary.minAppliedAngleDeg.toFixed(1)})`
    )
    return `${cycles.cycles} cycles, angle ${swingSummary.minAppliedAngleDeg.toFixed(1)}..${swingSummary.maxAppliedAngleDeg.toFixed(1)} deg`
  })

  await checks.run('scripted HUD hand-speed keeps updating', async () => {
    assertTrue(
      swingSummary.speedTexts.length >= MIN_DISTINCT_SPEED_TEXTS,
      `[data-hand-speed] showed ${swingSummary.speedTexts.length} distinct values, expected at least ${MIN_DISTINCT_SPEED_TEXTS}`
    )
    assertTrue(
      swingSummary.speedTexts.every((text) => /^-?\d+\.\d m\/s$/.test(text)),
      `[data-hand-speed] format is off: ${JSON.stringify(swingSummary.speedTexts.slice(0, 4))}`
    )
    return `${swingSummary.speedTexts.length} distinct values, peak speed ${swingSummary.maxSpeed.toFixed(2)} m/s`
  })

  await page.screenshot({ path: path.join(OUT_DIR, 'hand-scripted.png') })

  let dragNote = ''
  await checks.run('mouse drag steers the arm while held', async () => {
    await page.mouse.move(DRAG_START.x, DRAG_START.y)
    await page.mouse.down()
    await page.mouse.move(DRAG_HOLD.x, DRAG_HOLD.y, { steps: DRAG_STEPS })
    await page.waitForTimeout(DRAG_SETTLE_MS)
    const held = await armAngleDeg(page)
    await page.waitForTimeout(DRAG_HOLD_MS)
    const stillHeld = await armAngleDeg(page)
    assertTrue(
      held > MIN_DRAG_ANGLE_DEG,
      `dragged arm angle is ${held.toFixed(1)} deg, expected above ${MIN_DRAG_ANGLE_DEG}`
    )
    assertTrue(
      Math.abs(stillHeld - held) < MAX_DRAG_HOLD_DRIFT_DEG,
      `arm drifted ${Math.abs(stillHeld - held).toFixed(1)} deg while the pointer was held still — the swing loop did not pause`
    )
    await page.screenshot({ path: path.join(OUT_DIR, 'hand-drag.png') })
    await page.mouse.move(DRAG_SECOND.x, DRAG_SECOND.y, { steps: DRAG_STEPS })
    await page.waitForTimeout(DRAG_SETTLE_MS)
    const moved = await armAngleDeg(page)
    assertTrue(
      Math.abs(moved - held) > MIN_DRAG_MOVE_DELTA_DEG,
      `arm moved only ${Math.abs(moved - held).toFixed(1)} deg when the pointer moved`
    )
    dragNote = `held ${held.toFixed(1)} deg (drift ${Math.abs(stillHeld - held).toFixed(2)}), moved to ${moved.toFixed(1)} deg`
    return dragNote
  })

  await checks.run('swing resumes about a second after release', async () => {
    await page.mouse.up()
    await page.waitForTimeout(DRAG_RELEASE_WAIT_MS)
    const resumedSeries = await collectSeries(page, SCRIPTED_RESUME_OBSERVE_MS)
    const resumed = summarizeSeries(resumedSeries)
    const spanDeg = resumed.maxAppliedAngleDeg - resumed.minAppliedAngleDeg
    assertTrue(
      spanDeg > MIN_RESUMED_ANGLE_SPAN_DEG,
      `arm angle only spanned ${spanDeg.toFixed(1)} deg after release, expected above ${MIN_RESUMED_ANGLE_SPAN_DEG}`
    )
    assertTrue(
      poseRateHz(resumed) >= MIN_SCRIPTED_POSE_RATE_HZ,
      `pose rate after release is ${poseRateHz(resumed).toFixed(1)} Hz`
    )
    return `angle span ${spanDeg.toFixed(1)} deg over ${(resumed.spanMs / 1000).toFixed(2)}s`
  })

  if (recording) {
    await page.waitForTimeout(VIDEO_SCRIPTED_TAIL_MS)
  }

  await checks.run('scripted page stayed error free', async () => {
    const problems = diagnosticsProblems(mode.diagnostics)
    assertTrue(problems.length === 0, problems.join(' | '))
    return 'clean'
  })
}

async function runReplay(checks, mode, recording) {
  const { page } = mode

  await checks.run('replay mode syncs from the fixture trace', async () => {
    await page.waitForFunction(
      () => window.__throwABall.hand.poseCount > 0 && window.__throwABall.hand.qRef !== null,
      undefined,
      { timeout: POSE_TIMEOUT_MS }
    )
    const state = await page.evaluate(() => ({
      mode: window.__throwABall.hand.mode,
      qRef: window.__throwABall.hand.qRef,
      peerConstructions: window.__peerConstructions,
      peerId: window.__throwABall.pairing.peerId,
    }))
    assertTrue(state.mode === 'replay', `hand.mode is "${state.mode}", expected "replay"`)
    assertTrue(state.qRef !== null, 'hand.qRef is still null — the replay never emitted a sync')
    assertTrue(state.peerId === null, 'pairing.peerId is set in replay mode')
    assertTrue(
      state.peerConstructions === 0,
      `PeerJS was constructed ${state.peerConstructions} times in replay mode`
    )
    return `qRef ${JSON.stringify(state.qRef).slice(0, 60)}`
  })

  await checks.run('replay HUD reports the trace', async () => {
    const hud = await readHud(page)
    assertTrue(hud.state === 'connected', `[data-status] state is "${hud.state}", expected connected`)
    assertTrue(
      hud.detail === `input: replay (${TRACE_NAME})`,
      `[data-status-detail] is "${hud.detail}", expected "input: replay (${TRACE_NAME})"`
    )
    assertTrue(hud.pairingHidden === true, '#pairing is still visible in replay mode')
    return `"${hud.detail}"`
  })

  await page.waitForTimeout(REPLAY_WARMUP_MS)
  const series = await collectSeries(page, REPLAY_OBSERVE_MS)
  const summary = summarizeSeries(series)
  const speeds = restSpeedAfterPeak(series)

  await checks.run('replay poses keep flowing', async () => {
    const poseCount = await page.evaluate(() => window.__throwABall.hand.poseCount)
    assertTrue(
      poseCount > MIN_REPLAY_POSE_COUNT,
      `poseCount is ${poseCount}, expected above ${MIN_REPLAY_POSE_COUNT}`
    )
    assertTrue(
      summary.maxNormError <= QUATERNION_NORM_TOLERANCE,
      `applied quaternion norm drifted by ${summary.maxNormError}`
    )
    assertTrue(
      summary.maxAppliedAngleDeg - summary.minAppliedAngleDeg > 1,
      'applied quaternion never changed during replay'
    )
    return `${poseCount} poses, ${poseRateHz(summary).toFixed(1)} Hz, norm error ${summary.maxNormError.toExponential(2)}`
  })

  await checks.run('replay speed peaks during the swing and rests after', async () => {
    assertTrue(
      speeds.peak >= MIN_REPLAY_PEAK_SPEED,
      `peak hand speed is ${speeds.peak.toFixed(2)} m/s, expected at least ${MIN_REPLAY_PEAK_SPEED}`
    )
    assertTrue(
      speeds.rest < MAX_REPLAY_REST_SPEED,
      `hand speed after the peak bottomed out at ${speeds.rest.toFixed(3)} m/s, expected below ${MAX_REPLAY_REST_SPEED}`
    )
    return `peak ${speeds.peak.toFixed(2)} m/s, rest ${speeds.rest.toFixed(3)} m/s`
  })

  await checks.run('replay drives the arm well away from neutral', async () => {
    assertTrue(
      summary.maxTargetAngleDeg > MIN_REPLAY_TARGET_ANGLE_DEG,
      `target angle peaked at ${summary.maxTargetAngleDeg.toFixed(1)} deg, expected above ${MIN_REPLAY_TARGET_ANGLE_DEG}`
    )
    assertTrue(
      summary.maxAppliedAngleDeg > MIN_REPLAY_APPLIED_ANGLE_DEG,
      `applied angle peaked at ${summary.maxAppliedAngleDeg.toFixed(1)} deg, expected above ${MIN_REPLAY_APPLIED_ANGLE_DEG}`
    )
    return `target ${summary.maxTargetAngleDeg.toFixed(1)} deg, applied ${summary.minAppliedAngleDeg.toFixed(1)}..${summary.maxAppliedAngleDeg.toFixed(1)} deg`
  })

  await checks.run('replay HUD hand-speed keeps updating', async () => {
    assertTrue(
      summary.speedTexts.length >= MIN_DISTINCT_SPEED_TEXTS,
      `[data-hand-speed] showed ${summary.speedTexts.length} distinct values`
    )
    return `${summary.speedTexts.length} distinct values`
  })

  await page.screenshot({ path: path.join(OUT_DIR, 'hand-replay.png') })

  if (recording) {
    await page.waitForTimeout(VIDEO_REPLAY_TAIL_MS)
  }

  await checks.run('replay page stayed error free', async () => {
    const problems = diagnosticsProblems(mode.diagnostics)
    assertTrue(problems.length === 0, problems.join(' | '))
    return 'clean'
  })
}

async function runHand({ videoOutPath }) {
  const recording = videoOutPath !== null
  const checks = createChecklist()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (recording) {
    fs.rmSync(VIDEO_ROOT, { recursive: true, force: true })
  }

  const { chromium } = resolvePlaywright()
  const cdnPackageDirs = await ensureCdnPackages()
  const staticServer = await startStaticServer(REPO_ROOT)
  const baseUrl = `http://127.0.0.1:${staticServer.address().port}`

  let browser = null
  let scripted = null
  let replay = null
  const segments = []

  try {
    browser = await launchBrowser(chromium)

    scripted = await openMode(browser, {
      baseUrl,
      query: 'input=scripted',
      label: 'scripted',
      cdnPackageDirs,
      recordDir: recording ? path.join(VIDEO_ROOT, 'scripted') : null,
    })
    await runScripted(checks, scripted, recording)
    const scriptedVideo = await closeMode(scripted, recording)
    scripted = null
    if (scriptedVideo !== null) {
      segments.push(scriptedVideo)
    }

    replay = await openMode(browser, {
      baseUrl,
      query: `input=replay&trace=${TRACE_NAME}`,
      label: 'replay',
      cdnPackageDirs,
      recordDir: recording ? path.join(VIDEO_ROOT, 'replay') : null,
    })
    await runReplay(checks, replay, recording)
    const replayVideo = await closeMode(replay, recording)
    replay = null
    if (replayVideo !== null) {
      segments.push(replayVideo)
    }

    if (recording) {
      await checks.run('hand demo video encoded', async () => {
        assertTrue(segments.length === 2, `expected 2 recorded segments, got ${segments.length}`)
        encodeHandVideo(segments, videoOutPath)
        assertTrue(fs.existsSync(videoOutPath), `${videoOutPath} was not written`)
        const probe = ffprobeVideo(videoOutPath)
        assertTrue(probe.videoStream !== null, 'ffprobe found no video stream in the output')
        assertTrue(
          probe.videoStream.codec_name === 'h264',
          `video codec is ${probe.videoStream.codec_name}, expected h264`
        )
        assertTrue(
          probe.duration >= MIN_VIDEO_SECONDS,
          `video duration ${probe.duration.toFixed(2)}s is shorter than ${MIN_VIDEO_SECONDS}s`
        )
        return `${probe.videoStream.codec_name} ${probe.videoStream.width}x${probe.videoStream.height}, ${probe.duration.toFixed(2)}s`
      })
      console.log(`\nvideo: ${videoOutPath}`)
    }
  } finally {
    for (const mode of [scripted, replay]) {
      if (mode !== null) {
        await mode.context.close().catch(() => {})
      }
    }
    if (browser !== null) {
      await browser.close().catch(() => {})
    }
    await new Promise((resolve) => staticServer.close(resolve))
    console.log(checks.report())
    console.log(`screenshots: ${OUT_DIR}`)
  }

  return checks.failed() ? 1 : 0
}

function flushOutput() {
  return new Promise((resolve) => {
    process.stdout.write('', () => process.stderr.write('', () => resolve()))
  })
}

async function main() {
  let timeoutHandle
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`e2e-hand exceeded ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    )
  })
  try {
    const options = parseArgs(process.argv.slice(2))
    const exitCode = await Promise.race([runHand(options), timeout])
    process.exitCode = exitCode
    console.log(exitCode === 0 ? '\ne2e-hand: PASS' : '\ne2e-hand: FAIL')
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err))
    console.log('\ne2e-hand: FAIL')
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
  await flushOutput()
  process.exit(process.exitCode)
}

main()
