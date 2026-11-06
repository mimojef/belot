/**
 * checkTopicMessageLikeTracking.ts
 *
 * Unit + модел-базиран тест + синтетичен benchmark за ограничения tracking
 * set на like drift-detection poll-а (src/realtime/topicMessageLikeTracking.ts,
 * runTopicMessageLikePoll в index.ts).
 *
 * [1]  seedIfAbsent не презаписва известен count (catch-up / cross-instance seed)
 * [2]  recordLocalCount презаписва count-а на място (редът не се променя)
 * [3]  Гледана тема: записите остават и lastWatchedAt се опреснява
 * [4]  Негледана тема: записите остават в рамките на grace, махат се след него
 * [5]  Reconnect/презареждане в рамките на grace: нищо не се губи
 * [6]  Таван — приоритет: изтекли без абонати → несъществуващи → най-старите;
 *      записите на активно гледаната тема оцеляват, докато има какво друго да се махне
 * [6b] Авариен таван при добавяне (ако poll-ът спре): размерът ≤ HARD_MAX
 * [6c] Пълен таван: потвърдените съществуващи не се проверяват наново до RECHECK
 * [7]  forget + size
 * [8]  Модел (без граници): новият poll дава ИДЕНТИЧНИ broadcast-и със стария
 * [9]  Модел (реални граници): новите broadcast-и са подмножество на старите;
 *      пълно съвпадение докато темите са гледани и размерът < тавана
 * [10] Benchmark преди/след (идентична SQL заявка с getLikeCountsByMessageIds)
 *
 * Без мрежа/сървър; [10] ползва in-memory node:sqlite.
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  createTopicMessageLikeTracker,
  TOPIC_MESSAGE_LIKE_TRACKING_IDLE_GRACE_MS,
  TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES,
  TOPIC_MESSAGE_LIKE_TRACKING_HARD_MAX_ENTRIES,
  TOPIC_MESSAGE_LIKE_TRACKING_EXISTENCE_RECHECK_MS,
  type TopicMessageLikeTracker,
} from '../src/realtime/topicMessageLikeTracking.js'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

const GRACE = TOPIC_MESSAGE_LIKE_TRACKING_IDLE_GRACE_MS
const LIKE_ANNOUNCED_TTL_MS = 15_000 // = TOPIC_MESSAGE_LIKE_LOCALLY_ANNOUNCED_TTL_MS в index.ts
const POLL_MS = 4_000 // = TOPIC_MESSAGE_LIKE_POLL_INTERVAL_MS

console.log('\n=== Topic message like tracking ===\n')

check('[1] seedIfAbsent не презаписва известен count', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('m1', 'T', 3, 0)
  t.seedIfAbsent('m1', 'T', 7, 10)
  assertEqual(t.getKnownCount('m1'), 3, 'seed не трябва да презаписва')
  assertEqual(t.size(), 1, 'size')
})

check('[2] recordLocalCount презаписва count-а на място (редът не се променя)', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('m1', 'T', 1, 0)
  t.seedIfAbsent('m2', 'T', 1, 0)
  t.recordLocalCount('m1', 'T', 5, 1)
  t.recordLocalCount('m3', 'T', 2, 1)
  assertEqual(t.getKnownCount('m1'), 5, 'local toggle count')
  assertEqual(t.messageIds().join(','), 'm1,m2,m3', 'редът трябва да е по първо добавяне (като стария Map)')
})

check('[3] Гледана тема: записите остават и lastWatchedAt се опреснява', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('m1', 'T', 0, 0)
  for (let now = POLL_MS; now <= 5 * GRACE; now += POLL_MS) t.pruneUnwatched(now, () => true)
  // Темата спира да се гледа в 5*GRACE → записът трябва да живее още GRACE.
  t.pruneUnwatched(5 * GRACE + GRACE - 1, () => false)
  assert(t.has('m1'), 'записът трябва да оцелее grace след последното гледане')
  t.pruneUnwatched(5 * GRACE + GRACE, () => false)
  assert(!t.has('m1'), 'записът трябва да се махне след grace')
})

check('[4] Негледана тема: остава в grace, маха се след него; другите теми не се засягат', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('a1', 'A', 0, 0)
  t.seedIfAbsent('b1', 'B', 0, 0)
  const watched = (topicId: string) => topicId === 'B'
  assertEqual(t.pruneUnwatched(GRACE - 1, watched), 0, 'нищо в grace')
  assertEqual(t.pruneUnwatched(GRACE, watched), 1, 'A се маха след grace')
  assert(!t.has('a1') && t.has('b1'), 'само A е махнат')
})

check('[5] Reconnect/презареждане в рамките на grace: нищо не се губи', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('m1', 'T', 2, 0)
  t.pruneUnwatched(POLL_MS, () => true)
  // Връзката пада 3 минути (няма subscribers), после нов subscribe.
  for (let now = 2 * POLL_MS; now < 3 * 60_000; now += POLL_MS) t.pruneUnwatched(now, () => false)
  t.pruneUnwatched(3 * 60_000, () => true)
  assert(t.has('m1') && t.getKnownCount('m1') === 2, 'записът трябва да е непокътнат след reconnect')
  // И отново пълен grace след новото излизане.
  t.pruneUnwatched(3 * 60_000 + GRACE - 1, () => false)
  assert(t.has('m1'), 'grace се брои от последното гледане')
})

check('[6] Таван — приоритет: изтекли без абонати → несъществуващи → най-старите', () => {
  // Огледало на tick-а в index.ts: pruneUnwatched → enforceMaxEntries.
  const tick = (t: TopicMessageLikeTracker, now: number, watched: Set<string>, existing: Set<string>) => {
    t.pruneUnwatched(now, (topicId) => watched.has(topicId))
    t.enforceMaxEntries(now, (id) => existing.has(id))
  }
  // Най-стари: изтекли записи от негледана тема U, после изтрити съобщения
  // от Лафче (L), после живите записи на активно гледаната тема W.
  const t = createTopicMessageLikeTracker({ maxEntries: 4 })
  t.seedIfAbsent('u1', 'U', 0, 0)
  t.seedIfAbsent('u2', 'U', 0, 0)
  t.seedIfAbsent('d1', 'L', 0, GRACE)
  t.seedIfAbsent('d2', 'L', 0, GRACE)
  for (const id of ['w1', 'w2', 'w3']) t.seedIfAbsent(id, 'W', 0, GRACE)
  assertEqual(t.size(), 7, 'преди tick-а таванът може временно да е надвишен')
  const existing = new Set(['u1', 'u2', 'w1', 'w2', 'w3', 'l1'])
  tick(t, GRACE + POLL_MS, new Set(['W', 'L']), existing)
  // u* (изтекли) изцяло; от несъществуващите — само колкото трябва (d1).
  assertEqual(t.messageIds().join(','), 'd2,w1,w2,w3', 'махат се изтеклите и най-старият несъществуващ; W е непокътната')

  // Несъществуващите се махат преди по-стари, но живи записи.
  t.seedIfAbsent('l1', 'L', 0, GRACE + POLL_MS) // жив, по-нов от w*
  t.seedIfAbsent('d3', 'L', 0, GRACE + POLL_MS) // изтрит, най-нов
  tick(t, GRACE + 2 * POLL_MS, new Set(['W', 'L']), existing)
  assertEqual(t.messageIds().join(','), 'w1,w2,w3,l1', 'изтритите d2/d3 се махат преди живите w*/l1 (дори d3 да е най-нов)')

  // Без изтекли и несъществуващи → едва тогава най-рано добавените.
  t.seedIfAbsent('l2', 'L', 0, GRACE + 2 * POLL_MS)
  existing.add('l2')
  tick(t, GRACE + 3 * POLL_MS, new Set(['W', 'L']), existing)
  assertEqual(t.messageIds().join(','), 'w2,w3,l1,l2', 'накрая изважда най-рано добавения (w1)')

  // Под тавана enforceMaxEntries не пипа нищо (и не вика проверката за съществуване).
  let probes = 0
  t.enforceMaxEntries(GRACE + 4 * POLL_MS, () => { probes++; return false })
  assertEqual(probes, 0, 'под тавана няма DB проверки')
  assertEqual(t.size(), 4, 'размерът е непроменен')
})

