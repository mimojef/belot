import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { assertWildcardPortFree, backendTestEnv, ownedHarnessPath, verifyHarnessIdentity } from './svaraRealIntegrationHarness'

let passed = 0, failed = 0
async function check(label: string, run: () => Promise<void> | void) {
  try { await run(); passed++; console.log(`  PASS ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}`, error) }
}
await check('wildcard ownership check refuses an existing listener, including the Windows loopback-probe trap', async () => {
  const owner = createServer()
  await new Promise<void>((done, reject) => { owner.once('error', reject); owner.listen(0, '0.0.0.0', done) })
  const address = owner.address()
  assert(address && typeof address !== 'string')
  try {
    await assert.rejects(assertWildcardPortFree(address.port), { code: 'EADDRINUSE' })
    const narrow = createServer()
    const accepted = await new Promise<boolean>((done) => {
      narrow.once('error', () => done(false))
      narrow.listen(address.port, '127.0.0.1', () => done(true))
    })
    if (accepted) await new Promise<void>((done) => narrow.close(() => done()))
    console.log(`       loopback-only probe accepted alongside wildcard owner: ${accepted}`)
  } finally { await new Promise<void>((done) => owner.close(() => done())) }
  await assertWildcardPortFree(address.port)
})
await check('backend environment cannot inherit production database, credentials, dotenv overrides or runtime flags', () => {
  const parent = { PATH: 'path', DATABASE_URL: 'production-db', EMAIL_VERIFICATION_CODE_SECRET: 'production-key',
    PASSWORD_RESET_RATE_LIMIT_SECRET: 'production-key', DOTENV_CONFIG_PATH: 'production.env', DOTENV_CONFIG_OVERRIDE: 'true',
    NODE_OPTIONS: '--require production-hook', SVARA_TEST_ENABLED: '0', CAMPAIGNS_FEATURE_ENABLED: '1' }
  const before = JSON.stringify(parent), env = backendTestEnv(parent, process.pid, 'nonce')
  assert.equal(env.PATH, 'path'); assert.equal(env.NODE_ENV, 'test'); assert.equal(env.PORT, '0')
  assert.equal(env.DATABASE_URL, undefined); assert.equal(env.DOTENV_CONFIG_PATH, undefined)
  assert.equal(env.DOTENV_CONFIG_OVERRIDE, undefined); assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.PASSWORD_RESET_RATE_LIMIT_SECRET, undefined); assert.equal(env.CAMPAIGNS_FEATURE_ENABLED, undefined)
  assert(env.EMAIL_VERIFICATION_CODE_SECRET!.length >= 32 && env.EMAIL_VERIFICATION_CODE_SECRET !== 'production-key')
  assert.equal(JSON.stringify(parent), before)
})
await check('identity proof rejects a different process, parent or nonce', () => {
  const message = { event: 'identity', nonce: 'ours', pid: 1234, parentPid: process.pid }
  verifyHarnessIdentity(message, 'ours', 1234)
  assert.throws(() => verifyHarnessIdentity(message, 'foreign', 1234))
  assert.throws(() => verifyHarnessIdentity(message, 'ours', 4321))
  assert.throws(() => verifyHarnessIdentity({ ...message, parentPid: process.pid + 1 }, 'ours', 1234))
})
await check('cleanup rejects the workspace, temp root itself and paths outside its owned temporary tree', () => {
  const root = join(tmpdir(), 'pika-svara-browser-check')
  assert.equal(ownedHarnessPath(root, join(root, 'server/database/data')), resolve(root, 'server/database/data'))
  assert.throws(() => ownedHarnessPath(process.cwd(), process.cwd()))
  assert.throws(() => ownedHarnessPath(tmpdir(), tmpdir()))
  assert.throws(() => ownedHarnessPath(root, join(root, '..', 'other')))
})

async function forbiddenHook(mode: string, ipc: boolean, validParent = true) {
  const env = backendTestEnv(process.env, validParent ? process.pid : process.pid + 1, randomUUID())
  env.NODE_ENV = mode
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/fixtures/svaraRealBackendHooks.mjs')).href, '-e', 'console.log("UNSAFE_BODY_REACHED")'], {
    env, windowsHide: true, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (chunk) => { output += chunk.toString() })
  child.stderr!.on('data', (chunk) => { output += chunk.toString() })
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done) })
  assert.notEqual(code, 0)
  assert(output.includes('requires test mode and a private parent IPC channel'))
  assert(!output.includes('UNSAFE_BODY_REACHED'))
}
await check('private fixture cannot activate with NODE_ENV=production, even with a matching IPC channel', () => forbiddenHook('production', true))
await check('private fixture cannot activate in test mode without IPC', () => forbiddenHook('test', false))
await check('private fixture cannot activate under a different parent', () => forbiddenHook('test', true, false))
await check('parent disconnect before server startup terminates the owned child instead of leaving it orphaned', async () => {
  const nonce = randomUUID()
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/fixtures/svaraRealBackendHooks.mjs')).href, '-e', 'setInterval(() => {}, 1000)'], {
    env: backendTestEnv(process.env, process.pid, nonce), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const exited = new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject) })
  try {
    await new Promise<void>((done) => child.once('message', (value) => { verifyHarnessIdentity(value, nonce, child.pid!); child.disconnect(); done() }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Orphaned test child')), 3000) })])
      assert.equal(code, 1)
    } finally { if (timer) clearTimeout(timer) }
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited } }
})
console.log(`Svara real integration infrastructure: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
