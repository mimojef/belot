/**
 * checkVoiceCreateOption.ts — Етап 4: опцията „Гласов чат“ във формата
 * „Нова маса“ (GET /api/voice/create-option). Само четене: чиста функция
 * describeVoiceTableCreationOption + HTTP слоя (метод, сесия, no-store).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceCreateOption.ts   (от server/)
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describeVoiceTableCreationOption } from '../src/voice/voiceChatEligibility.js'
import { createVoiceChatHttpRequestHandler } from '../src/voice/voiceChatHttpApi.js'
import type { VoiceChatMode } from '../src/voice/voiceChatTypes.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

const option = (mode: VoiceChatMode, requester: { isFullAdmin?: boolean; isVipActive?: boolean; isBanned?: boolean; profileId?: string | null }, emergencyStop = false) =>
  describeVoiceTableCreationOption({
    mode: { storedMode: mode, emergencyStop },
    requester: {
      profileId: requester.profileId === undefined ? 'p1' : requester.profileId,
      isFullAdmin: requester.isFullAdmin ?? false,
      isVipActive: requester.isVipActive ?? false,
      isBanned: requester.isBanned ?? false,
    },
  })

const HIDDEN = { visible: false, canCreate: false, reason: null }
const LOCKED = { visible: true, canCreate: false, reason: 'vip_required' }
const OPEN = { visible: true, canCreate: true, reason: null }

console.log('\ncheckVoiceCreateOption\n')

await check('[O1] „Изключен“ и авариен стоп: редът не се показва на никого (вкл. VIP админ)', () => {
  assertEqual(option('off', { isFullAdmin: true, isVipActive: true }), HIDDEN, 'off')
  assertEqual(option('public', { isVipActive: true }, true), HIDDEN, 'авариен стоп')
})

await check('[O2] „Само админ“: само пълен админ вижда реда; админ без VIP -> заключен (без VIP bypass)', () => {
  assertEqual(option('admin_only', { isVipActive: true }), HIDDEN, 'VIP не-админ')
  assertEqual(option('admin_only', { isFullAdmin: true }), LOCKED, 'админ без VIP')
  assertEqual(option('admin_only', { isFullAdmin: true, isVipActive: true }), OPEN, 'админ с VIP')
})

await check('[O3] „Активен“: VIP -> отворен; без VIP -> заключен (VIP прозорец); бан / гост -> скрит', () => {
  assertEqual(option('public', { isVipActive: true }), OPEN, 'VIP')
  assertEqual(option('public', {}), LOCKED, 'без VIP')
  assertEqual(option('public', { isVipActive: true, isBanned: true }), HIDDEN, 'бан')
  assertEqual(option('public', { profileId: null }), HIDDEN, 'гост')
})

await check('[O4] HTTP: само GET, изисква сесия, no-store, без резервация; другите пътища не се засягат', async () => {
  let described = 0
  const handler = createVoiceChatHttpRequestHandler({
    service: {
      describeCreationOption: ({ profileId, isFullAdmin }) => {
        described += 1
        return profileId === 'vip' && !isFullAdmin ? OPEN as never : LOCKED as never
      },
      handleTokenRequest: async () => { throw new Error('unused') },
      handleSpeakAccessRequest: async () => { throw new Error('unused') },
    },
    getSessionProfileId: (req) => (req.headers['x-test-profile'] as string | undefined) ?? null,
    isFullAdminProfile: (profileId) => profileId === 'admin',
    isAllowedOrigin: () => true,
    readJsonBody: async () => ({}),
  })
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) { res.writeHead(404); res.end() }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice`
  try {
    assertEqual((await fetch(`${base}/create-option`, { method: 'POST' })).status, 405, 'POST')
    assertEqual((await fetch(`${base}/create-option`)).status, 401, 'без сесия')
    const vip = await fetch(`${base}/create-option`, { headers: { 'x-test-profile': 'vip' } })
    assertEqual(vip.status, 200, 'успех')
    assertEqual(vip.headers.get('cache-control'), 'no-store', 'no-store')
    assertEqual(await vip.json(), { ok: true, ...OPEN }, 'тяло')
    const admin = await fetch(`${base}/create-option`, { headers: { 'x-test-profile': 'admin' } })
    assertEqual(await admin.json(), { ok: true, ...LOCKED }, 'isFullAdmin се подава към service-а')
    assertEqual(described, 2, 'service-ът се вика само при валидна сесия')
    assertEqual((await fetch(`${base}/other`)).status, 404, 'непознат път')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