check('[6b] Авариен таван при добавяне (ако poll-ът спре): размерът ≤ HARD_MAX', () => {
  const big = createTopicMessageLikeTracker()
  for (let i = 0; i < TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES * 5; i++) big.seedIfAbsent(`x${i}`, 'T', 0, 0)
  assertEqual(big.size(), TOPIC_MESSAGE_LIKE_TRACKING_HARD_MAX_ENTRIES, 'размерът никога не надвишава аварийния таван')
  assertEqual(big.messageIds()[0], `x${TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES * 5 - TOPIC_MESSAGE_LIKE_TRACKING_HARD_MAX_ENTRIES}`, 'изваждат се най-рано добавените')
  big.enforceMaxEntries(0, () => true)
  assertEqual(big.size(), TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES, 'следващият tick връща размера до тавана')
})

check('[6c] Пълен таван: потвърдените съществуващи не се проверяват наново до EXISTENCE_RECHECK', () => {
  const t = createTopicMessageLikeTracker({ maxEntries: 100 })
  const deleted = new Set<string>()
  let probes = 0
  const exists = (id: string) => { probes++; return !deleted.has(id) }
  for (let i = 0; i < 101; i++) t.seedIfAbsent(`m${i}`, 'W', 0, 0)
  t.enforceMaxEntries(0, exists)
  assertEqual(probes, 101, 'първият пълен таван проверява всички')
  // Всеки следващ tick добавя по един запис — без нови DB проверки за старите.
  probes = 0
  for (let tickNo = 1; tickNo <= 10; tickNo++) {
    t.seedIfAbsent(`n${tickNo}`, 'W', 0, tickNo * POLL_MS)
    t.enforceMaxEntries(tickNo * POLL_MS, exists)
  }
  assertEqual(probes, 10, 'проверява се само новодобавеният запис на всеки tick')
  assertEqual(t.size(), 100, 'размерът остава на тавана')
  // След RECHECK изтритите съобщения отново се откриват преди живите.
  deleted.add('m50')
  t.seedIfAbsent('late', 'W', 0, TOPIC_MESSAGE_LIKE_TRACKING_EXISTENCE_RECHECK_MS + POLL_MS)
  t.enforceMaxEntries(TOPIC_MESSAGE_LIKE_TRACKING_EXISTENCE_RECHECK_MS + POLL_MS, exists)
  assert(!t.has('m50') && t.has('m11'), 'след RECHECK се маха изтритото m50, а не най-старото живо m11')
})

