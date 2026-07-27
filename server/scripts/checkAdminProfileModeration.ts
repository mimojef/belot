import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

function readProjectFile(path: string): string {
  return readFileSync(resolve(PROJECT_ROOT, path), 'utf8')
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) return ''
  // Следваща TOP-LEVEL декларация (колона 0) — не случаен nested helper
  // вътре в целевата функция (крехко към рефактори на вложени функции).
  const rest = source.slice(start + 1)
  const nextMatch = /\n(?:export )?(?:async )?function /.exec(rest)
  const nextFunction = nextMatch ? start + 1 + nextMatch.index : -1
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction)
}

console.log('\ncheckAdminProfileModeration')

const popupRenderer = readProjectFile('src/app/lobby/renderLobbyScreen.ts')
const lobbyController = readProjectFile('src/app/lobby/createLobbyFlowController.ts')
const mainClient = readProjectFile('src/main.ts')
const serverIndex = readProjectFile('server/src/index.ts')
const progressStore = readProjectFile('server/src/db/playerProgressStore.ts')
const adminRenameBody = functionBody(progressStore, 'adminRenameProfileDisplayName')
const profileRequestBody = functionBody(serverIndex, 'handleProfileRequest')
const adminModerationBody = functionBody(serverIndex, 'handleAdminProfileModerationRequest')
const forbiddenModerationFields = [
  'balance',
  'coins',
  'rating',
  'level',
  'rank',
  'role',
  'email',
  'password',
  'stats',
  'wins',
  'games',
]

check(
  'popup edit callback carries viewed profileId',
  popupRenderer.includes('onEditClick: (profileId: string | null) => void') &&
    popupRenderer.includes('cb.onEditClick(profileId)') &&
    popupRenderer.includes('popupState.profile?.profileId ?? null'),
)

check(
  'non-admin cannot open target profile editor',
  // Рефакторирано зад isFullAdminAuthSession() helper (виж subadmin ролята) —
  // семантиката е непроменена: само пълен admin (role==='admin') може да отвори
  // редактора на чужд профил. Реалната authorization behavior се тества end-to-end
  // в checkSubadminHttpAuthorization.ts.
  lobbyController.includes('!isFullAdminAuthSession(authSession)') &&
    lobbyController.includes('state.profileEditorOpen = false') &&
    popupRenderer.includes("state.profileEditorTargetProfileId !== null && !state.isAdmin"),
)

check(
  'admin edit submits target profileId through frontend callbacks',
  lobbyController.includes('options.onProfileEditSubmit(targetProfileId, avatarFile, avatarCrop, galleryFiles)') &&
    lobbyController.includes('options.onProfileNameChangeSubmit(targetProfileId, displayName)') &&
    lobbyController.includes('options.onProfileGalleryDelete(targetProfileId, imageId)'),
)

check(
  'admin profile client uses target admin routes, self edit keeps /me routes',
  mainClient.includes('/api/profile/me/display-name') &&
    mainClient.includes('/api/profile/me/${endpoint}') &&
    mainClient.includes('/api/profile/me/gallery/') &&
    mainClient.includes('/api/admin/profiles/${encodeURIComponent(targetProfileId)}/display-name') &&
    mainClient.includes('/api/admin/profiles/${encodeURIComponent(targetProfileId)}/avatar') &&
    mainClient.includes('/api/admin/profiles/${encodeURIComponent(targetProfileId)}/gallery/'),
)

check(
  'admin display-name endpoint is admin-only and allowlisted',
  // Рефакторирано зад isFullAdminSession() type-predicate helper (виж subadmin
  // ролята: server/src/db/authStore.ts) — семантиката е непроменена.
  serverIndex.includes('!isFullAdminSession(session)') &&
    serverIndex.includes("new Set(['displayName'])") &&
    serverIndex.includes('adminRenameProfileDisplayName('),
)

check(
  'admin avatar endpoint rejects forbidden fields by allowlist',
  serverIndex.includes("new Set(['avatarUrl', 'imageDataUrl', 'cropX', 'cropY', 'cropSize'])") &&
    serverIndex.includes('Позволена е само промяна на avatar.'),
)

