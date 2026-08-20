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
const VIDEO_DIR = path.join(OUT_DIR, 'video')

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

const OVERALL_TIMEOUT_MS = 180000
const GOTO_TIMEOUT_MS = 30000
const DESKTOP_READY_TIMEOUT_MS = 45000
const CONNECT_TIMEOUT_MS = 60000
const LATENCY_TIMEOUT_MS = 15000
const TAP_ASSERT_TIMEOUT_MS = 15000

const ASSERT_TAP_COUNT = 3
const ASSERT_TAP_GAP_MS = 400
const VIDEO_TAP_COUNT = 5
const VIDEO_TAP_GAP_MS = 800
const VIDEO_WAITING_HOLD_MS = 2500
const VIDEO_CONNECTED_HOLD_MS = 3000
const VIDEO_TAIL_HOLD_MS = 2000

const COMPOSED_HEIGHT = 720
const COMPOSED_FPS = 30
const MIN_VIDEO_SECONDS = 8

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
  const require = createRequire(path.join(PEER_SERVER_PREFIX, 'e2e-pairing-resolver.cjs'))
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

function onSignalledExit(exitCode) {
  killLivePeerServers()
  process.exit(exitCode)
}

process.on('exit', killLivePeerServers)
process.on('SIGINT', () => onSignalledExit(130))
process.on('SIGTERM', () => onSignalledExit(143))

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
    await stopPeerServer(child)
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
    const lines = ['', `--- pairing summary: ${passed}/${entries.length} checks passed ---`]
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

async function waitForStatus(page, expectedState, timeout) {
  await page.waitForFunction(
    (state) => {
      const element = document.querySelector('[data-status]')
      if (element === null) {
        return false
      }
      return element.textContent.trim() === state && element.dataset.state === state
    },
    expectedState,
    { timeout }
  )
}

async function statusDetail(page) {
  const element = await page.$('[data-status-detail]')
  if (element === null) {
    return ''
  }
  return (await element.textContent()).trim()
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

function composeSideBySide(desktopVideoPath, phoneVideoPath, outPath, measuredLeadSeconds) {
  const desktopProbe = ffprobeVideo(desktopVideoPath)
  const phoneProbe = ffprobeVideo(phoneVideoPath)
  const durationLeadSeconds = Math.max(0, desktopProbe.duration - phoneProbe.duration)
  const leadSeconds =
    typeof measuredLeadSeconds === 'number' && measuredLeadSeconds >= 0
      ? measuredLeadSeconds
      : durationLeadSeconds
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
    throw new Error('--video needs an output path, e.g. --video test/out/m1-demo.mp4')
  }
  return { videoOutPath: path.resolve(process.cwd(), value) }
}

