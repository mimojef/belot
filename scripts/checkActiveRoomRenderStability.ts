import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright'

declare global {
  interface Window {
    __activeRoomRenderStabilityResult?: {
      cutNodeStable: boolean
      cutCommandsAfterDoubleClick: number
      cutCommandsAfterRejectionRetry: number
      bidNodeStable: boolean
      bidCommands: number
      animatedCountersFirst: number
      animatedCountersDuplicate: number
      animatedCountersNewKey: number
      audioPlays: number
    }
  }
}

const port = 5197
const baseUrl = `http://127.0.0.1:${port}`

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${name}`)
    return
  }
  failed += 1
  console.error(`  FAIL ${name}`)
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

async function waitForVite(proc: ChildProcessWithoutNullStreams): Promise<void> {
  let output = ''
  const deadline = Date.now() + 20_000
  proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })

  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(output)
    if (plainOutput.includes('Local:') || plainOutput.includes(`:${port}`)) return
    if (proc.exitCode !== null) throw new Error(`Vite exited early with code ${proc.exitCode}:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for Vite:\n${output}`)
}

async function main(): Promise<void> {
  console.log('═══ checkActiveRoomRenderStability ═══')

  const vite = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  )

  try {
    await waitForVite(vite)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      page.on('pageerror', (error) => {
        console.error(`  browser error ${error.message}`)
      })
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
      await page.addScriptTag({
        type: 'module',
        url: `${baseUrl}/scripts/activeRoomRenderStability.browser.mjs`,
      })
      const result = await page.waitForFunction(() => window.__activeRoomRenderStabilityResult !== undefined)
        .then(() => page.evaluate(() => window.__activeRoomRenderStabilityResult))

      check('cutting countdown tick keeps cut node stable', result.cutNodeStable)
      check('cutting pointerdown -> tick -> click sends one command', result.cutCommandsAfterDoubleClick === 1)
      check('cutting double click is guarded and rejection releases pending', result.cutCommandsAfterRejectionRetry === 2)
      check('bidding countdown tick keeps bid button stable', result.bidNodeStable)
      check('bidding pointerdown -> tick -> click sends one command', result.bidCommands === 1)
      check('first scoring key animates counters once', result.animatedCountersFirst === 2)
      check('duplicate scoring key does not reanimate counters', result.animatedCountersDuplicate === 0)
      check('new scoring key animates counters again', result.animatedCountersNewKey === 2)
      check('scoring sound plays exactly for the two unique scoring keys', result.audioPlays === 2)
    } finally {
      await browser.close()
    }
  } finally {
    vite.kill()
    if (vite.exitCode === null) {
      await Promise.race([
        once(vite, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    }
  }

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