check(
  'admin display-name rename does not debit coins',
  adminRenameBody.length > 0 &&
    !adminRenameBody.includes('debitWalletStatement') &&
    !adminRenameBody.includes('insertNameChangeLedgerStatement'),
)

check(
  'admin endpoints reject unauthenticated and non-admin sessions server-side',
  // isFullAdminSession() е type predicate: session is null → връща false (не хвърля) —
  // покрива и "session === null" случая от старата inline проверка. Виж authStore.ts.
  adminModerationBody.includes('const sessionToken = getSessionTokenFromCookieHeader(req.headers.cookie)') &&
    adminModerationBody.includes('const session = authStore.getSession(sessionToken)') &&
    adminModerationBody.includes('!isFullAdminSession(session)') &&
    adminModerationBody.indexOf('!isFullAdminSession(session)') <
      adminModerationBody.indexOf('playerProgressStore.adminRenameProfileDisplayName(') &&
    adminModerationBody.indexOf('!isFullAdminSession(session)') <
      adminModerationBody.indexOf('playerProgressStore.updateProfileAvatar(') &&
    adminModerationBody.indexOf('!isFullAdminSession(session)') <
      adminModerationBody.indexOf('playerProgressStore.deleteProfileGalleryImage('),
)

check(
  'admin endpoints derive target from URL, not request body',
  adminModerationBody.includes('const targetProfileId = decodeURIComponent(') &&
    adminModerationBody.includes('displayNameMatch?.[1]') &&
    adminModerationBody.includes('avatarMatch?.[1]') &&
    adminModerationBody.includes('galleryDeleteMatch?.[1]') &&
    !adminModerationBody.includes("getStringField(body, 'profileId')") &&
    !adminModerationBody.includes("getStringField(body, 'targetProfileId')"),
)

check(
  'normal users cannot change another display-name, avatar, or gallery image',
  adminModerationBody.includes('!isFullAdminSession(session)') &&
    adminModerationBody.includes('playerProgressStore.adminRenameProfileDisplayName(') &&
    adminModerationBody.includes('playerProgressStore.updateProfileAvatar(targetProfileId') &&
    adminModerationBody.includes('playerProgressStore.deleteProfileGalleryImage(targetProfileId'),
)

check(
  '/api/profile/me routes always mutate session.profile.profileId',
  /playerProgressStore\.changeProfileDisplayName\(\s*session\.profile\.profileId/.test(profileRequestBody) &&
    /playerProgressStore\.updateProfileAvatar\(\s*session\.profile\.profileId/.test(profileRequestBody) &&
    /playerProgressStore\.deleteProfileGalleryImage\(\s*session\.profile\.profileId/.test(profileRequestBody) &&
    profileRequestBody.includes('profileId: session.profile.profileId') &&
    !profileRequestBody.includes("getStringField(body, 'profileId')") &&
    !profileRequestBody.includes("getStringField(body, 'targetProfileId')"),
)

check(
  'admin moderation allowlists exclude forbidden account/economy/stats fields',
  adminModerationBody.includes("new Set(['displayName'])") &&
    adminModerationBody.includes("new Set(['avatarUrl', 'imageDataUrl', 'cropX', 'cropY', 'cropSize'])") &&
    adminModerationBody.includes('hasOnlyAllowedFields(body') &&
    forbiddenModerationFields.every((field) =>
      !adminModerationBody.includes(`'${field}'`) &&
      !adminModerationBody.includes(`"${field}"`),
    ),
)

check(
  'admin moderation updates target profile, not admin session profile',
  adminModerationBody.includes('session.profile.profileId === targetProfileId') &&
    /playerProgressStore\.adminRenameProfileDisplayName\(\s*targetProfileId/.test(adminModerationBody) &&
    /playerProgressStore\.updateProfileAvatar\(\s*targetProfileId/.test(adminModerationBody) &&
    /playerProgressStore\.deleteProfileGalleryImage\(\s*targetProfileId/.test(adminModerationBody),
)

if (failed > 0) {
  console.error(`\n${failed} admin profile moderation checks failed.`)
  process.exit(1)
}

console.log(`\n${passed} admin profile moderation checks passed.`)
