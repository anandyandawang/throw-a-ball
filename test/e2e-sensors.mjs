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
const VIDEO_DIR = path.join(OUT_DIR, 'video-sensors')

const CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/'
const CDN_PACKAGES = Object.freeze([{ name: 'peerjs', version: '1.5.5' }])
const PACKAGE_SUBDIR = 'package'

const PHONE_VIEWPORT = { width: 390, height: 844 }
const PHONE_SCALE_FACTOR = 2

const OVERALL_TIMEOUT_MS = 180000
const GOTO_TIMEOUT_MS = 30000
const SCREEN_TIMEOUT_MS = 15000
const SAMPLE_COUNT_TIMEOUT_MS = 5000
const GYRO_UNIT_TIMEOUT_MS = 10000
const DOWNLOAD_TIMEOUT_MS = 20000
const POLL_INTERVAL_MS = 100

const SENSOR_SIM_INTERVAL_MS = 16
const GRAVITY_Y = 9.81
const BURST_AMPLITUDE_SCALE = 3
const CALM_AMPLITUDE_SCALE = 1

const FIRST_SAMPLE_GRACE_MS = 1500
const MIN_MOTION_COUNT = 60
const MIN_ORIENTATION_COUNT = 60
const MIN_MOTION_RATE_HZ = 40
const MAX_MOTION_RATE_HZ = 80
const MIN_DT_MS = 1
const MAX_DT_MS = 50
const QUATERNION_NORM_TOLERANCE = 1e-6
const QUATERNION_CHANGE_GAP_MS = 500
const GYRO_PEAK_WINDOW_MS = 1000
const GYRO_PEAK_SAMPLE_MS = 40
const MIN_GYRO_PEAK_DEG_PER_S = 40

const TRACE_ASSERT_RECORD_MS = 2000
const TRACE_VIDEO_RECORD_MS = 3000
const TRACE_MIN_SAMPLES_ASSERT = 60
const TRACE_MIN_SAMPLES_VIDEO = 100
const TRACE_GYRO_Z_MIN_RAD_PER_S = 1.4
const TRACE_GYRO_Z_MAX_RAD_PER_S = 2.1
const TRACE_ORIENTATION_COVERAGE = 0.9
const TRACE_SAMPLE_KEYS = Object.freeze([
  'timeStamp',
  'rotationRate',
  'accelerationIncludingGravity',
  'acceleration',
  'orientation',
])

const SAFETY_PHRASES = Object.freeze(['strap or grip the phone', 'never let go'])
const GYRO_UNIT_DEG_PER_S = 'deg/s'
const DENIED_REASON_SENSOR = 'motion'

const VIDEO_HOME_HOLD_MS = 2000
const VIDEO_DENIED_HOLD_MS = 2000
const VIDEO_SAFETY_HOLD_MS = 2500
const VIDEO_CALM_HOLD_MS = 5000
const VIDEO_TAIL_HOLD_MS = 2000

