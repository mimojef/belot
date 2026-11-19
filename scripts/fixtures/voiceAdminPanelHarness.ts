/**
 * Визуален harness за админ панела „Гласови разговори“ (Етап 6) — реалният
 * showAdminVoiceChatPanel с ФИКСИРАНИ отговори вместо мрежа. Сценарий от
 * query-то: ?scenario=full|unconfigured|offline|computing|forbidden.
 * Само за scripts/checkVoiceAdminPanel.ts; не влиза в production build-а.
 */

import { showAdminVoiceChatPanel } from '../../src/app/adminVoiceChat/showAdminVoiceChatPanel'

type Scenario = 'full' | 'unconfigured' | 'offline' | 'computing' | 'forbidden'
const params = new URLSearchParams(location.search)
const scenario = (params.get('scenario') ?? 'full') as Scenario
const refreshMs = Number(params.get('refresh') ?? '0')

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

let mode: 'off' | 'admin_only' | 'public' = scenario === 'unconfigured' ? 'off' : 'admin_only'
let maxTables = 10
const history = [
  { changeId: 'c3', setting: 'max_tables', newValue: '10', previousValue: '6', changedAt: iso(-3_600_000), changedByDisplayName: 'Админ' },
  { changeId: 'c2', setting: 'mode', newValue: 'admin_only', previousValue: 'off', changedAt: iso(-7_200_000), changedByDisplayName: 'Админ' },
] as Array<{ changeId: string; setting: 'mode' | 'max_tables'; newValue: string; previousValue: string | null; changedAt: string; changedByDisplayName: string | null }>

const requests: Array<{ method: string; path: string; body: unknown }> = []

// Като реалния сървър: setMode('off') освобождава масите в същата транзакция
// (резервациите стават 0), а живите LiveKit стаи минават в delete_pending —
// потвърждението идва асинхронно (тук: след ?confirmAfter GET-а, по подразбиране никога).
let released = false
let pendingDeletions = scenario === 'offline' ? 2 : 0
let getsSinceOff = 0
const confirmAfter = Number(params.get('confirmAfter') ?? 'Infinity')