check('[7] forget + size', () => {
  const t = createTopicMessageLikeTracker()
  t.seedIfAbsent('m1', 'T', 0, 0)
  t.forget('m1')
  t.forget('missing')
  assertEqual(t.size(), 0, 'size след forget')
  t.setKnownCount('missing', 3)
  assertEqual(t.size(), 0, 'setKnownCount не създава записи')
})

// ─── Модел: стар vs нов poll върху една и съща последователност събития ─────
//
// Огледало на runTopicMessageLikePoll (index.ts) — стар (Map без граници) и
// нов (tracker). Fake DB: likeCount + topicId + exists на съобщение.

type Broadcast = string // `${tick}:${messageId}:${count}`

type ModelDb = { counts: Map<string, number>; topicOf: Map<string, string>; exists: Set<string> }

function createOldPoll() {
  const known = new Map<string, number>()
  const announcedAt = new Map<string, number>()
  return {
    name: 'old',
    seedIfAbsent(id: string, _topic: string, count: number, _now: number) { if (!known.has(id)) known.set(id, count) },
    localToggle(id: string, _topic: string, count: number, now: number) { announcedAt.set(id, now); known.set(id, count) },
    tick(db: ModelDb, now: number, hasSubs: (t: string) => boolean, tickNo: number, out: Broadcast[]) {
      const ids = [...known.keys()]
      for (const id of ids) {
        const current = db.counts.get(id) ?? 0
        const k = known.get(id)
        const a = announcedAt.get(id)
        const recent = a !== undefined && now - a < LIKE_ANNOUNCED_TTL_MS
        if (current !== k) {
          known.set(id, current)
          if (!recent && db.exists.has(id)) {
            const topic = db.topicOf.get(id)!
            if (hasSubs(topic)) out.push(`${tickNo}:${id}:${current}`)
          }
        }
      }
      for (const [id, at] of announcedAt) if (now - at >= LIKE_ANNOUNCED_TTL_MS) announcedAt.delete(id)
      return ids.length
    },
  }
}

