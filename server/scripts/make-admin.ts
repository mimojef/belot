import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'

const args = process.argv.slice(2)
const emailArg = args.find((a) => a.startsWith('--email='))
const hasConfirm = args.includes('--confirm')

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLocaleLowerCase('en-US')
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 254) {
    return null
  }
  return trimmed
}

if (!emailArg) {
  console.error('Употреба: npm run make-admin -- --email=твоят@email.com')
  console.error('')
  console.error('За реална промяна добави --confirm:')
  console.error('  npm run make-admin -- --email=твоят@email.com --confirm')
  process.exit(1)
}

const rawEmail = emailArg.slice('--email='.length)
const email = normalizeEmail(rawEmail)

if (email === null) {
  console.error(`Невалиден email адрес: ${rawEmail}`)
  process.exit(1)
}

const dbPath = getServerDatabaseFilePath()

type AccountRow = {
  account_id: string
  email: string
  role: string
  status: string
}

let db: InstanceType<typeof DatabaseSync> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true })

  const row = db
    .prepare(
      `SELECT account_id, email, role, status
       FROM accounts
       WHERE email = ?
       LIMIT 1;`,
    )
    .get(email) as AccountRow | undefined

  if (!row) {
    console.error(`Не е намерен акаунт с email: ${email}`)
    process.exit(1)
  }

  if (row.role === 'admin') {
    console.log(`Акаунтът ${row.email} вече е admin.`)
    process.exit(0)
  }

  console.log('Ще бъде направен admin:')
  console.log(`  email:        ${row.email}`)
  console.log(`  account_id:   ${row.account_id}`)
  console.log(`  current_role: ${row.role}`)

  if (!hasConfirm) {
    console.log('')
    console.log('Без промяна. За потвърждение изпълни:')
    console.log(`  npm run make-admin -- --email=${rawEmail} --confirm`)
    process.exit(1)
  }

  const result = db
    .prepare(
      `UPDATE accounts
       SET role = 'admin', updated_at = CURRENT_TIMESTAMP
       WHERE email = ? AND role <> 'admin';`,
    )
    .run(email) as { changes?: number }

  if ((result.changes ?? 0) === 0) {
    console.error('Промяната не беше записана. Акаунтът може вече да е admin или е настъпила грешка.')
    process.exit(1)
  }

  console.log(`Готово: ${row.email} е вече admin.`)
} finally {
  db?.close()
}
