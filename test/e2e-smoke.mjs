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
const THREE_VERSION = '0.185.1'
const THREE_CACHE_DIR = path.join(HERE, '.cache', 'three', THREE_VERSION)
const THREE_PACKAGE_REL = 'package'
const THREE_MODULE_REL = path.join(THREE_PACKAGE_REL, 'build', 'three.module.js')
const THREE_CDN_PREFIX = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/`
const VIEWPORT = { width: 1280, height: 720 }
const OVERALL_TIMEOUT_MS = 90000
const SETTLE_MS = 500

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

function resolvePlaywright() {
  const require = createRequire(import.meta.url)
  try {
    return require('playwright')
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return require(path.join(globalRoot, 'playwright'))
  }
}

async function ensureThreeCache() {
  const packageDir = path.join(THREE_CACHE_DIR, THREE_PACKAGE_REL)
  const modulePath = path.join(THREE_CACHE_DIR, THREE_MODULE_REL)
  if (fs.existsSync(modulePath)) {
    return packageDir
  }
  fs.mkdirSync(THREE_CACHE_DIR, { recursive: true })
  const tarballUrl = `https://registry.npmjs.org/three/-/three-${THREE_VERSION}.tgz`
  const response = await fetch(tarballUrl)
  if (!response.ok) {
    throw new Error(`fetch ${tarballUrl} failed: ${response.status} ${response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const tarballPath = path.join(os.tmpdir(), `three-${THREE_VERSION}-${process.pid}.tgz`)
  fs.writeFileSync(tarballPath, buffer)
  try {
    execFileSync('tar', ['-xzf', tarballPath, '-C', THREE_CACHE_DIR])
  } finally {
    fs.rmSync(tarballPath, { force: true })
  }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`expected ${modulePath} after extracting ${tarballUrl}`)
  }
  return packageDir
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

function startServer(rootDir) {
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
    const message = err && err.message ? err.message : String(err)
    if (!/executable doesn't exist/i.test(message)) {
      throw err
    }
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  }
}

async function installExternalRouting(context, threePackageDir, ownAbortedUrls) {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(THREE_CDN_PREFIX)) {
      const relPath = url.slice(THREE_CDN_PREFIX.length).split('?')[0]
      const filePath = path.join(threePackageDir, relPath)
      if (isPathInside(filePath, threePackageDir) && fs.existsSync(filePath)) {
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

function attachDiagnostics(page, ownAbortedUrls) {
  const consoleErrors = []
  const pageErrors = []
  const requestFailures = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err && err.message ? err.message : String(err))
  })
  page.on('requestfailed', (request) => {
    if (ownAbortedUrls.has(request.url())) {
      return
    }
    const failure = request.failure()
    requestFailures.push(`${request.url()} :: ${failure ? failure.errorText : 'unknown failure'}`)
  })
  return { consoleErrors, pageErrors, requestFailures }
}

async function checkDesktopExtras(page) {
  const notes = []
  try {
    await page.waitForFunction(() => window.__throwABall != null, { timeout: 5000 })
  } catch {
    notes.push('window.__throwABall did not appear within 5s')
    return notes
  }
  const canvasSize = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    return canvas ? { width: canvas.width, height: canvas.height } : null
  })
  if (!canvasSize) {
    notes.push('no <canvas> element found')
  } else if (canvasSize.width <= 0 || canvasSize.height <= 0) {
    notes.push(`canvas has zero size: ${canvasSize.width}x${canvasSize.height}`)
  }
  return notes
}

async function checkPage(browser, { name, url, screenshotPath, isDesktop, threePackageDir }) {
  const ownAbortedUrls = new Set()
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  const diagnostics = attachDiagnostics(page, ownAbortedUrls)
  await installExternalRouting(context, threePackageDir, ownAbortedUrls)

  const extraNotes = []
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 30000 })
    await page.waitForTimeout(SETTLE_MS)
    if (isDesktop) {
      extraNotes.push(...(await checkDesktopExtras(page)))
    }
    await page.screenshot({ path: screenshotPath })
  } finally {
    await context.close()
  }

  return { name, url, screenshotPath, extraNotes, ...diagnostics }
}

function summarize(result) {
  const lines = []
  lines.push(`--- ${result.name} (${result.url}) ---`)
  lines.push(`screenshot: ${result.screenshotPath}`)
  lines.push(`console errors: ${result.consoleErrors.length}`)
  result.consoleErrors.forEach((entry) => lines.push(`  ${entry}`))
  lines.push(`page errors: ${result.pageErrors.length}`)
  result.pageErrors.forEach((entry) => lines.push(`  ${entry}`))
  lines.push(`request failures: ${result.requestFailures.length}`)
  result.requestFailures.forEach((entry) => lines.push(`  ${entry}`))
  if (result.extraNotes.length > 0) {
    lines.push(`notes: ${result.extraNotes.length}`)
    result.extraNotes.forEach((entry) => lines.push(`  ${entry}`))
  }
  return lines.join('\n')
}

function resultHasFailure(result) {
  return (
    result.consoleErrors.length > 0 ||
    result.pageErrors.length > 0 ||
    result.requestFailures.length > 0 ||
    result.extraNotes.length > 0
  )
}

async function runSmoke() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { chromium } = resolvePlaywright()
  const threePackageDir = await ensureThreeCache()
  const server = await startServer(REPO_ROOT)
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  const browser = await launchBrowser(chromium)
  try {
    const pages = [
      {
        name: 'desktop',
        url: `${baseUrl}/`,
        screenshotPath: path.join(OUT_DIR, 'desktop.png'),
        isDesktop: true,
        threePackageDir,
      },
      {
        name: 'phone',
        url: `${baseUrl}/phone/`,
        screenshotPath: path.join(OUT_DIR, 'phone.png'),
        isDesktop: false,
        threePackageDir,
      },
    ]
    const results = []
    for (const pageSpec of pages) {
      results.push(await checkPage(browser, pageSpec))
    }
    results.forEach((result) => console.log(summarize(result)))
    const anyFailure = results.some(resultHasFailure)
    return anyFailure ? 1 : 0
  } finally {
    await browser.close().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  let timeoutHandle
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`e2e-smoke exceeded ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS
    )
  })
  try {
    const exitCode = await Promise.race([runSmoke(), timeout])
    process.exitCode = exitCode
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err))
    process.exitCode = 1
  } finally {
    clearTimeout(timeoutHandle)
  }
}

main()
