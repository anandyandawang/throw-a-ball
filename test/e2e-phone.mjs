#!/usr/bin/env node
import { createRequire } from 'node:module'
import { execSync, execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(HERE)
const OUT_DIR = path.join(HERE, 'out')
const CACHE_DIR = path.join(HERE, '.cache')
const VIDEO_DIR = path.join(OUT_DIR, 'video-phone')

const CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/'
const CDN_PACKAGES = Object.freeze([
  { name: 'three', version: '0.185.1' },
  { name: 'peerjs', version: '1.5.5' },
  { name: 'qrcodejs', version: '1.0.0' },
])
const PACKAGE_SUBDIR = 'package'

const PEER_SERVER_PACKAGE = 'peer'
const PEER_SERVER_VERSION = '1.0.2'
const PEER_SERVER_PREFIX = path.join(CACHE_DIR, 'peer-server')
const PEER_SERVER_HOST = '127.0.0.1'
const PEER_SERVER_PATH = '/'
const PEER_SERVER_PORT_MIN = 20000
const PEER_SERVER_PORT_SPAN = 25000
const PEER_SERVER_BIND_ATTEMPTS = 12
const PEER_SERVER_READY_TIMEOUT_MS = 15000
const PEER_SERVER_POLL_MS = 150

const DESKTOP_VIEWPORT = { width: 1280, height: 720 }
const PHONE_VIEWPORT = { width: 390, height: 844 }
const PHONE_SCALE_FACTOR = 2

const OVERALL_TIMEOUT_MS = 240000
const GOTO_TIMEOUT_MS = 30000
const DESKTOP_READY_TIMEOUT_MS = 45000
const CONNECT_TIMEOUT_MS = 60000
const SCREEN_TIMEOUT_MS = 15000
const STREAM_TIMEOUT_MS = 15000
const SYNC_TIMEOUT_MS = 10000
const SWING_TIMEOUT_MS = 15000
const SETTLE_TIMEOUT_MS = 10000
const POLL_INTERVAL_MS = 100

const SIM_INTERVAL_MS = 16
const GRAVITY_M_S2 = 9.81
const SWING_RATE_AMPLITUDE_DEG_PER_S = 360
const SWING_CYCLE_MS = 1200

const AccelConvention = Object.freeze({ SPEC: 1, INVERTED: -1 })

const SYNC_HINT_DETAIL = 'phone streaming — tap sync on the phone to move the arm'
const CONNECTED_DETAIL = 'phone connected — latency is live'
const WRONG_HOLD_NOTE = 'hold it upside-down at your side and re-sync'
const SYNCED_NOTE = 'synced — arm reference stored'

const NEUTRAL_ARM_MAX_DEG = 5
const SWING_ARM_MIN_DEG = 30
const SWING_SPEED_MIN_M_S = 0.3
const SETTLED_ARM_MAX_DEG = 15

const VIDEO_PRE_SYNC_HOLD_MS = 2500
const VIDEO_SWING_HOLD_MS = 6000
const VIDEO_TAIL_HOLD_MS = 1500
const COMPOSED_HEIGHT = 720
const COMPOSED_FPS = 30
const MIN_VIDEO_SECONDS = 10

const WEBRTC_LAUNCH_ARGS = Object.freeze([
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--force-webrtc-ip-handling-policy=default',
])

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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

async function ensureNpmPackage(name, version) {
  const versionDir = path.join(CACHE_DIR, name, version)
  const packageDir = path.join(versionDir, PACKAGE_SUBDIR)
  const manifestPath = path.join(packageDir, 'package.json')
  if (fs.existsSync(manifestPath)) {
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
  return packageDir
}

async function ensureCdnPackages() {
  const byPrefix = new Map()
  for (const { name, version } of CDN_PACKAGES) {
    const packageDir = await ensureNpmPackage(name, version)
    byPrefix.set(`${CDN_PREFIX}${name}@${version}/`, packageDir)
  }
  return byPrefix
}

function resolvePeerServerModule() {
  const modulePath = path.join(PEER_SERVER_PREFIX, 'node_modules', PEER_SERVER_PACKAGE)
  const manifestPath = path.join(modulePath, 'package.json')
  const installed =
    fs.existsSync(manifestPath) &&
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version === PEER_SERVER_VERSION
  if (!installed) {
    fs.mkdirSync(PEER_SERVER_PREFIX, { recursive: true })
    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        PEER_SERVER_PREFIX,
        '--no-audit',
        '--no-fund',
        `${PEER_SERVER_PACKAGE}@${PEER_SERVER_VERSION}`,
      ],
      { stdio: 'pipe' }
    )
  }
  const require = createRequire(path.join(PEER_SERVER_PREFIX, 'e2e-phone-resolver.cjs'))
  return require.resolve(PEER_SERVER_PACKAGE)
}

