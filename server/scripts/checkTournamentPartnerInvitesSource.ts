import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve(
  process.argv.find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length) ?? '..',
)

let passed = 0
let failed = 0

function file(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf8')
}

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}`)
  }
}

const index = file('server/src/index.ts')
const economy = file('server/src/db/tournamentEconomyStore.ts')
const dto = file('server/src/tournament/tournamentDto.ts')
const ui = file('src/app/lobby/renderTournamentsScreen.ts')
const client = file('src/main.ts')

check('partner candidates endpoint exists', index.includes('/partner-candidates'))
check('pending invites endpoint exists', index.includes('/api/tournaments/partner-invites/pending'))
check('partner invite action endpoints exist', index.includes('/(accept|decline|cancel)$'))
// Friends-only prerequisite за invite ELIGIBILITY е премахнат (виж §
// "FRIENDSHIP ВЕЧЕ НЕ Е REQUIREMENT") — getCandidateUnavailableReason вече
// НЕ съдържа 'not_friend' branch-а. profile_friendships/'accepted' продължават
// да съществуват в economy файла (изворът на FRIENDS LIST-а остава
// selectAcceptedFriendsStatement — friends discovery не е премахнат, само
// вече не е единственият/задължителен discovery/invite path), затова
// проверяваме ЛИПСАТА на самия eligibility gate, не присъствието на низовете.
check('friends-only invite ELIGIBILITY gate is removed (not_friend no longer blocks invites)', !economy.includes("return 'not_friend'"))
check('friends list source (profile_friendships/accepted) is still present for FRIENDS section', economy.includes('profile_friendships') && economy.includes("status = 'accepted'"))
check('global partner search store method exists', economy.includes('getGlobalPartnerCandidatesForTournament'))
check('server-side block check is present', economy.includes('player_blocks'))
check('reserved pending places are counted', economy.includes('countReservedPendingPlaces') && dto.includes('reservedPlacesCount'))
check('lazy expiry is persisted and reconciled', economy.includes('expireDuePartnerInvitesAtomically') && economy.includes("'expired'"))
check('partner picker uses candidates endpoint', client.includes('/partner-candidates'))
check('pending list uses pending invites endpoint', client.includes('/api/tournaments/partner-invites/pending'))
check('UI shows incoming invites section', ui.includes('Покани към теб'))
check('UI exposes online/offline friends', ui.includes('Онлайн') && ui.includes('Офлайн'))
// Обратен на предишния requirement (виж § "НОВО ИЗИСКВАНЕ" — global partner
// search вече е intentional feature, не regression): проверяваме, че UI-ят
// ДЕЙСТВИТЕЛНО показва двете отделни секции (search results + friends),
// с точния нов placeholder/heading текст от task spec-а.
check('UI has the new global search input placeholder', ui.includes('Търси във всички играчи'))
check('UI has a dedicated search results heading, separate from friends', ui.includes('Резултати от търсенето') && ui.includes('Приятели'))
check('UI updated description text says "потребител", not "приятел"', ui.includes('Поканеният потребител ще плати своя вход само ако приеме.'))
check('UI no longer says partner stage is future', !ui.includes('следващия етап'))
check('no tournament scheduler implementation in touched source', !economy.includes('setTimeout') && !ui.includes('setTimeout'))
check('no persistent popup implementation in tournament UI', !ui.includes('popup_dismissed_at') && !ui.includes('notification_read_at'))
check('client does not send entry fee for partner actions', !client.includes('entryFee:') || !client.includes('partner-invites'))

console.log(`Passed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)
