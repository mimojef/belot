/**
 * checkMuteEndNotices.ts
 *
 * Store-level regression за жизнения цикъл на мюта и известията за
 * приключването му (topic_mute_end_notices + topicModerationStore). Изолирана
 * temp база, мигрирана с РЕАЛНИЯ ensureServerDatabaseReady (цялата верига
 * миграции, вкл. 20261008_001_create_topic_mute_end_notices.sql).
 *
 * Покрива:
 *  [1] естествено изтичане -> точно 1 'expired' известие; sweep е idempotent;
 *      topic_section_mutes редът е изтрит, evidence -> 'expired'.
 *  [2] предсрочно премахване -> 'unmuted'; последващ sweep НЕ създава
 *      'expired' за същия мют (никога два вида за едно приключване).
 *  [3] изтекъл, но още необработен мют + unmute -> changed=false, без
 *      'unmuted'; sweep -> 'expired' (едновременно изтичане и unmute).
 *  [4] нов мют супресира pending известие (G); удължен/заменен мют не дава
 *      фалшиво "приключи" за старото наказание (C).
 *  [5] ack: само собствено pending известие, idempotent.
 *  [6] muteProfileInTopicsIfNotMuted: отказ при активен мют без промяна в
 *      mute/audit/evidence; успех иначе (контекст 'profile-popup').
 *  [7] restart: pending известията оцеляват при затваряне/отваряне на store-а
 *      и при рестарт: изтекъл "докато сървърът е спрял" -> sweep при старт.
 *  [8] legacy мют без evidence ред -> известие с уникален section end_key.
 *  [9] isMuteProtectedStaffTarget: admin/pika_team/marketing/официален ID.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createTopicModerationStore, type TopicModerationStore } from '../src/db/topicModerationStore.js'
import { isMuteProtectedStaffTarget, isProtectedStaffRole } from '../src/core/protectedStaffProfiles.js'
import { OFFICIAL_PIKA_PROFILE_ID } from '../src/db/normalizeProfileIdentityText.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

console.log('\n═══ checkMuteEndNotices ═══')

const serverRoot = resolve(process.cwd())
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-mute-end-notices-'))
await cp(join(serverRoot, 'database', 'migrations'), join(tempRoot, 'database', 'migrations'), { recursive: true })
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: tempRoot })

const raw = new DatabaseSync(databaseFilePath, { open: true })
raw.exec('PRAGMA foreign_keys = ON;')
const ACTOR_ACCOUNT_ID = 'acct-moderator'
raw.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, ?, 'admin')`)
  .run(ACTOR_ACCOUNT_ID, 'moderator@example.test', 'x')

let profileCounter = 0
function newProfile(): string {
  profileCounter += 1
  const id = `profile-${profileCounter}-${Date.now()}`
  raw.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)`)
    .run(id, `P${profileCounter}`, `p${profileCounter}`)
  return id
}

function sqlDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

// Симулира естествено изтичане без чакане: местим muted_until в миналото.
function forceExpire(profileId: string): void {
  const past = sqlDate(Date.now() - 60_000)
  raw.prepare(`UPDATE topic_section_mutes SET muted_until = ? WHERE profile_id = ?`).run(past, profileId)
  raw.prepare(`UPDATE topic_mute_evidence SET muted_until = ? WHERE profile_id = ? AND status = 'active'`).run(past, profileId)
}

function count(sql: string, ...params: string[]): number {
  return Number((raw.prepare(sql).get(...params) as { c: number }).c)
}

function mute(store: TopicModerationStore, profileId: string, durationMs = 30 * 60 * 1000): void {
  store.muteProfileInTopics({
    topicId: 'topic-lafche',
    profileId,
    actorAccountId: ACTOR_ACCOUNT_ID,
    actorRole: 'admin',
    reason: 'test reason',
    durationMs,
  })
}

let store = await createTopicModerationStore(databaseFilePath)

try {
  await check('[1] natural expiry -> exactly one "expired" notice; sweep is idempotent', () => {
    const p = newProfile()
    mute(store, p)
    assert(store.sweepExpiredSectionMutes().filter((n) => n.profileId === p).length === 0, 'active mute must not produce a notice')
    forceExpire(p)
    const first = store.sweepExpiredSectionMutes().filter((n) => n.profileId === p)
    assert(first.length === 1 && first[0]!.kind === 'expired', `expected 1 expired notice, got ${JSON.stringify(first)}`)
    assert(store.sweepExpiredSectionMutes().filter((n) => n.profileId === p).length === 0, 'second sweep must not duplicate')
    assert(count(`SELECT COUNT(*) c FROM topic_section_mutes WHERE profile_id = ?`, p) === 0, 'expired section row must be removed')
    assert(count(`SELECT COUNT(*) c FROM topic_mute_evidence WHERE profile_id = ? AND status = 'expired'`, p) === 1, 'evidence must be expired')
    const pending = store.listPendingMuteEndNotices(p)
    assert(pending.length === 1 && pending[0]!.noticeId === first[0]!.noticeId, 'notice must be pending for delivery')
  })

  await check('[2] early unmute -> "unmuted"; no extra "expired" notice for the same mute', () => {
    const p = newProfile()
    mute(store, p)
    const result = store.unmuteProfileInTopics({ topicId: 'profile-popup', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'subadmin' })
    assert(result.changed && result.notice?.kind === 'unmuted', `expected unmuted notice, got ${JSON.stringify(result)}`)
    assert(count(`SELECT COUNT(*) c FROM topic_mute_evidence WHERE profile_id = ? AND status = 'manually_unmuted'`, p) === 1, 'evidence manually_unmuted')
    assert(store.sweepExpiredSectionMutes().filter((n) => n.profileId === p).length === 0, 'sweep must not add "expired" after unmute')
    const kinds = store.listPendingMuteEndNotices(p).map((n) => n.kind)
    assert(JSON.stringify(kinds) === JSON.stringify(['unmuted']), `exactly one notice of one kind, got ${JSON.stringify(kinds)}`)
    const second = store.unmuteProfileInTopics({ topicId: 'profile-popup', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'admin' })
    assert(!second.changed && second.notice === null, 'repeated unmute is a no-op')
  })

  await check('[3] mute expiring at the same moment as an unmute -> only "expired"', () => {
    const p = newProfile()
    mute(store, p)
    forceExpire(p)
    const result = store.unmuteProfileInTopics({ topicId: 'profile-popup', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'admin' })
    assert(!result.changed && result.notice === null, 'expired mute must not be reported as an early unmute')
    const swept = store.sweepExpiredSectionMutes().filter((n) => n.profileId === p)
    assert(swept.length === 1 && swept[0]!.kind === 'expired', 'sweep creates the single "expired" notice')
    assert(store.listPendingMuteEndNotices(p).length === 1, 'exactly one notice for one ending')
  })

  await check('[4] new mute supersedes pending notice (G); extended mute gives no false "ended" (C)', () => {
    const p = newProfile()
    mute(store, p)
    forceExpire(p)
    store.sweepExpiredSectionMutes()
    assert(store.listPendingMuteEndNotices(p).length === 1, 'setup: pending expired notice')
    mute(store, p)
    assert(store.listPendingMuteEndNotices(p).length === 0, 'new mute must supersede the stale "you can write" notice')
    assert(count(`SELECT COUNT(*) c FROM topic_mute_end_notices WHERE profile_id = ? AND status = 'superseded'`, p) === 1, 'superseded status')

    const q = newProfile()
    mute(store, q, 30 * 60 * 1000)
    mute(store, q, 24 * 60 * 60 * 1000)
    assert(store.sweepExpiredSectionMutes().filter((n) => n.profileId === q).length === 0, 'replaced mute must not produce an "ended" notice')
    forceExpire(q)
    const swept = store.sweepExpiredSectionMutes().filter((n) => n.profileId === q)
    assert(swept.length === 1, `only the current punishment ends once, got ${swept.length}`)
  })

  await check('[5] acknowledge: only own pending notice, idempotent; superseding returns ids', () => {
    const p = newProfile()
    const other = newProfile()
    mute(store, p)
    const { notice } = store.unmuteProfileInTopics({ topicId: 'topic-lafche', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'pika_team' })
    assert(notice !== null, 'setup notice')
    assert(!store.acknowledgeMuteEndNotice(other, notice.noticeId), 'foreign profile cannot acknowledge')
    assert(store.acknowledgeMuteEndNotice(p, notice.noticeId), 'own pending notice is acknowledged')
    assert(!store.acknowledgeMuteEndNotice(p, notice.noticeId), 'second ack is a no-op')
    assert(store.listPendingMuteEndNotices(p).length === 0, 'acknowledged notice is no longer pending')

    const r = newProfile()
    mute(store, r)
    const unmuted = store.unmuteProfileInTopics({ topicId: 'topic-lafche', profileId: r, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'admin' })
    const ids = store.supersedePendingMuteEndNotices(r)
    assert(ids.length === 1 && ids[0] === unmuted.notice?.noticeId, 'supersede returns the cleared notice ids')
  })

  await check('[6] muteProfileInTopicsIfNotMuted rejects an active mute without any DB change', () => {
    const p = newProfile()
    const first = store.muteProfileInTopicsIfNotMuted({
      topicId: 'profile-popup', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'pika_team', reason: 'r1', durationMs: 60 * 60 * 1000,
    })
    assert(first.ok && first.snapshot.isMuted, 'first profile mute succeeds')
    const before = {
      audit: count(`SELECT COUNT(*) c FROM topic_moderation_audit_log WHERE target_profile_id = ?`, p),
      evidence: count(`SELECT COUNT(*) c FROM topic_mute_evidence WHERE profile_id = ?`, p),
      until: (raw.prepare(`SELECT muted_until FROM topic_section_mutes WHERE profile_id = ?`).get(p) as { muted_until: string }).muted_until,
    }
    const second = store.muteProfileInTopicsIfNotMuted({
      topicId: 'profile-popup', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'admin', reason: 'r2', durationMs: 24 * 60 * 60 * 1000,
    })
    assert(!second.ok && second.code === 'already_muted', 'second mute must be rejected')
    assert(count(`SELECT COUNT(*) c FROM topic_moderation_audit_log WHERE target_profile_id = ?`, p) === before.audit, 'no new audit row')
    assert(count(`SELECT COUNT(*) c FROM topic_mute_evidence WHERE profile_id = ?`, p) === before.evidence, 'no new evidence row')
    const after = (raw.prepare(`SELECT muted_until FROM topic_section_mutes WHERE profile_id = ?`).get(p) as { muted_until: string }).muted_until
    assert(after === before.until, 'mute end must not change')
    const evidence = raw.prepare(`SELECT source_topic_id, source_kind, source_message_id FROM topic_mute_evidence WHERE profile_id = ?`).get(p) as
      { source_topic_id: string; source_kind: string; source_message_id: string | null }
    assert(evidence.source_topic_id === 'profile-popup' && evidence.source_kind === 'unspecified' && evidence.source_message_id === null,
      `profile mute evidence context: ${JSON.stringify(evidence)}`)
  })

  await check('[7] restart: pending notices survive; mute expired while down is swept on start', async () => {
    const p = newProfile()
    mute(store, p)
    const { notice } = store.unmuteProfileInTopics({ topicId: 'topic-lafche', profileId: p, actorAccountId: ACTOR_ACCOUNT_ID, actorRole: 'admin' })
    const q = newProfile()
    mute(store, q)
    store.close()
    forceExpire(q) // "изтича докато сървърът е спрян"
    store = await createTopicModerationStore(databaseFilePath)
    assert(store.listPendingMuteEndNotices(p).some((n) => n.noticeId === notice?.noticeId), 'pending notice survives restart')
    const swept = store.sweepExpiredSectionMutes().filter((n) => n.profileId === q)
    assert(swept.length === 1 && swept[0]!.kind === 'expired', 'startup sweep catches the mute that expired while down')
  })

  await check('[8] legacy section mute without evidence row -> unique section end key', () => {
    const p = newProfile()
    raw.prepare(`INSERT INTO topic_section_mutes (profile_id, muted_until, muted_by_account_id, reason) VALUES (?, ?, ?, ?)`)
      .run(p, sqlDate(Date.now() - 1000), ACTOR_ACCOUNT_ID, 'legacy')
    const swept = store.sweepExpiredSectionMutes().filter((n) => n.profileId === p)
    assert(swept.length === 1, 'legacy mute produces a notice')
    const row = raw.prepare(`SELECT end_key, mute_history_id FROM topic_mute_end_notices WHERE profile_id = ?`).get(p) as { end_key: string; mute_history_id: string | null }
    assert(row.end_key.startsWith(`section:${p}:`) && row.mute_history_id === null, `legacy end_key ${JSON.stringify(row)}`)
  })

  await check('[9] mute protection: admin/pika_team/marketing/official ID; block protection unchanged', () => {
    for (const role of ['admin', 'pika_team', 'marketing']) {
      assert(isMuteProtectedStaffTarget(role, 'any-id'), `${role} must be protected from mute`)
    }
    for (const role of ['player', 'subadmin', 'top_chat_admin', 'chat_admin', null]) {
      assert(!isMuteProtectedStaffTarget(role, 'any-id'), `${String(role)} must NOT be protected`)
    }
    assert(isMuteProtectedStaffTarget('player', OFFICIAL_PIKA_PROFILE_ID), 'official Pika.bg profile protected by ID')
    assert(isMuteProtectedStaffTarget(null, OFFICIAL_PIKA_PROFILE_ID), 'official Pika.bg profile protected even without role')
    // Block-правилото остава непроменено (admin НЕ е защитен от блокиране).
    assert(!isProtectedStaffRole('admin') && isProtectedStaffRole('pika_team') && isProtectedStaffRole('marketing'), 'block rule unchanged')
  })
} finally {
  store.close()
  raw.close()
  try {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch { /* Windows WAL handle — best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