function randomHighPort() {
  return PEER_SERVER_PORT_MIN + Math.floor(Math.random() * PEER_SERVER_PORT_SPAN)
}

function probePortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, PEER_SERVER_HOST, () => {
      probe.close(() => resolve(true))
    })
  })
}

async function waitForPeerServerReady(child, port) {
  const deadline = Date.now() + PEER_SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false
    }
    try {
      const response = await fetch(`http://${PEER_SERVER_HOST}:${port}/`)
      if (response.ok) {
        await response.arrayBuffer()
        return true
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, PEER_SERVER_POLL_MS))
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, PEER_SERVER_POLL_MS))
  }
  return false
}

const livePeerServers = new Set()

function killLivePeerServers() {
  for (const child of livePeerServers) {
    child.kill('SIGKILL')
  }
  livePeerServers.clear()
}

process.on('exit', killLivePeerServers)
process.on('SIGINT', () => {
  killLivePeerServers()
  process.exit(130)
})
process.on('SIGTERM', () => {
  killLivePeerServers()
  process.exit(143)
})

function spawnPeerServer(peerModulePath, port) {
  const source = [
    `const { PeerServer } = require(${JSON.stringify(peerModulePath)})`,
    `PeerServer({ port: ${port}, host: ${JSON.stringify(PEER_SERVER_HOST)}, path: ${JSON.stringify(PEER_SERVER_PATH)} })`,
  ].join('\n')
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  livePeerServers.add(child)
  child.once('exit', () => livePeerServers.delete(child))
  return child
}

async function startPeerServer(peerModulePath) {
  for (let attempt = 0; attempt < PEER_SERVER_BIND_ATTEMPTS; attempt += 1) {
    const port = randomHighPort()
    if (!(await probePortFree(port))) {
      continue
    }
    const child = spawnPeerServer(peerModulePath, port)
    if (await waitForPeerServerReady(child, port)) {
      return { child, port }
    }
    child.kill('SIGKILL')
  }
  throw new Error(`no usable port for the peer server after ${PEER_SERVER_BIND_ATTEMPTS} attempts`)
}

