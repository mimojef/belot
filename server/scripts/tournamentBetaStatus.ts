import 'dotenv/config'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { createTournamentBetaAccessStore } from '../src/db/tournamentBetaAccessStore.js'

const store = await createTournamentBetaAccessStore(getServerDatabaseFilePath())

try {
  const status = store.getStatus()
  console.log('Tournament beta gate:')
  console.log(`  enabled:              ${status.enabled ? 'yes' : 'no'}`)
  console.log(`  password configured:  ${status.hasPassword ? 'yes' : 'no'}`)
  console.log(`  password version:     ${status.passwordVersion}`)
  console.log(`  valid grants:         ${status.validGrantsCount}`)
  console.log(`  updated at:           ${status.updatedAt}`)
} finally {
  store.close()
}
