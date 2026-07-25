/**
 * checkPlayersPageSnapshotStore.ts
 *
 * Unit тестове за server/src/db/playersPageSnapshotStore.ts — in-memory
 * store, замразяваща глобалната подредба на players директорията за
 * стабилна пагинация между страници (виж checkPlayersPagination.ts за
 * пълния HTTP интеграционен тест).
 *
 * [1]  create() връща token, get() със същите (isAdmin, viewer) го намира.
 * [2]  get() с грешен viewerProfileId → null (без mixing между viewer-и).
 * [3]  get() с грешен isAdmin → null (без mixing между admin/user подредби).
 * [4]  get() с непознат token → null.
 * [5]  Изтекъл (по TTL) snapshot → null, автоматично се премахва.
 * [6]  Все още валиден (в рамките на TTL) snapshot → намира се коректно.
 * [7]  Size cap: при надвишаване на maxEntries най-старите записи се premahват.
 * [8]  Всеки create() връща различен (случаен) token.
 */

import { createPlayersPageSnapshotStore } from '../src/db/playersPageSnapshotStore.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

console.log('\ncheckPlayersPageSnapshotStore')

// [1] Basic create + get roundtrip
{
  const store = createPlayersPageSnapshotStore()
  const token = store.create(['a', 'b', 'c'], false, 'viewer-1', 1000)
  const result = store.get(token, false, 'viewer-1', 1000)
  check('[1] create() + get() roundtrip със същия (isAdmin, viewer)', JSON.stringify(result) === JSON.stringify(['a', 'b', 'c']))
}

// [2] Viewer mismatch
{
  const store = createPlayersPageSnapshotStore()
  const token = store.create(['a', 'b'], false, 'viewer-1', 1000)
  const result = store.get(token, false, 'viewer-2', 1000)
  check('[2] get() с грешен viewerProfileId → null', result === null)
}

// [3] isAdmin mismatch
{
  const store = createPlayersPageSnapshotStore()
  const token = store.create(['a', 'b'], true, 'admin-1', 1000)
  const result = store.get(token, false, 'admin-1', 1000)
  check('[3] get() с грешен isAdmin → null', result === null)
}

// [4] Unknown token
{
  const store = createPlayersPageSnapshotStore()
  const result = store.get('non-existent-token', false, 'viewer-1', 1000)
  check('[4] get() с непознат token → null', result === null)
}

// [5] + [6] TTL expiry
{
  const store = createPlayersPageSnapshotStore({ ttlMs: 1000 })
  const token = store.create(['a', 'b'], false, 'viewer-1', 1000)

  const stillValid = store.get(token, false, 'viewer-1', 1500) // +500ms, под TTL
  check('[6] Все още валиден snapshot (в рамките на TTL) се намира', JSON.stringify(stillValid) === JSON.stringify(['a', 'b']))

  const expired = store.get(token, false, 'viewer-1', 2500) // +1500ms, над TTL=1000
  check('[5] Изтекъл (по TTL) snapshot → null', expired === null)

  const sizeAfterExpiry = store.size()
  check('[5b] Изтеклият snapshot се премахва от store-а', sizeAfterExpiry === 0)
}

// [7] Size cap eviction
{
  const store = createPlayersPageSnapshotStore({ maxEntries: 3, cleanupIntervalMs: 0 })
  const t1 = store.create(['a'], false, 'v1', 1000)
  const t2 = store.create(['b'], false, 'v2', 1001)
  const t3 = store.create(['c'], false, 'v3', 1002)
  const t4 = store.create(['d'], false, 'v4', 1003) // трябва да предизвика eviction на най-стария (t1)

  check('[7] Размерът не надвишава maxEntries', store.size() <= 3)
  check('[7b] Най-старият token (t1) е премахнат', store.get(t1, false, 'v1', 1003) === null)
  check('[7c] Най-новият token (t4) е още наличен', JSON.stringify(store.get(t4, false, 'v4', 1003)) === JSON.stringify(['d']))
  void t2
  void t3
}

// [8] Уникалност на token-ите
{
  const store = createPlayersPageSnapshotStore()
  const tokens = new Set<string>()
  for (let i = 0; i < 20; i++) {
    tokens.add(store.create(['x'], false, `viewer-${i}`, 1000))
  }
  check('[8] Всеки create() връща различен token', tokens.size === 20)
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