function createNewPoll(tracker: TopicMessageLikeTracker) {
  const announcedAt = new Map<string, number>()
  return {
    name: 'new',
    tracker,
    seedIfAbsent(id: string, topic: string, count: number, now: number) { tracker.seedIfAbsent(id, topic, count, now) },
    localToggle(id: string, topic: string, count: number, now: number) { announcedAt.set(id, now); tracker.recordLocalCount(id, topic, count, now) },
    tick(db: ModelDb, now: number, hasSubs: (t: string) => boolean, tickNo: number, out: Broadcast[]) {
      tracker.pruneUnwatched(now, hasSubs)
      tracker.enforceMaxEntries(now, (id) => db.exists.has(id))
      const ids = tracker.messageIds()
      for (const id of ids) {
        const current = db.counts.get(id) ?? 0
        const k = tracker.getKnownCount(id)
        const a = announcedAt.get(id)
        const recent = a !== undefined && now - a < LIKE_ANNOUNCED_TTL_MS
        if (current !== k) {
          tracker.setKnownCount(id, current)
          if (!recent) {
            if (db.exists.has(id)) {
              const topic = db.topicOf.get(id)!
              if (hasSubs(topic)) out.push(`${tickNo}:${id}:${current}`)
            } else {
              tracker.forget(id)
            }
          }
        }
      }
      for (const [id, at] of announcedAt) if (now - at >= LIKE_ANNOUNCED_TTL_MS) announcedAt.delete(id)
      return ids.length
    },
  }
}

// Детерминиран PRNG (mulberry32) — възпроизводими сценарии.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type ScenarioResult = { oldOut: Broadcast[]; newOut: Broadcast[]; oldMaxTracked: number; newMaxTracked: number; evictedOrPruned: boolean }

function runScenario(seed: number, tracker: TopicMessageLikeTracker, opts: { ticks: number; topics: number; msgsPerTopic: number; churn: boolean }): ScenarioResult {
  const r = rng(seed)
  const db: ModelDb = { counts: new Map(), topicOf: new Map(), exists: new Set() }
  const topics = Array.from({ length: opts.topics }, (_, i) => `T${i}`)
  let nextMsg = 0
  function newMessage(topic: string): string {
    const id = `m${nextMsg++}`
    db.topicOf.set(id, topic)
    db.exists.add(id)
    db.counts.set(id, 0)
    return id
  }
  for (const topic of topics) for (let i = 0; i < opts.msgsPerTopic; i++) newMessage(topic)
  // Без churn всички теми са гледани непрекъснато (напр. Лафче във вечерен пик).
  const subs = new Map<string, number>(topics.map((t) => [t, !opts.churn || r() < 0.5 ? 1 : 0]))
  const hasSubs = (t: string) => (subs.get(t) ?? 0) > 0
  const oldP = createOldPoll()
  const newP = createNewPoll(tracker)
  const oldOut: Broadcast[] = []
  const newOut: Broadcast[] = []
  let oldMax = 0
  let newMax = 0
  let lostEntries = false
  const allIds = () => [...db.exists]
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!

  for (let tick = 1; tick <= opts.ticks; tick++) {
    const now = tick * POLL_MS
    // Събития между два tick-а.
    const events = Math.floor(r() * 4)
    for (let e = 0; e < events; e++) {
      const roll = r()
      const ids = allIds()
      if (ids.length === 0) break
      if (roll < 0.30) {
        // Харесване/премахване от ДРУГА инстанция или out-of-band (само DB).
        const id = pick(ids)
        db.counts.set(id, Math.max(0, (db.counts.get(id) ?? 0) + (r() < 0.6 ? 1 : -1)))
      } else if (roll < 0.50) {
        // Локален toggle на ТАЗИ инстанция (count от транзакцията).
        const id = pick(ids)
        const c = Math.max(0, (db.counts.get(id) ?? 0) + (r() < 0.6 ? 1 : -1))
        db.counts.set(id, c)
        oldP.localToggle(id, db.topicOf.get(id)!, c, now)
        newP.localToggle(id, db.topicOf.get(id)!, c, now)
      } else if (roll < 0.65) {
        // Subscribe (catch-up seed на няколко съобщения от темата).
        const topic = pick(topics)
        subs.set(topic, (subs.get(topic) ?? 0) + 1)
        for (const id of ids.filter((x) => db.topicOf.get(x) === topic).slice(-5)) {
          oldP.seedIfAbsent(id, topic, db.counts.get(id) ?? 0, now)
          newP.seedIfAbsent(id, topic, db.counts.get(id) ?? 0, now)
        }
      } else if (roll < 0.78 && opts.churn) {
        // Unsubscribe / затваряне / разпадане на връзка.
        const topic = pick(topics)
        subs.set(topic, Math.max(0, (subs.get(topic) ?? 0) - 1))
      } else if (roll < 0.90) {
        // Ново съобщение от друга инстанция → seed от cross-instance poll-а.
        const topic = pick(topics)
        const id = newMessage(topic)
        oldP.seedIfAbsent(id, topic, 0, now)
        newP.seedIfAbsent(id, topic, 0, now)
      } else if (roll < 0.95) {
        // Hard delete (Лафче retention / изтриване на тема) → likes CASCADE.
        const id = pick(ids)
        db.exists.delete(id)
        db.counts.set(id, 0)
      }
    }
    const before = tracker.size()
    oldMax = Math.max(oldMax, oldP.tick(db, now, hasSubs, tick, oldOut))
    newMax = Math.max(newMax, newP.tick(db, now, hasSubs, tick, newOut))
    if (tracker.size() < before) lostEntries = true
  }
  return { oldOut, newOut, oldMaxTracked: oldMax, newMaxTracked: newMax, evictedOrPruned: lostEntries }
}

