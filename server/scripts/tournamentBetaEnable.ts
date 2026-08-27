import 'dotenv/config'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { createTournamentBetaAccessStore } from '../src/db/tournamentBetaAccessStore.js'

const store = await createTournamentBetaAccessStore(getServerDatabaseFilePath())

try {
  const result = store.enable()
  if (!result.ok) {
    console.error('Не може да се enable-не gate-ът: няма конфигурирана парола.')
    console.error('Първо изпълни: npm run tournament:beta-password')
    process.exit(1)
  }
  console.log('Готово: tournament beta gate е enabled.')
} finally {
  store.close()
}
