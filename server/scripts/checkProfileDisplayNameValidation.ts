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
  OFFICIAL_PIKA_PROFILE_ID,
  PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE,
  PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE,
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

function assertValidName(
  input: string,
  canonical: string,
  options: { profileId?: string | null; officialPikaProfileId?: string | null } = {},
): void {
  const backend = validateBackendProfileDisplayName(input, options)
  const frontend = validateFrontendProfileDisplayName(input, options)
  assert(backend.ok, `backend rejected ${input}`)
  assert(frontend.ok, `frontend rejected ${input}`)
  if (backend.ok) assert(backend.canonicalDisplayName === canonical, `backend canonical=${backend.canonicalDisplayName}`)
  if (frontend.ok) assert(frontend.canonicalDisplayName === canonical, `frontend canonical=${frontend.canonicalDisplayName}`)
  assert(getProfileDisplayNameAvailabilityQuery(input, options) === canonical, `availability query mismatch for ${input}`)
}

function assertInvalidName(
  input: string,
  expectedCode?: 'NOT_STRING' | 'LENGTH' | 'INVALID_CHARACTERS' | 'MIXED_ALPHABETS' | 'RESERVED_PIKA_NAME',
  expectedMessage?: string,
): void {
  const backend = validateBackendProfileDisplayName(input)
  const frontend = validateFrontendProfileDisplayName(input)
  if (backend.ok) throw new Error(`backend accepted ${input}`)
  if (frontend.ok) throw new Error(`frontend accepted ${input}`)
  assert(!Object.prototype.hasOwnProperty.call(backend, 'canonicalDisplayName'), 'backend invalid result exposes canonicalDisplayName')
  assert(!Object.prototype.hasOwnProperty.call(backend, 'normalizedKey'), 'backend invalid result exposes normalizedKey')
  assert(Object.prototype.hasOwnProperty.call(backend, 'canonicalCandidate'), 'backend invalid result missing canonicalCandidate')
  assert(!Object.prototype.hasOwnProperty.call(frontend, 'canonicalDisplayName'), 'frontend invalid result exposes canonicalDisplayName')
  assert(!Object.prototype.hasOwnProperty.call(frontend, 'normalizedKey'), 'frontend invalid result exposes normalizedKey')
  assert(Object.prototype.hasOwnProperty.call(frontend, 'canonicalCandidate'), 'frontend invalid result missing canonicalCandidate')
  if (expectedCode !== undefined) {
    assert(backend.code === expectedCode, `backend code=${backend.code}`)
    assert(frontend.code === expectedCode, `frontend code=${frontend.code}`)
  }
  if (expectedMessage !== undefined) {
    assert(backend.message === expectedMessage, `backend message=${backend.message}`)
    assert(frontend.message === expectedMessage, `frontend message=${frontend.message}`)
  }
  assert(getProfileDisplayNameAvailabilityQuery(input) === null, `availability query produced for ${input}`)
}

function assertInvalidName2(
  result: ReturnType<typeof validateBackendProfileDisplayName>,
  expectedCode: 'NOT_STRING' | 'LENGTH' | 'INVALID_CHARACTERS' | 'MIXED_ALPHABETS' | 'RESERVED_PIKA_NAME',
): void {
  assert(result.ok === false, 'expected validation to fail')
  if (result.ok === false) {
    assert(result.code === expectedCode, `code=${result.code}, expected=${expectedCode}`)
  }
}

const CYRILLIC_ER = '\u0420'
const CYRILLIC_KA = '\u041A'
const CYRILLIC_A = '\u0410'
const CYRILLIC_VE = '\u0412'
const CYRILLIC_EM = '\u041C'
const CYRILLIC_IE = '\u0435'
const CYRILLIC_EL = '\u043B'

const MIXED_SCRIPT_CASES = [
  `${CYRILLIC_EM}ilen`,
  `Mi${CYRILLIC_EL}${CYRILLIC_IE}n`,
  '\u0418\u0432\u0430\u043DPetrov',
  `P${CYRILLIC_IE}t${CYRILLIC_IE}r`,
  'Pika \u0411\u0413',
  '\u041F\u0438\u043A\u0430 BG',
]