function base() {
  const configured = scenario !== 'unconfigured'
  return {
    ok: true,
    mode,
    effectiveMode: mode,
    emergencyStop: false,
    modeChangedAt: iso(-7_200_000),
    modeChangedByDisplayName: 'Админ',
    maxTables,
    maxTablesUpperBound: 200,
    activeVoiceTables: !released && (scenario === 'full' || scenario === 'computing') ? 3 : 0,
    pendingRoomDeletions: pendingDeletions,
    liveKit: configured ? { configured: true, missing: [] } : { configured: false, missing: ['LIVEKIT_API_URL', 'LIVEKIT_WS_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'VOICE_ROOM_NAMESPACE'] },
    vpsMetrics: configured ? { configured: true, missing: [] } : { configured: false, missing: ['VOICE_VPS_METRICS_URL', 'VOICE_VPS_METRICS_USERNAME', 'VOICE_VPS_METRICS_PASSWORD'] },
    history,
  }
}

const quality = (intervalMean: number | null, lifetimeMean: number | null, current: number | null = null) => ({ intervalMean, lifetimeMean, intervalCount: intervalMean === null ? 0 : 38, current })

function liveTables() {
  if (scenario === 'unconfigured' || released) return []
  const rows = [
    { voiceTableId: '3f2a9c1e-0b7d-4e8a-9f11-aa00bb11cc22', phase: 'in_game', createdAt: iso(-42 * 60_000), inGameAt: iso(-35 * 60_000), liveRoomName: 'pv_prod_x_g1', generation: 1, seatedMembers: 4, activeVoiceSessions: 4, blocked: null, roomExists: true, counts: { participants: 4, microphoneOn: 3, listening: 1 } },
    { voiceTableId: '8d41b7f0-2c9e-4a53-8e77-112233445566', phase: 'in_game', createdAt: iso(-18 * 60_000), inGameAt: iso(-12 * 60_000), liveRoomName: 'pv_prod_y_g2', generation: 2, seatedMembers: 4, activeVoiceSessions: 2, blocked: 'rotation_pending', roomExists: true, counts: { participants: 2, microphoneOn: 1, listening: 1 } },
    { voiceTableId: 'c09e5512-7a1b-4f6d-b2c3-998877665544', phase: 'waiting', createdAt: iso(-4 * 60_000), inGameAt: null, liveRoomName: null, generation: null, seatedMembers: 2, activeVoiceSessions: 0, blocked: null, roomExists: false, counts: { participants: 0, microphoneOn: 0, listening: 0 } },
  ]
  if (scenario === 'offline') return rows.slice(0, 2).map((row) => ({ ...row, roomExists: null, counts: { participants: null, microphoneOn: null, listening: null } }))
  return rows
}

function monitoring() {
  const offline = scenario === 'offline'
  const unconfigured = scenario === 'unconfigured'
  const computing = scenario === 'computing'
  const tables = liveTables()
  const lkSource = unconfigured ? { status: 'not_configured', reason: null, lastSuccessAt: null } : offline ? { status: 'unavailable', reason: 'timeout', lastSuccessAt: iso(-11 * 60_000) } : { status: 'ok', reason: null, lastSuccessAt: iso(-3_000) }
  const hostSource = unconfigured ? { status: 'not_configured', reason: null, lastSuccessAt: null } : offline ? { status: 'unavailable', reason: 'http_401', lastSuccessAt: iso(-11 * 60_000) } : { status: 'ok', reason: null, lastSuccessAt: iso(-3_000) }
  const hostOk = hostSource.status === 'ok'
  const lkOk = lkSource.status === 'ok'
  const rate = (value: number) => (hostOk && !computing ? value : null)
  return {
    ok: true,
    generatedAt: iso(0),
    live: {
      status: unconfigured ? 'not_configured' : offline ? 'unavailable' : 'ok',
      reason: offline ? 'breaker_open' : null,
      sampledAt: offline || unconfigured ? null : iso(-3_000),
      totals: offline || unconfigured
        ? { reservedTables: tables.length, activeRooms: null, participants: null, microphoneOn: null, listening: null }
        : released
          ? { reservedTables: 0, activeRooms: 0, participants: 0, microphoneOn: 0, listening: 0 }
          : { reservedTables: 3, activeRooms: 2, participants: 6, microphoneOn: 4, listening: 2 },
      tables,
    },
    vps: {
      configured: !unconfigured,
      sampledAt: unconfigured ? null : iso(-3_000),
      rateWindowSeconds: hostOk && !computing ? 20 : null,
      liveKit: {
        ...lkSource,
        version: lkOk ? '1.13.11' : null,
        processStartedAt: lkOk ? iso(-3 * 86_400_000 - 5 * 3_600_000) : null,
        uptimeSeconds: lkOk ? 3 * 86_400 + 5 * 3_600 : null,
        rooms: lkOk ? 2 : null,
        participants: lkOk ? 6 : null,
        tracksPublished: lkOk ? 4 : null,
        tracksSubscribed: lkOk ? 14 : null,
        participantJoins: { total: lkOk ? 128 : null, byLabel: [] },
        quality: lkOk
          ? { rttMs: quality(computing ? null : 38.4, 41.2), jitterUs: quality(computing ? null : 4_200, 5_100), packetLossPercent: quality(computing ? null : 0.18, 0.31), qualityScore: quality(null, null, 4.6), qualityRating: quality(null, null, 2.9), joinLatencyMs: quality(computing ? null : 412, 455) }
          : { rttMs: quality(null, null), jitterUs: quality(null, null), packetLossPercent: quality(null, null), qualityScore: quality(null, null), qualityRating: quality(null, null), joinLatencyMs: quality(null, null) },
      },
      host: {
        ...hostSource,
        bootedAt: hostOk ? iso(-12 * 86_400_000) : null,
        uptimeSeconds: hostOk ? 12 * 86_400 + 4 * 3_600 : null,
        cpuCount: hostOk ? 4 : null,
        cpuBusyPercent: rate(17.6),
        cpuStealPercent: rate(3.4),
        perCpu: hostOk ? [
          { cpu: '0', busyPercent: rate(22.1), stealPercent: rate(4.2) },
          { cpu: '1', busyPercent: rate(14.8), stealPercent: rate(2.9) },
          { cpu: '2', busyPercent: rate(19.3), stealPercent: rate(3.8) },
          { cpu: '3', busyPercent: rate(14.2), stealPercent: rate(2.7) },
        ] : [],
        cpuPressureWaitingPercent: rate(0.8),
        load: hostOk ? { one: 0.42, five: 0.37, fifteen: 0.31 } : { one: null, five: null, fifteen: null },
        memory: hostOk ? { totalBytes: 8 * 1024 ** 3, availableBytes: 6.9 * 1024 ** 3, usedPercent: 13.75, swapUsedBytes: 0 } : { totalBytes: null, availableBytes: null, usedPercent: null, swapUsedBytes: null },
        network: hostOk ? [{ device: 'eth0', receiveBytesPerSecond: rate(61_250), transmitBytesPerSecond: rate(178_400), receiveBytesTotal: 412 * 1024 ** 3, transmitBytesTotal: 1.3 * 1024 ** 4 }] : [],
      },
    },
    server: {
      since: iso(-26 * 3_600_000),
      liveKitConfigured: !unconfigured,
      breaker: offline ? 'open' : 'closed',
      activeVoiceSessions: offline || unconfigured ? 0 : 6,
      reconciler: { uncertainWatches: 0, pendingUncertainMarks: 0, bootSweepPending: false, createsInFlight: 0 },
      tokensIssued: unconfigured ? 0 : 57,
      tokensDenied: unconfigured ? 0 : 9,
      tokensDeniedByCode: unconfigured ? {} : { voice_rotation_pending: 4, invalid_session: 2, spectator: 2, voice_unavailable: offline ? 1 : 1 },
      tokensDiscardedStale: 1,
      rotations: unconfigured ? 0 : 5,
      rotationsByReason: unconfigured ? {} : { listen_revoked: 3, session_displaced: 1, boot_rotation: 1 },
      sessionEndsByReason: unconfigured ? {} : { 'left_table:page_hide': 2, 'left_table:context_changed': 1, 'left_table:unspecified': 3, lease_expired: 1, game_connection_lost: 1 },
      bindingEndsByReason: unconfigured ? {} : { 'left_table:rotation': 4, 'session_replaced:rotation': 1, 'left_table:no_rotation': 2 },
      presenceDeniedByCode: unconfigured ? {} : { not_seat_connection: 2 },
      tokenLeaseMargin: unconfigured ? {} : { gt30s: 40, '15to30s': 9, lt5s: 1 },
      createRoomFailures: offline ? 3 : 0,
      leaseExpired: unconfigured ? 0 : 2,
      disconnectTimeouts: unconfigured ? 0 : 1,
      speakUpgrades: unconfigured ? 0 : 1,
      muteRevocations: 0,
      liveKitRequests: { succeeded: unconfigured ? 0 : 211, failed: offline ? 7 : 2, rejectedBreakerOpen: offline ? 12 : 0, rejectedQueueFull: 0, breakerOpenedCount: offline ? 1 : 0 },
    },
    clients: {
      since: iso(-26 * 3_600_000),
      events: unconfigured
        ? { connected: 0, connect_failed: 0, reconnecting: 0, reconnected: 0, connection_lost: 0, reconnect_failed: 0, mic_failed: 0, transport: 0 }
        : { connected: 54, connect_failed: 3, reconnecting: 6, reconnected: 5, connection_lost: 1, reconnect_failed: 0, mic_failed: 2, transport: 49 },
      failures: unconfigured ? {} : { livekit_connect_failed: 2, token_unavailable: 1, mic_permission_denied: 1, mic_not_found: 1 },
      transport: unconfigured
        ? { reports: 0, byCandidateType: {}, relayByProtocol: {}, relayPercent: null, rttMs: { mean: null, reports: 0 }, jitterMs: { mean: null, reports: 0 }, packetLossPercent: { mean: null, reports: 0 } }
        : { reports: 49, byCandidateType: { host: 6, srflx: 35, relay: 8 }, relayByProtocol: { udp: 3, tls: 5 }, relayPercent: 16.3, rttMs: { mean: 46, reports: 49 }, jitterMs: { mean: 3.8, reports: 47 }, packetLossPercent: { mean: 0.42, reports: 47 } },
      mic: unconfigured
        ? { attempts: { initial: { enabled: 0, recovered: 0, lost: 0, failed: 0, cancelled: 0 }, panel: { enabled: 0, recovered: 0, lost: 0, failed: 0, cancelled: 0 } }, interruptions: {}, failures: {}, gum: {}, lost: {} }
        : {
            attempts: { initial: { enabled: 31, recovered: 4, lost: 1, failed: 2, cancelled: 1 }, panel: { enabled: 12, recovered: 1, lost: 0, failed: 1, cancelled: 0 } },
            interruptions: { sdk_reconnect: { recovered: 3, lost: 1, other: 0 }, connection_lost: { recovered: 1, lost: 0, other: 0 }, rotation: { recovered: 1, lost: 0, other: 0 } },
            failures: { publish_cancelled: 1, permission_denied: 1, not_found: 1, device_busy: 1 },
            gum: { lt1s: 38, '1to5s': 9, '5to15s': 3, gt15s: 1 },
            lost: { track_ended: 1, republish_failed: 1 },
          },
      liveKitDisconnects: unconfigured ? {} : { network: 2, room_deleted: 3, participant_removed: 1 },
      sessionEnds: unconfigured
        ? { byReason: {}, failStages: {} }
        : { byReason: { leave_voice: 3, page_hide: 2, fail_connection: 2, access_ended: 1 }, failStages: { presence: 1, rotation_resume: 1 } },
      // Етап H: медийно здраве (броячи + последните събития, UTC минута).
      media: unconfigured
        ? { input: {}, inputEvidence: {}, output: {}, recovery: {}, byPlatform: {} }
        : {
            input: { stall_suspected: 2, stall_cleared: 1, system_muted: 3, system_unmuted: 3 },
            inputEvidence: { capture_stalled: 1, capture_active: 1 },
            output: { element_paused: 4, element_missing: 1, playback_blocked: 1, remote_stall_suspected: 1 },
            recovery: { 'play:success': 4, 'reattach:success': 1, 'play:gesture_required': 1, 'start_audio:success': 1 },
            byPlatform: { ios_safari: 6, android_samsung: 4, desktop_chrome: 3 },
          },
      recent: unconfigured ? [] : [
        { at: '2026-11-18T13:39Z', event: 'media_input', detail: 'stall_suspected/capture_stalled/none', platform: 'ios_safari' },
        { at: '2026-11-18T13:38Z', event: 'media_output', detail: 'element_paused', platform: 'android_samsung' },
        { at: '2026-11-18T13:38Z', event: 'media_recovery', detail: 'output/play/success/pause', platform: 'android_samsung' },
        { at: '2026-11-18T13:34Z', event: 'connected', detail: '', platform: 'ios_safari' },
      ],
      recentLimit: 500,
      rejectedReports: 0,
    },
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  const path = url.pathname.replace('/api/admin/voice-chat', '')
  requests.push({ method, path, body })
  if (scenario === 'forbidden') return json(403, { ok: false, code: 'forbidden', message: 'Нямаш достъп до гласовия чат.' })
  if (method === 'GET' && path === '') {
    if (released && pendingDeletions > 0) {
      getsSinceOff += 1
      if (getsSinceOff >= confirmAfter) pendingDeletions = 0
    }
    return json(200, base())
  }
  if (method === 'GET' && path === '/monitoring') return json(200, monitoring())
  if (method === 'POST' && path === '/mode') {
    const previous = mode
    mode = body.mode
    history.unshift({ changeId: `c${history.length + 10}`, setting: 'mode', newValue: mode, previousValue: previous, changedAt: iso(0), changedByDisplayName: 'Админ' })
    if (mode === 'off' && !released) {
      released = true
      const retiredRooms = scenario === 'full' || scenario === 'computing' ? 2 : 0
      pendingDeletions += retiredRooms
      return json(200, { ...base(), changed: true, releasedVoiceTables: scenario === 'full' || scenario === 'computing' ? 3 : 0, retiredRooms })
    }
    return json(200, { ...base(), changed: true, releasedVoiceTables: 0, retiredRooms: 0 })
  }
  if (method === 'POST' && path === '/limit') {
    maxTables = body.maxTables
    return json(200, { ...base(), changed: true })
  }
  return json(404, { ok: false })
}

const panel = showAdminVoiceChatPanel({ getApiBaseUrl: () => 'https://api.test', fetchImpl, refreshIntervalMs: refreshMs })
;(window as unknown as { __voiceAdminHarness: unknown }).__voiceAdminHarness = {
  requests,
  close: () => panel.close(),
  ready: () => document.querySelector('[data-avc-body="1"]')?.textContent?.includes('Зареждане') === false,
}
