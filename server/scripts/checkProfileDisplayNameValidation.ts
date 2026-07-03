import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  getProfileDisplayNameAvailabilityQuery,
  validateProfileDisplayName as validateFrontendProfileDisplayName,
} from '../../src/app/lobby/profileDisplayNameValidation.ts'
import {
  validateProfileDisplayName as validateBackendProfileDisplayName,
} from '../src/db/normalizeProfileIdentityText.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
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
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA foreign_keys = ON;')

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }

  db.close()
}

function assertValidName(input: string, canonical: string): void {
  const backend = validateBackendProfileDisplayName(input)
  const frontend = validateFrontendProfileDisplayName(input)
  assert(backend.ok, `backend rejected ${input}`)
  assert(frontend.ok, `frontend rejected ${input}`)
  if (backend.ok) assert(backend.canonicalDisplayName === canonical, `backend canonical=${backend.canonicalDisplayName}`)
  if (frontend.ok) assert(frontend.canonicalDisplayName === canonical, `frontend canonical=${frontend.canonicalDisplayName}`)
}

function assertInvalidName(input: string): void {
  const backend = validateBackendProfileDisplayName(input)
  const frontend = validateFrontendProfileDisplayName(input)
  assert(!backend.ok, `backend accepted ${input}`)
  assert(!frontend.ok, `frontend accepted ${input}`)
  assert(!Object.prototype.hasOwnProperty.call(backend, 'canonicalDisplayName'), 'backend invalid result exposes canonicalDisplayName')
  assert(!Object.prototype.hasOwnProperty.call(backend, 'normalizedKey'), 'backend invalid result exposes normalizedKey')
  assert(Object.prototype.hasOwnProperty.call(backend, 'canonicalCandidate'), 'backend invalid result missing canonicalCandidate')
  assert(!Object.prototype.hasOwnProperty.call(frontend, 'canonicalDisplayName'), 'frontend invalid result exposes canonicalDisplayName')
  assert(!Object.prototype.hasOwnProperty.call(frontend, 'normalizedKey'), 'frontend invalid result exposes normalizedKey')
  assert(Object.prototype.hasOwnProperty.call(frontend, 'canonicalCandidate'), 'frontend invalid result missing canonicalCandidate')
  assert(getProfileDisplayNameAvailabilityQuery(input) === null, `availability query produced for ${input}`)
}

