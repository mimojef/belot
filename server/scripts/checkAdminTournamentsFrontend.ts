import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}`)
  }
}

async function readProjectFile(projectRoot: string, relativePath: string): Promise<string> {
  return readFile(join(projectRoot, relativePath), 'utf8')
}

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length) ?? join(process.cwd(), '..'),
)

console.log('\ncheckAdminTournamentsFrontend')
console.log(`Project root: ${projectRoot}`)

const renderLobbyScreen = await readProjectFile(projectRoot, 'src/app/lobby/renderLobbyScreen.ts')
const flowController = await readProjectFile(projectRoot, 'src/app/lobby/createLobbyFlowController.ts')
const main = await readProjectFile(projectRoot, 'src/main.ts')
const adminRenderer = await readProjectFile(projectRoot, 'src/app/adminTournaments/renderAdminTournamentsPanel.ts')
const adminTypes = await readProjectFile(projectRoot, 'src/app/adminTournaments/adminTournamentTypes.ts')

check('lobby state includes admin tournament screens', [
  "'admin-tournaments'",
  "'admin-tournament-detail'",
  'adminTournamentsRows',
  'adminTournamentDetail',
].every((needle) => renderLobbyScreen.includes(needle) && flowController.includes(needle)))

check('admin info surface links to admin tournaments', [
  'data-lobby-nav-admin-tournaments',
  'onAdminTournamentsOpen',
  '/admin/tournaments',
].every((needle) => renderLobbyScreen.includes(needle) || flowController.includes(needle)))

check('network layer uses admin tournament endpoints only', [
  '/api/admin/tournaments',
  'loadAdminTournaments',
  'loadAdminTournamentDetail',
  'postAdminTournamentAction',
].every((needle) => main.includes(needle)))

check('list UI has bounded filters, pagination and integrity state', [
  'data-admin-tournaments-filters',
  'integrityState',
  'data-admin-tournaments-page',
  'integrityBadge',
].every((needle) => adminRenderer.includes(needle)))

check('detail UI exposes safe reconcile and cancel-open controls with confirmation', [
  'data-admin-tournament-reconcile',
  'data-admin-tournament-cancel-open',
  'data-admin-tournament-cancel-confirm',
  'cancelConfirmOpen',
].every((needle) => adminRenderer.includes(needle)))

check('subadmin read-only state is represented in UI types and renderer', [
  'adminTournamentsCanWrite',
  'canWrite',
  'readonly',
  'Read-only',
].every((needle) => renderLobbyScreen.includes(needle) || flowController.includes(needle) || adminRenderer.includes(needle) || adminTypes.includes(needle)))

check('frontend model does not include password hash, wallet balance or raw session identifiers', ![
  'passwordHash',
  'password_hash',
  'yellowCoinsBalance',
  'sessionId',
  'accountId',
  'connectionId',
  'tokenHash',
].some((needle) => adminTypes.includes(needle) || adminRenderer.includes(needle)))

if (failed > 0) {
  console.error(`checkAdminTournamentsFrontend failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkAdminTournamentsFrontend passed: ${passed} checks.`)
