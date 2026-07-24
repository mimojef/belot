/**
 * checkBootstrapRecovery.ts
 *
 * Regression check за index.html bootstrap-recovery поправката:
 *  - recovery-то преди винаги хардкоднато водеше до /lobby, независимо от
 *    реалния path, откъдето потребителят е дошъл (/, /strategy и т.н.) —
 *    отделен routing дефект, докладван заедно с production PWA/deploy
 *    инцидента.
 *  - добавен е ЕДИН автоматичен recovery опит (unregister SW + clear caches
 *    + reload на СЪЩИЯ URL) преди да се покаже ръчният бутон, с
 *    sessionStorage guard срещу безкраен reload loop.
 *
 * Реален браузър (Playwright), реален build, реален статичен сървър — не
 * regex/source-text проверки. Bootstrap провал се симулира чрез мрежово
 * блокиране на главния module script (route interception), точно каквото
 * би причинило доказания deploy-race дефект (стар client, вече изтрит asset).
 *
 * Покрива:
 *  [6]  Recovery от / остава на /
 *  [7]  Recovery от /lobby остава на /lobby
 *  [8]  Recovery от /strategy остава на /strategy
 *  [9]  Query и hash параметри се запазват през recovery цикъла
 *  [10] recoveryReload се премахва от URL-а след успешно зареждане
 *  [11] Няма безкраен recovery reload loop — точно ЕДИН автоматичен опит,
 *       после ръчен бутон, без по-нататъшни автоматични reload-и
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { chromium, type Browser } from 'playwright'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

const PROJECT_ROOT = process.cwd()
const DIST_DIR = join(PROJECT_ROOT, 'dist')
const PORT = 4931

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
}

function startStaticServer() {
  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      let filePath = join(DIST_DIR, urlPath === '/' ? '/index.html' : urlPath)
      try {
        const st = await stat(filePath)
        if (st.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        if (!extname(urlPath)) filePath = join(DIST_DIR, 'index.html')
      }
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404')
    }
  }).listen(PORT, '127.0.0.1')
}

function runBuild(): Promise<void> {
  return new Promise((resolveBuild, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn('npx', ['vite', 'build'], { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('exit', (code) => code === 0 ? resolveBuild() : reject(new Error(out.slice(-1000))))
  })
}

console.log('\ncheckBootstrapRecovery\n')
console.log('Build-вам dist (нужен е за реален index.html/main script)...')
await runBuild()

const server = startStaticServer()
await sleep(300)

let browser: Browser | null = null

try {
  browser = await chromium.launch({ headless: true })

  // ─── [6]-[10]: recovery преживява path + query + hash, self-heal сценарий ──
  const scenarios: Array<{ label: string; path: string; query: string; hash: string }> = [
    { label: '[6] /', path: '/', query: '', hash: '' },
    { label: '[7] /lobby', path: '/lobby', query: '', hash: '' },
    { label: '[8] /strategy', path: '/strategy', query: '?utm_source=test&foo=bar', hash: '#section-2' },
  ]

  for (const scenario of scenarios) {
    const context = await browser.newContext()
    const page = await context.newPage()

    let scriptRequestCount = 0
    let blockActive = true
    await page.route('**/assets/index-*.js', async (route) => {
      scriptRequestCount++
      if (blockActive) {
        // Симулира точно доказания production дефект: стар client иска
        // main script-а, който вече не съществува / все още не е publish-нат.
        blockActive = false // само ПЪРВОТО искане е блокирано — retry-то ще успее
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })

    const targetUrl = `http://127.0.0.1:${PORT}${scenario.path}${scenario.query}${scenario.hash}`
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })

    // Изчакваме auto-retry цикъла: 5s bootstrap timeout + unregister SW/
    // clear caches + reload + реално зареждане на новия (unblocked) script.
    await page.waitForFunction(
      () => document.getElementById('app')?.children.length ?? 0 > 0,
      { timeout: 20_000 },
    ).catch(() => { /* проверяваме реалното състояние по-долу, за по-добра диагностика */ })

    const finalUrl = new URL(page.url())

    await check(`${scenario.label}: pathname остава ${scenario.path} след recovery`, () => {
      if (finalUrl.pathname !== scenario.path) throw new Error(`pathname=${finalUrl.pathname}, очакван ${scenario.path}`)
    })
    if (scenario.query) {
      await check(`${scenario.label}: query параметрите са запазени`, () => {
        const expectedParams = new URLSearchParams(scenario.query)
        for (const [k, v] of expectedParams) {
          if (finalUrl.searchParams.get(k) !== v) throw new Error(`${k}=${finalUrl.searchParams.get(k)}, очакван ${v}`)
        }
      })
    }
    if (scenario.hash) {
      await check(`${scenario.label}: hash е запазен (${scenario.hash})`, () => {
        if (finalUrl.hash !== scenario.hash) throw new Error(`hash=${finalUrl.hash}, очакван ${scenario.hash}`)
      })
    }
    await check(`${scenario.label}: recoveryReload е премахнат от URL-а след успешно зареждане`, () => {
      if (finalUrl.searchParams.has('recoveryReload')) throw new Error(`URL все още съдържа recoveryReload: ${finalUrl.href}`)
    })
    await check(`${scenario.label}: #app реално е populated (не е застинал в recovery екрана)`, async () => {
      const childCount = await page.evaluate(() => document.getElementById('app')?.children.length ?? 0)
      if (childCount === 0) throw new Error('app е все още празен след recovery цикъла')
    })
    await check(`${scenario.label}: ръчният recovery бутон НЕ се вижда (auto-retry-то реши проблема)`, async () => {
      const btnExists = await page.evaluate(() => !!document.getElementById('pika-bootstrap-recovery'))
      if (btnExists) throw new Error('Recovery overlay все още е в DOM след успешен auto-retry')
    })

    await context.close()
  }

  // ─── [11]: loop guard — постоянен провал → точно ЕДИН auto-retry, после бутон ──
  console.log('\nТествам loop guard (постоянен bootstrap провал)...')
  const loopContext = await browser.newContext()
  const loopPage = await loopContext.newPage()

  let blockedRequestCount = 0
  await loopPage.route('**/assets/index-*.js', async (route) => {
    blockedRequestCount++
    await route.abort('failed') // ВИНАГИ блокиран — реален "неотстранен deploy дефект"
  })

  await loopPage.goto(`http://127.0.0.1:${PORT}/lobby`, { waitUntil: 'domcontentloaded' })

  // Изчакай auto-retry-то да се случи (5s timeout + reload).
  await sleep(7_000)
  const requestCountAfterAutoRetry = blockedRequestCount

  await check('[11a] Auto-retry реално се е опитал (поне 2 заявки за script-а: original + retry)', () => {
    if (requestCountAfterAutoRetry < 2) throw new Error(`заявки=${requestCountAfterAutoRetry}, очаквах поне 2 (original load + auto-retry reload)`)
  })

  // Изчакай ощ 5s (поредния bootstrap-timeout прозорец) — recovery бутонът
  // трябва да се появи, БЕЗ трети автоматичен reload.
  await sleep(6_000)
  const requestCountAfterSecondWindow = blockedRequestCount

  await check('[11b] Recovery бутонът се показва след неуспешен auto-retry', async () => {
    const btnExists = await loopPage.evaluate(() => !!document.getElementById('pika-bootstrap-recovery-btn'))
    if (!btnExists) throw new Error('Ръчният бутон не се появи след неуспешния auto-retry')
  })
  await check('[11c] НЯМА трети/безкраен автоматичен reload — заявките за script-а спират да растат сами', () => {
    if (requestCountAfterSecondWindow > requestCountAfterAutoRetry) {
      throw new Error(`заявки продължиха да растат без user action: ${requestCountAfterAutoRetry} -> ${requestCountAfterSecondWindow} (infinite loop риск)`)
    }
  })

  await check('[11d] sessionStorage guard е зададен (auto-retry вече консумиран за тази сесия)', async () => {
    const guardValue = await loopPage.evaluate(() => {
      try { return sessionStorage.getItem('pika-bootstrap-recovery-auto-retry') } catch { return null }
    })
    if (guardValue !== '1') throw new Error(`guard=${guardValue}, очакван "1"`)
  })

  await loopContext.close()
} finally {
  if (browser) await browser.close()
  server.close()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