function stopPeerServer(child) {
  return new Promise((resolve) => {
    if (child == null || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
  const options = { args: [...WEBRTC_LAUNCH_ARGS] }
  try {
    return await chromium.launch(options)
  } catch (err) {
    if (!/executable doesn't exist/i.test(errorMessage(err))) {
      throw err
    }
    return chromium.launch({ ...options, executablePath: '/opt/pw-browsers/chromium' })
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
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('ws://127.0.0.1:')) {
      await route.continue()
      return
    }
    ownAbortedUrls.add(url)
    await route.abort()
  })
}

function attachDiagnostics(page, label, ownAbortedUrls) {
  const consoleErrors = []
  const pageErrors = []
  const requestFailures = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
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
  if (diagnostics === null) {
    return []
  }
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
    const lines = ['', `--- phone summary: ${passed}/${entries.length} checks passed ---`]
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

async function pollUntil(evaluate, timeoutMs, describeFailure) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await evaluate()
    if (last && last.ok) {
      return last
    }
    if (Date.now() >= deadline) {
      throw new Error(`${describeFailure} after ${timeoutMs}ms :: ${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
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

function composeSideBySide(desktopVideoPath, phoneVideoPath, outPath, leadSeconds) {
  const phoneLead =
    leadSeconds > 0.05 ? `,tpad=start_duration=${leadSeconds.toFixed(3)}:start_mode=add:color=black` : ''
  const filter = [
    `[0:v]scale=-2:${COMPOSED_HEIGHT},fps=${COMPOSED_FPS},setsar=1[desktop]`,
    `[1:v]scale=-2:${COMPOSED_HEIGHT},fps=${COMPOSED_FPS},setsar=1${phoneLead}[phone]`,
    '[desktop][phone]hstack=inputs=2[out]',
  ].join(';')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      desktopVideoPath,
      '-i',
      phoneVideoPath,
      '-filter_complex',
      filter,
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
      String(COMPOSED_FPS),
      '-movflags',
      '+faststart',
      outPath,
    ],
    { stdio: 'pipe' }
  )
}

function parseArgs(argv) {
  const videoIndex = argv.indexOf('--video')
  if (videoIndex === -1) {
    return { videoOutPath: null }
  }
  const value = argv[videoIndex + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--video needs an output path, e.g. --video test/out/m3-phone.mp4')
  }
  return { videoOutPath: path.resolve(process.cwd(), value) }
}

function installPhoneSim(page, accelConvention) {
  return page.evaluate(
    ({ convention, intervalMs, gravity, rateAmplitudeDegPerS, cycleMs }) => {
      const SimPhase = Object.freeze({ REST: 'rest', FLAT: 'flat', SWING: 'swing' })
      let phase = SimPhase.REST
      let thetaDeg = 0
      let last = performance.now()
      let swingStartedAt = 0

      function emit() {
        const now = performance.now()
        const dtSeconds = (now - last) / 1000
        last = now
        let rateDegPerS = 0
        if (phase === SimPhase.SWING) {
          const seconds = (now - swingStartedAt) / 1000
          rateDegPerS = rateAmplitudeDegPerS * Math.sin((2 * Math.PI * seconds * 1000) / cycleMs)
          thetaDeg += rateDegPerS * dtSeconds
        } else {
          thetaDeg = 0
        }
        const theta = (thetaDeg * Math.PI) / 180
        const upDevice =
          phase === SimPhase.FLAT
            ? { x: 0, y: 0, z: 1 }
            : { x: Math.sin(theta), y: -Math.cos(theta), z: 0 }
        const reading = {
          x: convention * gravity * upDevice.x,
          y: convention * gravity * upDevice.y,
          z: convention * gravity * upDevice.z,
        }
        window.dispatchEvent(
          new DeviceOrientationEvent('deviceorientation', {
            alpha: ((thetaDeg % 360) + 360) % 360,
            beta: -90,
            gamma: 0,
            absolute: false,
          })
        )
        window.dispatchEvent(
          new DeviceMotionEvent('devicemotion', {
            rotationRate: { alpha: -rateDegPerS, beta: 0, gamma: 0 },
            accelerationIncludingGravity: reading,
            acceleration: { x: 0, y: 0, z: 0 },
            interval: intervalMs,
          })
        )
      }

      window.__phoneSim = {
        setPhase(next) {
          if (next === SimPhase.SWING && phase !== SimPhase.SWING) {
            swingStartedAt = performance.now()
          }
          phase = next
        },
        get phase() {
          return phase
        },
      }
      setInterval(emit, intervalMs)
    },
    {
      convention: accelConvention,
      intervalMs: SIM_INTERVAL_MS,
      gravity: GRAVITY_M_S2,
      rateAmplitudeDegPerS: SWING_RATE_AMPLITUDE_DEG_PER_S,
      cycleMs: SWING_CYCLE_MS,
    }
  )
}

async function openPhone(browser, cdnPackageDirs, phoneLink, accelConvention, recording) {
  const abortedUrls = new Set()
  const context = await browser.newContext({
    viewport: PHONE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: PHONE_SCALE_FACTOR,
    recordVideo: recording ? { dir: VIDEO_DIR, size: PHONE_VIEWPORT } : undefined,
  })
  const page = await context.newPage()
  const diagnostics = attachDiagnostics(page, `phone(${accelConvention})`, abortedUrls)
  await installExternalRouting(context, cdnPackageDirs, abortedUrls)
  await page.goto(phoneLink, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
  await page.waitForFunction(() => window.__phone && window.__phone.state === 'connected', undefined, {
    timeout: CONNECT_TIMEOUT_MS,
  })
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = function () {
      return Promise.resolve()
    }
    window.DeviceMotionEvent.requestPermission = () => Promise.resolve('granted')
    window.DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted')
  })
  await page.click('#start-sensors')
  await page.waitForFunction(() => window.__phoneSensors.screen === 'safety', undefined, {
    timeout: SCREEN_TIMEOUT_MS,
  })
  await page.click('#begin-capture')
  await page.waitForFunction(() => window.__phoneSensors.screen === 'capture', undefined, {
    timeout: SCREEN_TIMEOUT_MS,
  })
  await installPhoneSim(page, accelConvention)
  return { context, page, diagnostics }
}

async function desktopHand(desktop) {
  return desktop.evaluate(() => {
    const hand = window.__throwABall.hand
    const applied = window.__throwABall.armRig.group.quaternion
    const armAngleDeg = (2 * Math.acos(Math.min(1, Math.abs(applied.w))) * 180) / Math.PI
    const detailElement = document.querySelector('[data-status-detail]')
    return {
      poseCount: hand.poseCount,
      seq: hand.seq,
      speed: hand.speed,
      qRef: hand.qRef,
      armAngleDeg,
      statusDetail: detailElement === null ? '' : detailElement.textContent.trim(),
    }
  })
}

async function syncNote(phone) {
  return phone.evaluate(() => document.querySelector('[data-sync-note]').textContent.trim())
}

async function runPhone({ videoOutPath }) {
  const recording = videoOutPath !== null
  const checks = createChecklist()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (recording) {
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
    fs.mkdirSync(VIDEO_DIR, { recursive: true })
  }

  const { chromium } = resolvePlaywright()
  const cdnPackageDirs = await ensureCdnPackages()
  const peerModulePath = resolvePeerServerModule()
  const staticServer = await startStaticServer(REPO_ROOT)
  const staticBase = `http://127.0.0.1:${staticServer.address().port}`
  const peerServer = await startPeerServer(peerModulePath)

  let browser = null
  let desktopContext = null
  let phoneA = null
  let phoneB = null
  let desktopDiagnostics = null
  let desktopRecordingStartedAt = null
  let phoneRecordingLeadSeconds = 0

  try {
    browser = await launchBrowser(chromium)

    const desktopAborted = new Set()
    desktopContext = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      recordVideo: recording ? { dir: VIDEO_DIR, size: DESKTOP_VIEWPORT } : undefined,
    })
    const desktop = await desktopContext.newPage()
    desktopDiagnostics = attachDiagnostics(desktop, 'desktop', desktopAborted)
    await installExternalRouting(desktopContext, cdnPackageDirs, desktopAborted)
    desktopRecordingStartedAt = Date.now()

    let phoneLink = null

    await checks.run('desktop boots into phone input mode', async () => {
      const desktopUrl = `${staticBase}/?host=${PEER_SERVER_HOST}&port=${peerServer.port}&path=${encodeURIComponent(PEER_SERVER_PATH)}&insecure=1`
      await desktop.goto(desktopUrl, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
      await desktop.waitForFunction(
        () => window.__throwABall && window.__throwABall.pairing.phoneLink !== null,
        undefined,
        { timeout: DESKTOP_READY_TIMEOUT_MS }
      )
      const mode = await desktop.evaluate(() => window.__throwABall.hand.mode)
      assertTrue(mode === 'phone', `hand.mode is "${mode}", expected phone`)
      phoneLink = await desktop.evaluate(() => window.__throwABall.pairing.phoneLink)
      return phoneLink
    })

    await checks.run('a spec-sign phone pairs and streams poses', async () => {
      phoneA = await openPhone(browser, cdnPackageDirs, phoneLink, AccelConvention.SPEC, recording)
      phoneRecordingLeadSeconds = (Date.now() - desktopRecordingStartedAt) / 1000
      const result = await pollUntil(
        async () => {
          const phoneSeq = await phoneA.page.evaluate(() => window.__phoneSensors.poseSeq)
          const hand = await desktopHand(desktop)
          return { ok: phoneSeq > 30 && hand.poseCount > 30, phoneSeq, poseCount: hand.poseCount }
        },
        STREAM_TIMEOUT_MS,
        'pose packets never reached the desktop'
      )
      return `phone seq ${result.phoneSeq}, desktop poses ${result.poseCount}`
    })

    await checks.run('the arm stays neutral and the desktop hints at sync', async () => {
      const result = await pollUntil(
        async () => {
          const hand = await desktopHand(desktop)
          return {
            ok: hand.qRef === null && hand.statusDetail === SYNC_HINT_DETAIL,
            qRef: hand.qRef,
            statusDetail: hand.statusDetail,
            armAngleDeg: hand.armAngleDeg,
          }
        },
        SYNC_TIMEOUT_MS,
        'desktop never showed the sync hint'
      )
      assertTrue(
        result.armAngleDeg < NEUTRAL_ARM_MAX_DEG,
        `arm moved ${result.armAngleDeg.toFixed(1)} deg before any sync`
      )
      return `"${result.statusDetail}", arm ${result.armAngleDeg.toFixed(2)} deg`
    })

    if (recording) {
      await desktop.waitForTimeout(VIDEO_PRE_SYNC_HOLD_MS)
    }

    await checks.run('a flat hold is rejected by the gravity check', async () => {
      await phoneA.page.evaluate(() => window.__phoneSim.setPhase('flat'))
      await phoneA.page.waitForTimeout(600)
      await phoneA.page.click('#sync-hold')
      const note = await syncNote(phoneA.page)
      assertTrue(note === WRONG_HOLD_NOTE, `sync note is "${note}", expected "${WRONG_HOLD_NOTE}"`)
      return `"${note}"`
    })

    await checks.run('the canonical hold syncs and reaches the desktop', async () => {
      await phoneA.page.evaluate(() => window.__phoneSim.setPhase('rest'))
      await phoneA.page.waitForTimeout(1500)
      await phoneA.page.click('#sync-hold')
      const note = await syncNote(phoneA.page)
      assertTrue(note === SYNCED_NOTE, `sync note is "${note}", expected "${SYNCED_NOTE}"`)
      const result = await pollUntil(
        async () => {
          const hand = await desktopHand(desktop)
          return {
            ok: hand.qRef !== null && hand.statusDetail === CONNECTED_DETAIL,
            qRef: hand.qRef,
            statusDetail: hand.statusDetail,
          }
        },
        SYNC_TIMEOUT_MS,
        'the sync reference never reached the desktop'
      )
      return `qRef {${result.qRef.x.toFixed(3)}, ${result.qRef.y.toFixed(3)}, ${result.qRef.z.toFixed(3)}, ${result.qRef.w.toFixed(3)}}, detail "${result.statusDetail}"`
    })

    await checks.run('swinging the phone swings the desktop arm', async () => {
      await phoneA.page.evaluate(() => window.__phoneSim.setPhase('swing'))
      const result = await pollUntil(
        async () => {
          const hand = await desktopHand(desktop)
          return {
            ok: hand.armAngleDeg > SWING_ARM_MIN_DEG && hand.speed > SWING_SPEED_MIN_M_S,
            armAngleDeg: hand.armAngleDeg,
            speed: hand.speed,
          }
        },
        SWING_TIMEOUT_MS,
        `the arm never passed ${SWING_ARM_MIN_DEG} deg while swinging`
      )
      if (recording) {
        await desktop.waitForTimeout(VIDEO_SWING_HOLD_MS)
      }
      return `arm ${result.armAngleDeg.toFixed(1)} deg, hand speed ${result.speed.toFixed(2)} m/s`
    })

    await checks.run('resting the phone settles the arm again', async () => {
      await phoneA.page.evaluate(() => window.__phoneSim.setPhase('rest'))
      const result = await pollUntil(
        async () => {
          const hand = await desktopHand(desktop)
          return { ok: hand.armAngleDeg < SETTLED_ARM_MAX_DEG, armAngleDeg: hand.armAngleDeg }
        },
        SETTLE_TIMEOUT_MS,
        `the arm never settled under ${SETTLED_ARM_MAX_DEG} deg at rest`
      )
      return `arm ${result.armAngleDeg.toFixed(1)} deg`
    })

    await desktop.screenshot({ path: path.join(OUT_DIR, 'phone-e2e-desktop.png') })
    await phoneA.page.screenshot({ path: path.join(OUT_DIR, 'phone-e2e-phone.png') })

    if (recording) {
      await desktop.waitForTimeout(VIDEO_TAIL_HOLD_MS)
    }

    const phoneAProblems = diagnosticsProblems(phoneA.diagnostics)
    await phoneA.context.close()
    const phoneAContext = phoneA
    phoneA = null

    await checks.run('an inverted-sign phone calibrates, syncs, and swings the arm', async () => {
      phoneB = await openPhone(browser, cdnPackageDirs, phoneLink, AccelConvention.INVERTED, false)
      await phoneB.page.waitForTimeout(800)
      const accelSign = await phoneB.page.evaluate(() => window.__phoneSensors.snapshot().accelSign)
      assertTrue(accelSign === -1, `accelSign resolved to ${accelSign}, expected -1 for the inverted convention`)
      await phoneB.page.click('#sync-hold')
      const note = await syncNote(phoneB.page)
      assertTrue(note === SYNCED_NOTE, `sync note is "${note}", expected "${SYNCED_NOTE}"`)
      await phoneB.page.evaluate(() => window.__phoneSim.setPhase('swing'))
      const result = await pollUntil(
        async () => {
          const hand = await desktopHand(desktop)
          return {
            ok: hand.armAngleDeg > SWING_ARM_MIN_DEG && hand.speed > SWING_SPEED_MIN_M_S,
            armAngleDeg: hand.armAngleDeg,
            speed: hand.speed,
          }
        },
        SWING_TIMEOUT_MS,
        `the arm never passed ${SWING_ARM_MIN_DEG} deg from the inverted-sign phone`
      )
      return `accelSign -1, arm ${result.armAngleDeg.toFixed(1)} deg, speed ${result.speed.toFixed(2)} m/s`
    })

    await checks.run('no console or page errors on any page', async () => {
      const problems = [
        ...diagnosticsProblems(desktopDiagnostics),
        ...phoneAProblems,
        ...diagnosticsProblems(phoneB === null ? null : phoneB.diagnostics),
      ]
      assertTrue(problems.length === 0, problems.join(' | '))
      return 'all pages clean'
    })

    if (recording) {
      const desktopVideo = desktopContext.pages()[0].video()
      const phoneVideo = phoneAContext.page.video()
      const desktopVideoPath = await desktopVideo.path()
      const phoneVideoPath = await phoneVideo.path()
      if (phoneB !== null) {
        await phoneB.context.close()
        phoneB = null
      }
      await desktopContext.close()
      desktopContext = null

      await checks.run('side-by-side demo video encoded', async () => {
        composeSideBySide(desktopVideoPath, phoneVideoPath, videoOutPath, phoneRecordingLeadSeconds)
        assertTrue(fs.existsSync(videoOutPath), `${videoOutPath} was not written`)
        const probe = ffprobeVideo(videoOutPath)
        assertTrue(probe.videoStream !== null, 'ffprobe found no video stream in the output')
        assertTrue(
          probe.duration > MIN_VIDEO_SECONDS,
          `video duration ${probe.duration.toFixed(2)}s is not longer than ${MIN_VIDEO_SECONDS}s`
        )
        return `${probe.videoStream.codec_name} ${probe.videoStream.width}x${probe.videoStream.height}, ${probe.duration.toFixed(2)}s`
      })

      console.log(`\nvideo: ${videoOutPath}`)
    }
  } finally {
    if (phoneA !== null) {
      await phoneA.context.close().catch(() => {})
    }
    if (phoneB !== null) {
      await phoneB.context.close().catch(() => {})
    }
    if (desktopContext !== null) {
      await desktopContext.close().catch(() => {})
    }
    if (browser !== null) {
      await browser.close().catch(() => {})
    }
    await stopPeerServer(peerServer.child)
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
      () => reject(new Error(`e2e-phone exceeded ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    )
  })
  try {
    const options = parseArgs(process.argv.slice(2))
    const exitCode = await Promise.race([runPhone(options), timeout])
    process.exitCode = exitCode
    console.log(exitCode === 0 ? '\ne2e-phone: PASS' : '\ne2e-phone: FAIL')
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err))
    console.log('\ne2e-phone: FAIL')
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
  await flushOutput()
  process.exit(process.exitCode)
}

main()
