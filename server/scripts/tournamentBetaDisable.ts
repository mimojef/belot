import 'dotenv/config'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { createTournamentBetaAccessStore } from '../src/db/tournamentBetaAccessStore.js'

const store = await createTournamentBetaAccessStore(getServerDatabaseFilePath())

try {
  store.disable()
  console.log('Готово: tournament beta gate е disabled. Турнирите работят нормално.')
} finally {
  store.close()
}