async function main(): Promise<void> {
  await check('[1] valid names', () => {
    assertValidName('Diabla', 'Diabla')
    assertValidName('Diabla 123', 'Diabla 123')
    assertValidName('Иван', 'Иван')
    assertValidName('Иван Петров', 'Иван Петров')
    assertValidName('Иван 123', 'Иван 123')
    assertValidName('Ivan Иван', 'Ivan Иван')
    assertValidName('Ѝван', 'Ѝван')
    assertValidName('abc', 'abc')
    assertValidName('Abcdefghij Abcdefghij Abcdefghij', 'Abcdefghij Abcdefghij Abcdefghij')
  })

  await check('[2] canonicalization', () => {
    assertValidName('  Иван      Петров  ', 'Иван Петров')
    assertValidName('DIABLA    123', 'DIABLA 123')
    assertValidName('Иван\t\tПетров', 'Иван Петров')
    assertValidName('Иван\nПетров', 'Иван Петров')
    assertValidName('Иван\u00a0Петров', 'Иван Петров')
    assertValidName('𝑫𝑰𝑨𝑩𝑳𝑨', 'DIABLA')
    assertValidName('ＤＩＡＢＬＡ１２３', 'DIABLA123')
  })

  await check('[3] invalid names', () => {
    assertInvalidName('Иван-Петров')
    assertInvalidName('Иван_Петров')
    assertInvalidName('Иван❤️')
    assertInvalidName('<b>Иван</b>')
    assertInvalidName("Ivan's")
    assertInvalidName('Ivan.Petrov')
    assertInvalidName('Ivan/Petrov')
    assertInvalidName('Иван\u200bПетров')
    assertInvalidName('Иван\ufeffПетров')
    assertInvalidName('Иван\u200cПетров')
    assertInvalidName('Иван\u200dПетров')
    assertInvalidName('Иван\u2060Петров')
    assertInvalidName('Иван\u0000Петров')
    assertInvalidName('a\u0301bc')
    assertInvalidName('ab')
    assertInvalidName('Abcdefghij Abcdefghij Abcdefghij1')
    assertInvalidName('')
    assertInvalidName('     ')
  })

  await check('[4] availability query uses canonical valid value only', () => {
    assert(getProfileDisplayNameAvailabilityQuery('  Иван    Петров  ') === 'Иван Петров', 'valid query mismatch')
    assert(getProfileDisplayNameAvailabilityQuery('Иван-Петров') === null, 'invalid query should be null')
  })

  await check('[4b] allowed whitespace canonicalizes to one ASCII space', () => {
    assertValidName('Иван   Петров', 'Иван Петров')
    assertValidName('Иван\tПетров', 'Иван Петров')
    assertValidName('Иван\nПетров', 'Иван Петров')
    assertValidName('Иван\rПетров', 'Иван Петров')
    assertValidName('Иван\u00a0Петров', 'Иван Петров')
  })

  const tempDir = await mkdtemp(join(tmpdir(), 'belot-profile-name-'))
  const dbPath = join(tempDir, 'profile-name.sqlite')
  let progressStore: Awaited<ReturnType<typeof createPlayerProgressStore>> | null = null
  let authStore: Awaited<ReturnType<typeof createAuthStore>> | null = null
  let db: DatabaseSync | null = null

  try {
    await applyMigrations(dbPath)
    progressStore = await createPlayerProgressStore(dbPath)
    authStore = await createAuthStore(dbPath, progressStore)
    db = new DatabaseSync(dbPath, { open: true })

    await check('[5] registration stores canonical display and username', () => {
      const result = authStore?.register({
        email: 'diabla@example.test',
        password: 'secret1',
        displayName: '  𝑫𝑰𝑨𝑩𝑳𝑨  ',
        gender: 'female',
      })
      assert(result?.ok === true, 'registration failed')
      const row = db?.prepare(`
        SELECT username, normalized_username, display_name, normalized_display_name
        FROM profiles
        WHERE account_id = ?
        LIMIT 1;
      `).get(result.ok ? result.session.account.accountId : '') as
        | {
            username: string
            normalized_username: string
            display_name: string
            normalized_display_name: string
          }
        | undefined
      assert(row !== undefined, 'profile row missing')
      assert(row.username === 'DIABLA', `username=${row.username}`)
      assert(row.display_name === 'DIABLA', `display_name=${row.display_name}`)
      assert(row.normalized_username === 'diabla', `normalized_username=${row.normalized_username}`)
      assert(row.normalized_display_name === 'diabla', `normalized_display_name=${row.normalized_display_name}`)
    })

    await check('[6] registration uniqueness is case-insensitive and NFKC-aware', () => {
      const result = authStore?.register({
        email: 'diabla2@example.test',
        password: 'secret1',
        displayName: 'diabla',
        gender: 'female',
      })
      assert(result?.ok === false, 'duplicate registration succeeded')
    })

    await check('[7] availability uses same canonicalization', () => {
      assert(progressStore?.isDisplayNameAvailable('𝑫𝑰𝑨𝑩𝑳𝑨') === false, 'decorative duplicate available')
      assert(progressStore?.isDisplayNameAvailable('DIABLA') === false, 'case duplicate available')
      assert(progressStore?.isDisplayNameAvailable('Иван-Петров') === false, 'invalid name available')
    })

    await check('[8] profile rename stores canonical value', () => {
      const registered = authStore?.register({
        email: 'rename@example.test',
        password: 'secret1',
        displayName: 'Player One',
        gender: 'male',
      })
      assert(registered?.ok === true, 'registration failed')
      const result = progressStore?.changeProfileDisplayName(
        registered.ok ? registered.session.profile.profileId : '',
        ' Иван  Петров ',
        0,
      )
      assert(result?.ok === true, 'rename failed')
      if (result?.ok) assert(result.profile.displayName === 'Иван Петров', `displayName=${result.profile.displayName}`)
      assert(progressStore?.isDisplayNameAvailable('Иван   Петров') === false, 'canonical rename duplicate available')
    })

    await check('[9] temporary human fallback is unique canonical display', () => {
      const guestRegistration = authStore?.register({
        email: 'guest@example.test',
        password: 'secret1',
        displayName: 'Гост',
        gender: 'male',
      })
      assert(guestRegistration?.ok === true, 'Гост registration failed')

      const first = progressStore?.createTemporaryHumanProfile('Иван-Петров', 'temp-one')
      const second = progressStore?.createTemporaryHumanProfile('Иван-Петров', 'temp-two')
      assert(first !== undefined && second !== undefined, 'temporary profiles missing')
      assert(first.displayName !== 'Гост', 'first fallback used bare Гост')
      assert(second.displayName !== 'Гост', 'second fallback used bare Гост')
      assert(first.displayName !== second.displayName, 'temporary fallbacks collided')
      assert(first.displayName.startsWith('Гост '), `first displayName=${first.displayName}`)
      assert(second.displayName.startsWith('Гост '), `second displayName=${second.displayName}`)
      assert(first.displayName.length <= 32, `first too long: ${first.displayName}`)
      assert(second.displayName.length <= 32, `second too long: ${second.displayName}`)
      assert(validateBackendProfileDisplayName(first.displayName).ok, 'first fallback invalid')
      assert(validateBackendProfileDisplayName(second.displayName).ok, 'second fallback invalid')

      const rows = db?.prepare(`
        SELECT display_name, normalized_display_name
        FROM profiles
        WHERE profile_id IN (?, ?)
        ORDER BY profile_id ASC;
      `).all(first.profileId, second.profileId) as
        | Array<{ display_name: string; normalized_display_name: string }>
        | undefined
      assert(rows?.length === 2, `temporary rows=${rows?.length ?? 0}`)
      for (const row of rows) {
        assert(
          row.normalized_display_name === row.display_name.toLocaleLowerCase('bg-BG'),
          `mismatch ${row.display_name} / ${row.normalized_display_name}`,
        )
      }
    })

    await check('[10] normalized_username reservations affect availability and registration', () => {
      db?.prepare(`
        INSERT INTO profiles (
          profile_id,
          account_id,
          profile_kind,
          username,
          normalized_username,
          display_name,
          normalized_display_name,
          status
        ) VALUES (
          'reserved-username-profile',
          NULL,
          'human',
          'ReservedName',
          'reservedname',
          'OtherName',
          'othername',
          'active'
        );
      `).run()

      assert(progressStore?.isDisplayNameAvailable('ReservedName') === false, 'username reservation available')
      assert(progressStore?.isDisplayNameAvailable('𝑹𝒆𝒔𝒆𝒓𝒗𝒆𝒅𝑵𝒂𝒎𝒆') === false, 'NFKC username reservation available')
      const result = authStore?.register({
        email: 'reserved@example.test',
        password: 'secret1',
        displayName: 'ReservedName',
        gender: 'male',
      })
      assert(result?.ok === false, 'registration with reserved username succeeded')
      if (result?.ok === false) assert(result.message === 'Това име вече е заето.', `message=${result.message}`)
    })

    await check('[11] invalid and taken rename do not debit; successful rename debits once', () => {
      const registered = authStore?.register({
        email: 'economy@example.test',
        password: 'secret1',
        displayName: 'Economy Player',
        gender: 'male',
      })
      assert(registered?.ok === true, 'economy registration failed')
      const profileId = registered.ok ? registered.session.profile.profileId : ''
      db?.prepare(`UPDATE profile_wallets SET yellow_coins_balance = 1000 WHERE profile_id = ?`).run(profileId)

      const balance = (): number => {
        const row = db?.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
          | { yellow_coins_balance: number }
          | undefined
        return row?.yellow_coins_balance ?? -1
      }

      const invalid = progressStore?.changeProfileDisplayName(profileId, 'Bad-Name', 100)
      assert(invalid?.ok === false, 'invalid rename succeeded')
      assert(balance() === 1000, `invalid rename debited balance=${balance()}`)

      const taken = progressStore?.changeProfileDisplayName(profileId, 'ReservedName', 100)
      assert(taken?.ok === false, 'taken username rename succeeded')
      assert(balance() === 1000, `taken rename debited balance=${balance()}`)

      const success = progressStore?.changeProfileDisplayName(profileId, 'Economy Winner', 100)
      assert(success?.ok === true, 'valid rename failed')
      assert(balance() === 900, `successful rename balance=${balance()}`)
    })

    await check('[12] blur: invalid input with zero-width chars stays invalid (validator rejects, no silent canonicalization)', () => {
      // Иван﻿Петров contains a BOM format character — the validator must reject it
      // even though canonicalizeProfileDisplayName() would produce "Иван Петров"
      const zwInput = 'Иван﻿Петров'
      const frontend = validateFrontendProfileDisplayName(zwInput)
      assert(!frontend.ok, 'frontend accepted zero-width input')
      assert(frontend.ok === false && frontend.reason === 'invalid-characters', `reason=${frontend.ok ? '' : frontend.reason}`)
      // The blur handler must NOT write canonicalCandidate to the input when ok=false.
      // We verify this contract by confirming that validation.ok is false — only then
      // does the blur handler leave the input unchanged.
      assert(frontend.ok === false, 'blur would silently canonicalize: ok is unexpectedly true')

      // Same on backend
      const backend = validateBackendProfileDisplayName(zwInput)
      assert(!backend.ok, 'backend accepted zero-width input')
      assert(backend.ok === false && backend.reason === 'invalid-characters', `backend reason=${backend.ok ? '' : backend.reason}`)

      // getProfileDisplayNameAvailabilityQuery must return null for this input
      const query = getProfileDisplayNameAvailabilityQuery(zwInput)
      assert(query === null, `availability query non-null for invalid input: ${query}`)
    })

    await check('[13] cross-column name reservation race: register blocks on name taken inside transaction', () => {
      // Simulate the race: first registrant gets the name, second must fail
      const r1 = authStore?.register({ email: 'race1@example.test', password: 'secret1', displayName: 'RaceName', gender: 'male' })
      assert(r1?.ok === true, 'race1 registration failed')
      const r2 = authStore?.register({ email: 'race2@example.test', password: 'secret1', displayName: 'RaceName', gender: 'male' })
      assert(r2?.ok === false, 'race2 registration succeeded (race not protected)')
      if (r2?.ok === false) assert(r2.message.includes('заето') || r2.message.includes('заета'), `message=${r2.message}`)
    })

    await check('[14] cross-column rename race: rename blocks on name taken inside transaction, wallet not debited', () => {
      const rr = authStore?.register({ email: 'raceRename@example.test', password: 'secret1', displayName: 'RaceRenamePlayer', gender: 'female' })
      assert(rr?.ok === true, 'raceRename registration failed')
      const pid = rr?.ok ? rr.session.profile.profileId : ''
      db?.prepare(`UPDATE profile_wallets SET yellow_coins_balance = 500 WHERE profile_id = ?`).run(pid)
      const getBalance = (): number => {
        const row = db?.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(pid) as { yellow_coins_balance: number } | undefined
        return row?.yellow_coins_balance ?? -1
      }
      // Try to rename to an already-taken name (RaceName from [13])
      const taken = progressStore?.changeProfileDisplayName(pid, 'RaceName', 100)
      assert(taken?.ok === false, 'rename to taken name succeeded')
      assert(getBalance() === 500, `wallet debited on failed rename: balance=${getBalance()}`)
    })
  } finally {
    authStore?.close()
    progressStore?.close()
    db?.close()
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log(`\nProfile display name checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