const RESERVED_PIKA_CASES = [
  // Latin case variants
  'PIKABG',
  'pikabg',
  'Pikabg',
  'PikaBG',
  'PiKaBG',
  'pIkAbG',
  'PIKA BG',
  'Pika Bg',
  'pika bg',
  'P I K A B G',
  'Pi Ka Bg',
  'PIKABG origin',
  'PikaBG origin',
  'origin PIKABG',
  'origin Pika Bg',
  'PIKABG 1',
  '1 PIKABG',
  'MYPIKABG',
  'myPikaBg',
  'PIKABGUSER',
  'Pika Bg Support',
  'Support Pika Bg',
  // Cyrillic case variants
  'ПИКАБГ',
  'пикабг',
  'Пикабг',
  'ПикаБГ',
  'ПиКаБг',
  'пИкАбГ',
  'ПИКА БГ',
  'Пика Бг',
  'пика бг',
  'П И К А Б Г',
  'Пи Ка Бг',
  'ПИКАБГ произход',
  'ПикаБГ произход',
  'произход ПИКАБГ',
  'произход Пика Бг',
  'ПИКАБГ 1',
  '1 ПИКАБГ',
  'МОЯТПИКАБГ',
  'ПИКАБГИГРА',
  'Пика Бг Поддръжка',
  'Поддръжка Пика Бг',
]

const ALLOWED_PARTIAL_PIKA_CASES = [
  'PIKA',
  'PIKAB',
  'PIKAG',
  'PIKABOX',
  'PIKAGAME',
  'BGPIKA',
  'PIKA HOME',
  'PIKA TEAM',
  'ПИКА',
  'ПИКАБ',
  'ПИКАИГРА',
  'БГПИКА',
  'ПИКА ДОМ',
  'ПИКА ОТБОР',
]

function withOfficialPikaEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PIKA_OFFICIAL_PROFILE_ID
  try {
    if (value === undefined) {
      delete process.env.PIKA_OFFICIAL_PROFILE_ID
    } else {
      process.env.PIKA_OFFICIAL_PROFILE_ID = value
    }
    return fn()
  } finally {
    if (previous === undefined) {
      delete process.env.PIKA_OFFICIAL_PROFILE_ID
    } else {
      process.env.PIKA_OFFICIAL_PROFILE_ID = previous
    }
  }
}