const ENCODED_HEIGHT = 720
const ENCODED_FPS = 30
const MIN_VIDEO_SECONDS = 12

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
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`expected ${manifestPath} after extracting ${tarballUrl}`)
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
  const options = {}
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
    if (url.startsWith('http://127.0.0.1:')) {
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
    const mark = entry.ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${entry.name}${entry.note === '' ? '' : ` :: ${entry.note}`}`)
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
    const lines = ['', `--- sensors summary: ${passed}/${entries.length} checks passed ---`]
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

function assertFiniteVector(vector, label) {
  assertTrue(vector !== null && vector !== undefined, `${label} is null`)
  for (const axis of ['x', 'y', 'z']) {
    assertTrue(
      typeof vector[axis] === 'number' && Number.isFinite(vector[axis]),
      `${label}.${axis} is not finite: ${JSON.stringify(vector[axis])}`
    )
  }
}

function quaternionNorm(quaternion) {
  return Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
}

async function pollUntil(page, evaluator, timeoutMs, describeFailure) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await page.evaluate(evaluator)
    if (last && last.ok) {
      return last
    }
    if (Date.now() >= deadline) {
      throw new Error(`${describeFailure} after ${timeoutMs}ms :: ${JSON.stringify(last)}`)
    }
    await page.waitForTimeout(POLL_INTERVAL_MS)
  }
}

async function currentScreen(page) {
  return page.evaluate(() => window.__phoneSensors.screen)
}

async function waitForScreen(page, expected) {
  await page.waitForFunction(
    (name) => window.__phoneSensors && window.__phoneSensors.screen === name,
    expected,
    { timeout: SCREEN_TIMEOUT_MS }
  )
}

function installSensorSim(page, config) {
  return page.evaluate((options) => {
    const twoPi = Math.PI * 2
    const alphaAmplitudeDeg = 40
    const betaAmplitudeDeg = 15
    const gammaAmplitudeDeg = 8
    const alphaHz = 0.4
    const betaHz = 0.3
    const gammaHz = 0.25
    const gammaPhase = 1
    const accelXAmplitude = 2.5
    const accelYAmplitude = 1.5
    const accelZAmplitude = 0.8
    const accelXHz = 0.7
    const accelYHz = 0.9
    const accelZHz = 0.6
    const accelYPhase = 0.5
    const accelZPhase = 1

    let timer = null
    let startedAtMs = 0
    let amplitudeScale = options.initialAmplitudeScale

    function wave(amplitude, hz, phase, seconds) {
      return amplitude * Math.sin(twoPi * hz * seconds + phase)
    }

    function waveRate(amplitude, hz, phase, seconds) {
      return amplitude * twoPi * hz * Math.cos(twoPi * hz * seconds + phase)
    }

    function emit() {
      const seconds = (performance.now() - startedAtMs) / 1000
      const scale = amplitudeScale
      const alphaDeg = scale * wave(alphaAmplitudeDeg, alphaHz, 0, seconds)
      const betaDeg = scale * wave(betaAmplitudeDeg, betaHz, 0, seconds)
      const gammaDeg = scale * wave(gammaAmplitudeDeg, gammaHz, gammaPhase, seconds)
      const zDegPerS = scale * waveRate(alphaAmplitudeDeg, alphaHz, 0, seconds)
      const xDegPerS = scale * waveRate(betaAmplitudeDeg, betaHz, 0, seconds)
      const yDegPerS = scale * waveRate(gammaAmplitudeDeg, gammaHz, gammaPhase, seconds)
      const acceleration = {
        x: scale * wave(accelXAmplitude, accelXHz, 0, seconds),
        y: scale * wave(accelYAmplitude, accelYHz, accelYPhase, seconds),
        z: scale * wave(accelZAmplitude, accelZHz, accelZPhase, seconds),
      }
      const accelerationIncludingGravity = {
        x: acceleration.x,
        y: acceleration.y + options.gravityY,
        z: acceleration.z,
      }
      window.dispatchEvent(
        new DeviceOrientationEvent('deviceorientation', {
          alpha: alphaDeg,
          beta: betaDeg,
          gamma: gammaDeg,
          absolute: false,
        })
      )
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', {
          rotationRate: { alpha: zDegPerS, beta: xDegPerS, gamma: yDegPerS },
          accelerationIncludingGravity,
          acceleration,
          interval: options.intervalMs,
        })
      )
    }

    window.__sensorSim = {
      start() {
        if (timer !== null) {
          return
        }
        startedAtMs = performance.now()
        timer = setInterval(emit, options.intervalMs)
      },
      stop() {
        if (timer === null) {
          return
        }
        clearInterval(timer)
        timer = null
      },
      setAmplitudeScale(scale) {
        amplitudeScale = scale
      },
      get amplitudeScale() {
        return amplitudeScale
      },
    }
  }, config)
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

function encodePhoneVideo(sourcePath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      sourcePath,
      '-vf',
      `scale=-2:${ENCODED_HEIGHT},fps=${ENCODED_FPS},setsar=1`,
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
    throw new Error('--video needs an output path, e.g. --video test/out/m2-sensors.mp4')
  }
  return { videoOutPath: path.resolve(process.cwd(), value) }
}

function parseTrace(rawJson, filePath) {
  let parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`downloaded trace ${filePath} is not valid JSON: ${errorMessage(err)}`)
  }
  assertTrue(Array.isArray(parsed), `downloaded trace is ${typeof parsed}, expected an array`)
  return parsed
}

function assertTraceShape(samples, minSamples, maxGyroZBound) {
  assertTrue(
    samples.length >= minSamples,
    `trace has ${samples.length} samples, expected at least ${minSamples}`
  )
  assertTrue(
    samples[0].timeStamp === 0,
    `first trace timeStamp is ${samples[0].timeStamp}, expected 0`
  )
  let previousTimeStamp = -1
  let orientationCount = 0
  let maxGyroZ = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    for (const key of TRACE_SAMPLE_KEYS) {
      assertTrue(
        Object.prototype.hasOwnProperty.call(sample, key),
        `trace sample ${index} is missing key "${key}"`
      )
    }
    assertTrue(
      typeof sample.timeStamp === 'number' && sample.timeStamp >= previousTimeStamp,
      `trace timeStamp went backwards at sample ${index}: ${sample.timeStamp} after ${previousTimeStamp}`
    )
    previousTimeStamp = sample.timeStamp
    if (sample.orientation !== null && sample.orientation !== undefined) {
      orientationCount += 1
    }
    if (sample.rotationRate !== null && typeof sample.rotationRate.z === 'number') {
      maxGyroZ = Math.max(maxGyroZ, Math.abs(sample.rotationRate.z))
    }
  }
  assertTrue(
    maxGyroZ >= TRACE_GYRO_Z_MIN_RAD_PER_S && maxGyroZ <= maxGyroZBound,
    `trace peak |rotationRate.z| is ${maxGyroZ.toFixed(3)} rad/s, expected within [${TRACE_GYRO_Z_MIN_RAD_PER_S}, ${maxGyroZBound}] — rotationRate is not normalized to rad/s from deg/s`
  )
  const coverage = orientationCount / samples.length
  assertTrue(
    coverage >= TRACE_ORIENTATION_COVERAGE,
    `only ${(coverage * 100).toFixed(1)}% of trace samples carry orientation, expected at least ${TRACE_ORIENTATION_COVERAGE * 100}%`
  )
  return { count: samples.length, maxGyroZ, coverage }
}

async function recordAndSaveTrace(page, recording) {
  await page.click('#record-trace')
  await page.waitForFunction(() => window.__phoneSensors.traceActive === true, undefined, {
    timeout: SCREEN_TIMEOUT_MS,
  })
  if (recording) {
    await page.evaluate((scale) => window.__sensorSim.setAmplitudeScale(scale), BURST_AMPLITUDE_SCALE)
    await page.waitForTimeout(TRACE_VIDEO_RECORD_MS)
  } else {
    await page.waitForTimeout(TRACE_ASSERT_RECORD_MS)
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
    page.click('#record-trace'),
  ])
  const savedPath = path.join(OUT_DIR, download.suggestedFilename() || 'imu-trace.json')
  await download.saveAs(savedPath)
  return savedPath
}

async function runSensors({ videoOutPath }) {
  const recording = videoOutPath !== null
  const checks = createChecklist()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (recording) {
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
    fs.mkdirSync(VIDEO_DIR, { recursive: true })
  }

  const { chromium } = resolvePlaywright()
  const cdnPackageDirs = await ensureCdnPackages()
  const staticServer = await startStaticServer(REPO_ROOT)
  const staticBase = `http://127.0.0.1:${staticServer.address().port}`
  const phoneUrl = `${staticBase}/phone/`

  let browser = null
  let phoneContext = null

  try {
    browser = await launchBrowser(chromium)

    const abortedUrls = new Set()
    phoneContext = await browser.newContext({
      viewport: PHONE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: PHONE_SCALE_FACTOR,
      acceptDownloads: true,
      recordVideo: recording ? { dir: VIDEO_DIR, size: PHONE_VIEWPORT } : undefined,
    })
    const phone = await phoneContext.newPage()
    const diagnostics = attachDiagnostics(phone, 'phone', abortedUrls)
    await installExternalRouting(phoneContext, cdnPackageDirs, abortedUrls)

    await checks.run('phone page loads without a peer param', async () => {
      await phone.goto(phoneUrl, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
      await phone.waitForFunction(() => window.__phoneSensors != null, undefined, {
        timeout: SCREEN_TIMEOUT_MS,
      })
      const status = await phone.evaluate(() => {
        const element = document.querySelector('[data-status]')
        return element === null ? null : { text: element.textContent.trim(), state: element.dataset.state }
      })
      assertTrue(status !== null, '[data-status] is missing from the phone page')
      assertTrue(
        status.text === 'waiting' && status.state === 'waiting',
        `[data-status] is "${status.text}"/"${status.state}", expected waiting`
      )
      const screen = await currentScreen(phone)
      assertTrue(screen === 'home', `screen is "${screen}", expected home`)
      const startVisible = await phone.locator('#start-sensors').isVisible()
      const startDisabled = await phone.locator('#start-sensors').isDisabled()
      assertTrue(startVisible, '#start-sensors is not visible on the home screen')
      assertTrue(!startDisabled, '#start-sensors is disabled on the home screen')
      return phoneUrl
    })

    if (recording) {
      await phone.waitForTimeout(VIDEO_HOME_HOLD_MS)
    }
    await phone.screenshot({ path: path.join(OUT_DIR, 'sensors-home.png') })

    await checks.run('denied motion permission lands on the denied screen', async () => {
      await phone.evaluate(() => {
        DeviceMotionEvent.requestPermission = () => Promise.resolve('denied')
      })
      await phone.click('#start-sensors')
      await waitForScreen(phone, 'denied')
      const deniedVisible = await phone.locator('#screen-denied').isVisible()
      assertTrue(deniedVisible, '#screen-denied is not visible after a denied motion permission')
      const reason = (await phone.locator('[data-denied-reason]').textContent()).trim()
      assertTrue(
        reason.toLowerCase().includes(DENIED_REASON_SENSOR),
        `[data-denied-reason] is "${reason}", expected it to mention "${DENIED_REASON_SENSOR}"`
      )
      return `"${reason}"`
    })

    await phone.screenshot({ path: path.join(OUT_DIR, 'sensors-denied.png') })
    if (recording) {
      await phone.waitForTimeout(VIDEO_DENIED_HOLD_MS)
    }

    await checks.run('retry after granting lands on the safety screen', async () => {
      await phone.evaluate(() => {
        DeviceMotionEvent.requestPermission = () => Promise.resolve('granted')
        DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted')
      })
      await phone.click('#retry-permissions')
      await waitForScreen(phone, 'safety')
      const safetyVisible = await phone.locator('#screen-safety').isVisible()
      assertTrue(safetyVisible, '#screen-safety is not visible after retrying with granted permissions')
      const safetyText = (await phone.locator('#screen-safety').textContent()).toLowerCase()
      for (const phrase of SAFETY_PHRASES) {
        assertTrue(
          safetyText.includes(phrase),
          `#screen-safety text is missing the phrase "${phrase}"`
        )
      }
      return SAFETY_PHRASES.map((phrase) => `"${phrase}"`).join(' + ')
    })

    await phone.screenshot({ path: path.join(OUT_DIR, 'sensors-safety.png') })
    if (recording) {
      await phone.waitForTimeout(VIDEO_SAFETY_HOLD_MS)
    }

    await checks.run('begin capture opens the capture screen', async () => {
      await phone.click('#begin-capture')
      await waitForScreen(phone, 'capture')
      const captureActive = await phone.evaluate(() =>
        document.body.classList.contains('capture-active')
      )
      assertTrue(captureActive, 'body is missing the capture-active class on the capture screen')
      return 'capture-active'
    })

    await checks.run('synthetic sensor stream installed', async () => {
      await installSensorSim(phone, {
        intervalMs: SENSOR_SIM_INTERVAL_MS,
        gravityY: GRAVITY_Y,
        initialAmplitudeScale: CALM_AMPLITUDE_SCALE,
      })
      await phone.evaluate(() => window.__sensorSim.start())
      return `${SENSOR_SIM_INTERVAL_MS}ms spec-shaped deg/s device`
    })

    await checks.run('capture layer reads the spec event shape', async () => {
      try {
        await pollUntil(
          phone,
          () => {
            const snapshot = window.__phoneSensors.snapshot()
            if (snapshot === null) {
              return { ok: false, reason: 'snapshot is null' }
            }
            return {
              ok: snapshot.gyroRaw !== null,
              motionCount: snapshot.motionCount,
              gyroRaw: snapshot.gyroRaw,
            }
          },
          FIRST_SAMPLE_GRACE_MS,
          'snapshot().gyroRaw stayed null'
        )
      } catch (err) {
        throw new Error(
          `${errorMessage(err)} — event-shape mismatch: devicemotion carries rotationRate as the spec {alpha, beta, gamma} dict and the capture layer must map it to {x: beta, y: gamma, z: alpha}`
        )
      }
      return 'gyroRaw populated'
    })

    await checks.run('sample counts and rates look like a live device', async () => {
      const result = await pollUntil(
        phone,
        () => {
          const snapshot = window.__phoneSensors.snapshot()
          if (snapshot === null) {
            return { ok: false, reason: 'snapshot is null' }
          }
          return {
            ok: snapshot.motionCount > 60 && snapshot.orientationCount > 60,
            motionCount: snapshot.motionCount,
            orientationCount: snapshot.orientationCount,
          }
        },
        SAMPLE_COUNT_TIMEOUT_MS,
        `motionCount/orientationCount did not both pass ${MIN_MOTION_COUNT}`
      )
      const snapshot = await phone.evaluate(() => window.__phoneSensors.snapshot())
      assertTrue(
        snapshot.motionRateHz >= MIN_MOTION_RATE_HZ && snapshot.motionRateHz <= MAX_MOTION_RATE_HZ,
        `motionRateHz is ${snapshot.motionRateHz}, expected within [${MIN_MOTION_RATE_HZ}, ${MAX_MOTION_RATE_HZ}]`
      )
      assertTrue(
        snapshot.lastDtMs >= MIN_DT_MS && snapshot.lastDtMs <= MAX_DT_MS,
        `lastDtMs is ${snapshot.lastDtMs}, expected within [${MIN_DT_MS}, ${MAX_DT_MS}]`
      )
      assertFiniteVector(snapshot.gyroRaw, 'gyroRaw')
      return `motion ${result.motionCount}, orientation ${result.orientationCount}, ${snapshot.motionRateHz.toFixed(1)} Hz, dt ${snapshot.lastDtMs.toFixed(1)} ms`
    })

    await checks.run('quaternion is unit length and moving', async () => {
      const first = await phone.evaluate(() => window.__phoneSensors.snapshot().quaternion)
      assertTrue(first !== null, 'snapshot().quaternion is null while orientation events flow')
      const firstNorm = quaternionNorm(first)
      assertTrue(
        Math.abs(firstNorm - 1) <= QUATERNION_NORM_TOLERANCE,
        `quaternion norm is ${firstNorm}, expected 1 within ${QUATERNION_NORM_TOLERANCE}`
      )
      await phone.waitForTimeout(QUATERNION_CHANGE_GAP_MS)
      const second = await phone.evaluate(() => window.__phoneSensors.snapshot().quaternion)
      assertTrue(second !== null, 'snapshot().quaternion went null between reads')
      const secondNorm = quaternionNorm(second)
      assertTrue(
        Math.abs(secondNorm - 1) <= QUATERNION_NORM_TOLERANCE,
        `quaternion norm is ${secondNorm}, expected 1 within ${QUATERNION_NORM_TOLERANCE}`
      )
      const unchanged =
        first.x === second.x && first.y === second.y && first.z === second.z && first.w === second.w
      assertTrue(
        !unchanged,
        `quaternion did not change over ${QUATERNION_CHANGE_GAP_MS}ms: ${JSON.stringify(first)}`
      )
      return `norm ${firstNorm.toFixed(9)} -> ${secondNorm.toFixed(9)}, moving`
    })

    await checks.run('gyro unit calibration resolves to deg/s', async () => {
      const result = await pollUntil(
        phone,
        () => {
          const snapshot = window.__phoneSensors.snapshot()
          if (snapshot === null) {
            return { ok: false, reason: 'snapshot is null' }
          }
          return {
            ok: snapshot.gyroUnit === 'deg/s',
            gyroUnit: snapshot.gyroUnit,
            calibrationRatio: snapshot.calibrationRatio,
            orientationTravelDeg: snapshot.orientationTravelDeg,
          }
        },
        GYRO_UNIT_TIMEOUT_MS,
        `gyroUnit never became "${GYRO_UNIT_DEG_PER_S}"`
      )
      return `ratio ${result.calibrationRatio === null ? 'null' : Number(result.calibrationRatio).toFixed(3)}, travel ${Number(result.orientationTravelDeg).toFixed(1)} deg`
    })

    await checks.run('converted gyro reaches the analytic peak', async () => {
      const peak = await phone.evaluate(
        async (window_) => {
          const deadline = performance.now() + window_.windowMs
          let maxZ = 0
          while (performance.now() < deadline) {
            const snapshot = window.__phoneSensors.snapshot()
            if (snapshot !== null && snapshot.gyroDegPerS !== null) {
              maxZ = Math.max(maxZ, Math.abs(snapshot.gyroDegPerS.z))
            }
            await new Promise((resolve) => setTimeout(resolve, window_.sampleMs))
          }
          return maxZ
        },
        { windowMs: GYRO_PEAK_WINDOW_MS, sampleMs: GYRO_PEAK_SAMPLE_MS }
      )
      assertTrue(
        peak > MIN_GYRO_PEAK_DEG_PER_S,
        `peak |gyroDegPerS.z| over ${GYRO_PEAK_WINDOW_MS}ms was ${peak.toFixed(2)} deg/s, expected above ${MIN_GYRO_PEAK_DEG_PER_S}`
      )
      return `${peak.toFixed(1)} deg/s`
    })

    await checks.run('capture readout renders live values', async () => {
      const unitText = (await phone.locator('[data-gyro-unit]').textContent()).trim()
      assertTrue(
        unitText.includes(GYRO_UNIT_DEG_PER_S),
        `[data-gyro-unit] is "${unitText}", expected it to contain "${GYRO_UNIT_DEG_PER_S}"`
      )
      const rateText = (await phone.locator('[data-rate]').textContent()).trim()
      assertTrue(
        Number.isFinite(Number(rateText)),
        `[data-rate] is "${rateText}", expected a number`
      )
      const firstQuat = (await phone.locator('[data-quat]').textContent()).trim()
      await phone.waitForTimeout(QUATERNION_CHANGE_GAP_MS)
      const secondQuat = (await phone.locator('[data-quat]').textContent()).trim()
      assertTrue(
        firstQuat !== secondQuat,
        `[data-quat] did not change over ${QUATERNION_CHANGE_GAP_MS}ms: "${firstQuat}"`
      )
      return `unit "${unitText}", rate ${rateText}`
    })

    await checks.run('touchmove is blocked while capture is active', async () => {
      const prevented = await phone.evaluate(() => {
        const touchMove = new Event('touchmove', { cancelable: true, bubbles: true })
        return document.body.dispatchEvent(touchMove) === false
      })
      assertTrue(
        prevented,
        'dispatchEvent("touchmove") returned true — preventDefault did not fire on the capture screen'
      )
      return 'preventDefault fired'
    })

    await checks.run('no-sensor notice stays hidden while data flows', async () => {
      const note = await phone.evaluate(() => {
        const element = document.querySelector('[data-capture-note]')
        if (element === null) {
          return null
        }
        return { hidden: element.hidden, text: element.textContent.trim() }
      })
      assertTrue(note !== null, '[data-capture-note] is missing from the capture screen')
      assertTrue(
        note.hidden || note.text === '',
        `[data-capture-note] shows "${note.text}" while sensor events are flowing`
      )
      return note.hidden ? 'hidden' : 'empty'
    })

    await phone.screenshot({ path: path.join(OUT_DIR, 'sensors-capture.png') })

    if (recording) {
      await phone.waitForTimeout(VIDEO_CALM_HOLD_MS)
    }

    await checks.run('trace records, downloads, and parses', async () => {
      const savedPath = await recordAndSaveTrace(phone, recording)
      const samples = parseTrace(fs.readFileSync(savedPath, 'utf8'), savedPath)
      const minSamples = recording ? TRACE_MIN_SAMPLES_VIDEO : TRACE_MIN_SAMPLES_ASSERT
      const maxGyroZBound = recording
        ? TRACE_GYRO_Z_MAX_RAD_PER_S * BURST_AMPLITUDE_SCALE
        : TRACE_GYRO_Z_MAX_RAD_PER_S
      const summary = assertTraceShape(samples, minSamples, maxGyroZBound)
      return `${summary.count} samples, peak |wz| ${summary.maxGyroZ.toFixed(3)} rad/s, orientation ${(summary.coverage * 100).toFixed(1)}%, saved ${savedPath}`
    })

    if (recording) {
      await phone.evaluate((scale) => window.__sensorSim.setAmplitudeScale(scale), CALM_AMPLITUDE_SCALE)
      await phone.waitForTimeout(VIDEO_TAIL_HOLD_MS)
    }

    await checks.run('exit capture returns to the home screen', async () => {
      await phone.evaluate(() => window.__sensorSim.stop())
      await phone.click('#exit-capture')
      await waitForScreen(phone, 'home')
      const captureActive = await phone.evaluate(() =>
        document.body.classList.contains('capture-active')
      )
      assertTrue(!captureActive, 'body still carries capture-active after exiting capture')
      return 'home'
    })

    await checks.run('no console or page errors', async () => {
      const problems = diagnosticsProblems(diagnostics)
      assertTrue(problems.length === 0, problems.join(' | '))
      return 'phone page clean'
    })

    if (recording) {
      const rawVideoPath = await phone.video().path()
      await phoneContext.close()
      phoneContext = null

      await checks.run('phone capture video encoded', async () => {
        encodePhoneVideo(rawVideoPath, videoOutPath)
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
    if (phoneContext !== null) {
      await phoneContext.close().catch(() => {})
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
      () => reject(new Error(`e2e-sensors exceeded ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    )
  })
  try {
    const options = parseArgs(process.argv.slice(2))
    const exitCode = await Promise.race([runSensors(options), timeout])
    process.exitCode = exitCode
    console.log(exitCode === 0 ? '\ne2e-sensors: PASS' : '\ne2e-sensors: FAIL')
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err))
    console.log('\ne2e-sensors: FAIL')
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
  await flushOutput()
  process.exit(process.exitCode)
}

main()