check('[8] Модел без граници (grace=∞, таван=∞): ИДЕНТИЧНИ broadcast-и, 200 сценария', () => {
  let totalBroadcasts = 0
  for (let seed = 1; seed <= 200; seed++) {
    const tracker = createTopicMessageLikeTracker({ idleGraceMs: Number.POSITIVE_INFINITY, maxEntries: Number.POSITIVE_INFINITY })
    const res = runScenario(seed, tracker, { ticks: 300, topics: 6, msgsPerTopic: 10, churn: true })
    totalBroadcasts += res.oldOut.length
    assertEqual(res.newOut.join('|'), res.oldOut.join('|'), `seed ${seed}: broadcast-ите се различават`)
  }
  assert(totalBroadcasts > 1000, `сценариите трябва реално да генерират broadcast-и (получени ${totalBroadcasts})`)
})

check('[9] Модел с реални граници: нов ⊆ стар; без churn и под тавана → идентични', () => {
  let strictSubsetCases = 0
  for (let seed = 1; seed <= 200; seed++) {
    // Churn: малък таван и кратък grace, за да има реално изваждане.
    const tracker = createTopicMessageLikeTracker({ idleGraceMs: 60_000, maxEntries: 40 })
    const res = runScenario(seed, tracker, { ticks: 400, topics: 8, msgsPerTopic: 10, churn: true })
    const oldSet = new Set(res.oldOut)
    for (const b of res.newOut) assert(oldSet.has(b), `seed ${seed}: нов broadcast ${b}, който старият не прави`)
    assert(res.newMaxTracked <= 40, `seed ${seed}: таванът е надвишен (${res.newMaxTracked})`)
    if (res.newOut.length < res.oldOut.length) strictSubsetCases++
  }
  assert(strictSubsetCases > 0, 'churn сценариите трябва реално да упражняват изваждането')
  for (let seed = 1001; seed <= 1100; seed++) {
    // Без unsubscribe (темите остават гледани) и под тавана: реални defaults.
    const tracker = createTopicMessageLikeTracker()
    const res = runScenario(seed, tracker, { ticks: 300, topics: 6, msgsPerTopic: 10, churn: false })
    assert(res.newMaxTracked < TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES, `seed ${seed}: сценарият трябва да е под тавана`)
    assertEqual(res.newOut.join('|'), res.oldOut.join('|'), `seed ${seed}: broadcast-ите се различават`)
  }
})

// ─── [10] Benchmark ─────────────────────────────────────────────────────────

