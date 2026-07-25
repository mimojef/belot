/**
 * checkDebouncedPlayerSearch.ts
 *
 * Unit тестове за createDebouncedPlayerSearch (src/app/lobby/createDebouncedPlayerSearch.ts) —
 * чист, DOM-независим debounce + "latest-request-wins" helper, ползван за
 * server-side players search (виж checkPlayersSearch.ts за store/HTTP теста).
 *
 * [1] Debounce: няколко бързи schedule() повиквания → само ЕДНО реално run()
 *     извикване, с последния query.
 * [2] Latest-wins: по-стара (in-flight) заявка, отменена от по-нова, дори
 *     ако resolve-не СЛЕД по-новата, не презаписва резултата.
 * [3] cancel() преди debounce timer-ът да е изпукал → run() никога не се вика.
 * [4] Отменена (aborted) заявка не води до onResult с грешка.
 * [5] Обикновен успешен резултат (без race) → onResult с ok:true и вярна стойност.
 * [6] Грешка от run() (не abort) за най-новата заявка → onResult с ok:false.
 */

import { createDebouncedPlayerSearch } from '../../src/app/lobby/createDebouncedPlayerSearch.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

console.log('\ncheckDebouncedPlayerSearch')

// ─── [1] Debounce coalescing ────────────────────────────────────────────────

await check('[1] Debounce: няколко бързи schedule() → само едно run() с последния query', async () => {
  const runCalls: string[] = []
  const results: string[] = []

  const runner = createDebouncedPlayerSearch<string>({
    run: async (query) => {
      runCalls.push(query)
      return query
    },
    onResult: (result) => {
      if (result.ok) results.push(result.value)
    },
    delayMs: 40,
  })

  runner.schedule('a')
  runner.schedule('ab')
  runner.schedule('abc')

  await sleep(120)

  assert(runCalls.length === 1, `run() трябва да е извикан точно 1 път, извикан ${runCalls.length} пъти`)
  assert(runCalls[0] === 'abc', `run() трябва да получи последния query "abc", получи "${runCalls[0]}"`)
  assert(results.length === 1 && results[0] === 'abc', 'onResult трябва да получи резултат само за "abc"')
})

// ─── [2] Latest-wins: закъснял stale отговор не презаписва по-новия ────────

await check('[2] Latest-wins: закъснял (по-стар) отговор не презаписва по-новия', async () => {
  const firstDeferred = deferred<string>()
  const secondDeferred = deferred<string>()
  const results: Array<{ ok: boolean; query: string }> = []

  const runner = createDebouncedPlayerSearch<string>({
    run: async (query) => {
      if (query === 'first') {
        return await firstDeferred.promise
      }
      return await secondDeferred.promise
    },
    onResult: (result) => {
      results.push({ ok: result.ok, query: result.query })
    },
    delayMs: 10,
  })

  runner.schedule('first')
  await sleep(40) // 'first' е вече in-flight (debounce е изпукал, run() е стартирал)

  runner.schedule('second')
  await sleep(40) // 'second' е вече in-flight, 'first' трябва да е abort-нат

  // Резолвваме 'second' ПЪРВО, после закъснелия 'first' — 'first' е логически
  // по-стар (изпреварен), независимо от реалния ред на resolve.
  secondDeferred.resolve('second-value')
  await sleep(10)
  firstDeferred.resolve('first-value')
  await sleep(10)

  assert(results.length === 1, `onResult трябва да е извикан точно веднъж, извикан е ${results.length} пъти`)
  assert(results[0]!.query === 'second', `очакван резултат за "second", получен за "${results[0]!.query}"`)
})

// ─── [3] cancel() преди timer-ът да изпука ──────────────────────────────────

await check('[3] cancel() преди debounce timer да изпука → run() никога не се вика', async () => {
  let runCalled = false

  const runner = createDebouncedPlayerSearch<string>({
    run: async (query) => {
      runCalled = true
      return query
    },
    onResult: () => {},
    delayMs: 40,
  })

  runner.schedule('query')
  runner.cancel()

  await sleep(100)

  assert(!runCalled, 'run() не трябва да бъде извикан след cancel()')
})

// ─── [4] Отменена in-flight заявка → без onResult грешка ───────────────────

await check('[4] Отменена in-flight заявка не води до onResult с грешка', async () => {
  const results: Array<{ ok: boolean }> = []
  let sawAbort = false

  const runner = createDebouncedPlayerSearch<string>({
    run: (_query, signal) =>
      new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    onResult: (result) => {
      results.push({ ok: result.ok })
    },
    delayMs: 10,
  })

  runner.schedule('query')
  await sleep(30) // run() е стартирал, чака abort сигнал

  runner.cancel()
  await sleep(30)

  assert(sawAbort, 'signal трябва да получи abort event')
  assert(results.length === 0, `onResult не трябва да бъде извикан при cancel-натa заявка, извикан е ${results.length} пъти`)
})

// ─── [5] Обикновен успешен резултат ─────────────────────────────────────────

await check('[5] Обикновен успешен резултат → onResult с ok:true и вярна стойност', async () => {
  const results: Array<{ ok: boolean; value?: unknown }> = []

  const runner = createDebouncedPlayerSearch<string[]>({
    run: async (query) => [query, 'extra'],
    onResult: (result) => {
      results.push(result.ok ? { ok: true, value: result.value } : { ok: false })
    },
    delayMs: 10,
  })

  runner.schedule('mimo')
  await sleep(60)

  assert(results.length === 1, `очакван точно 1 резултат, получени ${results.length}`)
  assert(results[0]!.ok === true, 'резултатът трябва да е ok:true')
  assert(
    Array.isArray(results[0]!.value) && (results[0]!.value as string[])[0] === 'mimo',
    'резултатът трябва да съдържа очакваната стойност',
  )
})

// ─── [6] Реална грешка (не abort) за най-новата заявка → ok:false ──────────

await check('[6] Реална грешка (не abort) → onResult с ok:false', async () => {
  const results: Array<{ ok: boolean }> = []

  const runner = createDebouncedPlayerSearch<string>({
    run: async () => {
      throw new Error('network down')
    },
    onResult: (result) => {
      results.push({ ok: result.ok })
    },
    delayMs: 10,
  })

  runner.schedule('query')
  await sleep(60)

  assert(results.length === 1, `очакван точно 1 резултат, получени ${results.length}`)
  assert(results[0]!.ok === false, 'резултатът трябва да е ok:false')
})

// ─── Резюме ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