async function runPairing({ videoOutPath }) {
  const recording = videoOutPath !== null
  const tapTotal = recording ? VIDEO_TAP_COUNT : ASSERT_TAP_COUNT
  const tapGapMs = recording ? VIDEO_TAP_GAP_MS : ASSERT_TAP_GAP_MS
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

  let peerServer = null
  let browser = null
  let desktopContext = null
  let phoneContext = null
  let desktopVideoPath = null
  let phoneVideoPath = null

  try {
    const started = await startPeerServer(peerModulePath)
    peerServer = started.child
    const peerPort = started.port

    const desktopUrl = `${staticBase}/?host=${PEER_SERVER_HOST}&port=${peerPort}&path=${PEER_SERVER_PATH}&insecure=1`

    browser = await launchBrowser(chromium)

    const desktopAbortedUrls = new Set()
    desktopContext = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      recordVideo: recording
        ? { dir: path.join(VIDEO_DIR, 'desktop'), size: DESKTOP_VIEWPORT }
        : undefined,
    })
    const desktopRecordingStartedAt = Date.now()
    const desktop = await desktopContext.newPage()
    const desktopDiagnostics = attachDiagnostics(desktop, 'desktop', desktopAbortedUrls)
    await installExternalRouting(desktopContext, cdnPackageDirs, desktopAbortedUrls)

    let phoneLink = null
    let phoneDiagnostics = null
    let phoneRecordingLeadSeconds = null

    await checks.run('desktop page loads', async () => {
      await desktop.goto(desktopUrl, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
      return desktopUrl
    })

    await checks.run('desktop reaches waiting with a peer id', async () => {
      await desktop.waitForFunction(
        () => {
          const element = document.querySelector('[data-status]')
          const pairing = window.__throwABall && window.__throwABall.pairing
          if (element === null || pairing == null) {
            return false
          }
          return (
            element.textContent.trim() === 'waiting' &&
            element.dataset.state === 'waiting' &&
            typeof pairing.peerId === 'string' &&
            pairing.peerId.length > 0
          )
        },
        undefined,
        { timeout: DESKTOP_READY_TIMEOUT_MS }
      )
      const peerId = await desktop.evaluate(() => window.__throwABall.pairing.peerId)
      return `peerId ${peerId}, detail "${await statusDetail(desktop)}"`
    })

    await checks.run('desktop link carries peer id and signaling overrides', async () => {
      const linkText = (await desktop.locator('[data-link]').textContent()).trim()
      const pairing = await desktop.evaluate(() => ({
        peerId: window.__throwABall.pairing.peerId,
        phoneLink: window.__throwABall.pairing.phoneLink,
      }))
      assertTrue(linkText.includes('peer='), `[data-link] text has no peer= param: ${linkText}`)
      assertTrue(
        pairing.phoneLink === linkText,
        `pairing.phoneLink "${pairing.phoneLink}" differs from [data-link] "${linkText}"`
      )
      const parsed = new URL(linkText)
      const expected = {
        peer: pairing.peerId,
        host: PEER_SERVER_HOST,
        port: String(peerPort),
        path: PEER_SERVER_PATH,
        insecure: '1',
      }
      for (const [key, value] of Object.entries(expected)) {
        assertTrue(
          parsed.searchParams.get(key) === value,
          `phone link ${key} is "${parsed.searchParams.get(key)}", expected "${value}"`
        )
      }
      phoneLink = linkText
      return linkText
    })

    await checks.run('desktop pairing panel renders a QR code', async () => {
      const qrChildren = await desktop.evaluate(() => {
        const qr = document.getElementById('qr')
        return qr === null ? -1 : qr.childElementCount
      })
      assertTrue(qrChildren > 0, `#qr has ${qrChildren} children, expected a rendered code`)
      const panelHidden = await desktop.evaluate(() =>
        document.getElementById('pairing').classList.contains('hidden')
      )
      assertTrue(!panelHidden, 'pairing panel is hidden while waiting')
      return `${qrChildren} qr node(s)`
    })

    if (recording) {
      await desktop.waitForTimeout(VIDEO_WAITING_HOLD_MS)
    }
    await desktop.screenshot({ path: path.join(OUT_DIR, 'pairing-desktop-waiting.png') })

    await checks.run('phone page loads from the desktop link', async () => {
      const phoneAbortedUrls = new Set()
      phoneContext = await browser.newContext({
        viewport: PHONE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: PHONE_SCALE_FACTOR,
        recordVideo: recording
          ? { dir: path.join(VIDEO_DIR, 'phone'), size: PHONE_VIEWPORT }
          : undefined,
      })
      phoneRecordingLeadSeconds = (Date.now() - desktopRecordingStartedAt) / 1000
      const page = await phoneContext.newPage()
      phoneDiagnostics = attachDiagnostics(page, 'phone', phoneAbortedUrls)
      await installExternalRouting(phoneContext, cdnPackageDirs, phoneAbortedUrls)
      await page.goto(phoneLink, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
      return phoneLink
    })

    const phone = phoneContext.pages()[0]

    await checks.run('phone reaches connected', async () => {
      await waitForStatus(phone, 'connected', CONNECT_TIMEOUT_MS)
      return `detail "${await statusDetail(phone)}"`
    })

    await checks.run('desktop reaches connected', async () => {
      await waitForStatus(desktop, 'connected', CONNECT_TIMEOUT_MS)
      const panelHidden = await desktop.evaluate(() =>
        document.getElementById('pairing').classList.contains('hidden')
      )
      assertTrue(panelHidden, 'pairing panel is still visible while connected')
      return `detail "${await statusDetail(desktop)}"`
    })

    await checks.run('phone tap zone is enabled', async () => {
      const disabled = await phone.locator('#tap-zone').isDisabled()
      assertTrue(!disabled, 'tap zone is still disabled after connecting')
      return 'enabled'
    })

    await checks.run('desktop shows a round-trip latency', async () => {
      await desktop.waitForFunction(
        () => /^\d+ ms$/.test(document.querySelector('[data-latency]').textContent.trim()),
        undefined,
        { timeout: LATENCY_TIMEOUT_MS }
      )
      return (await desktop.locator('[data-latency]').textContent()).trim()
    })

    await desktop.screenshot({ path: path.join(OUT_DIR, 'pairing-both-connected.png') })
    await phone.screenshot({ path: path.join(OUT_DIR, 'pairing-phone-connected.png') })

    if (recording) {
      await desktop.waitForTimeout(VIDEO_CONNECTED_HOLD_MS)
    }

    await checks.run(`phone sends ${tapTotal} taps`, async () => {
      for (let index = 0; index < tapTotal; index += 1) {
        await phone.click('#tap-zone')
        await phone.waitForTimeout(tapGapMs)
      }
      await phone.waitForFunction(
        (expected) => document.querySelector('[data-phone-taps]').textContent.trim() === expected,
        String(tapTotal),
        { timeout: TAP_ASSERT_TIMEOUT_MS }
      )
      return `phone counter ${tapTotal}`
    })

    await checks.run('desktop counts every tap', async () => {
      await desktop.waitForFunction(
        (expected) => {
          const pairing = window.__throwABall.pairing
          const taps = document.querySelector('[data-taps]').textContent.trim()
          return pairing.tapCount === expected && taps === String(expected)
        },
        tapTotal,
        { timeout: TAP_ASSERT_TIMEOUT_MS }
      )
      return `tapCount ${tapTotal}, [data-taps] ${tapTotal}`
    })

    await desktop.screenshot({ path: path.join(OUT_DIR, 'pairing-desktop-after-taps.png') })

    if (recording) {
      await desktop.waitForTimeout(VIDEO_TAIL_HOLD_MS)
    }

    await checks.run('no console or page errors', async () => {
      const problems = [
        ...diagnosticsProblems(desktopDiagnostics),
        ...diagnosticsProblems(phoneDiagnostics),
      ]
      assertTrue(problems.length === 0, problems.join(' | '))
      return 'both pages clean'
    })

    if (recording) {
      desktopVideoPath = await desktop.video().path()
      phoneVideoPath = await phone.video().path()
      await desktopContext.close()
      desktopContext = null
      await phoneContext.close()
      phoneContext = null

      await checks.run('side-by-side video composed', async () => {
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
    if (phoneContext !== null) {
      await phoneContext.close().catch(() => {})
    }
    if (desktopContext !== null) {
      await desktopContext.close().catch(() => {})
    }
    if (browser !== null) {
      await browser.close().catch(() => {})
    }
    await stopPeerServer(peerServer)
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
      () => reject(new Error(`e2e-pairing exceeded ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    )
  })
  try {
    const options = parseArgs(process.argv.slice(2))
    const exitCode = await Promise.race([runPairing(options), timeout])
    process.exitCode = exitCode
    console.log(exitCode === 0 ? '\ne2e-pairing: PASS' : '\ne2e-pairing: FAIL')
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err))
    console.log('\ne2e-pairing: FAIL')
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
  await flushOutput()
  process.exit(process.exitCode)
}

main()