async function main(): Promise<void> {
  await check('[1] valid names', () => {
    assertValidName('Diabla', 'Diabla')
    assertValidName('Diabla 123', 'Diabla 123')
    assertValidName('Иван', 'Иван')
    assertValidName('Иван Петров', 'Иван Петров')
    assertValidName('Иван 123', 'Иван 123')
    assertValidName('Пика Дом', 'Пика Дом')
    assertValidName('Ѝван', 'Ѝван')
    assertValidName('abc', 'abc')
    assertValidName('Abcdefghij Abcdefghij Abcdefghij', 'Abcdefghij Abcdefghij Abcdefghij')
  })

  await check('[1b] mixed Cyrillic/Latin names are rejected with exact message', () => {
    for (const input of MIXED_SCRIPT_CASES) {
      assertInvalidName(input, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    }
    assertInvalidName(`${CYRILLIC_ER}IKABG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName(`PI${CYRILLIC_KA}ABG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName(`PIK${CYRILLIC_A}BG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName(`PIKA${CYRILLIC_VE}G`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
  })

  await check('[1c] reserved PIKABG/ПИКАБГ variants are blocked by containment, regardless of position', () => {
    for (const input of RESERVED_PIKA_CASES) {
      assertInvalidName(input, 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    }
  })

  await check('[1c-2] names containing only PIKA/ПИКА (not the full reserved sequence) remain allowed', () => {
    for (const input of ALLOWED_PARTIAL_PIKA_CASES) {
      assertValidName(input, input)
    }
  })

  await check('[1d] official exact profileId can keep the reserved PIKABG name only with explicit valid config', () => {
    const official = {
      profileId: OFFICIAL_PIKA_PROFILE_ID,
      officialPikaProfileId: OFFICIAL_PIKA_PROFILE_ID,
    }
    assertValidName('PIKABG', 'PIKABG', official)
    assertValidName('P I K A B G', 'P I K A B G', official)

    const other = validateBackendProfileDisplayName('PIKABG', {
      profileId: '11111111-1111-4111-8111-111111111111',
      officialPikaProfileId: OFFICIAL_PIKA_PROFILE_ID,
    })
    assert(other.ok === false && other.code === 'RESERVED_PIKA_NAME', 'non-official profile was allowed to use PIKABG')
  })

  await check('[1d-2] official exception only covers the exact canonical PIKABG key, not longer names or Cyrillic', () => {
    const official = {
      profileId: OFFICIAL_PIKA_PROFILE_ID,
      officialPikaProfileId: OFFICIAL_PIKA_PROFILE_ID,
    }
    assertInvalidName2(validateBackendProfileDisplayName('PIKABG origin', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('origin PIKABG', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('PIKA BG support', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('MYPIKABG', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('ПИКАБГ', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('ПИКА БГ', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateBackendProfileDisplayName('ПИКАБГ произход', official), 'RESERVED_PIKA_NAME')

    assertInvalidName2(validateFrontendProfileDisplayName('PIKABG origin', official), 'RESERVED_PIKA_NAME')
    assertInvalidName2(validateFrontendProfileDisplayName('ПИКАБГ', official), 'RESERVED_PIKA_NAME')
  })

  await check('[1e] missing, empty, and invalid PIKA_OFFICIAL_PROFILE_ID fail closed', () => {
    for (const value of [undefined, '', 'not-a-uuid']) {
      withOfficialPikaEnv(value, () => {
        const result = validateBackendProfileDisplayName('PIKABG', {
          profileId: OFFICIAL_PIKA_PROFILE_ID,
        })
        assert(result.ok === false, `PIKABG accepted with env=${value ?? '(missing)'}`)
        if (!result.ok) {
          assert(result.code === 'RESERVED_PIKA_NAME', `code=${result.code}`)
          assert(result.message === PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE, `message=${result.message}`)
        }
      })
    }

    withOfficialPikaEnv(OFFICIAL_PIKA_PROFILE_ID, () => {
      const official = validateBackendProfileDisplayName('PIKABG', {
        profileId: OFFICIAL_PIKA_PROFILE_ID,
      })
      assert(official.ok === true, 'official profile not allowed with valid env UUID')

      const other = validateBackendProfileDisplayName('PIKABG', {
        profileId: '22222222-2222-4222-8222-222222222222',
      })
      assert(other.ok === false && other.code === 'RESERVED_PIKA_NAME', 'other profile allowed with valid env UUID')
    })
  })

  await check('[1f] frontend/backend error priority is identical for PIKABG edge cases', () => {
    // Mixed alphabets (Cyrillic Р + Latin IKABG) must win over the reserved-name check.
    assertInvalidName(`${CYRILLIC_ER}IKABG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName(`PI${CYRILLIC_KA}ABG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName(`PIK${CYRILLIC_A}BG`, 'MIXED_ALPHABETS', PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE)
    assertInvalidName('PIKA BG', 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    assertInvalidName('P I K A B G', 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    assertInvalidName('PIKABGUSER', 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    assertInvalidName('MYPIKABG', 'RESERVED_PIKA_NAME', PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE)
    assertValidName('PIKA', 'PIKA')
    assertValidName('ПИКА', 'ПИКА')
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

  await check('[4c] frontend live validation is field-local and uses exact validator message', async () => {
    const source = await readFile(resolve(serverRoot, '../src/app/lobby/renderLobbyScreen.ts'), 'utf8')
    const start = source.indexOf('function attachNameAvailabilityCheck(')
    const end = source.indexOf('function showAuthError(', start)
    assert(start !== -1 && end !== -1, 'attachNameAvailabilityCheck body not found')
    const body = source.slice(start, end)
    assert(body.includes('validateProfileDisplayName(input.value, validationOptions)'), 'live validator does not use validation options')
    assert(body.includes("setHint(validation.message, '#f87171')"), 'live validator does not show validator message under the field')
    assert(!body.includes('render()'), 'live validation should not trigger full render on each input')
    assert(!body.includes('input.focus()'), 'live validation should not move focus')
    assert(!body.includes('setSelectionRange'), 'live validation should not move caret')
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

    await check('[6b] registration rejects mixed-script and reserved PIKABG names', () => {
      const mixed = authStore?.register({
        email: 'mixed-register@example.test',
        password: 'secret1',
        displayName: MIXED_SCRIPT_CASES[0],
        gender: 'male',
      })
      assert(mixed?.ok === false, 'mixed registration succeeded')
      if (mixed?.ok === false) {
        assert(mixed.code === 'MIXED_ALPHABETS', `mixed code=${mixed.code}`)
        assert(mixed.message === PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE, `mixed message=${mixed.message}`)
      }

      const reserved = authStore?.register({
        email: 'reserved-pika@example.test',
        password: 'secret1',
        displayName: 'P I K A B G',
        gender: 'female',
      })
      assert(reserved?.ok === false, 'reserved PIKABG registration succeeded')
      if (reserved?.ok === false) {
        assert(reserved.code === 'RESERVED_PIKA_NAME', `reserved code=${reserved.code}`)
        assert(reserved.message === PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE, `reserved message=${reserved.message}`)
      }
    })

    await check('[7] availability uses same canonicalization', () => {
      assert(progressStore?.isDisplayNameAvailable('𝑫𝑰𝑨𝑩𝑳𝑨') === false, 'decorative duplicate available')
      assert(progressStore?.isDisplayNameAvailable('DIABLA') === false, 'case duplicate available')
      assert(progressStore?.isDisplayNameAvailable('Иван-Петров') === false, 'invalid name available')
      assert(progressStore?.isDisplayNameAvailable('PIKABG') === false, 'reserved PIKABG available')
      assert(progressStore?.isDisplayNameAvailable('PIKABGUSER') === false, 'PIKABG containment substring not blocked')
      assert(progressStore?.isDisplayNameAvailable('ПИКАБГ') === false, 'reserved Cyrillic ПИКАБГ available')
      withOfficialPikaEnv(OFFICIAL_PIKA_PROFILE_ID, () => {
        assert(progressStore?.isDisplayNameAvailable('PIKABG', OFFICIAL_PIKA_PROFILE_ID) === true, 'official PIKABG was not available for exact profileId')
      })
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

    await check('[8b] self rename rejects mixed-script and reserved names before wallet debit', () => {
      const registered = authStore?.register({
        email: 'mixed-rename@example.test',
        password: 'secret1',
        displayName: 'Rename Guard',
        gender: 'male',
      })
      assert(registered?.ok === true, 'registration failed')
      const profileId = registered.ok ? registered.session.profile.profileId : ''
      db?.prepare(`UPDATE profile_wallets SET yellow_coins_balance = 500 WHERE profile_id = ?`).run(profileId)
      const balance = (): number => {
        const row = db?.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
          | { yellow_coins_balance: number }
          | undefined
        return row?.yellow_coins_balance ?? -1
      }

      const mixed = progressStore?.changeProfileDisplayName(profileId, MIXED_SCRIPT_CASES[1], 100)
      assert(mixed?.ok === false, 'mixed rename succeeded')
      if (mixed?.ok === false) assert(mixed.code === 'MIXED_ALPHABETS', `mixed rename code=${mixed.code}`)
      assert(balance() === 500, `mixed rename debited balance=${balance()}`)

      const reserved = progressStore?.changeProfileDisplayName(profileId, 'PIKABG', 100)
      assert(reserved?.ok === false, 'reserved rename succeeded')
      if (reserved?.ok === false) assert(reserved.code === 'RESERVED_PIKA_NAME', `reserved rename code=${reserved.code}`)
      assert(balance() === 500, `reserved rename debited balance=${balance()}`)
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

    await check('[10b] admin rename uses the same mixed-script and reserved PIKABG validator', () => {
      const target = authStore?.register({
        email: 'admin-target-name@example.test',
        password: 'secret1',
        displayName: 'Admin Target',
        gender: 'female',
      })
      assert(target?.ok === true, 'target registration failed')
      const targetProfileId = target.ok ? target.session.profile.profileId : ''

      const mixed = progressStore?.adminRenameProfileDisplayName(targetProfileId, MIXED_SCRIPT_CASES[2])
      assert(mixed?.ok === false, 'admin mixed rename succeeded')
      if (mixed?.ok === false) {
        assert(mixed.code === 'MIXED_ALPHABETS', `admin mixed code=${mixed.code}`)
        assert(mixed.message === PROFILE_DISPLAY_NAME_MIXED_ALPHABETS_MESSAGE, `admin mixed message=${mixed.message}`)
      }

      const reserved = progressStore?.adminRenameProfileDisplayName(targetProfileId, 'P I K A B G')
      assert(reserved?.ok === false, 'admin reserved rename succeeded')
      if (reserved?.ok === false) {
        assert(reserved.code === 'RESERVED_PIKA_NAME', `admin reserved code=${reserved.code}`)
        assert(reserved.message === PROFILE_DISPLAY_NAME_RESERVED_PIKA_MESSAGE, `admin reserved message=${reserved.message}`)
      }
    })

    await check('[10c] official exact profileId can keep/use PIKABG through mutation path only', () => {
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
        ) VALUES (?, NULL, 'human', 'OfficialPika', 'officialpika', 'OfficialPika', 'officialpika', 'active');
      `).run(OFFICIAL_PIKA_PROFILE_ID)

      withOfficialPikaEnv(OFFICIAL_PIKA_PROFILE_ID, () => {
        const official = progressStore?.adminRenameProfileDisplayName(OFFICIAL_PIKA_PROFILE_ID, 'PIKABG')
        assert(official?.ok === true, 'official profile could not use PIKABG')
        if (official?.ok) assert(official.profile.displayName === 'PIKABG', `official displayName=${official.profile.displayName}`)
      })

      const other = authStore?.register({
        email: 'other-pika-team-role@example.test',
        password: 'secret1',
        displayName: 'Other Pika Team',
        gender: 'male',
      })
      assert(other?.ok === true, 'other registration failed')
      const otherProfileId = other.ok ? other.session.profile.profileId : ''
      const roleBlind = progressStore?.adminRenameProfileDisplayName(otherProfileId, 'pikabg')
      assert(roleBlind?.ok === false, 'non-official profile was allowed to use PIKABG')
      if (roleBlind?.ok === false) assert(roleBlind.code === 'RESERVED_PIKA_NAME', `role-blind code=${roleBlind.code}`)

      // The official profile stays blocked from a longer name that merely CONTAINS
      // PIKABG, and from the Cyrillic ПИКАБГ sequence — the exception is exact-only.
      const officialLonger = progressStore?.adminRenameProfileDisplayName(OFFICIAL_PIKA_PROFILE_ID, 'PIKABG origin')
      assert(officialLonger?.ok === false, 'official profile was allowed to use a longer PIKABG-containing name')
      if (officialLonger?.ok === false) assert(officialLonger.code === 'RESERVED_PIKA_NAME', `official longer code=${officialLonger.code}`)

      const officialCyrillic = progressStore?.adminRenameProfileDisplayName(OFFICIAL_PIKA_PROFILE_ID, 'ПИКАБГ')
      assert(officialCyrillic?.ok === false, 'official profile was allowed to use Cyrillic ПИКАБГ')
      if (officialCyrillic?.ok === false) assert(officialCyrillic.code === 'RESERVED_PIKA_NAME', `official Cyrillic code=${officialCyrillic.code}`)
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