function runBenchmark(): void {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE topic_message_likes (
      message_id TEXT NOT NULL,
      liker_profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, liker_profile_id)
    );
    CREATE INDEX idx_topic_message_likes_message ON topic_message_likes(message_id);
  `)
  // Огледало на topicMessageStore.getLikeCountsByMessageIds (същият SQL, prepare на всеки tick).
  function getLikeCountsByMessageIds(messageIds: readonly string[]): Map<string, number> {
    const result = new Map<string, number>(messageIds.map((id) => [id, 0]))
    if (messageIds.length === 0) return result
    const placeholders = messageIds.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT message_id, COUNT(*) as cnt FROM topic_message_likes WHERE message_id IN (${placeholders}) GROUP BY message_id;`)
      .all(...messageIds) as Array<{ message_id: string; cnt: number }>
    for (const row of rows) result.set(row.message_id, row.cnt)
    return result
  }

  // Синтетичен живот на процеса: 40 теми + Лафче; на ден 1 500 различни
  // харесани съобщения (60% Лафче) + 300 catch-up seed-а. В момента на
  // измерване се гледат Лафче + 5 теми (вечерен пик).
  const DAY_MS = 24 * 60 * 60_000
  const LIKED_PER_DAY = 1_500
  const CATCHUP_PER_DAY = 300
  const topics = ['lafche', ...Array.from({ length: 40 }, (_, i) => `topic-${i}`)]
  const watchedNow = new Set(['lafche', 'topic-0', 'topic-1', 'topic-2', 'topic-3', 'topic-4'])
  const insertLike = db.prepare('INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)')

  console.log('\n  [10] Benchmark — един poll tick (заявка + сравнение), медиана от 15 tick-а')
  console.log('       дни | стар: следени |  ms/tick | грешка        || нов: следени | ms/tick')
  for (const days of [1, 3, 7, 14, 30]) {
    const oldKnown = new Map<string, number>()
    const tracker = createTopicMessageLikeTracker()
    db.exec('DELETE FROM topic_message_likes')
    db.exec('BEGIN')
    const perDay = LIKED_PER_DAY + CATCHUP_PER_DAY
    const total = perDay * days
    for (let i = 0; i < total; i++) {
      const id = randomUUID()
      const topic = i % 10 < 6 ? 'lafche' : topics[1 + (i % 40)]!
      const now = Math.floor((i / total) * days * DAY_MS)
      const count = 1 + (i % 3)
      if (i % perDay < LIKED_PER_DAY) {
        for (let k = 0; k < count; k++) insertLike.run(id, `p${k}`)
        oldKnown.set(id, count)
        tracker.recordLocalCount(id, topic, count, now)
      } else {
        oldKnown.set(id, 0)
        tracker.seedIfAbsent(id, topic, 0, now)
      }
      // Poll на всеки „час“ симулирано време подрязва негледаните теми
      // (в реалния сървър става на всеки 4 сек; резултатът е същият).
      if (i % Math.max(1, Math.floor(perDay / 24)) === 0) {
        tracker.pruneUnwatched(now, (t) => watchedNow.has(t) && (t === 'lafche' || i % 7 === 0))
      }
    }
    db.exec('COMMIT')
    tracker.pruneUnwatched(days * DAY_MS, (t) => watchedNow.has(t))
    tracker.enforceMaxEntries(days * DAY_MS, () => true) // като tick-а в index.ts (всички съществуват)

    const measure = (ids: string[], known: (id: string) => number | undefined): { ms: number; error: string | null } => {
      const samples: number[] = []
      for (let r = 0; r < 15; r++) {
        const t0 = performance.now()
        try {
          const counts = getLikeCountsByMessageIds(ids)
          let changed = 0
          for (const id of ids) if ((counts.get(id) ?? 0) !== known(id)) changed++
          if (changed < 0) throw new Error('unreachable')
        } catch (e) {
          return { ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) }
        }
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      return { ms: samples[Math.floor(samples.length / 2)]!, error: null }
    }
    const oldIds = [...oldKnown.keys()]
    const oldRes = measure(oldIds, (id) => oldKnown.get(id))
    const newIds = tracker.messageIds()
    const newRes = measure(newIds, (id) => tracker.getKnownCount(id))
    console.log(
      `       ${String(days).padStart(3)} | ${String(oldIds.length).padStart(13)} | ${oldRes.ms.toFixed(2).padStart(8)} | ${(oldRes.error ? oldRes.error.slice(0, 22) : '—').padEnd(13)} || ${String(newIds.length).padStart(12)} | ${newRes.ms.toFixed(2).padStart(7)}`,
    )
    if (newIds.length > TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES) throw new Error('новият размер надвишава тавана')
    if (newRes.error) throw new Error(`новият poll хвърля: ${newRes.error}`)
  }
  db.close()
}

check('[10] Benchmark преди/след (новият никога не надвишава тавана и не хвърля)', runBenchmark)

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
