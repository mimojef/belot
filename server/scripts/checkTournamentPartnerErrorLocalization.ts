/**
 * checkTournamentPartnerErrorLocalization.ts
 *
 * Regression за BUG #2 — raw internal error codes (already_in_tournament и
 * др.) не трябва да стигат директно до потребителя нито в partner
 * candidate/search rows (unavailableReason), нито в invite create/accept/
 * decline/cancel error text (result.message).
 *
 * Two-layer audit, mirroring the two ACTUAL sources of these codes:
 *
 *  [server layer] PARTNER_INVITE_FAILURE_MESSAGES (server/src/index.ts) —
 *  вече съществуваща mapping функция за create/accept/decline/cancel error
 *  reason-ите (already_participant, already_teamed, invite_window_closed,
 *  blocked, self_invite, insufficient_funds, и т.н.) — тук проверяваме, че
 *  ВСИЧКИ reason-и, които getCandidateUnavailableReason/validateInvitee/
 *  createPartnerInviteAtomically/acceptPartnerInviteAtomically могат
 *  реално да произведат, имат запис в тази таблица (иначе fallback-ът
 *  показва generic, но НЕ raw snake_case).
 *
 *  [client layer] formatPartnerCandidateUnavailableReason
 *  (src/app/lobby/renderTournamentsScreen.ts) — новият mapping за
 *  candidate.unavailableReason кодовете (self, not_registered_human,
 *  temporary, blocked, already_in_tournament, active_tournament), които
 *  идват directly в HTTP response-а на partner-candidates/search endpoint-ите
 *  БЕЗ server-side text mapping (за разлика от create/accept грешките).
 *  renderPartnerCandidateRow трябва да reuse-ва точно тази функция, не да
 *  interpolира candidate.unavailableReason directly.
 */

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

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

const economy = file('server/src/db/tournamentEconomyStore.ts')
const index = file('server/src/index.ts')
const ui = file('src/app/lobby/renderTournamentsScreen.ts')

console.log('\n═══ checkTournamentPartnerErrorLocalization ═══\n')

// --- [client layer] raw unavailableReason is never interpolated directly ---

check(
  'renderPartnerCandidateRow no longer interpolates candidate.unavailableReason directly (the exact BUG #2 source)',
  !ui.includes('candidate.unavailableReason}) : \'\'') && !/disabledReason = candidate\.unavailableReason \? ` \(\$\{candidate\.unavailableReason\}\)`/.test(ui),
)

check(
  'a dedicated formatPartnerCandidateUnavailableReason mapping function exists',
  ui.includes('function formatPartnerCandidateUnavailableReason(reason: string): string'),
)

check(
  'renderPartnerCandidateRow calls the mapping function, not the raw field',
  ui.includes('formatPartnerCandidateUnavailableReason(candidate.unavailableReason)'),
)

// Extract the PARTNER_CANDIDATE_UNAVAILABLE_REASON_LABELS map body to check
// every code getCandidateUnavailableReason can actually produce has an entry.
const labelsMatch = ui.match(/PARTNER_CANDIDATE_UNAVAILABLE_REASON_LABELS[^{]*\{([\s\S]*?)\}/)
const labelsBody = labelsMatch?.[1] ?? ''

const candidateUnavailableReasonCodes = ['self', 'not_registered_human', 'temporary', 'blocked', 'already_in_tournament', 'active_tournament']
for (const code of candidateUnavailableReasonCodes) {
  check(
    `candidate unavailableReason code "${code}" (real getCandidateUnavailableReason return value) has a Bulgarian label`,
    new RegExp(`\\b${code}\\s*:`).test(labelsBody),
  )
}

check(
  'formatPartnerCandidateUnavailableReason has a non-raw-code Bulgarian fallback for unknown codes',
  ui.includes("?? 'Не може да бъде поканен в момента'"),
)

check(
  'the fallback text itself is not a raw snake_case identifier',
  !/\?\?\s*'[a-z]+_[a-z_]+'/.test(ui.match(/function formatPartnerCandidateUnavailableReason[\s\S]*?\n\}/)?.[0] ?? ''),
)

// --- [server layer] every real getCandidateUnavailableReason() return value
// that flows into validateInvitee's PartnerInviteMutationResult is present
// in PARTNER_INVITE_FAILURE_MESSAGES ---

const failureMessagesMatch = index.match(/PARTNER_INVITE_FAILURE_MESSAGES[^{]*\{([\s\S]*?)\n\}/)
const failureMessagesBody = failureMessagesMatch?.[1] ?? ''

// These are the exact reasons validateInvitee() can return (mapped from
// getCandidateUnavailableReason plus its own self_invite/invalid_invitee
// cases) — see tournamentEconomyStore.ts's validateInvitee function.
const validateInviteeReasons = [
  'self_invite',
  'invalid_invitee',
  'blocked',
  'already_participant',
  'already_participating_elsewhere',
]
for (const reason of validateInviteeReasons) {
  check(
    `invite-create reason "${reason}" (real validateInvitee() return value) has a Bulgarian message in PARTNER_INVITE_FAILURE_MESSAGES`,
    new RegExp(`\\b${reason}\\s*:`).test(failureMessagesBody),
  )
}

// createPartnerInviteAtomically's OWN direct-return reasons (not funneled
// through validateInvitee) — tournament_not_found, tournament_not_open,
// tournament_fill_expired, invite_window_closed, already_teamed,
// tournament_full, requires_password, insufficient_funds.
const createInviteDirectReasons = [
  'tournament_not_found',
  'tournament_not_open',
  'tournament_fill_expired',
  'invite_window_closed',
  'already_teamed',
  'tournament_full',
  'partner_requires_two_slots',
  'requires_password',
  'insufficient_funds',
]
for (const reason of createInviteDirectReasons) {
  check(
    `invite-create reason "${reason}" (real createPartnerInviteAtomically return value) has a Bulgarian message`,
    new RegExp(`\\b${reason}\\s*:`).test(failureMessagesBody),
  )
}

check(
  'unknown/unexpected create-invite error falls back to a Bulgarian generic message, not the raw reason',
  index.includes("PARTNER_INVITE_FAILURE_MESSAGES[result.reason] ?? 'Поканата не бе изпратена.'"),
)

check(
  'the create-invite HTTP response never sends message === reason (client always gets Bulgarian text, reason stays a separate machine-readable field)',
  index.includes('message: PARTNER_INVITE_FAILURE_MESSAGES[result.reason]'),
)

// --- economy store sanity: the exact codes referenced above must still be
// the real ones returned by the source (defends against silent renames that
// would desync this test's expectations from the actual enum). ---

for (const code of candidateUnavailableReasonCodes) {
  if (code === 'self' || code === 'not_registered_human') continue // literal-string returns are exact
  check(
    `economy store still actually returns "${code}" from getCandidateUnavailableReason`,
    // getCandidateUnavailableReason връща { code, activeEntryBlock? } обект
    // (не plain string) от multi-tournament registration Case A/B fix-а
    // (виж resolveActiveEntryBlock/CandidateUnavailableResult в
    // tournamentEconomyStore.ts) — pattern-ът следва точния source shape.
    economy.includes(`return { code: '${code}'`),
  )
}

console.log(`\nPassed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)
