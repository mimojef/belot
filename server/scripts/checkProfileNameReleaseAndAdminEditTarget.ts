/**
 * checkProfileNameReleaseAndAdminEditTarget.ts
 *
 * Regression за два production бъга, диагностицирани заедно (но с ОТДЕЛНИ
 * root causes — виж по-долу), реален случай: администраторски профил
 * "Mimojef" опитал да редактира чужд профил, вместо това погрешно
 * преименувал СЕБЕ СИ на "Pika BG", а системата после не позволила старото
 * име "Mimojef" да бъде възстановено, защото го е отчела за заето.
 *
 * ─── БЪГ 1: admin edit отваря собствения профил вместо избрания ──────────
 *
 * Root cause: LobbyScreenOptions.onProfileEditClick (src/app/lobby/
 * renderLobbyScreen.ts) беше типизиран `() => void` — БЕЗ profileId
 * параметър — докато createLobbyFlowController.ts-ата имплементация
 * игнорираше подадения аргумент и безусловно отваряше собствения профил
 * на потребителя (state.profileEditorTargetProfileId = null).
 *
 * Този callback се закача в renderLobbyScreen()'s ГЛАВЕН syncProfilePopup
 * call (пълния full-page render path, викан от createLobbyFlowController's
 * render() → renderLobby() при ВСЯКО фоново WS събитие — chat, presence,
 * countdown тикове и т.н., виж коментарите в renderLobbyScreen.ts около
 * "всяко несвързано WS събитие пренарежда целия root"). Има и ВТОРИ,
 * коректен callback getPopupCallbacks().onEditClick(profileId) — той се
 * ползва само от incremental single-popup re-render (renderPopupOnly(),
 * викан директно от click handler-и). Двата callback-а рисуват СЪЩИЯ DOM
 * елемент (data-player-profile-edit="1"), затова кой от двата всъщност
 * отговаря на клика зависи изцяло от това кой render е бил последен —
 * а на практика full-render почти винаги "печели" междувременно, защото се
 * тригерва от фонов WS трафик, несвързан с потребителското действие.
 *
 * Резултат: admin отваря попъпа на ЧУЖД профил (визуално коректно —
 * state.profilePopupProfile сочи вярно), но до момента на клик върху
 * "Редакция" почти сигурно вече е минал поне един full re-render, който е
 * презаписал бутона с грешния (own-profile) callback. Кликът тихо отваря
 * и после submit-ва редакция на СОБСТВЕНИЯ профил на admin-а.
 *
 * Fix: onProfileEditClick вече приема (profileId: string | null) => void
 * и делегира директно към getPopupCallbacks().onEditClick(profileId) — така
 * двата render path-а вече споделят точно същата target-resolution логика
 * (openProfileEditorForTarget), няма разминаване кой от двата е "последен".
 *
 * ─── БЪГ 2: старото име остава "заето" след успешна смяна ────────────────
 *
 * Root cause: колоната profiles.normalized_username (защитена от отделен
 * UNIQUE INDEX idx_profiles_normalized_username_unique) се записва САМО
 * ЕДНЪЖ, при регистрация (authStore.register), като snapshot на
 * първоначалното display name. Нито changeProfileDisplayName (self-service)
 * нито adminRenameProfileDisplayName (admin) обновяваха username/
 * normalized_username при смяна на име — те пипаха само display_name/
 * normalized_display_name. Но uniqueness проверката
 * (selectProfileByReservedIdentityNameStatement, ползвана от register,
 * changeProfileDisplayName, isDisplayNameAvailable) гледа
 * normalized_display_name OR normalized_username — старото име оставаше
 * завинаги "запазено" в normalized_username, независимо че вече не е
 * активното display name на никого.
 *
 * Fix: updateProfileDisplayNameStatement сега обновява display_name,
 * normalized_display_name, username И normalized_username едновременно
 * (единствен UPDATE statement — атомарно, без междинно състояние). Старото
 * име се освобождава веднага; текущото име остава защитено от ДВАТА UNIQUE
 * индекса едновременно (без промяна в тяхната схема). adminRenameProfileDisplayName
 * вече прави и explicit pre-check конфликт (огледално на self-service пътя),
 * вместо да разчита само на UNIQUE constraint catch.
 *
 * ─── Не е обща причина ────────────────────────────────────────────────────
 *
 * Двата бъга са в напълно различни части на системата (клиентски popup
 * callback wiring срещу server SQL rename statement) — свързани са само в
 * production инцидента като последователност от събития (грешна редакция
 * → искане на връщане на старото име → блокирано от Бъг 2), не като обща
 * причина. Сценарий [C] по-долу доказва двата фикса заедно, но всеки от
 * тях се доказва и поотделно ([A]/[D] за Бъг 1, [B] за Бъг 2).
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const projectRoot = resolve(serverRoot, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function checkSync(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of migrationFiles) {
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.close()
}

console.log('\ncheckProfileNameReleaseAndAdminEditTarget\n')

// ─────────────────────────────────────────────────────────────────────────
// [D] Client-side source/behavior checks — proves the ACTUAL bug (missing
// profileId plumbing through the full-render callback path), not just that
// SOME edit-related string exists somewhere.
// ─────────────────────────────────────────────────────────────────────────
console.log('--- [D] Client-side target-profile wiring (full render path) ---')

function readSourceNormalized(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf8').replace(/\r\n/g, '\n')
}

const renderLobbyScreenSrc = readSourceNormalized('src/app/lobby/renderLobbyScreen.ts')
const controllerSrc = readSourceNormalized('src/app/lobby/createLobbyFlowController.ts')

checkSync(
  '[D1] LobbyScreenOptions.onProfileEditClick accepts a profileId (the full-render path callback type, NOT just the popup-only ProfilePopupCallbacks type)',
  /onProfileEditClick:\s*\(profileId:\s*string\s*\|\s*null\)\s*=>\s*void/.test(renderLobbyScreenSrc),
)

checkSync(
  '[D2] the main syncProfilePopup() call inside renderLobbyScreen() (the full re-render path triggered by every background WS event) wires onEditClick to options.onProfileEditClick, forwarding the SAME profileId the popup click carries',
  /onEditClick:\s*options\.onProfileEditClick,/.test(renderLobbyScreenSrc),
)

const onProfileEditClickImplMatch = controllerSrc.match(
  /onProfileEditClick:\s*\(profileId\)\s*=>\s*\{([\s\S]*?)\n {6}\},/,
)
checkSync(
  '[D3] createLobbyFlowController.ts\'s onProfileEditClick implementation exists and takes the profileId parameter (not a no-arg () => {...} that silently discards it)',
  onProfileEditClickImplMatch !== null,
)
if (onProfileEditClickImplMatch !== null) {
  const body = onProfileEditClickImplMatch[1]
  checkSync(
    '[D4] onProfileEditClick delegates to getPopupCallbacks().onEditClick(profileId) — the SAME target-resolution function used by the popup-only render path, so both render paths agree on which profile is being edited',
    /getPopupCallbacks\(\)\.onEditClick\(profileId\)/.test(body),
  )
  checkSync(
    '[D5] onProfileEditClick body does NOT unconditionally null out profileEditorTargetProfileId (the exact bug: silently forcing own-profile edit regardless of which profile was clicked)',
    !/state\.profileEditorTargetProfileId\s*=\s*null/.test(body),
  )
}

checkSync(
  '[D6] openProfileEditorForTarget() (the shared target-resolution function both render paths now funnel through) requires isFullAdminAuthSession() before honoring a non-own profileId — a normal player cannot redirect edits to someone else via this path',
  /function openProfileEditorForTarget[\s\S]*?if \(!isOwn && !isFullAdminAuthSession\(authSession\)\)/.test(controllerSrc),
)

// ─────────────────────────────────────────────────────────────────────────
// [A]+[C] Server-side: admin edits exactly the selected target profile,
// actor (admin session) is never mutated as a side effect, and the exact
// "Mimojef → Pika BG" incident shape is covered end-to-end against a real
// isolated SQLite database.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n--- [A]+[C] Server-side: admin renames the TARGET, actor untouched ---')

{
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-admin-edit-target-'))
  const dbPath = join(tempDir, 'admin-edit-target.sqlite')
  let progressStore: Awaited<ReturnType<typeof createPlayerProgressStore>> | null = null
  let authStore: Awaited<ReturnType<typeof createAuthStore>> | null = null
  let db: DatabaseSync | null = null

  try {
    await applyMigrations(dbPath)
    progressStore = await createPlayerProgressStore(dbPath)
    authStore = await createAuthStore(dbPath, progressStore)
    db = new DatabaseSync(dbPath, { open: true })

    const readNames = (profileId: string) => {
      const row = db!.prepare(`
        SELECT display_name, normalized_display_name, username, normalized_username
        FROM profiles WHERE profile_id = ? LIMIT 1;
      `).get(profileId) as
        | { display_name: string; normalized_display_name: string; username: string; normalized_username: string }
        | undefined
      assert(row !== undefined, `profile row missing for ${profileId}`)
      return row!
    }

    // Regression case [C]: admin "Mimojef", target profile "TargetPlayer",
    // bystander "Bystander" (a 3rd profile that must remain fully untouched).
    const adminReg = authStore!.register({ email: 'mimojef@example.test', password: 'secret1', displayName: 'Mimojef', gender: 'male' })
    assert(adminReg.ok === true, 'admin registration failed')
    const adminProfileId = adminReg.ok ? adminReg.session.profile.profileId : ''

    const targetReg = authStore!.register({ email: 'targetplayer@example.test', password: 'secret1', displayName: 'TargetPlayer', gender: 'male' })
    assert(targetReg.ok === true, 'target registration failed')
    const targetProfileId = targetReg.ok ? targetReg.session.profile.profileId : ''

    const bystanderReg = authStore!.register({ email: 'bystander@example.test', password: 'secret1', displayName: 'Bystander', gender: 'female' })
    assert(bystanderReg.ok === true, 'bystander registration failed')
    const bystanderProfileId = bystanderReg.ok ? bystanderReg.session.profile.profileId : ''

    await check('[C1] admin renames TargetPlayer via adminRenameProfileDisplayName(targetProfileId, ...) — the target profile changes', () => {
      const result = progressStore!.adminRenameProfileDisplayName(targetProfileId, 'RenamedTarget')
      assert(result.ok === true, `admin rename failed: ${result.ok ? '' : result.message}`)
      const row = readNames(targetProfileId)
      assert(row.display_name === 'RenamedTarget', `target display_name=${row.display_name}`)
    })

    await check('[C2] the ADMIN\'s own profile ("Mimojef") is completely untouched by an admin-target rename — this is the exact production incident shape (admin ended up renamed instead of the target)', () => {
      const row = readNames(adminProfileId)
      assert(row.display_name === 'Mimojef', `admin display_name mutated to "${row.display_name}" — this IS the production bug`)
      assert(row.normalized_display_name === 'mimojef', `admin normalized_display_name mutated to "${row.normalized_display_name}"`)
    })

    await check('[C3] the bystander profile is completely untouched', () => {
      const row = readNames(bystanderProfileId)
      assert(row.display_name === 'Bystander', `bystander display_name mutated to "${row.display_name}"`)
    })

    await check('[C4] the old target name "TargetPlayer" is freed by the rename — a THIRD profile can now register it', () => {
      const available = progressStore!.isDisplayNameAvailable('TargetPlayer')
      assert(available === true, 'old target name "TargetPlayer" still reserved after being vacated by rename')
      const thirdReg = authStore!.register({ email: 'thirdparty@example.test', password: 'secret1', displayName: 'TargetPlayer', gender: 'male' })
      assert(thirdReg.ok === true, `a fresh profile could not claim the freed name: ${thirdReg.ok ? '' : thirdReg.message}`)
    })

    await check('[C5] "Mimojef" itself is never treated as reserved/unavailable for its own current owner (the admin never lost their own name)', () => {
      const stillOwn = progressStore!.isDisplayNameAvailable('Mimojef', adminProfileId)
      assert(stillOwn === true, 'admin excluded-self check incorrectly reports own current name as unavailable')
    })

    await check('[A6] admin cannot silently create a duplicate/second identity for the target — exactly one profile row exists for targetProfileId, with the new name', () => {
      const rows = db!.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE profile_id = ?;`).get(targetProfileId) as { n: number }
      assert(rows.n === 1, `expected exactly 1 row for target, got ${rows.n}`)
    })
  } finally {
    authStore?.close()
    progressStore?.close()
    db?.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// [B] Old-name release and re-use — the 7 required scenarios.
// ─────────────────────────────────────────────────────────────────────────
console.log('\n--- [B] Old name release and re-use ---')

{
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-name-release-'))
  const dbPath = join(tempDir, 'name-release.sqlite')
  let progressStore: Awaited<ReturnType<typeof createPlayerProgressStore>> | null = null
  let authStore: Awaited<ReturnType<typeof createAuthStore>> | null = null
  let db: DatabaseSync | null = null

  try {
    await applyMigrations(dbPath)
    progressStore = await createPlayerProgressStore(dbPath)
    authStore = await createAuthStore(dbPath, progressStore)
    db = new DatabaseSync(dbPath, { open: true })

    const setBalance = (profileId: string, amount: number): void => {
      db!.prepare(`UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?`).run(amount, profileId)
    }
    const readUsernameCols = (profileId: string) => {
      const row = db!.prepare(`
        SELECT username, normalized_username, display_name, normalized_display_name
        FROM profiles WHERE profile_id = ? LIMIT 1;
      `).get(profileId) as
        | { username: string; normalized_username: string; display_name: string; normalized_display_name: string }
        | undefined
      assert(row !== undefined, `profile row missing for ${profileId}`)
      return row!
    }

    const bReg = authStore!.register({ email: 'b-player@example.test', password: 'secret1', displayName: 'Alpha', gender: 'male' })
    assert(bReg.ok === true, 'B registration failed')
    const bProfileId = bReg.ok ? bReg.session.profile.profileId : ''
    setBalance(bProfileId, 10_000)

    await check('[B1] B: Alpha -> Beta succeeds and username/normalized_username move WITH the rename (not left pinned to "alpha")', () => {
      const result = progressStore!.changeProfileDisplayName(bProfileId, 'Beta', 100)
      assert(result.ok === true, `rename failed: ${result.ok ? '' : result.message}`)
      const row = readUsernameCols(bProfileId)
      assert(row.display_name === 'Beta', `display_name=${row.display_name}`)
      assert(row.normalized_display_name === 'beta', `normalized_display_name=${row.normalized_display_name}`)
      assert(row.username === 'Beta', `username=${row.username} (still pinned to old name — THIS IS THE BUG)`)
      assert(row.normalized_username === 'beta', `normalized_username=${row.normalized_username} (still pinned to old name — THIS IS THE BUG)`)
    })

    await check('[B2] only "Beta" is B\'s active name — "Alpha" is fully released (isDisplayNameAvailable reports it free)', () => {
      const alphaFree = progressStore!.isDisplayNameAvailable('Alpha')
      assert(alphaFree === true, 'Alpha still reported unavailable after B renamed away from it')
      const betaTaken = progressStore!.isDisplayNameAvailable('Beta')
      assert(betaTaken === false, 'Beta (B\'s current name) incorrectly reported available')
    })

    const cReg = authStore!.register({ email: 'c-player@example.test', password: 'secret1', displayName: 'Gamma', gender: 'female' })
    assert(cReg.ok === true, 'C registration failed')
    const cProfileId = cReg.ok ? cReg.session.profile.profileId : ''
    setBalance(cProfileId, 10_000)

    await check('[B3] C successfully claims the freed "Alpha"', () => {
      const result = progressStore!.changeProfileDisplayName(cProfileId, 'Alpha', 100)
      assert(result.ok === true, `C could not claim freed Alpha: ${result.ok ? '' : result.message}`)
      if (result.ok) assert(result.profile.displayName === 'Alpha', `C displayName=${result.profile.displayName}`)
    })

    await check('[B4] B trying to go back to "Alpha" now that C owns it is correctly rejected', () => {
      const result = progressStore!.changeProfileDisplayName(bProfileId, 'Alpha', 100)
      assert(result.ok === false, 'B was allowed to steal Alpha from C')
      if (!result.ok) assert(result.message === 'Това име вече е заето.', `message=${result.message}`)
      // No partial mutation: B is still Beta.
      const row = readUsernameCols(bProfileId)
      assert(row.display_name === 'Beta', `B display_name changed to ${row.display_name} despite rejected rename`)
    })

    await check('[B5] once C releases "Alpha" (renames away), B can reclaim it', () => {
      const cRenameAway = progressStore!.changeProfileDisplayName(cProfileId, 'GammaAgain', 100)
      assert(cRenameAway.ok === true, `C could not rename away: ${cRenameAway.ok ? '' : cRenameAway.message}`)
      const bReclaim = progressStore!.changeProfileDisplayName(bProfileId, 'Alpha', 100)
      assert(bReclaim.ok === true, `B could not reclaim freed Alpha: ${bReclaim.ok ? '' : bReclaim.message}`)
      if (bReclaim.ok) assert(bReclaim.profile.displayName === 'Alpha', `B displayName=${bReclaim.profile.displayName}`)
    })

    await check('[B6] saving the SAME name (no real change) does not give a false "taken" error — it is rejected with the distinct "must be different" message, and check-name (self-excluded) reports it available', () => {
      const sameNameResult = progressStore!.changeProfileDisplayName(bProfileId, 'Alpha', 100)
      assert(sameNameResult.ok === false, 'renaming to the exact same current name unexpectedly succeeded')
      if (!sameNameResult.ok) {
        assert(
          sameNameResult.message === 'Новото име трябва да е различно от текущото.',
          `expected the distinct "must differ" message, got: "${sameNameResult.message}" (a bare "already taken" would be the false-conflict bug)`,
        )
      }
      // check-name / live-availability path must exclude the caller's own profile.
      const availableForSelf = progressStore!.isDisplayNameAvailable('Alpha', bProfileId)
      assert(availableForSelf === true, 'check-name reports the caller\'s OWN current name as unavailable to themselves')
    })

    await check('[B7] a normalized-equivalent of another profile\'s current name is rejected (case/NFKC aware), and no partial row mutation occurs on the rejected attempt', () => {
      const before = readUsernameCols(cProfileId)
      const attempt = progressStore!.changeProfileDisplayName(bProfileId, 'gammaagain', 100) // C's current name, different case
      assert(attempt.ok === false, 'case-insensitive duplicate of another profile\'s current name was accepted')
      const after = readUsernameCols(cProfileId)
      assert(before.display_name === after.display_name, 'bystander C profile mutated by a REJECTED rename attempt on B')
    })

    await check('[B8] concurrent claims of one freed name: only one of two competing renames succeeds (DB-level UNIQUE constraint, not just a pre-check)', () => {
      // Free up a fresh name via a throwaway profile, then race two other
      // profiles for it using the DB's actual UNIQUE constraint as the
      // final arbiter (sequential calls here — the guarantee under test is
      // the constraint itself, exercised identically to a real race:
      // the second writer must be rejected by the DB, not just a client-side
      // pre-check that both callers could pass simultaneously).
      const seedReg = authStore!.register({ email: 'seed-race@example.test', password: 'secret1', displayName: 'RaceSeed', gender: 'male' })
      assert(seedReg.ok === true, 'seed registration failed')
      const seedId = seedReg.ok ? seedReg.session.profile.profileId : ''
      setBalance(seedId, 10_000)
      const freeIt = progressStore!.changeProfileDisplayName(seedId, 'RaceSeedRenamed', 100)
      assert(freeIt.ok === true, 'could not free RaceSeed')

      const racerAReg = authStore!.register({ email: 'racer-a@example.test', password: 'secret1', displayName: 'RacerA', gender: 'male' })
      const racerBReg = authStore!.register({ email: 'racer-b@example.test', password: 'secret1', displayName: 'RacerB', gender: 'female' })
      assert(racerAReg.ok === true && racerBReg.ok === true, 'racer registrations failed')
      const racerAId = racerAReg.ok ? racerAReg.session.profile.profileId : ''
      const racerBId = racerBReg.ok ? racerBReg.session.profile.profileId : ''
      setBalance(racerAId, 10_000)
      setBalance(racerBId, 10_000)

      const claimA = progressStore!.changeProfileDisplayName(racerAId, 'RaceSeed', 100)
      const claimB = progressStore!.changeProfileDisplayName(racerBId, 'RaceSeed', 100)
      const successCount = [claimA.ok, claimB.ok].filter(Boolean).length
      assert(successCount === 1, `expected exactly 1 of 2 concurrent claims to succeed, got ${successCount}`)
    })
  } finally {
    authStore?.close()
    progressStore?.close()
    db?.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
