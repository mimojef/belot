/**
 * checkVoiceDiagnosticsPrerender.ts — Етап H3: заявката ?voicediag=1 оцелява ли,
 * когато Chrome е PRERENDER-нал страницата (въвеждане в адресната лента, вкл.
 * Android Chrome)?
 *
 * Prerender-ната страница има отделен sessionStorage, който се изхвърля при
 * активирането. Playwright/DevTools забранява prerender-а
 * (PrerenderingDisabledByDevTools), затова тук реалният Chromium се пуска БЕЗ
 * DevTools, а резултатът се докладва на preview сървъра.
 *
 *   [P0] контрола: обикновен (не prerender-нат) запис се пази
 *   [P1] production bundle, prerender на /lobby?voicediag=1 -> активиране ->
 *        sessionStorage на таба съдържа заявката (преди поправката: null)
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceDiagnosticsPrerender.ts
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { build, preview } from 'vite'
import { assert, check, finishAndExit } from './giftBackTestHarness'

console.log('\ncheckVoiceDiagnosticsPrerender\n')

const workDir = mkdtempSync(join(tmpdir(), 'pika-voicediag-prerender-'))
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
await build({ mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true } })
process.env.NODE_ENV = previousNodeEnv

// Само в копието: репортер в index.html (след активиране) + начална страница със speculation rules.
const indexPath = join(outDir, 'index.html')
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<head>', `<head><script>
  (function () {
    var was = document.prerendering === true
    function report() { setTimeout(function () {
      var nav = performance.getEntriesByType('navigation')[0]
      fetch('/__report?' + new URLSearchParams({ wasPrerendering: String(was), activationStart: String(nav && nav.activationStart), stored: String(sessionStorage.getItem('pika.voice.diag')) }))
    }, 2500) }
    if (document.prerendering) document.addEventListener('prerenderingchange', report, { once: true }); else report()
  })()
</script>`))
writeFileSync(join(outDir, 'start.html'), `<!doctype html><html><body><a id="go" href="/lobby?voicediag=1">go</a>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["/lobby?voicediag=1"]}]}</script>
<script>setTimeout(function () { document.getElementById('go').click() }, 6000)</script></body></html>`)

let deliver: (value: URLSearchParams | null) => void = () => {}
const server = await preview({
  root: process.cwd(), logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'voicediag-report', configurePreviewServer(s) {
    s.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/__report')) { next(); return }
      deliver(new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)))
      res.end('ok')
    })
  } }],
})
const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '')

async function run(url: string): Promise<URLSearchParams | null> {
  const result = new Promise<URLSearchParams | null>((resolve) => { deliver = resolve })
  const child = spawn(chromium.executablePath(), [`--user-data-dir=${mkdtempSync(join(workDir, 'profile-'))}`, '--no-first-run', '--no-default-browser-check', '--headless=new', url], { stdio: 'ignore' })
  const timer = setTimeout(() => deliver(null), 40_000)
  const value = await result
  clearTimeout(timer)
  child.kill()
  return value
}

try {
  await check('[P0] Контрола: директно зареждане на /lobby?voicediag=1 -> заявката е записана', async () => {
    const r = await run(`${origin}/lobby?voicediag=1`)
    assert(r !== null, 'отчет')
    assert(r.get('wasPrerendering') === 'false', 'без prerender')
    assert(r.get('stored') === '1', `записано (${r.get('stored')})`)
  })
  await check('[P1] Prerender (като адресната лента на Chrome) -> активиране -> заявката е в sessionStorage на таба', async () => {
    const r = await run(`${origin}/start.html`)
    assert(r !== null, 'отчет')
    assert(r.get('wasPrerendering') === 'true' && Number(r.get('activationStart')) > 0, `страницата е prerender-ната (${r.toString()})`)
    assert(r.get('stored') === '1', `заявката оцелява след активирането (${r.get('stored')})`)
  })
} finally {
  await server.close().catch(() => undefined)
  try { rmSync(workDir, { recursive: true, force: true }) } catch { /* Chromium може още да държи профила */ }
}
finishAndExit()
