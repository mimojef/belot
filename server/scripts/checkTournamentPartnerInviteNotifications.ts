import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve(
  process.argv.find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length) ?? '.',
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
const serverMessages = file('server/src/protocol/messageTypes.ts')
const clientMessages = file('src/app/network/createGameServerClient.ts')
const main = file('src/main.ts')
const lobby = file('src/app/lobby/createLobbyFlowController.ts')
const popup = file('src/ui/notifications/tournamentPartnerInvitePopup.ts')
const migration = file('server/database/migrations/20260730_006_add_tournament_partner_invite_notification_index.sql')

check('dismiss-popup endpoint exists', index.includes('/(dismiss-popup|view)$') && index.includes('dismissPartnerInvitePopup'))
check('view endpoint marks read and returns tournamentId', index.includes('viewPartnerInviteNotification') && index.includes('tournamentId: result.invite.tournamentId'))
check('notification endpoints use origin/auth/rate/uuid guards', index.includes('isAllowedVisitorRequestOrigin(req)') && index.includes('requireRegisteredHumanSession(req)') && index.includes('isTournamentEntryActionRateLimited') && index.includes('VISITOR_UUID_RE.test(inviteId)'))
check('create sends realtime invite to invitee profile connections', index.includes("type: 'tournament_partner_invite_received'") && index.includes('sendToOpenProfileConnections(result.invite.inviteeProfileId'))
check('connect bootstraps undismissed pending partner invites only', index.includes('listUndismissedPendingPartnerInvitesForProfile(connection.profileId)') && index.includes("type: 'tournament_partner_invite_received'"))
check('resolution event is broadcast to invitee and inviter tabs', index.includes('sendTournamentPartnerInviteResolved') && index.includes('sendToOpenProfileConnections(invite.inviteeProfileId') && index.includes('sendToOpenProfileConnections(invite.inviterProfileId'))
check('DTO exposes popup/read timestamps', dto.includes('popupDismissedAt: string | null') && dto.includes('notificationReadAt: string | null') && dto.includes('input.invite.popupDismissedAt'))
check('store has undismissed pending query ordered oldest-first', economy.includes('listUndismissedPendingPartnerInvitesForProfile') && economy.includes('popup_dismissed_at IS NULL') && economy.includes('ORDER BY created_at ASC'))
check('dismiss is popup-only and idempotent', economy.includes('dismissPartnerInvitePopupStatement') && economy.includes('SET popup_dismissed_at = COALESCE(popup_dismissed_at, CURRENT_TIMESTAMP)'))
check('view sets popup dismissed and notification read with COALESCE', economy.includes('viewPartnerInviteNotificationStatement') && economy.includes('notification_read_at = COALESCE(notification_read_at, CURRENT_TIMESTAMP)'))
check('accept/decline mark resolved notification state', economy.includes('markInviteeResolvedNotificationStateStatement.run(inviteId, inviteeProfileId)'))
check('partial index exists for undismissed invite delivery', migration.includes('idx_tpi_pending_undismissed_invitee_created') && migration.includes('invitee_profile_id, created_at') && migration.includes("WHERE status = 'pending' AND popup_dismissed_at IS NULL"))
check('client and server message unions include tournament invite events', serverMessages.includes('TournamentPartnerInviteReceivedMessage') && clientMessages.includes('TournamentPartnerInviteReceivedMessage') && clientMessages.includes('TournamentPartnerInviteResolvedMessage'))
check('global popup is mounted outside screen render tree', main.includes('global-tournament-partner-invite-notifications') && main.includes('createTournamentPartnerInvitePopup'))
check('main handles received/dismissed/resolved websocket events', main.includes("message.type === 'tournament_partner_invite_received'") && main.includes('tournamentPartnerInvitePopup.enqueue') && main.includes('tournamentPartnerInvitePopup.remove'))
check('lobby keeps pending invite list in sync', lobby.includes("message.type === 'tournament_partner_invite_received'") && lobby.includes("message.type === 'tournament_partner_invite_resolved'") && lobby.includes('refreshPendingTournamentPartnerInvites'))
check('popup has no auto-dismiss, outside-click, or Escape close', !popup.includes('AUTO_DISMISS_MS') && !popup.includes('keydown') && !popup.includes('Escape') && !popup.includes('document.addEventListener'))
check('popup offers only close and view actions', popup.includes('data-tpi-dismiss') && popup.includes('data-tpi-view') && !popup.includes('data-tpi-accept') && !popup.includes('data-tpi-decline'))
check('popup countdown only triggers server refresh', popup.includes('setInterval') && popup.includes('onExpiredRefresh') && !popup.includes('setTimeout'))
check('popup/server message code does not expose accounts, passwords, or balances', !popup.includes('accountId') && !serverMessages.includes('accountId') && !serverMessages.includes('passwordHash') && !serverMessages.includes('walletBalance'))

console.log(`Passed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)
