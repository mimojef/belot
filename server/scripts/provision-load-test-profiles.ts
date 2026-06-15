import 'dotenv/config'
import { createHmac, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import {
  normalizeProfileDisplayName,
  normalizeProfileUsername,
} from '../src/db/normalizeProfileIdentityText.js'

const CONFIRM_VALUE = 'CREATE-LOADTEST-PROFILES'
const EMAIL_DOMAIN = 'loadtest.pika.bg'
const PROFILE_PREFIX = 'loadtest'
const MIN_BALANCE = 100_000
const MAX_COUNT = 800
const PASSWORD_SEED_MIN_LENGTH = 24
const SCRYPT_KEY_LENGTH = 64

type SqliteDatabase = InstanceType<typeof DatabaseSync>

type AccountRow = {
  account_id: string
  role: string
  status: string
}

type ProfileRow = {
  profile_id: string
  account_id: string | null
  profile_kind: string
  username: string | null
  normalized_username: string | null
  display_name: string
  normalized_display_name: string
}

type CredentialEntry = {
  index: number
  email: string
  password: string
  displayName: string
}

type PreparedCredentialEntry = CredentialEntry & {
  passwordHash: string
}

type ProvisionStats = {
  createdAccounts: number
  updatedAccounts: number
  createdProfiles: number
  updatedProfiles: number
  walletsEnsured: number
  progressEnsured: number
}

const args = process.argv.slice(2)

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

async function main(): Promise<void> {
  const count = parseCountArg(getArgValue('--count'))
  const outPath = parseOutputPath(getArgValue('--out'))
  const confirm = getArgValue('--confirm')
  const passwordSeed = process.env.LOADTEST_PASSWORD_SEED ?? ''

  if (confirm !== CONFIRM_VALUE) {
    throw new Error(`Missing confirmation. Use --confirm=${CONFIRM_VALUE}`)
  }

  if (passwordSeed.length < PASSWORD_SEED_MIN_LENGTH) {
    throw new Error(`LOADTEST_PASSWORD_SEED must be at least ${PASSWORD_SEED_MIN_LENGTH} characters.`)
  }

  const credentials = createCredentials(count, passwordSeed)
  const preparedCredentials = prepareCredentialHashes(credentials)
  await mkdir(dirname(outPath), { recursive: true })

  const tempCredentialsPath = await writeCredentialsTempFile(outPath, credentials)
  const dbPath = getServerDatabaseFilePath()
  let db: SqliteDatabase | null = null
  let stats: ProvisionStats

  try {
    db = new DatabaseSync(dbPath, {
      open: true,
      enableForeignKeyConstraints: true,
    })
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA busy_timeout = 10000;')
    stats = provisionProfiles(db, preparedCredentials)
  } catch (error) {
    await rm(tempCredentialsPath, { force: true })
    throw error
  } finally {
    db?.close()
  }

  try {
    await finalizeCredentialsFile(tempCredentialsPath, outPath)
  } catch (error) {
    await rm(tempCredentialsPath, { force: true })
    throw new Error(
      `Database provisioning completed, but credentials file final rename failed. ` +
        `It is safe to rerun this script with the same LOADTEST_PASSWORD_SEED. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  console.log(`Provisioned ${credentials.length} load-test profile(s).`)
  console.log(`Credentials written to: ${outPath}`)
  console.log(
    [
      `created_accounts=${stats.createdAccounts}`,
      `updated_accounts=${stats.updatedAccounts}`,
      `created_profiles=${stats.createdProfiles}`,
      `updated_profiles=${stats.updatedProfiles}`,
      `wallets_ensured=${stats.walletsEnsured}`,
      `progress_ensured=${stats.progressEnsured}`,
    ].join(' '),
  )
}

function provisionProfiles(db: SqliteDatabase, credentials: PreparedCredentialEntry[]): ProvisionStats {
  const stats: ProvisionStats = {
    createdAccounts: 0,
    updatedAccounts: 0,
    createdProfiles: 0,
    updatedProfiles: 0,
    walletsEnsured: 0,
    progressEnsured: 0,
  }

  const selectAccountStatement = db.prepare(`
    SELECT account_id, role, status
    FROM accounts
    WHERE email = ?
    LIMIT 1;
  `)

  const insertAccountStatement = db.prepare(`
    INSERT INTO accounts (
      account_id,
      email,
      password_hash,
      role,
      status
    ) VALUES (
      ?,
      ?,
      ?,
      'player',
      'active'
    );
  `)

  const updateAccountStatement = db.prepare(`
    UPDATE accounts
    SET
      password_hash = ?,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
  `)

  const selectProfilesForAccountStatement = db.prepare(`
    SELECT
      profile_id,
      account_id,
      profile_kind,
      username,
      normalized_username,
      display_name,
      normalized_display_name
    FROM profiles
    WHERE account_id = ?
    ORDER BY created_at ASC;
  `)

  const selectProfileByNormalizedUsernameStatement = db.prepare(`
    SELECT
      profile_id,
      account_id,
      profile_kind,
      username,
      normalized_username,
      display_name,
      normalized_display_name
    FROM profiles
    WHERE normalized_username = ?
    LIMIT 1;
  `)

  const selectProfileByNormalizedDisplayNameStatement = db.prepare(`
    SELECT
      profile_id,
      account_id,
      profile_kind,
      username,
      normalized_username,
      display_name,
      normalized_display_name
    FROM profiles
    WHERE normalized_display_name = ?
    LIMIT 1;
  `)

  const insertProfileStatement = db.prepare(`
    INSERT INTO profiles (
      profile_id,
      account_id,
      profile_kind,
      username,
      normalized_username,
      display_name,
      normalized_display_name,
      avatar_url,
      level,
      rank_title,
      skill_rating,
      gender,
      status,
      is_temporary
    ) VALUES (
      ?,
      ?,
      'human',
      ?,
      ?,
      ?,
      ?,
      NULL,
      1,
      'Ранг 1',
      1000,
      NULL,
      'active',
      0
    );
  `)

  const updateProfileStatement = db.prepare(`
    UPDATE profiles
    SET
      username = ?,
      normalized_username = ?,
      display_name = ?,
      normalized_display_name = ?,
      status = 'active',
      is_temporary = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND profile_kind = 'human';
  `)

  const ensureWalletStatement = db.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      ?
    )
    ON CONFLICT(profile_id) DO UPDATE SET
      yellow_coins_balance = CASE
        WHEN profile_wallets.yellow_coins_balance < excluded.yellow_coins_balance
          THEN excluded.yellow_coins_balance
        ELSE profile_wallets.yellow_coins_balance
      END,
      updated_at = CASE
        WHEN profile_wallets.yellow_coins_balance < excluded.yellow_coins_balance
          THEN CURRENT_TIMESTAMP
        ELSE profile_wallets.updated_at
      END;
  `)

  const ensureProgressStatement = db.prepare(`
    INSERT INTO profile_progress (
      profile_id,
      completed_games_count,
      won_games_count,
      rank_level
    ) VALUES (
      ?,
      0,
      0,
      1
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  db.exec('BEGIN IMMEDIATE;')

  try {
    for (const credential of credentials) {
      const email = normalizeEmail(credential.email)
      const displayName = credential.displayName
      const normalizedDisplayName = normalizeProfileDisplayName(displayName)
      const normalizedUsername = normalizeProfileUsername(displayName)

      if (email === null) {
        throw new Error(`Invalid generated email for index ${credential.index}.`)
      }

      if (normalizedDisplayName === null || normalizedUsername === null) {
        throw new Error(`Invalid generated display name for index ${credential.index}.`)
      }

      const existingAccount = selectAccountStatement.get(email) as AccountRow | undefined
      const accountId = existingAccount?.account_id ?? randomUUID()
      let existingProfile: ProfileRow | undefined

      if (existingAccount) {
        existingProfile = validateExistingLoadTestAccount(
          existingAccount,
          selectProfilesForAccountStatement.all(accountId) as ProfileRow[],
          credential,
          normalizedUsername,
          normalizedDisplayName,
        )
      }

      const profileId = existingProfile?.profile_id ?? randomUUID()

      assertNormalizedIdentityIsAvailable(
        selectProfileByNormalizedUsernameStatement.get(normalizedUsername) as ProfileRow | undefined,
        profileId,
        credential,
        'normalized_username',
      )
      assertNormalizedIdentityIsAvailable(
        selectProfileByNormalizedDisplayNameStatement.get(normalizedDisplayName) as ProfileRow | undefined,
        profileId,
        credential,
        'normalized_display_name',
      )

      if (existingAccount) {
        updateAccountStatement.run(credential.passwordHash, accountId)
        stats.updatedAccounts += 1
      } else {
        insertAccountStatement.run(accountId, email, credential.passwordHash)
        stats.createdAccounts += 1
      }

      if (existingProfile) {
        updateProfileStatement.run(
          displayName,
          normalizedUsername,
          displayName,
          normalizedDisplayName,
          profileId,
        )
        stats.updatedProfiles += 1
      } else {
        insertProfileStatement.run(
          profileId,
          accountId,
          displayName,
          normalizedUsername,
          displayName,
          normalizedDisplayName,
        )
        stats.createdProfiles += 1
      }

      ensureWalletStatement.run(profileId, MIN_BALANCE)
      ensureProgressStatement.run(profileId)
      stats.walletsEnsured += 1
      stats.progressEnsured += 1
    }

    db.exec('COMMIT;')
    return stats
  } catch (error) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // Surface the original provisioning error.
    }

    throw error
  }
}

function prepareCredentialHashes(credentials: CredentialEntry[]): PreparedCredentialEntry[] {
  return credentials.map((credential) => ({
    ...credential,
    passwordHash: createPasswordHash(credential.password),
  }))
}

function validateExistingLoadTestAccount(
  account: AccountRow,
  profiles: ProfileRow[],
  credential: CredentialEntry,
  normalizedUsername: string,
  normalizedDisplayName: string,
): ProfileRow {
  if (account.role !== 'player') {
    throw new Error(`Refusing to modify existing non-player account for ${credential.email}.`)
  }

  if (profiles.length !== 1) {
    throw new Error(
      `Refusing to modify existing account for ${credential.email}: expected exactly one profile, found ${profiles.length}.`,
    )
  }

  const profile = profiles[0]

  if (!profile) {
    throw new Error(`Refusing to modify existing account for ${credential.email}: profile lookup failed.`)
  }

  if (profile.profile_kind !== 'human') {
    throw new Error(`Refusing to modify existing account for ${credential.email}: profile is not human.`)
  }

  if (
    profile.username !== credential.displayName ||
    profile.display_name !== credential.displayName ||
    profile.normalized_username !== normalizedUsername ||
    profile.normalized_display_name !== normalizedDisplayName
  ) {
    throw new Error(`Refusing to modify existing account for ${credential.email}: profile identity is not loadtest-owned.`)
  }

  return profile
}

function assertNormalizedIdentityIsAvailable(
  existingProfile: ProfileRow | undefined,
  expectedProfileId: string,
  credential: CredentialEntry,
  fieldName: 'normalized_username' | 'normalized_display_name',
): void {
  if (!existingProfile || existingProfile.profile_id === expectedProfileId) {
    return
  }

  throw new Error(
    `Refusing to provision ${credential.email}: ${fieldName} already belongs to another profile.`,
  )
}

function createCredentials(count: number, passwordSeed: string): CredentialEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const oneBasedIndex = index + 1
    const suffix = String(oneBasedIndex).padStart(4, '0')
    const displayName = `${PROFILE_PREFIX}${suffix}`
    const email = `${displayName}@${EMAIL_DOMAIN}`

    return {
      index: oneBasedIndex,
      email,
      password: createStablePassword(passwordSeed, email),
      displayName,
    }
  })
}

function createStablePassword(passwordSeed: string, email: string): string {
  const digest = createHmac('sha256', passwordSeed)
    .update(`belot-v2-loadtest:${email}`)
    .digest('base64url')

  return `lt_${digest}`
}

function createPasswordHash(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex')

  return `scrypt:${salt}:${hash}`
}

async function writeCredentialsTempFile(
  outPath: string,
  credentials: CredentialEntry[],
): Promise<string> {
  const tempPath = `${outPath}.${process.pid}.${Date.now()}.tmp`
  const payload = `${JSON.stringify({ users: credentials }, null, 2)}\n`

  await writeFile(tempPath, payload, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })

  return tempPath
}

async function finalizeCredentialsFile(tempPath: string, outPath: string): Promise<void> {
  await rename(tempPath, outPath)
}

function getArgValue(name: string): string | null {
  const prefix = `${name}=`
  const arg = args.find((value) => value.startsWith(prefix))

  return arg ? arg.slice(prefix.length) : null
}

function parseCountArg(value: string | null): number {
  if (value === null) {
    throw new Error('Missing required --count=<number> argument.')
  }

  const count = Number.parseInt(value, 10)

  if (!Number.isInteger(count) || String(count) !== value || count < 1 || count > MAX_COUNT) {
    throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}.`)
  }

  return count
}

function parseOutputPath(value: string | null): string {
  if (value === null || value.trim() === '') {
    throw new Error('Missing required --out=<path> argument.')
  }

  if (!value.endsWith('.local')) {
    throw new Error('--out must end with .local or .json.local.')
  }

  return resolve(value)
}

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLocaleLowerCase('en-US')

  if (!trimmed || trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return null
  }

  return trimmed
}
