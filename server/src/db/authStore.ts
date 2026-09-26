import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import type { AccountId, PlayerPublicProfileSnapshot, ProfileId } from '../core/serverTypes.js'
import {
  createPasswordHash,
  generateVerificationCode,
  hashVerificationCode,
  hmacRateLimitSubject,
  maskEmailForDisplay,
  normalizeEmail,
  validatePassword,
  validateRateLimitSecret,
  verifyPassword,
  verifyVerificationCode,
} from './authHelpers.js'
import {
  validateProfileDisplayName,
  type ProfileIdentityValidationCode,
} from './normalizeProfileIdentityText.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AccountRoleValue = 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'

export type AuthAccountSnapshot = {
  accountId: AccountId
  email: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  createdAt: string
}

export type AuthSessionSnapshot = {
  sessionId: string
  account: AuthAccountSnapshot
  profile: PlayerPublicProfileSnapshot
}

/**
 * Configurable registration mode (Admin -> Настройки -> "Метод за
 * регистрация", виж adminSettingsStore.ts registrationVerificationMode) —
 * SERVER-AUTHORITATIVE, четено live на всяка register() заявка, клиентът
 * никога не го избира directno.
 *
 * 'email_code' (default) — СЪЩИЯТ, напълно непроменен pending-first flow:
 * register() създава pending_registrations ред, връща
 * {mode:'email_code', pendingRegistrationId, rawCode, maskedEmail,
 * expiresAt} — акаунтът се материализира едва във verifyRegistrationEmail().
 *
 * 'direct' — email+име+парола+повтори -> account/profile/wallet/progress се
 * материализират ВЕДНАГА, БЕЗ pending_registrations ред, БЕЗ verification
 * code/email — register() връща {mode:'direct', sessionToken, session}
 * directno (same shape като login()/verifyRegistrationEmail()'s success).
 * Виж registerDirect()/materializeAccountAndProfileInOpenTransaction() за
 * implementation-а — SAME materialization функция като email_code flow-а,
 * само conflict-проверките преди нея се различават (виж registerDirect()'s
 * doc коментар).
 */
export type RegistrationVerificationMode = 'email_code' | 'direct'

/**
 * Email verification pending-first registration flow — виж register()'s doc
 * коментар за пълната policy. rawCode присъства САМО в резултата на
 * register()/resendRegistrationVerificationCode() (in-memory, връща се на
 * caller-а за да го изпрати по email) — НИКОГА не се логва, НИКОГА не се
 * връща в HTTP JSON response-а към клиента (виж registrationVerificationHandlers.ts).
 *
 * 'direct' success клонът (RegistrationVerificationMode='direct') връща
 * sessionToken/session directno — index.ts's /api/auth/register handler
 * branch-ва на `mode`, за да реши дали да изпрати verification email
 * (email_code) или да отговори directno с {ok:true, session} (direct),
 * mirror на login()/verifyRegistrationEmail()'s response shape.
 */
export type PendingRegistrationCreatedResult =
  | {
      ok: true
      mode: 'email_code'
      pendingRegistrationId: string
      rawCode: string
      maskedEmail: string
      expiresAt: string
    }
  | {
      ok: true
      mode: 'direct'
      sessionToken: string
      session: AuthSessionSnapshot
    }
  | {
      ok: false
      message: string
      code?: ProfileIdentityValidationCode | 'EMAIL_VERIFICATION_PENDING' | 'DISPLAY_NAME_TAKEN' | 'RATE_LIMITED'
    }

export type ResendRegistrationCodeResult =
  /** email е РЕАЛНИЯТ (normalized) адрес — само за caller-а да го подаде на sendRegistrationVerificationEmail(); HTTP response-ът към клиента трябва да ползва maskedEmail, никога email. */
  | { ok: true; rawCode: string; email: string; maskedEmail: string; expiresAt: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'rate_limited' | 'email_mismatch' }

/**
 * Email → dedicated registration verification page (§"EMAIL → DIRECT
 * REGISTRATION VERIFICATION PAGE"). PURE read-only lookup — за разлика от
 * verifyRegistrationEmail()/resendRegistrationVerificationCode(), НЕ трие
 * expired redове при среща (side-effect-free by design — статус страницата
 * трябва да може да бъде отваряна repeatedly/refresh-вана без да consume-ва
 * или мутира каквото и да е pending state). Разчита на СЪЩИЯ opaque
 * pendingRegistrationId bearer capability модел като resend/update-display-
 * name/verify (виж UpdatePendingRegistrationDisplayNameResult doc коментара) —
 * не нов security model, не нов token.
 *
 * 'not_found' покрива И "никога не е съществувал", И "вече consumed от
 * успешен verify", И "вече opportunistically изтрит от unrelated
 * register()/resend() cleanup на ДРУГ pending ред със същия email/име" —
 * тези три случая НЕ могат да бъдат надеждно различени, след като редът е
 * физически изтрит (виж authStore.ts's deleteExpiredPendingRegistrationBy*
 * statements/deletePendingRegistrationByIdStatement call sites за пълния
 * opportunistic-delete inventory). Клиентът третира 'not_found' еднакво,
 * независимо от истинската причина — generic "invalid link" state, никога
 * фалшиво увереност за "already verified" или "expired", ако не можем
 * реално да го докажем от все още съществуващ ред.
 */
export type PendingRegistrationVerificationStatusResult =
  | {
      ok: true
      status: 'valid'
      maskedEmail: string
      expiresAt: string
      /** epoch ms — kога resend бутонът отново става наличен (mirror на popup-овия resendAvailableAtMs изчисление). */
      resendAvailableAtMs: number
    }
  | { ok: true; status: 'expired' }
  | { ok: false; reason: 'not_found' | 'rate_limited' }

export type VerifyRegistrationEmailResult =
  | { ok: true; sessionToken: string; session: AuthSessionSnapshot }
  | {
      ok: false
      reason: 'not_found' | 'expired' | 'invalid_code' | 'too_many_attempts' | 'email_taken' | 'display_name_taken' | 'rate_limited'
      attemptsRemaining?: number
    }

/**
 * Display-name-taken recovery (hardening pass §1) — позволява да се смени
 * display_name-а на ВЕЧЕ съществуващ pending registration, БЕЗ да се пипат
 * password_hash/code_hash/resend_count/expires_at.
 *
 * PUBLIC LOCATOR модел (revised) — pendingRegistrationId САМ ПО СЕБЕ СИ вече
 * НЕ е "authorization" за dedicated-page (locator-resolved) заявки. Ако
 * caller-ът подаде `requiredCode`, той се верифицира срещу row.code_hash
 * (СЪЩИЯТ pure timing-safe verifyVerificationCode primitive като verify()
 * по-долу, СЪЩИЯТ споделен failed_attempts budget — грешен requiredCode
 * увеличава failed_attempts точно както грешен verify() опит, за да не се
 * отвори отделен unlimited-guess канал) — display_name НЕ се update-ва, ако
 * кодът е грешен/липсва изтощен бюджет. Ако `requiredCode` е omitted (старият
 * popup flow, kind:'id' в registrationVerificationHandlers.ts), поведението
 * остава bearer-capability, непроменено (backward compatibility).
 */
export type UpdatePendingRegistrationDisplayNameResult =
  | { ok: true; maskedEmail: string; expiresAt: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'rate_limited' }
  | { ok: false; reason: 'invalid_code'; attemptsRemaining: number }
  | { ok: false; reason: 'too_many_attempts' }
  | { ok: false; reason: 'invalid_display_name'; message: string; code?: ProfileIdentityValidationCode }
  | { ok: false; reason: 'display_name_taken' }

/**
 * Пълен администратор — единствената роля с достъп до "Настройки",
 * редакция/модериране на профили, чат с поддръжката и управление на роли.
 *
 * Type predicate (не просто boolean) — след `if (!isFullAdminSession(session)) return`
 * TypeScript стеснява `session` до non-null за остатъка от функцията, точно
 * както правеше досегашният inline `session === null || session.account.role !== 'admin'`.
 */
export function isFullAdminSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'admin'
}

/**
 * Read-only административен достъп ("Информация" / "Сървър") —
 * субадмин ИЛИ пълен администратор. Виж isFullAdminSession за защо е type predicate.
 */
export function isAdminOrSubadminSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (session.account.role === 'admin' || session.account.role === 'subadmin')
}

/**
 * Единственото право на chat_admin: изтриване на съобщения от общия лайв чат
 * в лобито. НЕ дава достъп до нищо друго — admin/subadmin/chat_admin,
 * нищо повече (никакви други "OR" комбинации с chat_admin другаде в кода).
 */
export function isLobbyChatModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'chat_admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * "Публикации от Pika.bg" (бивш общ Live Chat в лобито, ограничен до
 * официален канал) — write И delete достъп: admin/pika_team. Умишлено
 * по-тесен от isLobbyChatModeratorSession (5 роли, delete-only, за
 * стария общ чат) — subadmin/chat_admin/top_chat_admin НЕ получават
 * автоматично право тук само защото са могли да трият в стария общ чат
 * (Публикации от Pika.bg брифа §2/§3: "Не разширявай автоматично
 * правата на други роли само защото преди са имали право"). НЕ замествай
 * isLobbyChatModeratorSession другаде с тази функция.
 */
export function isPikaAnnouncementAuthorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
  )
}

/**
 * "Рекламни кампании" (ad campaigns) management достъп — admin И pika_team
 * имат ЕДНАКВИ права (виждат/create/send/delete всяка кампания, независимо
 * кой я е създал). Умишлено нов, тесен predicate, а не reuse на
 * isPikaAnnouncementAuthorSession, въпреки идентичното тяло — established
 * конвенция в проекта е всяко permission да си има собствен predicate, за
 * да не се разширят случайно правата на едната фича заради промяна в другата.
 */
export function isAdCampaignManagerSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
  )
}

/**
 * Topics moderation достъп (lock/unlock/mute/unmute/delete тема) —
 * admin/subadmin/pika_team/top_chat_admin. Изрично БЕЗ chat_admin (за
 * разлика от isLobbyChatModeratorSession) — chat_admin правото е тясно
 * scoped само до общия лайв чат в лобито, Topics moderation е отделен
 * permission set (Топикс moderation брифа: "Не разширявай автоматично
 * moderator permissions към други роли").
 */
export function isTopicModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * "Лафче" (system Topics поток, topic_id='topic-lafche') delete+mute достъп
 * — САМО admin/pika_team/top_chat_admin, изрично БЕЗ subadmin (за разлика
 * от isTopicModeratorSession по-горе, който важи за General/user-created
 * теми). Прилага се само когато действието е scoped към topic-lafche
 * конкретно (виж handleTopicMuteRequest/handleTopicUnmuteRequest/
 * handleTopicMuteStatusRequest/handleTopicMessageDeleteRequest в index.ts —
 * branch по topicId === 'topic-lafche') — НЕ замества isTopicModeratorSession
 * за General/user topics ("Лафче" брифа §6: "Не давай тези права автоматично
 * на subadmin/chat_admin").
 */
export function isLafcheModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * "Лафче" individual-message delete достъп — isLafcheModeratorSession
 * (admin/pika_team/top_chat_admin) + chat_admin, за paritет с normal Topics
 * individual-message moderation (isTopicMessageModeratorSession по-долу,
 * който вече включва chat_admin). Умишлено НЕ разширява
 * isLafcheModeratorSession самата — тя остава непроменена и продължава да
 * важи за mute/unmute/report/audit в Лафче (§6 продуктовото решение "не
 * давай тези права автоматично на subadmin/chat_admin" остава в сила ЗА
 * онези actions). Тази функция е scoped само към delete parity fix-а (виж
 * handleTopicMessageDeleteRequest branch по topicId === LAFCHE_TOPIC_ID) —
 * subadmin остава изрично изключен и тук, продуктовото решение го изключва
 * само за chat_admin, не за subadmin.
 */
export function isLafcheMessageDeleteModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  // Explicit role comparison вместо isLafcheModeratorSession(session) ||
  // ... — predicate reuse тук narrow-ва session до `never` в false branch-а
  // (established TS control-flow особеност, mirror на коментара в
  // handleTopicMessageDeleteRequest/index.ts).
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
    || session.account.role === 'chat_admin'
  )
}

/**
 * Whole-topic destructive/control действия (lock/unlock/delete тема) — по-тесен
 * permission set от isTopicModeratorSession. Продуктово решение: pika_team
 * (и chat_admin) имат достъп до mute/unmute/reports/audit (isTopicModeratorSession
 * по-горе), но НЕ до lock/unlock/delete на цяла тема — тези остават admin/
 * subadmin/top_chat_admin, симетрично на isAdminOrSubadminAuthSession конвенцията
 * на клиента. НЕ замествай isTopicModeratorSession с тази функция другаде —
 * mute/reports/audit permissions остават непроменени (corrective pass брифа §A3).
 */
export function isTopicWholeTopicModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * Individual message/reply moderation достъп (delete на ОТДЕЛНО root
 * съобщение или reply в Topics) — admin/subadmin/top_chat_admin/pika_team/
 * chat_admin. Различен role set от isTopicModeratorSession (той е за
 * whole-topic mute/reports/audit, 4 роли, БЕЗ chat_admin) — умишлено НЕ
 * reuse-ва нито isTopicModeratorSession, нито isLobbyChatModeratorSession
 * (макар role set-ът на последния да съвпада 1:1 в момента) — Topics
 * individual-message moderation е собствен semantic domain, отделен от
 * lobby chat moderation, дори permission set-овете временно да съвпадат
 * (individual-message-moderation брифа §4).
 */
export function isTopicMessageModeratorSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'top_chat_admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'chat_admin'
  )
}

/**
 * Gift-yellow-coins friendship-gate bypass — САМО role='pika_team' (Екип
 * Pika.bg), изрично БЕЗ admin/subadmin/top_chat_admin/chat_admin (production
 * hotfix брифа §6: "Не давай това право на други роли, освен ако вече го
 * имат по текущата логика"). Различно от isPikaTeamGiftBypassProfileId
 * (yellowCoinGiftStore.ts) — онова е ЕДИН конкретен profileId, който бивша
 * функционалност ползва за recipient-window limit bypass + по-висок single-
 * операция таван; ТУК e role-based bypass само на "трябва да сте приятели"
 * проверката преди изпращане на подарък. Двата механизма са независими и
 * не се обединяват.
 */
export function isPikaTeamGiftFriendshipBypassSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'pika_team'
}

/**
 * Gift-yellow-coins single-операция max amount bypass (1 000 – 100 000
 * вместо 1 000 – 30 000), заедно с recipient 60-дневен window exemption-а
 * (без него 100 000 подарък не би могъл да мине покрай 30 000/60-дни
 * recipient cap-а за никой non-exempt получател) — САМО role='pika_team',
 * изрично БЕЗ admin/subadmin/top_chat_admin/chat_admin/player (mobile+gift-max
 * hotfix брифа §2: "Не разширявай лимита... само заради този fix"). Отделно
 * право от isPikaTeamGiftFriendshipBypassSession по-горе (брифа: "Friendship
 * bypass и max-amount permission са различни права, но и двете се разрешават
 * на pika_team") — двете предикати happen-стват да имат идентично тяло точно
 * сега, но представляват различни permission-и и НЕ трябва да се обединяват
 * в един predicate (утрешна промяна на едното право не бива да променя
 * другото). Reuse-ва СЪЩИЯ recipient-window-exemption механизъм като legacy
 * isPikaTeamGiftBypassProfileId (yellowCoinGiftStore.ts) — role-based
 * pika_team получава идентичен ефект (по-висок max + window exemption), но
 * през отделен, role-based gate вместо hardcoded profileId сравнение.
 */
export function isPikaTeamGiftMaxAmountSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'pika_team'
}

/**
 * Gift-yellow-coins unlimited bypass — role==='admin' (пълен администратор)
 * единствено, изрично БЕЗ subadmin/pika_team/chat_admin/top_chat_admin/player
 * (задачата: "не разширявай други permissions"). Бypass-ва sender single-
 * операция max amount (30 000), sender rolling-24h daily лимит (200 000) И
 * recipient 60-дневен window лимит (30 000) — виж sendGiftCore §admin bypass
 * в yellowCoinGiftStore.ts. Единствените проверки, които ОСТАВАТ за admin
 * sender: recipient съществува, amount е положително цяло число, sender има
 * достатъчно жълтици. Отделен predicate от isFullAdminSession по-горе (same
 * role check, но различно permission — виж isPikaTeamGiftMaxAmountSession
 * коментара защо не се обединяват).
 */
export function isAdminGiftUnlimitedSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'admin'
}

/**
 * Pika support/direct chat bypass — САМО role='pika_team', изрично БЕЗ
 * admin/subadmin/top_chat_admin/chat_admin/player (chat authorization hotfix
 * брифа: "Не разширявай това към други роли"). Разрешава да СЕ ЗАПОЧНЕ
 * chatStore.getOrCreatePikaSupportConversation с произволен регистриран
 * получател, БЕЗ friendship изискване — legacy единичен
 * OFFICIAL_PIKA_PROFILE_ID/PIKA_OFFICIAL_PROFILE_ID (chatStore.ts
 * officialPikaProfileId) остава ПАРАЛЕЛНО валиден за backward compatibility,
 * тази функция НЕ го заменя, само добавя алтернативен role-based път.
 * Отделен predicate от isPikaTeamGiftFriendshipBypassSession/
 * isPikaTeamGiftMaxAmountSession по-горе — различно permission (chat
 * bypass, не gift), дори тялото да е идентично сега; НЕ reuse-вай gift
 * predicate-ите за chat authorization (брифа §2: "Не използвай gift-specific
 * permission функция, ако това ще смеси две различни права").
 */
export function isPikaTeamSupportChatSession(
  session: AuthSessionSnapshot | null,
): session is AuthSessionSnapshot {
  return session !== null && session.account.role === 'pika_team'
}

export type ElevatedRole = 'subadmin' | 'chat_admin' | 'pika_team' | 'top_chat_admin'

export type SubadminRoleChangeErrorCode =
  | 'not_found'
  | 'no_account'
  | 'self'
  | 'target_is_admin'
  | 'conflict'
  | 'profile_inactive'
  | 'profile_temporary'
  | 'account_inactive'

export type SubadminRoleChangeResult =
  | { ok: true; role: 'subadmin' | 'player' }
  | { ok: false; code: SubadminRoleChangeErrorCode; message: string }

export type ChatAdminRoleChangeErrorCode = SubadminRoleChangeErrorCode

export type ChatAdminRoleChangeResult =
  | { ok: true; role: 'chat_admin' | 'player' }
  | { ok: false; code: ChatAdminRoleChangeErrorCode; message: string }

export type PikaTeamRoleChangeErrorCode = SubadminRoleChangeErrorCode

export type PikaTeamRoleChangeResult =
  | { ok: true; role: 'pika_team' | 'player' }
  | { ok: false; code: PikaTeamRoleChangeErrorCode; message: string }

export type TopChatAdminRoleChangeErrorCode = SubadminRoleChangeErrorCode

export type TopChatAdminRoleChangeResult =
  | { ok: true; role: 'top_chat_admin' | 'player' }
  | { ok: false; code: TopChatAdminRoleChangeErrorCode; message: string }

export type AuthStore = {
  /**
   * Email verification pending-first registration (виж production report-а
   * "PENDING REGISTRATION"/"REGISTRATION FLOW" секциите) — вече НЕ създава
   * account/profile/wallet/progress директно. Създава ред в
   * pending_registrations + връща rawCode (за caller-а да го изпрати по
   * email, виж registrationVerificationHandlers.ts — НИКОГА в HTTP
   * response-а). Реалният акаунт се материализира едва в
   * verifyRegistrationEmail() по-долу, след успешен код.
   */
  register: (input: {
    email: string
    password: string
    displayName: string
    gender?: 'male' | 'female' | null
    /** Device identity (localStorage-backed anonymous visitor id) на текущия registration опит — записва се в site_visit_events (authoritative source за admin linked-profile detection, виж adminProfileRiskStore.ts) едва при verifyRegistrationEmail() успех, НЕ участва в решението дали регистрацията да мине. null, ако липсва/невалиден. */
    visitorId?: string | null
    /** Canonical server-side resolved IP на текущия registration опит (index.ts's getRequestIp) — записва се за audit/tracking, НЕ участва в решението дали регистрацията да мине. null, ако не може да се резолвне. */
    ipAddress?: string | null
    /** Raw User-Agent header на текущия registration опит — записва се само в immediate visitor/profile binding-а при verifyRegistrationEmail() успех. */
    userAgent?: string | null
  }) => PendingRegistrationCreatedResult
  /**
   * Resend на 6-цифрения код (production report-а "RESEND CODE") — генерира
   * НОВ код, стария веднага става невалиден (UPDATE презаписва code_hash),
   * expires_at на pending registration-а НИКОГА не се удължава. 60-секунден
   * cooldown + registration_rate_limit_events anti-spam cap, виж
   * имплементацията по-долу.
   */
  resendRegistrationVerificationCode: (input: {
    pendingRegistrationId: string
    /** PUBLIC LOCATOR модел — ако е подадено, resend се позволява САМО ако съвпада с row.normalized_email (виж ResendRegistrationCodeResult doc коментара). Omitted за стария popup flow (bearer-capability, непроменено). */
    requiredNormalizedEmail?: string
    ipAddress: string | null
  }) => ResendRegistrationCodeResult
  /**
   * Email → dedicated registration verification page. PURE read-only lookup,
   * без side effects — виж PendingRegistrationVerificationStatusResult doc
   * коментара за пълния rationale (защо 'not_found' покрива и truly-invalid,
   * и already-consumed, и opportunistically-deleted-expired случаите
   * еднакво, без да можем надеждно да ги различим след физическо изтриване).
   */
  getPendingRegistrationVerificationStatus: (input: {
    pendingRegistrationId: string
    ipAddress: string | null
  }) => PendingRegistrationVerificationStatusResult
  /**
   * Финализира pending registration -> реален account/profile/wallet/
   * progress/visitor-history в ЕДНА атомарна, concurrency-safe транзакция
   * (production report-а "VERIFY ENDPOINT"). Consume-on-success (pending
   * редът се трие ВЪТРЕ в СЪЩАТА транзакция) — double-click/два конкурентни
   * verify request-а могат да произведат максимум 1 акаунт.
   */
  verifyRegistrationEmail: (input: {
    pendingRegistrationId: string
    code: string
    rememberMe: boolean
    ipAddress: string | null
    userAgent: string | null
  }) => VerifyRegistrationEmailResult
  /**
   * Display-name-taken recovery (hardening pass §1) — виж
   * UpdatePendingRegistrationDisplayNameResult doc коментара по-горе.
   * verifyRegistrationEmail()'s displayNameConflict вече не е dead-end —
   * клиентът може да смени името и да опита verify пак СЪС СЪЩИЯ код/pending.
   */
  updatePendingRegistrationDisplayName: (input: {
    pendingRegistrationId: string
    displayName: string
    /** PUBLIC LOCATOR модел — ако е подадено, update се позволява САМО след успешна non-consuming code проверка (виж UpdatePendingRegistrationDisplayNameResult doc коментара). Omitted за стария popup flow (bearer-capability, непроменено). */
    requiredCode?: string
    ipAddress: string | null
  }) => UpdatePendingRegistrationDisplayNameResult
  /**
   * FINAL PLAN v5 — Display Name Reservation. Read-only проверка дали
   * подаденото (raw, ще бъде normalized вътрешно) display name в момента е
   * reserved от активна (non-expired), различна от excludePendingRegistrationId
   * pending регистрация. Ползва се от GET /api/profile/check-name (композиран
   * с playerProgressStore.isDisplayNameAvailable(), виж index.ts) — НЕ пипа
   * DB-то, чисто informational availability snapshot (GET заявките никога не
   * резервират нищо, виж register()'s doc коментар за точния момент, в който
   * reservation-ът реално стартира).
   */
  hasActivePendingRegistrationForDisplayName: (
    displayName: string,
    excludePendingRegistrationId?: string | null,
  ) => boolean
  /**
   * "Смени имейла" recovery (hardening pass §3) — explicit cancel на pending
   * registration по opaque pendingRegistrationId (bearer capability, mirror
   * на resend/verify security модела). Идемпотентно — вика се безопасно
   * дори ако редът вече не съществува (изтекъл/вече consumed/вече cancelled).
   * НЕ хвърля/разкрива нищо за чужди pending registrations.
   */
  cancelPendingRegistration: (pendingRegistrationId: string) => { ok: true }
  login: (input: {
    email: string
    password: string
    /** Remember-me семантика (production report-а "REMEMBER ME — SERVER SEMANTICS") — подава се към createSession() за да реши cookie shape-а (persistent Max-Age vs browser session-only), НЕ променя server-side expires_at/revocation модела. */
    rememberMe: boolean
  }) =>
    | { ok: true; sessionToken: string; session: AuthSessionSnapshot }
    | { ok: false; message: string }
    | {
        ok: false
        code: 'PROFILE_BANNED'
        message: string
        bannedUntil: string
        reason: string
        remainingDays: number
      }
    | {
        /**
         * "Затваря сайта преди кода" сценарий — active account НЯМА за този
         * email, но unexpired pending registration ИМА и подадената парола
         * съвпада с pending password_hash-а. Клиентът автоматично отваря
         * verification popup-а (виж createLobbyFlowController.ts) вместо да
         * покаже generic invalid-credentials грешка.
         */
        ok: false
        code: 'EMAIL_VERIFICATION_REQUIRED'
        pendingRegistrationId: string
        maskedEmail: string
      }
    | {
        /** Pending registration за този email СЪЩЕСТВУВА, но вече е expired (>24ч) — паролата съвпада, значи е легитимният регистрант, не enumeration risk. */
        ok: false
        code: 'REGISTRATION_EXPIRED'
        message: string
      }
  changePassword: (input: {
    accountId: string
    currentPassword: string
    newPassword: string
  }) => { ok: true } | { ok: false; message: string }
  getSession: (sessionToken: string | null) => AuthSessionSnapshot | null
  /**
   * Rolling/sliding session renewal (auth session-lifetime fix) — виж
   * пълния doc коментар на имплементацията по-долу. Единствен caller:
   * handleAuthRequest-ово GET /api/auth/me в index.ts (не WS connect, не
   * никой друг route) — renewed:true сигнализира на HTTP layer-а да
   * изпрати нов Set-Cookie със същия expires_at. rememberMe в резултата
   * казва на HTTP layer-а КАКЪВ cookie header да построи при renewal
   * (persistent vs session-only) — session-only сесия НИКОГА не трябва да
   * получи Max-Age при renewal (виж createSessionCookieHeader()).
   */
  touchSession: (sessionToken: string | null) => { session: AuthSessionSnapshot | null; renewed: boolean; rememberMe: boolean }
  logout: (sessionToken: string | null) => void
  /**
   * Bulk session revocation по profile_id (spec §1, BAN/HARD-DELETE
   * enforcement) — mirror на logout()'s revokeSessionStatement, но за
   * ВСИЧКИ живи (revoked_at IS NULL) сесии на профила наведнъж, не само
   * една конкретна по token. Ползва СЪЩИЯ account_sessions.revoked_at модел
   * (getSession() вече филтрира revoked_at IS NULL) — никаква паралелна
   * auth система. account_sessions.profile_id е индексиран (виж
   * idx_account_sessions_profile_id в 20260510_003 migration-а), затова
   * това е евтин indexed UPDATE, не table scan. Връща броя реално
   * ревокирани сесии (за diagnostics/тестове).
   */
  revokeAllSessionsForProfile: (profileId: string) => number
  /**
   * Назначава/премахва субадмин роля за профила зад `targetProfileId`.
   * Ролята принадлежи на АКАУНТА (не профила) — виж AccountRow.role.
   * Атомарно: role UPDATE + admin_role_audit_log INSERT в една транзакция.
   * Идемпотентно: повторно грантване на вече-субадмин (или повторно
   * revoke на вече-player) връща ok:true без нов audit ред.
   * Ако акаунтът в момента е chat_admin, grant('subadmin') го ПРЕВКЛЮЧВА
   * директно на subadmin (chat_admin/subadmin са взаимно изключващи се);
   * revoke('subadmin'), докато акаунтът реално е chat_admin, се отказва
   * ('conflict') — не пипа чуждата роля по подразбиране.
   */
  setSubadminRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => SubadminRoleChangeResult
  /** Огледално на setSubadminRole, но за chat_admin роля — виж коментара там. */
  setChatAdminRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => ChatAdminRoleChangeResult
  setPikaTeamRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => PikaTeamRoleChangeResult
  setTopChatAdminRole: (input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }) => TopChatAdminRoleChangeResult
  /** Роля на акаунта зад даден профил — само за UI показване (badge), null ако профилът няма акаунт (бот/гост/изтрит). */
  getAccountRoleForProfile: (profileId: string) => AccountRoleValue | null
  close: () => void
}

type CreateAuthStoreOptions = {
  getSignupBonusYellowCoins?: () => number
  /**
   * Инжектирана зависимост към profileBanStore (spec §5A) — authStore.ts
   * умишлено не отваря собствена връзка към profile_bans/не import-ва
   * profileBanStore директно, mirror на getSignupBonusYellowCoins injection
   * pattern-а по-горе. Връща null, ако профилът няма активен бан.
   */
  getActiveBanForProfile?: (profileId: string) => {
    bannedUntil: string
    reason: string
    remainingDays: number
  } | null
  /**
   * Email verification pending-registration flow — HMAC secret за
   * verification-code hashing (hashVerificationCode/verifyVerificationCode
   * в authHelpers.ts) И registration_rate_limit_events subject hashing
   * (hmacRateLimitSubject, mirror на passwordResetStore-овия
   * rateLimitHashSecret contract — ≥32 символа, validateRateLimitSecret()).
   * Ако липсва/твърде къс: register() връща 'Регистрацията временно не е
   * налична.' БЕЗ никакъв DB write — authStore.ts НИКОГА не fallback-ва към
   * insecure default secret. Виж index.ts bootstrap-а за точния env var
   * resolution (EMAIL_VERIFICATION_CODE_SECRET, fallback
   * PASSWORD_RESET_RATE_LIMIT_SECRET за zero-new-config reuse).
   */
  registrationVerificationCodeSecret?: string
  /**
   * Server-authoritative registration mode (Admin -> Настройки, виж
   * RegistrationVerificationMode doc коментара по-горе и
   * adminSettingsStore.ts) — mirror на getSignupBonusYellowCoins injection
   * pattern-а: authStore.ts умишлено не import-ва adminSettingsStore
   * directno, вика тази callback-нута зависимост вместо това. Четена LIVE
   * (без кеш) на ВСЯКА register() заявка — index.ts's wiring е
   * `() => adminSettingsStore.getSettings().registrationVerificationMode`.
   * Липсва/undefined -> defaults 'email_code' (виж register()'s call site) —
   * safe fallback за тестове без explicit wiring, същия default като
   * adminSettingsStore-овия seed/fallback.
   */
  getRegistrationVerificationMode?: () => RegistrationVerificationMode
}

type AccountRow = {
  account_id: string
  email: string
  password_hash: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  created_at: string
}

type PendingRegistrationRow = {
  pending_registration_id: string
  normalized_email: string
  password_hash: string
  display_name: string
  gender: 'male' | 'female' | null
  visitor_id: string | null
  ip_address: string | null
  user_agent: string | null
  code_hash: string
  created_at: string
  expires_at: string
  last_code_sent_at: string
  resend_count: number
  failed_attempts: number
  /**
   * Display-name reservation (FINAL PLAN v5 — "Display Name Reservation").
   * NULL за legacy/unreserved redове (виж migration backfill-а в
   * ensureServerDatabaseReady.ts) — такъв ред НИКОГА не може да verify-не
   * успешно с оригиналното си display_name (виж
   * createVerifiedAccountAndProfileInOpenTransaction()'s own-reservation
   * check), само през съществуващия DISPLAY_NAME_TAKEN recovery flow.
   */
  normalized_display_name: string | null
}

type SessionRow = {
  session_id: string
  account_id: string
  profile_id: string
  email: string
  role: AccountRoleValue
  status: 'active' | 'disabled'
  account_created_at: string
  /** ISO string (createIsoExpiresAt() формат) — ползва се ЕДИНСТВЕНО от touchSession() за renewal-due изчислението; getSession() го игнорира. */
  expires_at: string
  /** 0/1 (SQLite INTEGER) — remember-me семантика, виж createSessionCookieHeader() doc коментара. */
  remember_me: number
}

const SESSION_COOKIE_NAME = 'belot_session'
/**
 * Rolling/sliding session lifetime (auth session-lifetime fix) — 90 дни от
 * ПОСЛЕДНАТА реална активност, не absolute от login момента. Reuse-ва се
 * И за нови сесии (createSession по-долу), И за renewal-а на съществуващи
 * (touchSession по-долу) — една-единствена константа определя целия
 * "плъзгащ прозорец". Виж touchSession() doc коментара за точната
 * renewal семантика/throttling.
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 90
/**
 * Throttle за touchSession() renewal-а — UPDATE account_sessions.expires_at
 * (плюс новия Set-Cookie от caller-а, виж index.ts's /api/auth/me) се
 * случва максимум веднъж на толкова често за дадена сесия, независимо
 * колко пъти /api/auth/me бъде удрян междувременно (auth session-lifetime
 * report: "НЕ искам UPDATE при всяка HTTP/API заявка"). С TTL=90 дни и
 * throttle=1 ден, максималният брой DB writes е ~1/сесия/ден — гарантирано
 * атомарно от renewSessionStatement-овата WHERE клауза (compare-and-swap
 * cutoff), не от JS-side "if due" проверка — виж touchSession() и
 * renewSessionStatement doc коментарите за пълния concurrency rationale.
 */
const SESSION_RENEWAL_THROTTLE_MS = 1000 * 60 * 60 * 24

/**
 * Pending registration lifetime (production report-а "24-ЧАСОВО ПРАВИЛО") —
 * ФИКСИРАН прозорец от ПЪРВОНАЧАЛНОТО създаване, НИКОГА удължаван (нито от
 * resend, нито от login опит, нито от нов verification attempt) — виж
 * pending_registrations.expires_at doc коментара в migration-а.
 */
const PENDING_REGISTRATION_TTL_MS = 1000 * 60 * 60 * 24
/** Минимален interval между resend-и (production report-а "RESEND CODE"). */
const PENDING_REGISTRATION_RESEND_MIN_INTERVAL_MS = 60 * 1000
/** Wrong-code cap — след толкова failed attempts, verify спира да приема опити за текущия код (resend нулира брояча, виж updatePendingRegistrationCodeStatement). */
const PENDING_REGISTRATION_MAX_FAILED_ATTEMPTS = 5
/** Anti-spam cap отвъд 60s cooldown-а — mirror на password-reset-овите FORGOT_ACCOUNT_MAX_EVENTS pattern-и. */
const PENDING_REGISTRATION_RESEND_MAX_PER_PENDING = 10
const PENDING_REGISTRATION_RESEND_WINDOW_SECONDS = 24 * 60 * 60
const PENDING_REGISTRATION_RESEND_IP_MAX_PER_WINDOW = 20
const PENDING_REGISTRATION_RESEND_IP_WINDOW_SECONDS = 60 * 60
/** IP-scoped brute-force defense за verify endpoint-а, отвъд per-pending failed_attempts cap-а. */
const PENDING_REGISTRATION_VERIFY_IP_MAX_PER_WINDOW = 30
const PENDING_REGISTRATION_VERIFY_IP_WINDOW_SECONDS = 60 * 60
/** Display-name-taken recovery (hardening pass §1) — IP-scoped anti-abuse cap (не за brute-force на кода, а за да не се ползва endpoint-ът за display-name enumeration). */
const PENDING_REGISTRATION_UPDATE_NAME_IP_MAX_PER_WINDOW = 20
const PENDING_REGISTRATION_UPDATE_NAME_IP_WINDOW_SECONDS = 60 * 60
/** Email→page verification status lookup (dedicated page) — IP-scoped, generous (read-only, no secrets, opaque unguessable ID), само за hygiene mirror на останалите registration endpoints, не primary defense. */
const PENDING_REGISTRATION_STATUS_IP_MAX_PER_WINDOW = 60
const PENDING_REGISTRATION_STATUS_IP_WINDOW_SECONDS = 60 * 60
/**
 * Direct-mode registration (registration_verification_mode='direct', виж
 * RegistrationVerificationMode) — IP-scoped anti-abuse cap. ЕДИНСТВЕНАТА
 * friction за direct mode (няма code/email стъпка изобщо да throttle-не
 * automated abuse, за разлика от email_code — там spammer-ът все пак трябва
 * да контролира реален inbox), затова по-консервативен от resend/verify-ip
 * лимитите по-горе (20-30/час), но НЕ толкова тесен, че на практика да
 * възстанови "едно устройство = един профил" (изрично забранено правило,
 * виж registerDirect()'s doc коментар и task-а §6/§7) — типична споделена
 * IP (NAT/mobile carrier/офис) с неколцина различни хора, регистриращи се
 * близо във времето, не бива да удари лимита.
 */
const REGISTRATION_DIRECT_IP_MAX_PER_WINDOW = 10
const REGISTRATION_DIRECT_IP_WINDOW_SECONDS = 60 * 60

/**
 * Registration anti-evasion gate (четвърти follow-up brief §2 — "REGISTRATION
 * ТРЯБВА ДА ИЗИСКВА VALID VISITOR_ID"). Same формат като index.ts's
 * VISITOR_UUID_RE (page-view tracking validation) — версия nibble 1-5,
 * variant nibble 8/9/a/b — точно формата, който crypto.randomUUID() (реалният
 * client tracker, createVisitorPageViewTracker.ts) генерира. Умишлено
 * ДУБЛИРАНА тук (не import от index.ts — authStore.ts е db-слой модул,
 * index.ts вече го import-ва обратно, circular import) — authStore.ts е
 * authoritative и НЕ разчита на index.ts вече да е validate-нал/нормализирал
 * стойността (defense-in-depth: "не разчитай само на frontend validation"
 * важи и за самия HTTP layer тук).
 */
const VISITOR_ID_FORMAT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

function createCookieExpiresAt(): Date {
  return new Date(Date.now() + SESSION_TTL_MS)
}

function createIsoExpiresAt(): string {
  return createCookieExpiresAt().toISOString()
}

/**
 * Remember-me cookie shape (production report-а "REMEMBER ME — SERVER
 * SEMANTICS") — rememberMe=true: persistent cookie с Max-Age (90 дни,
 * survives browser close). rememberMe=false: browser session-only cookie —
 * БЕЗ Max-Age/Expires атрибут изобщо (не "Max-Age=0", това би изтрило
 * cookie-то веднага; просто липсва атрибутът), browser-ът я пази само
 * докато сесията на browser-а трае. Server-side expires_at/renewal/
 * revocation моделът остава ИДЕНТИЧЕН за двата типа (виж touchSession()) —
 * единствената разлика е кое cookie shape browser-ът получава. КРИТИЧНО:
 * caller-ите (index.ts) трябва да подават rememberMe от СЪЩИЯ session ред
 * (SessionRow.remember_me / touchSession()'s rememberMe резултат), НЕ от
 * request-body-то на текущата заявка — иначе renewal на session-only сесия
 * би могъл случайно да я "ъпгрейдне" до persistent (виж index.ts's
 * /api/auth/me handler).
 */
export function createSessionCookieHeader(sessionToken: string, rememberMe: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (rememberMe) {
    parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
  }
  return parts.join('; ')
}

export function createClearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function getSessionTokenFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null
  }

  const cookies = cookieHeader.split(';')

  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.trim().split('=')

    if (rawName === SESSION_COOKIE_NAME) {
      return rawValueParts.join('=') || null
    }
  }

  return null
}

function toAccountSnapshot(row: AccountRow | SessionRow): AuthAccountSnapshot {
  const createdAt = 'account_created_at' in row ? row.account_created_at : row.created_at
  return {
    accountId: row.account_id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt,
  }
}

export async function createAuthStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
  options: CreateAuthStoreOptions = {},
): Promise<AuthStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  // Auth session-lifetime fix — touchSession() добавя нов UPDATE write path
  // (session renewal) към тази връзка; PM2 споделя СЪЩИЯ SQLite файл между
  // няколко process instances (виж ad_campaign_events poll коментара в
  // index.ts за established "PM2 споделя SQLite" facts), затова тази
  // връзка сега се нуждае от busy_timeout mirror на другите write-heavy
  // stores (profileHardDeleteService.ts, pendingProfileModerationStore.ts)
  // — изчаква writer lock-а вместо да хвърли SQLITE_BUSY веднага.
  database.exec('PRAGMA busy_timeout = 5000;')

  // Email verification code secret — виж CreateAuthStoreOptions.
  // registrationVerificationCodeSecret doc коментара. validateRateLimitSecret
  // е generic (≥32 символа), reuse-ван непроменен от authHelpers.ts.
  const registrationSecret = options.registrationVerificationCodeSecret ?? ''
  const isRegistrationSecretConfigured = validateRateLimitSecret(registrationSecret)

  const selectAccountByEmailStatement = database.prepare(`
    SELECT account_id, email, password_hash, role, status
    FROM accounts
    WHERE email = ?
    LIMIT 1;
  `)

  const insertAccountStatement = database.prepare(`
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

  const insertProfileStatement = database.prepare(`
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
      status
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
      ?,
      'active'
    );
  `)

  const insertWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      ?
    );
  `)

  const insertProgressStatement = database.prepare(`
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
    );
  `)

  // Registration anti-evasion gate — "immediate visitor/profile binding"
  // (follow-up brief §2/§3). Минимални INSERT-и в СЪЩИТЕ site_visitors/
  // site_visit_events таблици, ползвани от siteVisitStore.ts (нормалния
  // page-view tracking) — виж register()'s doc коментар за защо това
  // изпълнява на authStore-овата СОБСТВЕНА connection/transaction, а не
  // през siteVisitStore. Само колоните, нужни за findProfileIdsForVisitorId/
  // hasProfileEventFromIp — останалите (referrer/utm/device/os) остават
  // NULL, попълвани нормално от следващия реален page-view.
  const insertRegistrationVisitorRecordStatement = database.prepare(`
    INSERT OR IGNORE INTO site_visitors (
      anonymous_visitor_id,
      first_profile_id,
      last_profile_id
    ) VALUES (
      ?,
      ?,
      ?
    );
  `)

  const insertRegistrationVisitorEventStatement = database.prepare(`
    INSERT OR IGNORE INTO site_visit_events (
      page_view_id,
      anonymous_visitor_id,
      profile_id,
      path,
      navigation_type,
      ip_address,
      user_agent,
      is_entry
    ) VALUES (
      ?,
      ?,
      ?,
      '/lobby',
      'navigate',
      ?,
      ?,
      1
    );
  `)

  // visitor_registration_bindings (20260913_001 migration) — legacy
  // "първи регистриран профил на това device" marker, останал от старата
  // ONE-DEVICE-ONE-ACCOUNT enforcement (премахната, виж register()'s doc
  // коментар за пълната нова policy). Non-authoritative: НИКОЙ runtime path
  // (admin risk detection, hard-delete evidence, support tooling) не чете
  // тази таблица — записва се "best effort", само за архивна следа. "OR
  // IGNORE" (mirror на insertRegistrationVisitorRecordStatement/
  // insertRegistrationVisitorEventStatement по-горе): ако visitor_id вече
  // има binding ред (PRIMARY KEY(anonymous_visitor_id) пази точно 1 ред на
  // visitor_id — само ПЪРВИЯТ регистрирал профил, НЕ пълна история),
  // следващи регистрации от същия visitor_id просто не пипат съществуващия
  // ред — НЕ хвърляме грешка/rollback-ваме регистрацията.
  //
  // Реалният, пълен и authoritative source of truth за visitor<->profile
  // history и admin linked-profile detection е site_visit_events (виж
  // insertRegistrationVisitorEventStatement по-долу И adminProfileRiskStore.ts,
  // който заявява директно срещу нея) — записва по един ред на ВСЯКА
  // регистрация (включително втора/трета от същия visitor_id), независимо
  // от тази таблица.
  const insertVisitorRegistrationBindingStatement = database.prepare(`
    INSERT OR IGNORE INTO visitor_registration_bindings (
      anonymous_visitor_id,
      profile_id
    ) VALUES (
      ?,
      ?
    );
  `)

  const insertSessionStatement = database.prepare(`
    INSERT INTO account_sessions (
      session_id,
      account_id,
      profile_id,
      token_hash,
      expires_at,
      remember_me
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  // Auth session-lifetime fix — открит pre-existing bug (не въведен от тази
  // промяна, но директно противоречи на "изтекли сесии да НЕ се
  // възстановяват" изискването, затова се коригира тук): expires_at се
  // пази като пълен ISO string (createIsoExpiresAt() -> Date.toISOString(),
  // формат "YYYY-MM-DDTHH:MM:SS.sssZ"), но SQLite-овия литерал
  // CURRENT_TIMESTAMP връща РАЗЛИЧЕН формат ("YYYY-MM-DD HH:MM:SS" — space,
  // не 'T', без милисекунди/'Z'). Directна string сравнение (expires_at >
  // CURRENT_TIMESTAMP) на практика работеше "случайно" правилно само
  // защото при 30/90-дневна разлика датовата част сама определя реда —
  // но за сесия, изтекла едва преди секунди/минути (същия календарен
  // ден), 'T' (0x54) > ' ' (0x20) кара израза погрешно да върне TRUE
  // (empirically потвърдено), т.е. вече изтекла сесия минаваше като
  // валидна за кратък прозорец след реалния expiry момент. Фиксът:
  // сравнение срещу strftime('%Y-%m-%dT%H:%M:%fZ','now') — СЪЩИЯТ ISO
  // формат като съхранения expires_at, коректно lexicographically
  // сравним за произволна разлика, не само за дни.
  const selectSessionStatement = database.prepare(`
    SELECT
      s.session_id,
      s.account_id,
      s.profile_id,
      a.email,
      a.role,
      a.status,
      a.created_at AS account_created_at,
      s.expires_at,
      s.remember_me
    FROM account_sessions s
    JOIN accounts a
      ON a.account_id = s.account_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    LIMIT 1;
  `)

  // Auth session-lifetime fix — rolling renewal UPDATE, викан ЕДИНСТВЕНО от
  // touchSession() по-долу. Атомарен compare-and-swap: WHERE клаузата (не
  // JS "if renewal due" преди UPDATE-а) е ЕДИНСТВЕНИЯТ authority за дали
  // renewal-ът реално се случва — elimина TOCTOU race между конкурентни
  // /api/auth/me заявки (concurrency/security follow-up report — два таба
  // на един browser споделят ЕДНА и СЪЩА account_sessions.session_id, а
  // production PM2 споделя СЪЩИЯ SQLite файл между няколко process
  // instances; "SELECT стар expires_at в JS -> decide -> UPDATE" би
  // позволило и двата конкурентни request-а да видят "due" и да пишат).
  // Горна граница (expires_at <= ?, "renewal cutoff") прави throttle-а
  // атомарен: първият UPDATE, който реално matchне реда, го premества на
  // now+90d — веднага след това expires_at > cutoff за всеки друг
  // конкурентен UPDATE (дори ако е прочел стар expires_at в собствен
  // по-раншен SELECT), затова WHERE клаузата вече не съвпада и changes=0.
  // SQLite сериализира конкуриращи се writes (един writer lock, дори в WAL
  // mode) — вторият UPDATE винаги се изпълнява СЛЕД commit-натото
  // състояние на първия, не срещу stale snapshot, затова correctness-ът
  // не зависи от JS-level timing/interleaving, само от SQLite-овите
  // собствени transactional гаранции. Долна граница (expires_at > now)
  // остава defense-in-depth срещу race с expire/revoke (виж по-долу) —
  // никога не "съживява" invalid сесия. Обновява ЕДИНСТВЕНО реда по
  // session_id, не засяга други сесии на същия профил/акаунт
  // (multi-device isolation).
  const renewSessionStatement = database.prepare(`
    UPDATE account_sessions
    SET expires_at = ?
    WHERE session_id = ?
      AND revoked_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND expires_at <= ?;
  `)

  const selectAccountByIdStatement = database.prepare(`
    SELECT account_id, email, password_hash, role, status, created_at
    FROM accounts
    WHERE account_id = ?
    LIMIT 1;
  `)

  // status/is_temporary се ползват само от setSubadminRole (grant eligibility) —
  // getAccountRoleForProfile чете единствено account_id и игнорира останалото.
  const selectProfileRoleEligibilityStatement = database.prepare(`
    SELECT account_id, status, is_temporary
    FROM profiles
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const conditionalUpdateAccountRoleStatement = database.prepare(`
    UPDATE accounts
    SET role = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?
      AND role = ?;
  `)

  const insertAdminRoleAuditLogStatement = database.prepare(`
    INSERT INTO admin_role_audit_log (
      log_id,
      actor_account_id,
      target_account_id,
      action,
      previous_role,
      new_role
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const updatePasswordHashStatement = database.prepare(`
    UPDATE accounts
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
  `)

  const revokeSessionStatement = database.prepare(`
    UPDATE account_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE token_hash = ?
      AND revoked_at IS NULL;
  `)

  const revokeAllSessionsForProfileStatement = database.prepare(`
    UPDATE account_sessions
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND revoked_at IS NULL;
  `)

  const updateLastLoginStatement = database.prepare(`
    UPDATE accounts
    SET last_login_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE account_id = ?;
  `)

  // ─── Pending registration (email verification, "pending first" flow) ──────
  // Живее в authStore.ts's СОБСТВЕНА connection/транзакция (не отделен
  // store с отделна connection) — mirror на visitor_registration_bindings/
  // site_visitors/site_visit_events immediate-binding pattern-а по-горе:
  // verifyRegistrationEmail() ТРЯБВА да изтрие pending реда И да създаде
  // account/profile/wallet/progress В ЕДНА атомарна транзакция (production
  // report-а "VERIFY ENDPOINT" §concurrency-safe) — само възможно ако всички
  // statements споделят СЪЩАТА SQLite connection.

  const selectPendingRegistrationByEmailStatement = database.prepare(`
    SELECT pending_registration_id, normalized_email, password_hash, display_name,
           gender, visitor_id, ip_address, user_agent, code_hash, created_at,
           expires_at, last_code_sent_at, resend_count, failed_attempts,
           normalized_display_name
    FROM pending_registrations
    WHERE normalized_email = ?
    LIMIT 1;
  `)

  // Opportunistic cleanup — само за ТОЗИ email, ПРЕДИ uniqueness-проверката
  // в register()/login(). "По-чистия вариант" (spec §"EMAIL RESERVATION") —
  // изтрити, не просто flag-нати expired редове; UNIQUE(normalized_email)
  // индексът прави това самата DB гаранция, не application-level race.
  // Whole-row DELETE — освобождава ЕДНОВРЕМЕННО и email, И display-name
  // reservation-а (ако имаше такъв на СЪЩИЯ ред), виж FINAL PLAN v5
  // "Email + display-name expiry" секцията: единичен ред носи и двете
  // claims, затова изтриването му по което и да е от двете полета освобождава
  // и двете едновременно.
  const deleteExpiredPendingRegistrationByEmailStatement = database.prepare(`
    DELETE FROM pending_registrations
    WHERE normalized_email = ?
      AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  `)

  // Огледален cleanup, филтриран по normalized_display_name вместо email —
  // покрива "нов email, старо display name" сценария (FINAL PLAN v5 §10.B):
  // ако expired ред държи target името, но с ДРУГ email, cleanup-ът по email
  // (горе) не би го докоснал — трябва отделен filter по display name.
  // Same whole-row DELETE семантика — трие целия ред, освобождавайки и
  // email-а на този ред заедно с името.
  const deleteExpiredPendingRegistrationByNormalizedNameStatement = database.prepare(`
    DELETE FROM pending_registrations
    WHERE normalized_display_name = ?
      AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  `)

  // Authoritative pending-reservation conflict check — вика се ВЪТРЕ в
  // писателската транзакция (register()/updatePendingRegistrationDisplayName()),
  // СЛЕД съответния expired-cleanup по-горе, ПРЕДИ INSERT/UPDATE. excludePendingId
  // (nullable) изключва собствения ред на caller-а от update-display-name
  // сценария (виж FINAL PLAN v5 §4) — при register() винаги се подава null,
  // тъй като новия ред още не съществува.
  const selectActivePendingReservationConflictStatement = database.prepare(`
    SELECT pending_registration_id
    FROM pending_registrations
    WHERE normalized_display_name = ?
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (? IS NULL OR pending_registration_id <> ?)
    LIMIT 1;
  `)

  // last_code_sent_at се подава EXPLICIT като JS-generated ISO string
  // (createIsoNow(), виж по-долу) — НЕ разчита на column DEFAULT
  // CURRENT_TIMESTAMP/SQLite CURRENT_TIMESTAMP литерал, чийто формат
  // ("YYYY-MM-DD HH:MM:SS", без 'T'/'Z') не е JS Date-parseable съвместим с
  // expires_at-овия ISO формат (mirror на same bug class като
  // selectSessionStatement doc коментара по-горе за account_sessions —
  // 60s resend cooldown проверката по-долу сравнява точно тази колона чрез
  // JS `new Date()`, затова форматът трябва да е identical на expires_at).
  // normalized_display_name — единственото ново поле (FINAL PLAN v5): claim-ва
  // display-name reservation-а АТОМАРНО заедно с email reservation-а, в СЪЩИЯ
  // INSERT/COMMIT — виж register()'s doc коментар по-долу за пълния rationale.
  const insertPendingRegistrationStatement = database.prepare(`
    INSERT INTO pending_registrations (
      pending_registration_id, normalized_email, password_hash, display_name,
      gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
      normalized_display_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)

  const selectPendingRegistrationByIdStatement = database.prepare(`
    SELECT pending_registration_id, normalized_email, password_hash, display_name,
           gender, visitor_id, ip_address, user_agent, code_hash, created_at,
           expires_at, last_code_sent_at, resend_count, failed_attempts,
           normalized_display_name
    FROM pending_registrations
    WHERE pending_registration_id = ?
    LIMIT 1;
  `)

  const deletePendingRegistrationByIdStatement = database.prepare(`
    DELETE FROM pending_registrations WHERE pending_registration_id = ?;
  `)

  // Resend: НОВ code_hash, last_code_sent_at обновен (EXPLICIT ISO param,
  // виж insertPendingRegistrationStatement doc коментара по-горе за защо —
  // НЕ SQLite CURRENT_TIMESTAMP литерал), resend_count++, failed_attempts
  // нулиран (свеж attempt-бюджет за новия код) — expires_at умишлено
  // ОТСЪСТВА от SET клаузата (spec §"24-ЧАСОВО ПРАВИЛО": resend НИКОГА не
  // удължава оригиналния 24-часов прозорец).
  const updatePendingRegistrationCodeStatement = database.prepare(`
    UPDATE pending_registrations
    SET code_hash = ?, last_code_sent_at = ?,
        resend_count = resend_count + 1, failed_attempts = 0
    WHERE pending_registration_id = ?;
  `)

  const incrementPendingRegistrationFailedAttemptsStatement = database.prepare(`
    UPDATE pending_registrations
    SET failed_attempts = failed_attempts + 1
    WHERE pending_registration_id = ?;
  `)

  // Display-name-taken recovery (hardening pass §1, разширен от FINAL PLAN v5) —
  // display_name И normalized_display_name в ЕДИН UPDATE statement. Единичен
  // write атомарно "премества" reservation-а от старото към новото име на
  // СЪЩИЯ ред — никакъв отделен "release old -> claim new" двустъпков flow
  // (виж updatePendingRegistrationDisplayName()'s doc коментар за пълния
  // atomicity rationale: ако new-name conflict check-ът по-горе се провали,
  // ROLLBACK-ът връща стария normalized_display_name непокътнат, защото този
  // UPDATE изобщо не се изпълнява). code_hash/failed_attempts/resend_count/
  // last_code_sent_at/expires_at НИКОГА не се пипат тук — потребителят не
  // трябва да губи прогреса си само защото избраното от него име се е
  // оказало заето.
  const updatePendingRegistrationDisplayNameStatement = database.prepare(`
    UPDATE pending_registrations
    SET display_name = ?, normalized_display_name = ?
    WHERE pending_registration_id = ?;
  `)

  // Rate-limit events (mirror на passwordResetStore.ts's checkAndRecordRateLimit
  // — виж production report-а "RESEND CODE"/"SECURITY" секциите за reuse
  // rationale-а). Raw IP/pendingRegistrationId никога не се записват, само
  // HMAC subject_hash (hmacRateLimitSubject, СЪЩИЯ helper като password reset).
  const countRegistrationRateLimitEventsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt
    FROM registration_rate_limit_events
    WHERE scope = ?
      AND subject_hash = ?
      AND created_at > datetime('now', ? || ' seconds');
  `)

  const insertRegistrationRateLimitEventStatement = database.prepare(`
    INSERT INTO registration_rate_limit_events (event_id, scope, subject_hash)
    VALUES (?, ?, ?);
  `)

  // Retention 48h — по-дълъг от всеки реален rate-limit прозорец тук (max 24h),
  // mirror на passwordResetStore.ts's CLEANUP_RATE_LIMIT_RETENTION_SECONDS.
  const cleanupRegistrationRateLimitEventsStatement = database.prepare(`
    DELETE FROM registration_rate_limit_events
    WHERE created_at <= datetime('now', '-172800 seconds');
  `)

  const nameConflictStatement = database.prepare(`
    SELECT profile_id FROM profiles
    WHERE status = 'active'
      AND (normalized_display_name = ? OR normalized_username = ?)
    LIMIT 1;
  `)

  function createSession(account: AccountRow | SessionRow, profileId: ProfileId, rememberMe: boolean): {
    sessionToken: string
    session: AuthSessionSnapshot
  } {
    const sessionToken = createSessionToken()
    const sessionId = randomUUID()

    insertSessionStatement.run(
      sessionId,
      account.account_id,
      profileId,
      hashSessionToken(sessionToken),
      createIsoExpiresAt(),
      rememberMe ? 1 : 0,
    )
    updateLastLoginStatement.run(account.account_id)

    const profile = playerProgressStore.getPublicProfile(profileId)

    if (profile === null) {
      throw new Error('Profile was not found after session creation.')
    }

    return {
      sessionToken,
      session: {
        sessionId,
        account: toAccountSnapshot(account),
        profile,
      },
    }
  }

  /**
   * Реалната account/profile/wallet/progress/visitor-history материализация
   * — извлечена от старата (pre-pending-first) register() имплементация
   * БЕЗ функционална промяна (само преместена, после разцепена на shared
   * "insert only" building block, виж configurable-registration-mode audit
   * задачата §4). ЕДИНСТВЕНОТО място, което пише в accounts/profiles/
   * profile_wallets/profile_progress/visitor_registration_bindings за нова
   * регистрация — вика се и от verifyRegistrationEmail() (email_code, чрез
   * createVerifiedAccountAndProfileInOpenTransaction по-долу), и от
   * registerDirect() (direct mode) — "one choke point account-creation
   * логика", никаква паралелна account-creation пътека, независимо от mode.
   * Caller-ът управлява BEGIN/COMMIT/ROLLBACK И всички conflict-проверки
   * ПРЕДИ да я извика — тази функция самата НИКОГА не проверява конфликти,
   * само пише (assumption: caller вече е потвърдил че email/display name са
   * свободни в текущата отворена транзакция).
   */
  function materializeAccountAndProfileInOpenTransaction(input: {
    normalizedEmail: string
    passwordHash: string
    canonicalDisplayName: string
    normalizedDisplayName: string
    normalizedUsername: string
    gender: 'male' | 'female' | null
    visitorId: string
    ipAddress: string | null
    userAgent: string | null
  }): { accountRow: AccountRow; profileId: ProfileId } {
    const accountId = randomUUID()
    const profileId = randomUUID()

    insertAccountStatement.run(accountId, input.normalizedEmail, input.passwordHash)
    insertProfileStatement.run(
      profileId,
      accountId,
      input.canonicalDisplayName,
      input.normalizedUsername,
      input.canonicalDisplayName,
      input.normalizedDisplayName,
      input.gender,
    )
    insertWalletStatement.run(
      profileId,
      Math.max(0, Math.trunc(options.getSignupBonusYellowCoins?.() ?? 0)),
    )
    insertProgressStatement.run(profileId)

    // Immediate visitor/profile binding (follow-up brief §2) — ВЪТРЕ в
    // СЪЩАТА транзакция/connection като account/profile INSERT-ите по-горе.
    // Виж insertVisitorRegistrationBindingStatement doc коментара по-горе —
    // "OR IGNORE", не блокира/хвърля при вече съществуващ binding за този
    // visitor_id (product policy: MULTIPLE PROFILES FROM SAME DEVICE Е
    // ПОЗВОЛЕНО — виж configurable-registration-mode audit §6; тази "OR
    // IGNORE" INSERT е чисто archival "first-registered-profile-for-this-
    // visitor" marker, НЕ enforcement, важи еднакво за email_code И direct).
    // site_visit_events (insertRegistrationVisitorEventStatement) остава
    // authoritative историческия trail за admin linked-profile detection
    // (adminProfileRiskStore.ts) — записва по един ред на ВСЯКА успешна
    // регистрация, независимо от mode.
    insertVisitorRegistrationBindingStatement.run(input.visitorId, profileId)
    insertRegistrationVisitorRecordStatement.run(input.visitorId, profileId, profileId)
    insertRegistrationVisitorEventStatement.run(
      randomUUID(),
      input.visitorId,
      profileId,
      input.ipAddress,
      input.userAgent,
    )

    const accountRow: AccountRow = {
      account_id: accountId,
      email: input.normalizedEmail,
      password_hash: input.passwordHash,
      role: 'player',
      status: 'active',
      created_at: new Date().toISOString(),
    }

    return { accountRow, profileId }
  }

  /**
   * email_code verify-time материализация — ИДЕНТИЧНО поведение като преди
   * разцепването (виж materializeAccountAndProfileInOpenTransaction doc
   * коментара по-горе за пълния rationale защо е extracted): същите
   * conflict-проверки (email uniqueness, FINAL PLAN v5 pending-ownership
   * reservation check, profiles-table name conflict), само самите INSERT-и
   * вече живеят в shared helper-а. Извикана от verifyRegistrationEmail()
   * ВЪТРЕ в НЕГОВАТА собствена BEGIN IMMEDIATE транзакция.
   */
  function createVerifiedAccountAndProfileInOpenTransaction(input: {
    normalizedEmail: string
    passwordHash: string
    displayName: string
    gender: 'male' | 'female' | null
    visitorId: string
    ipAddress: string | null
    userAgent: string | null
    /** FINAL PLAN v5 — нужен за own-reservation ownership проверката веднага по-долу. */
    pendingRegistrationId: string
  }): { accountRow: AccountRow; profileId: ProfileId } | { conflict: 'email_taken' | 'display_name_taken' } {
    const existingAccount = selectAccountByEmailStatement.get(input.normalizedEmail) as AccountRow | undefined
    if (existingAccount) {
      return { conflict: 'email_taken' }
    }

    const displayNameResult = validateProfileDisplayName(input.displayName)
    // displayName вече е canonicalized/validated при pending creation-а
    // (register() по-долу) — това е defense-in-depth re-check, не нов
    // validation path; ако някак не е ok тук, третираме като name conflict
    // (не би трябвало да се случи на практика).
    const normalizedDisplayName = displayNameResult.ok ? displayNameResult.normalizedKey : input.displayName
    const canonicalDisplayName = displayNameResult.ok ? displayNameResult.canonicalDisplayName : input.displayName
    const normalizedUsername = normalizedDisplayName

    // FINAL PLAN v5 — Verification ownership: ТОЗИ pending ред трябва да
    // докаже, че реално Е authoritative reservation owner-ът на normalized
    // display name-а, ПРЕДИ да продължи към profiles-table проверката.
    // Покрива И "друг pending ред държи reservation-а" (winner срещу loser
    // race, виж migration backfill-а/verify race теста), И "ТОЗИ ред е
    // legacy/unreserved (normalized_display_name IS NULL от migration-а)" —
    // NULL никога не match-ва тази SELECT, затова unreserved loser
    // automатично пада в conflict клона по-долу, независимо от реда на
    // пристигане (SQLite BEGIN IMMEDIATE извън тази функция вече сериализира
    // конкурентни verify опити — виж verifyRegistrationEmail()).
    const reservationOwner = selectActivePendingReservationConflictStatement.get(
      normalizedDisplayName,
      null,
      null,
    ) as { pending_registration_id: string } | undefined
    if (reservationOwner === undefined || reservationOwner.pending_registration_id !== input.pendingRegistrationId) {
      return { conflict: 'display_name_taken' }
    }

    const nameConflict = nameConflictStatement.get(normalizedDisplayName, normalizedUsername) as
      | { profile_id: string }
      | undefined
    if (nameConflict !== undefined) {
      return { conflict: 'display_name_taken' }
    }

    return materializeAccountAndProfileInOpenTransaction({
      normalizedEmail: input.normalizedEmail,
      passwordHash: input.passwordHash,
      canonicalDisplayName,
      normalizedDisplayName,
      normalizedUsername,
      gender: input.gender,
      visitorId: input.visitorId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })
  }

  /**
   * Direct-mode registration (registration_verification_mode='direct', виж
   * RegistrationVerificationMode) — email+име+парола -> account/profile
   * ВЕДНАГА, БЕЗ pending_registrations ред, БЕЗ verification code/email.
   * Извикана от register() ПОСЛЕ споделената validation/existingAccount
   * проверка там (email format/normalize, password, display-name
   * format/normalize, visitorId format, duplicate email — виж register()'s
   * doc коментар) — тук остават само conflict-проверките, СПЕЦИФИЧНИ за
   * direct (различни от email_code verify-owneship модела, защото няма
   * pending ред, който да docaже ownership):
   *
   *   1. IP rate limit (registration-direct-ip) — ЕДИНСТВЕНАТА anti-abuse
   *      friction за direct mode (виж REGISTRATION_DIRECT_IP_* доc коментара
   *      по-горе за пълния rationale/window/limit).
   *   2. Symmetric active-pending-reservation guard — СЪЩАТА заявка
   *      (selectActivePendingReservationConflictStatement, excludeId=null)
   *      като register()'s pendingNameConflict проверка за email_code —
   *      direct регистрация НЕ трябва да открадне име, което В МОМЕНТА е
   *      резервирано от друг, все още валиден (non-expired) email_code
   *      pending ред (виж task-а §5 "email_code flow не трябва да може да
   *      вземе име, което междувременно вече е създадено от direct
   *      registration" — симетрията е гарантирана, защото и двата flow-а
   *      четат СЪЩИТЕ два data source-а: profiles + active pending redове).
   *   3. profiles-table name conflict (nameConflictStatement) — СЪЩАТА
   *      заявка като email_code flow-а/verify-я.
   *
   * След двете проверки — СЪЩАТА materializeAccountAndProfileInOpenTransaction
   * (§4 "account/profile creation трябва да има един shared implementation"),
   * после createSession() directно (mirror на old pre-pending-first
   * register()'s поведение) — НЕ verifyRegistrationEmail(), защото няма
   * pending ред за consume-ване.
   *
   * НЕ premahva/отслабва device/visitor blocking — такъв не съществува в
   * текущия код (продуктово решение, виж checkOpenRegistrationPolicy.ts) —
   * insertVisitorRegistrationBindingStatement вътре в
   * materializeAccountAndProfileInOpenTransaction е "OR IGNORE" archival
   * marker, никога gate.
   */
  function registerDirect(input: {
    normalizedEmail: string
    passwordHash: string
    canonicalDisplayName: string
    normalizedDisplayName: string
    gender: 'male' | 'female' | null
    visitorId: string
    ipAddress: string | null
    userAgent: string | null
  }): PendingRegistrationCreatedResult {
    try {
      database.exec('BEGIN IMMEDIATE;')

      if (input.ipAddress !== null) {
        const limitedByIp = checkRegistrationRateLimit({
          scope: 'registration-direct-ip',
          rawSubject: input.ipAddress,
          windowSeconds: REGISTRATION_DIRECT_IP_WINDOW_SECONDS,
          maxEvents: REGISTRATION_DIRECT_IP_MAX_PER_WINDOW,
        })
        if (limitedByIp) {
          database.exec('ROLLBACK;')
          return {
            ok: false,
            code: 'RATE_LIMITED',
            message: 'Твърде много регистрации от този адрес. Опитайте отново след малко.',
          }
        }
      }

      const normalizedUsername = input.normalizedDisplayName

      // Symmetric guard (виж registerDirect()'s doc коментар по-горе, т.2) —
      // ИДЕНТИЧНА заявка като register()'s pendingNameConflict проверка за
      // email_code, excludeId=null (direct регистрацията няма собствен
      // pending ред за self-exclusion).
      const pendingNameConflict = selectActivePendingReservationConflictStatement.get(
        input.normalizedDisplayName,
        null,
        null,
      ) as { pending_registration_id: string } | undefined
      if (pendingNameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      const nameConflict = nameConflictStatement.get(input.normalizedDisplayName, normalizedUsername) as
        | { profile_id: string }
        | undefined
      if (nameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      const materialized = materializeAccountAndProfileInOpenTransaction({
        normalizedEmail: input.normalizedEmail,
        passwordHash: input.passwordHash,
        canonicalDisplayName: input.canonicalDisplayName,
        normalizedDisplayName: input.normalizedDisplayName,
        normalizedUsername,
        gender: input.gender,
        visitorId: input.visitorId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      })

      database.exec('COMMIT;')

      // rememberMe=true — direct регистрацията е "register-and-immediately-
      // logged-in" UX (mirror на remember-me checked-by-default login
      // конвенцията, виж login()'s doc коментар "REMEMBER ME"), няма отделен
      // UI checkbox на register формата за това.
      const session = createSession(materialized.accountRow, materialized.profileId, true)

      return { ok: true, mode: 'direct', sessionToken: session.sessionToken, session: session.session }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }

      const message = error instanceof Error ? error.message : String(error)
      // UNIQUE(accounts.email) race — конкурентна регистрация за СЪЩИЯ email
      // committed-нала между register()'s early existingAccount проверка и
      // тази транзакция (TOCTOU, extremely tight window — SQLite BEGIN
      // IMMEDIATE все пак сериализира истински-конкурентни опити).
      if (message.includes('accounts.email')) {
        return { ok: false, message: 'Вече има регистрация с този email.' }
      }
      // UNIQUE(profiles.normalized_display_name) race — mirror на
      // createVerifiedAccountAndProfileInOpenTransaction's аналогичен catch.
      if (message.includes('normalized_display_name') || message.includes('normalized_username')) {
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      return { ok: false, message: 'Регистрацията не беше успешна.' }
    }
  }

  function checkRegistrationRateLimit(input: {
    scope: string
    rawSubject: string
    windowSeconds: number
    maxEvents: number
  }): boolean {
    // Връща true, ако е limited (caller-ът трябва да откаже). Извиква се
    // ВИНАГИ ВЪТРЕ в отворена BEGIN IMMEDIATE транзакция от caller-а (mirror
    // на passwordResetStore.ts's checkAndRecordRateLimit) — cleanup+count+
    // insert атомарно с останалата операция.
    const subjectHash = hmacRateLimitSubject(input.scope, input.rawSubject, registrationSecret)
    cleanupRegistrationRateLimitEventsStatement.run()
    const countRow = countRegistrationRateLimitEventsStatement.get(
      input.scope,
      subjectHash,
      `-${input.windowSeconds}`,
    ) as { cnt: number } | undefined
    if ((countRow?.cnt ?? 0) >= input.maxEvents) {
      return true
    }
    insertRegistrationRateLimitEventStatement.run(randomUUID(), input.scope, subjectHash)
    return false
  }

  const PENDING_REGISTRATION_EMAIL_MESSAGE =
    'Този имейл има незавършена регистрация. Влезте с имейла и паролата си, за да я завършите.'

  function register(input: {
    email: string
    password: string
    displayName: string
    gender?: 'male' | 'female' | null
    visitorId?: string | null
    ipAddress?: string | null
    userAgent?: string | null
  }): PendingRegistrationCreatedResult {
    if (!isRegistrationSecretConfigured) {
      return { ok: false, message: 'Регистрацията временно не е налична.' }
    }

    const email = normalizeEmail(input.email)
    const displayNameResult = validateProfileDisplayName(input.displayName)

    if (email === null) {
      return { ok: false, message: 'Невалиден email адрес.' }
    }

    if (!validatePassword(input.password)) {
      return { ok: false, message: 'Паролата трябва да е поне 6 символа.' }
    }

    if (!displayNameResult.ok) {
      return { ok: false, message: displayNameResult.message, code: displayNameResult.code }
    }

    // Стандартна input validation (НЕ anti-evasion решение) — visitorId е
    // задължителен prerequisite за регистрация, защото се записва в
    // site_visit_events (admin dependency detection source) при успешна
    // верификация, но липсата/форматът му вече НЕ участва в решение дали
    // регистрацията да мине — само дали заявката е добре формирана.
    if (typeof input.visitorId !== 'string' || !VISITOR_ID_FORMAT_RE.test(input.visitorId)) {
      return {
        ok: false,
        message: 'Невалидна заявка за регистрация. Моля презаредете страницата и опитайте отново.',
      }
    }
    const visitorId = input.visitorId.toLowerCase()

    const existingAccount = selectAccountByEmailStatement.get(email) as AccountRow | undefined
    if (existingAccount) {
      return { ok: false, message: 'Вече има регистрация с този email.' }
    }

    const gender = input.gender === 'male' || input.gender === 'female' ? input.gender : null
    const passwordHash = createPasswordHash(input.password)

    // Server-authoritative registration mode (Admin -> Настройки, виж
    // RegistrationVerificationMode/adminSettingsStore.ts) — четена LIVE тук,
    // на ВСЯКА заявка (без кеш, mirror на getSignupBonusYellowCoins pattern-а)
    // — клиентът никога не избира/подава mode, само сървърът решава.
    // Default 'email_code', ако callback-ът липсва (тестове без explicit
    // wiring) — same default като adminSettingsStore-овия seed/fallback,
    // гарантира 100% непроменено production поведение до explicit admin
    // превключване (виж task-а §12 "backward compatibility").
    const registrationMode = options.getRegistrationVerificationMode?.() ?? 'email_code'

    if (registrationMode === 'direct') {
      // Direct mode (виж registerDirect()'s doc коментар за пълния flow) —
      // email+parola+display name вече валидирани по-горе (СЪЩАТА validation
      // като email_code клона отдолу), existingAccount вече проверен
      // (веднага по-горе) — оттук registerDirect() продължава със
      // собствените си (direct-специфични) conflict-проверки +
      // materialization + session creation. НЕ се създава pending_registrations
      // ред, НЕ се изпраща verification email — index.ts's HTTP handler
      // разпознава mode:'direct' в резултата и пропуска
      // sendRegistrationVerificationEmail() изцяло.
      return registerDirect({
        normalizedEmail: email,
        passwordHash,
        canonicalDisplayName: displayNameResult.canonicalDisplayName,
        normalizedDisplayName: displayNameResult.normalizedKey,
        gender,
        visitorId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      })
    }

    const pendingRegistrationId = randomUUID()
    const rawCode = generateVerificationCode()
    const codeHash = hashVerificationCode(rawCode, registrationSecret)
    const expiresAt = new Date(Date.now() + PENDING_REGISTRATION_TTL_MS).toISOString()

    try {
      database.exec('BEGIN IMMEDIATE;')

      // Opportunistic cleanup — само за ТОЗИ email (spec §"EMAIL RESERVATION":
      // "по-чистия вариант" — изтрива, не флагва). Освобождава email-а за
      // нова регистрация веднага щом старият pending ред е expired.
      deleteExpiredPendingRegistrationByEmailStatement.run(email)
      // FINAL PLAN v5 — огледален cleanup по display name, ПРЕДИ conflict
      // check-а по-долу: ако друг, вече изтекъл pending ред държи ТОЧНО
      // target-натото име (но с различен email, затова горният cleanup не го
      // докосна), той трябва да бъде изчистен тук, за да не блокира новата
      // регистрация с фалшив "заето" конфликт.
      deleteExpiredPendingRegistrationByNormalizedNameStatement.run(displayNameResult.normalizedKey)

      const existingPending = selectPendingRegistrationByEmailStatement.get(email) as
        | PendingRegistrationRow
        | undefined
      if (existingPending !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'EMAIL_VERIFICATION_PENDING', message: PENDING_REGISTRATION_EMAIL_MESSAGE }
      }

      // Best-effort (НЕ authoritative за profiles race, но АВТОРИТЕТНО за
      // pending-pending race — виж проверката веднага по-долу) display-name
      // uniqueness проверка срещу СЪЩЕСТВУВАЩИ активни профили тук — веднага
      // feedback за потребителя при register(), вместо да чака до след email
      // verification. Authoritative re-check СЪЩО се случва в
      // verifyRegistrationEmail() (createVerifiedAccountAndProfileInOpenTransaction's
      // nameConflictStatement) — защита срещу profiles-table race (нов profile
      // е бил създаден между този momент и verify-а).
      const earlyNameConflict = nameConflictStatement.get(
        displayNameResult.normalizedKey,
        displayNameResult.normalizedKey,
      ) as { profile_id: string } | undefined
      if (earlyNameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      // FINAL PLAN v5 — Display Name Reservation. Authoritative pending↔pending
      // check: ако друга активна (non-expired), НЕ-собствена pending
      // регистрация вече държи точно това normalized име, тази регистрация
      // трябва да откаже ВЕДНАГА (не да чака до verify-а, както преди тази
      // задача) — точно бизнес правилото "успешно подадена pending
      // регистрация резервира display name-а до verify/expiry". excludeId=null
      // тук, тъй като новият ред все още не съществува (self-conflict е
      // структурно невъзможен).
      const pendingNameConflict = selectActivePendingReservationConflictStatement.get(
        displayNameResult.normalizedKey,
        null,
        null,
      ) as { pending_registration_id: string } | undefined
      if (pendingNameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      // Единствен INSERT/COMMIT долу claim-ва И email-а (normalized_email
      // UNIQUE), И display name-а (normalized_display_name UNIQUE) АТОМАРНО
      // заедно (FINAL PLAN v5 §"REGISTER CLAIM") — reservation-ът за двете
      // стартира в СЪЩИЯ момент, от СЪЩОТО committнато събитие. Ако
      // последващото sendRegistrationVerificationEmail() (извън тази функция,
      // виж index.ts) се провали, НИТО едната reservation не се отменя —
      // pending редът остава непокътнат за resend flow-а (изрично бизнес
      // правило, виж register()'s горен doc коментар).
      insertPendingRegistrationStatement.run(
        pendingRegistrationId,
        email,
        passwordHash,
        displayNameResult.canonicalDisplayName,
        gender,
        visitorId,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        codeHash,
        expiresAt,
        new Date().toISOString(),
        displayNameResult.normalizedKey,
      )

      database.exec('COMMIT;')

      return {
        ok: true,
        mode: 'email_code',
        pendingRegistrationId,
        rawCode,
        maskedEmail: maskEmailForDisplay(email),
        expiresAt,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }

      const message = error instanceof Error ? error.message : String(error)
      // UNIQUE(normalized_email) race — конкурентна регистрация за СЪЩИЯ
      // email е committed-нала между opportunistic cleanup-а и INSERT-а.
      // SQLite error формат е "UNIQUE constraint failed: <table>.<column>"
      // (потвърдено директно), затова 'normalized_email' и
      // 'normalized_display_name' са disjoint substrings — проверени
      // поотделно, за да се маппнат към правилния response code.
      if (message.includes('normalized_email')) {
        return { ok: false, code: 'EMAIL_VERIFICATION_PENDING', message: PENDING_REGISTRATION_EMAIL_MESSAGE }
      }
      // FINAL PLAN v5 — UNIQUE(normalized_display_name) race safety net:
      // конкурентна регистрация/pending-display-name-change за СЪЩОТО име е
      // committed-нала между explicit-ния selectActivePendingReservationConflictStatement
      // проверка по-горе и този INSERT (truly-concurrent BEGIN IMMEDIATE опити
      // все пак се сериализират от SQLite, но този catch е defense-in-depth,
      // не primary defense).
      if (message.includes('normalized_display_name')) {
        return { ok: false, code: 'DISPLAY_NAME_TAKEN', message: 'Това име вече е заето.' }
      }

      return { ok: false, message: 'Регистрацията не беше успешна.' }
    }
  }

  /**
   * Email → dedicated registration verification page (§"EMAIL → DIRECT
   * REGISTRATION VERIFICATION PAGE"). PURE read, никакъв write извън
   * rate-limit event insert-а — виж PendingRegistrationVerificationStatusResult
   * doc коментара за пълния "not_found покрива три различни реални причини"
   * rationale. Umishlено НЕ трие expired redове тук (за разлика от verify/
   * resend) — страницата трябва да може да бъде отваряна/refresh-вана
   * repeatedly без side effects.
   */
  function getPendingRegistrationVerificationStatus(input: {
    pendingRegistrationId: string
    ipAddress: string | null
  }): PendingRegistrationVerificationStatusResult {
    if (!isRegistrationSecretConfigured) {
      return { ok: false, reason: 'not_found' }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')

      if (input.ipAddress !== null) {
        const limitedByIp = checkRegistrationRateLimit({
          scope: 'registration-status-ip',
          rawSubject: input.ipAddress,
          windowSeconds: PENDING_REGISTRATION_STATUS_IP_WINDOW_SECONDS,
          maxEvents: PENDING_REGISTRATION_STATUS_IP_MAX_PER_WINDOW,
        })
        if (limitedByIp) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'rate_limited' }
        }
      }

      const row = selectPendingRegistrationByIdStatement.get(input.pendingRegistrationId) as
        | PendingRegistrationRow
        | undefined
      database.exec('COMMIT;')

      if (row === undefined) {
        return { ok: false, reason: 'not_found' }
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        // Row-ът СЪЩЕСТВУВА физически, но е past expires_at -> надеждно
        // 'expired' (за разлика от not_found случая, тук ЗНАЕМ, че е било
        // реална pending регистрация, а не невалиден/непознат идентификатор).
        // НЕ се трие тук — следващият opportunistic cleanup (от друг register()/
        // resend() call) ще го изчисти, или самата verify()/resend() ще го
        // изчисти при реален опит. Status lookup остава pure read.
        return { ok: true, status: 'expired' }
      }

      return {
        ok: true,
        status: 'valid',
        maskedEmail: maskEmailForDisplay(row.normalized_email),
        expiresAt: row.expires_at,
        resendAvailableAtMs: new Date(row.last_code_sent_at).getTime() + PENDING_REGISTRATION_RESEND_MIN_INTERVAL_MS,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      return { ok: false, reason: 'not_found' }
    }
  }

  function resendRegistrationVerificationCode(input: {
    pendingRegistrationId: string
    requiredNormalizedEmail?: string
    ipAddress: string | null
  }): ResendRegistrationCodeResult {
    if (!isRegistrationSecretConfigured) {
      return { ok: false, reason: 'not_found' }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')

      const row = selectPendingRegistrationByIdStatement.get(input.pendingRegistrationId) as
        | PendingRegistrationRow
        | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_found' }
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        // Opportunistic cleanup — mirror на register()'s "по-чистия вариант".
        deletePendingRegistrationByIdStatement.run(row.pending_registration_id)
        database.exec('COMMIT;')
        return { ok: false, reason: 'expired' }
      }

      const msSinceLastSend = Date.now() - new Date(row.last_code_sent_at).getTime()
      if (msSinceLastSend < PENDING_REGISTRATION_RESEND_MIN_INTERVAL_MS) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'rate_limited' }
      }

      const limitedByPending = checkRegistrationRateLimit({
        scope: 'registration-resend-pending',
        rawSubject: row.pending_registration_id,
        windowSeconds: PENDING_REGISTRATION_RESEND_WINDOW_SECONDS,
        maxEvents: PENDING_REGISTRATION_RESEND_MAX_PER_PENDING,
      })
      if (limitedByPending) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'rate_limited' }
      }

      if (input.ipAddress !== null) {
        const limitedByIp = checkRegistrationRateLimit({
          scope: 'registration-resend-ip',
          rawSubject: input.ipAddress,
          windowSeconds: PENDING_REGISTRATION_RESEND_IP_WINDOW_SECONDS,
          maxEvents: PENDING_REGISTRATION_RESEND_IP_MAX_PER_WINDOW,
        })
        if (limitedByIp) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'rate_limited' }
        }
      }

      // PUBLIC LOCATOR модел — за dedicated-page заявки caller-ът (виж
      // registrationVerificationHandlers.ts) подава requiredNormalizedEmail,
      // за да не позволи на locator-alone possession да rotate-не кода. Проверен
      // СЛЕД rate-limit-ите по-горе, за да не се отвори unbounded email-guessing
      // канал — всеки опит (верен или грешен email) консумира същия resend
      // rate-limit budget като реален resend.
      if (input.requiredNormalizedEmail !== undefined && input.requiredNormalizedEmail !== row.normalized_email) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'email_mismatch' }
      }

      const rawCode = generateVerificationCode()
      const codeHash = hashVerificationCode(rawCode, registrationSecret)
      // expires_at НЕ се пипа тук — 24-часовият прозорец е фиксиран от
      // ПЪРВОНАЧАЛНОТО създаване (spec §"24-ЧАСОВО ПРАВИЛО").
      updatePendingRegistrationCodeStatement.run(codeHash, new Date().toISOString(), row.pending_registration_id)

      database.exec('COMMIT;')

      return {
        ok: true,
        rawCode,
        email: row.normalized_email,
        maskedEmail: maskEmailForDisplay(row.normalized_email),
        expiresAt: row.expires_at,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      return { ok: false, reason: 'not_found' }
    }
  }

  function verifyRegistrationEmail(input: {
    pendingRegistrationId: string
    code: string
    rememberMe: boolean
    ipAddress: string | null
    userAgent: string | null
  }): VerifyRegistrationEmailResult {
    if (!isRegistrationSecretConfigured) {
      return { ok: false, reason: 'not_found' }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')

      if (input.ipAddress !== null) {
        const limitedByIp = checkRegistrationRateLimit({
          scope: 'registration-verify-ip',
          rawSubject: input.ipAddress,
          windowSeconds: PENDING_REGISTRATION_VERIFY_IP_WINDOW_SECONDS,
          maxEvents: PENDING_REGISTRATION_VERIFY_IP_MAX_PER_WINDOW,
        })
        if (limitedByIp) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'rate_limited' }
        }
      }

      const row = selectPendingRegistrationByIdStatement.get(input.pendingRegistrationId) as
        | PendingRegistrationRow
        | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_found' }
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        deletePendingRegistrationByIdStatement.run(row.pending_registration_id)
        database.exec('COMMIT;')
        return { ok: false, reason: 'expired' }
      }

      if (row.failed_attempts >= PENDING_REGISTRATION_MAX_FAILED_ATTEMPTS) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'too_many_attempts' }
      }

      const codeIsValid = /^[0-9]{6}$/.test(input.code) && verifyVerificationCode(input.code, registrationSecret, row.code_hash)
      if (!codeIsValid) {
        incrementPendingRegistrationFailedAttemptsStatement.run(row.pending_registration_id)
        database.exec('COMMIT;')
        const attemptsRemaining = Math.max(0, PENDING_REGISTRATION_MAX_FAILED_ATTEMPTS - (row.failed_attempts + 1))
        return { ok: false, reason: 'invalid_code', attemptsRemaining }
      }

      // Код е верен — материализираме реалния account/profile ВЪТРЕ в
      // СЪЩАТА транзакция (spec §"VERIFY ENDPOINT": re-check email
      // uniqueness + create account + profile + wallet/progress +
      // visitor history + consume pending, всичко атомарно).
      const creationResult = createVerifiedAccountAndProfileInOpenTransaction({
        normalizedEmail: row.normalized_email,
        passwordHash: row.password_hash,
        displayName: row.display_name,
        gender: row.gender,
        visitorId: row.visitor_id ?? randomUUID(),
        pendingRegistrationId: row.pending_registration_id,
        // Registration-time IP/UA (row.*, captured в pending_registrations
        // при ПЪРВОНАЧАЛНОТО register() извикване) има приоритет пред
        // verify-time IP/UA (input.*, от самата /verify-registration-email
        // заявка) — site_visit_events трябва да отразява откъде реално Е
        // ВЪЗНИКНАЛА регистрацията (spec §"REGISTRATION FLOW": "запиши
        // visitor/profile history по същия начин, както успешната
        // registration го прави в момента"), не откъде е бил въведен кодът
        // (обикновено СЪЩОТО устройство/IP, но не гарантирано — напр. отворен
        // email клиент на друг device/мрежа). input.* остава fallback само
        // ако registration-time стойността по някаква причина липсва.
        ipAddress: row.ip_address ?? input.ipAddress,
        userAgent: row.user_agent ?? input.userAgent,
      })

      if ('conflict' in creationResult) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: creationResult.conflict === 'email_taken' ? 'email_taken' : 'display_name_taken' }
      }

      // Consume-on-success — DELETE ВЪТРЕ в СЪЩАТА транзакция като account
      // creation-а по-горе. Double-click/два конкурентни verify request-а:
      // BEGIN IMMEDIATE сериализира ги (SQLite single-writer) — вторият
      // request вижда реда вече изтрит (row === undefined по-горе) и връща
      // 'not_found', след като първият commit-не. Кодът вече никога не
      // може да се използва повторно (редът, в който живееше, вече го няма).
      deletePendingRegistrationByIdStatement.run(row.pending_registration_id)

      database.exec('COMMIT;')

      const session = createSession(creationResult.accountRow, creationResult.profileId, input.rememberMe)

      return { ok: true, ...session }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      return { ok: false, reason: 'not_found' }
    }
  }

  function updatePendingRegistrationDisplayName(input: {
    pendingRegistrationId: string
    displayName: string
    requiredCode?: string
    ipAddress: string | null
  }): UpdatePendingRegistrationDisplayNameResult {
    if (!isRegistrationSecretConfigured) {
      return { ok: false, reason: 'not_found' }
    }

    // Формат/reserved-name валидацията е ИДЕНТИЧНА на register()'s
    // displayNameResult проверка (СЪЩИЯТ validateProfileDisplayName) — не
    // разхлабваме правилата само защото сме на recovery пътя.
    const displayNameResult = validateProfileDisplayName(input.displayName)
    if (!displayNameResult.ok) {
      return { ok: false, reason: 'invalid_display_name', message: displayNameResult.message, code: displayNameResult.code }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')

      if (input.ipAddress !== null) {
        const limitedByIp = checkRegistrationRateLimit({
          scope: 'registration-update-name-ip',
          rawSubject: input.ipAddress,
          windowSeconds: PENDING_REGISTRATION_UPDATE_NAME_IP_WINDOW_SECONDS,
          maxEvents: PENDING_REGISTRATION_UPDATE_NAME_IP_MAX_PER_WINDOW,
        })
        if (limitedByIp) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'rate_limited' }
        }
      }

      const row = selectPendingRegistrationByIdStatement.get(input.pendingRegistrationId) as
        | PendingRegistrationRow
        | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_found' }
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        deletePendingRegistrationByIdStatement.run(row.pending_registration_id)
        database.exec('COMMIT;')
        return { ok: false, reason: 'expired' }
      }

      // PUBLIC LOCATOR модел — non-consuming code проверка, gated само когато
      // caller-ът (dedicated-page locator flow) подаде requiredCode.
      // СЪЩИЯТ pure verifyVerificationCode primitive и СЪЩИЯТ failed_attempts
      // budget/lockout като verifyRegistrationEmail() по-горе — грешен код тук
      // увеличава failed_attempts точно както грешен verify опит (споделен
      // anti-brute-force бюджет, не отделен unlimited-guess канал). Успешна
      // проверка НЕ трие реда/НЕ create-ва сесия/НЕ ресетва failed_attempts —
      // само отключва display_name UPDATE-а по-долу (row-ът остава pending,
      // потребителят verify-ва отново СЪС СЪЩИЯ код след успешния rename).
      if (input.requiredCode !== undefined) {
        if (row.failed_attempts >= PENDING_REGISTRATION_MAX_FAILED_ATTEMPTS) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'too_many_attempts' }
        }
        const codeIsValid = /^[0-9]{6}$/.test(input.requiredCode) && verifyVerificationCode(input.requiredCode, registrationSecret, row.code_hash)
        if (!codeIsValid) {
          incrementPendingRegistrationFailedAttemptsStatement.run(row.pending_registration_id)
          database.exec('COMMIT;')
          const attemptsRemaining = Math.max(0, PENDING_REGISTRATION_MAX_FAILED_ATTEMPTS - (row.failed_attempts + 1))
          return { ok: false, reason: 'invalid_code', attemptsRemaining }
        }
      }

      // FINAL PLAN v5 — cleanup на target името, ако друг (различен от ТОЗИ
      // ред) pending е вече expired, но все още физически заема
      // normalized_display_name-а, което щеше да произведе фалшив conflict
      // по-долу. Mirror на register()'s cleanup, но targeted само към новото
      // желано име, никога не пипа собствения ред на A.
      deleteExpiredPendingRegistrationByNormalizedNameStatement.run(displayNameResult.normalizedKey)

      // Best-effort (НЕ authoritative — mirror на register()'s early check
      // doc коментара) uniqueness срещу ЖИВИ profiles. Authoritative
      // re-check пак се случва в createVerifiedAccountAndProfileInOpenTransaction
      // при следващия verify опит.
      const nameConflict = nameConflictStatement.get(
        displayNameResult.normalizedKey,
        displayNameResult.normalizedKey,
      ) as { profile_id: string } | undefined
      if (nameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'display_name_taken' }
      }

      // FINAL PLAN v5 — authoritative pending↔pending check, excludeId =
      // СОБСТВЕНИЯ pending_registration_id (self-conflict е structurally
      // невъзможен/неправилен — редакцията на собственото си желано ново
      // име никога не бива да се самоблокира). Ако друга активна pending
      // регистрация вече държи целевото име -> ROLLBACK -> старото
      // normalized_display_name на ТОЗИ ред остава напълно непроменено,
      // защото UPDATE-ът долу изобщо не се изпълнява (виж
      // updatePendingRegistrationDisplayNameStatement doc коментара —
      // единичен write, никакъв release-then-claim прозорец).
      const pendingNameConflict = selectActivePendingReservationConflictStatement.get(
        displayNameResult.normalizedKey,
        row.pending_registration_id,
        row.pending_registration_id,
      ) as { pending_registration_id: string } | undefined
      if (pendingNameConflict !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'display_name_taken' }
      }

      // display_name + normalized_display_name — password_hash/code_hash/
      // failed_attempts/resend_count/last_code_sent_at/expires_at НЕ се
      // пипат (hardening pass §1: потребителят не губи нито кода, нито
      // 24-часовия прозорец). Единичен UPDATE statement — атомарно "премества"
      // reservation-а от старото към новото име на СЪЩИЯ ред.
      updatePendingRegistrationDisplayNameStatement.run(
        displayNameResult.canonicalDisplayName,
        displayNameResult.normalizedKey,
        row.pending_registration_id,
      )

      database.exec('COMMIT;')

      return { ok: true, maskedEmail: maskEmailForDisplay(row.normalized_email), expiresAt: row.expires_at }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      return { ok: false, reason: 'not_found' }
    }
  }

  // FINAL PLAN v5 — read-only, no DB write. Нормализира входа СЪЩАТА
  // canonical validateProfileDisplayName()/normalizedKey логика като
  // register()/updatePendingRegistrationDisplayName(), за да остане
  // consistency-та гарантирана (виж "Normalization consistency" от
  // investigation-а). Невалиден вход (не минава validation) -> връща false
  // (не "reserved") — самата availability проверка за такъв вход вече се
  // решава от playerProgressStore.isDisplayNameAvailable() (mirror поведение).
  function hasActivePendingRegistrationForDisplayName(
    displayName: string,
    excludePendingRegistrationId: string | null = null,
  ): boolean {
    const displayNameResult = validateProfileDisplayName(displayName)
    if (!displayNameResult.ok) return false
    const row = selectActivePendingReservationConflictStatement.get(
      displayNameResult.normalizedKey,
      excludePendingRegistrationId,
      excludePendingRegistrationId,
    ) as { pending_registration_id: string } | undefined
    return row !== undefined
  }

  function cancelPendingRegistration(pendingRegistrationId: string): { ok: true } {
    // Идемпотентно, bearer-capability модел (виж AuthStore.cancelPendingRegistration
    // doc коментара по-горе) — просто DELETE, без транзакция (единична
    // statement), без да разкрива дали редът реално е съществувал.
    try {
      deletePendingRegistrationByIdStatement.run(pendingRegistrationId)
    } catch {
      // best-effort — cancel никога не трябва да хвърли към caller-а
    }
    return { ok: true }
  }

  function login(input: {
    email: string
    password: string
    rememberMe: boolean
  }):
    | { ok: true; sessionToken: string; session: AuthSessionSnapshot }
    | { ok: false; message: string }
    | {
        ok: false
        code: 'PROFILE_BANNED'
        message: string
        bannedUntil: string
        reason: string
        remainingDays: number
      }
    | { ok: false; code: 'EMAIL_VERIFICATION_REQUIRED'; pendingRegistrationId: string; maskedEmail: string }
    | { ok: false; code: 'REGISTRATION_EXPIRED'; message: string } {
    const email = normalizeEmail(input.email)

    if (email === null) {
      return { ok: false, message: 'Невалиден email адрес.' }
    }

    const account = selectAccountByEmailStatement.get(email) as AccountRow | undefined

    if (!account || !verifyPassword(input.password, account.password_hash)) {
      // "Затваря сайта преди кода" сценарий (production report-а §"ЗАТВАРЯ
      // САЙТА ПРЕДИ КОДА"/"EXPIRED PENDING + LOGIN") — active account НЯМА
      // за този email (ако имаше, горният verifyPassword branch вече би
      // хванал грешна парола independent от pending). Разкриваме pending
      // registration състояние САМО ако подадената парола реално съвпада с
      // pending password_hash-а — non-enumeration за трети страни, които не
      // знаят паролата.
      if (!account) {
        const pendingRow = selectPendingRegistrationByEmailStatement.get(email) as
          | PendingRegistrationRow
          | undefined
        if (pendingRow !== undefined && verifyPassword(input.password, pendingRow.password_hash)) {
          const isExpired = new Date(pendingRow.expires_at).getTime() <= Date.now()
          if (isExpired) {
            // Opportunistic cleanup — освобождава email-а за чисто нова
            // регистрация (spec §"EXPIRED PENDING + LOGIN").
            deletePendingRegistrationByIdStatement.run(pendingRow.pending_registration_id)
            return {
              ok: false,
              code: 'REGISTRATION_EXPIRED',
              message: 'Регистрацията ви е изтекла. Моля, регистрирайте се отново.',
            }
          }
          return {
            ok: false,
            code: 'EMAIL_VERIFICATION_REQUIRED',
            pendingRegistrationId: pendingRow.pending_registration_id,
            maskedEmail: maskEmailForDisplay(pendingRow.normalized_email),
          }
        }
      }
      return { ok: false, message: 'Грешен email или парола.' }
    }

    if (account.status !== 'active') {
      return { ok: false, message: 'Профилът е деактивиран.' }
    }

    const profileIdRow = database.prepare(`
      SELECT profile_id
      FROM profiles
      WHERE account_id = ?
        AND profile_kind = 'human'
      ORDER BY created_at ASC
      LIMIT 1;
    `).get(account.account_id) as { profile_id: string } | undefined

    if (!profileIdRow) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }

    // Ban gate — ПРЕДИ нормалното допускане в authenticated app/session
    // (spec §5A), но СЛЕД валидиране на credentials (не изтичаме информация
    // за ban статус на грешна парола/несъществуващ email). Активен бан
    // напълно спира login-а — не се създава сесия.
    const activeBan = options.getActiveBanForProfile?.(profileIdRow.profile_id) ?? null
    if (activeBan !== null) {
      return {
        ok: false,
        code: 'PROFILE_BANNED',
        message: 'Профилът е баннат.',
        bannedUntil: activeBan.bannedUntil,
        reason: activeBan.reason,
        remainingDays: activeBan.remainingDays,
      }
    }

    return {
      ok: true,
      ...createSession(account, profileIdRow.profile_id, input.rememberMe),
    }
  }

  /** Общ SELECT+валидация за getSession/touchSession по-долу — самото fetch-ване не се променя от auth session-lifetime fix-а, само добавя (вече игнорираното от getSession) expires_at поле. */
  function fetchValidSessionRow(sessionToken: string | null): SessionRow | null {
    if (sessionToken === null) {
      return null
    }

    const row = selectSessionStatement.get(hashSessionToken(sessionToken)) as SessionRow | undefined
    return row ?? null
  }

  function toSessionSnapshot(row: SessionRow): AuthSessionSnapshot | null {
    if (row.status !== 'active') {
      return null
    }

    const profile = playerProgressStore.getPublicProfile(row.profile_id)

    if (profile === null) {
      return null
    }

    return {
      sessionId: row.session_id,
      account: toAccountSnapshot(row),
      profile,
    }
  }

  function getSession(sessionToken: string | null): AuthSessionSnapshot | null {
    const row = fetchValidSessionRow(sessionToken)
    return row === null ? null : toSessionSnapshot(row)
  }

  /**
   * Rolling/sliding session renewal (auth session-lifetime fix) —
   * ЕДИНСТВЕНИЯТ touch point е GET /api/auth/me (index.ts), викан от
   * клиента при всяко зареждане/посещение на сайта, докато е логнат
   * (main.ts's loadAuthSession()) — ТОВА се счита за "реална активност"
   * тук, съзнателно избрано пред "произволна authenticated API заявка":
   * (1) гарантирано се случва на всяко истинско посещение, независимо от
   * gameplay действия; (2) е нормален HTTP request/response цикъл, може
   * безопасно да носи нов Set-Cookie (за разлика от WS traffic/upgrade);
   * (3) избягва да се пипат десетки други route handlers. WebSocket
   * connect/traffic НЕ вика тази функция — той продължава да ползва чист
   * getSession() (read-only), затова сам по себе си никога не причинява DB
   * write, дори при интензивен gameplay трафик (spec explicit изискване).
   *
   * Идентична validation верига като getSession() (revoked_at IS NULL,
   * expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'), account
   * status='active', профил съществува) — НИКОГА не renew-ва сесия, която вече не е доказано
   * валидна по същите критерии; expired/revoked/непознат token просто
   * връщат {session:null, renewed:false}, идентично на getSession()-овия
   * null резултат.
   *
   * Throttled renewal — атомарен compare-and-swap на SQL ниво (виж
   * renewSessionStatement doc коментара за пълния concurrency rationale),
   * НЕ JS "if remaining lifetime < throttle, renew" decision преди UPDATE-а
   * (старата имплементация имаше TOCTOU race тук: concurrency/security
   * follow-up report доказа, че два конкурентни /api/auth/me за ЕДНА и
   * СЪЩА сесия — напр. два таба на един browser, или два PM2 process
   * instances, четящи стар expires_at ПРЕДИ първият commit-не UPDATE-а си
   * — биха довели и двата до renewed:true, два реални DB writes вместо
   * един). Сега JS само подава горната граница (renewalCutoffIso =
   * now + (TTL - THROTTLE)) като bind параметър — SQL WHERE клаузата сама
   * решава атомарно: само ПЪРВИЯТ UPDATE, който реално намери ред с
   * expires_at все още ≤ cutoff, matchва и получава changes=1; всеки друг
   * конкурентен UPDATE за СЪЩАТА сесия неизбежно вижда вече-обновения (far
   * in the future) expires_at и получава changes=0 — независимо от reда,
   * по който заявките са прочели "стария" ред. Максимум ~1 реален DB
   * write/сесия/throttle прозорец (1 ден), гарантирано от SQLite-овите
   * собствени transactional/serialization гаранции, не от JS timing.
   *
   * Existing 30-дневни сесии (стар TTL, преди тази промяна) се upgrade-ват
   * автоматично тук БЕЗ никаква специална логика/migration — cutoff
   * формулата разчита само на реално записания expires_at: за стара сесия
   * той е поне 59 дни по-кратък от новия 90-дневен прозорец (под cutoff-а),
   * значи renewal-ът винаги matchва при първия ѝ /api/auth/me след deploy
   * (ако сесията все още не е изтекла по старите 30 дни — иначе изобщо не
   * стига дотук, selectSessionStatement вече я е филтрирал).
   */
  function touchSession(sessionToken: string | null): { session: AuthSessionSnapshot | null; renewed: boolean; rememberMe: boolean } {
    const row = fetchValidSessionRow(sessionToken)
    if (row === null) {
      return { session: null, renewed: false, rememberMe: true }
    }

    const session = toSessionSnapshot(row)
    if (session === null) {
      return { session: null, renewed: false, rememberMe: true }
    }

    const renewalCutoffIso = new Date(Date.now() + (SESSION_TTL_MS - SESSION_RENEWAL_THROTTLE_MS)).toISOString()
    const result = renewSessionStatement.run(createIsoExpiresAt(), row.session_id, renewalCutoffIso) as { changes?: number }
    return { session, renewed: (result.changes ?? 0) > 0, rememberMe: row.remember_me !== 0 }
  }

  function changePassword(input: {
    accountId: string
    currentPassword: string
    newPassword: string
  }): { ok: true } | { ok: false; message: string } {
    const account = selectAccountByIdStatement.get(input.accountId) as AccountRow | undefined

    if (!account) {
      return { ok: false, message: 'Профилът не беше намерен.' }
    }

    if (!verifyPassword(input.currentPassword, account.password_hash)) {
      return { ok: false, message: 'Грешна текуща парола.' }
    }

    if (!validatePassword(input.newPassword)) {
      return { ok: false, message: 'Новата парола трябва да е поне 6 символа.' }
    }

    const newHash = createPasswordHash(input.newPassword)
    updatePasswordHashStatement.run(newHash, input.accountId)

    return { ok: true }
  }

  function logout(sessionToken: string | null): void {
    if (sessionToken === null) {
      return
    }

    revokeSessionStatement.run(hashSessionToken(sessionToken))
  }

  function revokeAllSessionsForProfile(profileId: string): number {
    const result = revokeAllSessionsForProfileStatement.run(profileId)
    return result.changes as number
  }

  function getAccountRoleForProfile(profileId: string): AccountRoleValue | null {
    const profileRow = selectProfileRoleEligibilityStatement.get(profileId) as
      | { account_id: string | null }
      | undefined

    if (!profileRow || profileRow.account_id === null) {
      return null
    }

    const accountRow = selectAccountByIdStatement.get(profileRow.account_id) as AccountRow | undefined
    return accountRow?.role ?? null
  }

  /**
   * Споделена имплементация за setSubadminRole/setChatAdminRole — двете
   * "елевирани" роли (subadmin, chat_admin) са взаимно изключващи се и имат
   * идентични защити (self/target-is-admin/grant-eligibility/idempotency/audit),
   * разликата е само коя стойност се пише в role колоната.
   *
   * fromRole се чете от РЕАЛНАТА текуща роля на акаунта (не се хардкодва
   * 'player'), за да поддържа директно превключване между subadmin ↔
   * chat_admin (grant на едната, докато акаунтът е другата, просто я
   * заменя — единична role колона, няма нужда от изричен revoke стъпка).
   * REVOKE изисква текущата роля да съвпада точно с input.role — опит за
   * revoke на роля, която акаунтът реално няма (напр. "revoke chat_admin"
   * върху subadmin акаунт), се отказва с 'conflict', вместо тихо да пипне
   * другата роля.
   */
  function changeElevatedRole(input: {
    actorAccountId: string
    targetProfileId: string
    role: ElevatedRole
    action: 'grant' | 'revoke'
  }): { ok: true; role: 'player' | ElevatedRole } | { ok: false; code: SubadminRoleChangeErrorCode; message: string } {
    const profileRow = selectProfileRoleEligibilityStatement.get(input.targetProfileId) as
      | { account_id: string | null; status: 'active' | 'disabled'; is_temporary: number }
      | undefined

    if (!profileRow) {
      return { ok: false, code: 'not_found', message: 'Профилът не беше намерен.' }
    }

    const targetAccountId = profileRow.account_id

    if (targetAccountId === null) {
      return {
        ok: false,
        code: 'no_account',
        message: 'Този потребител няма регистриран акаунт и не може да получи административна роля.',
      }
    }

    if (targetAccountId === input.actorAccountId) {
      return { ok: false, code: 'self', message: 'Не можеш да промениш собствената си роля.' }
    }

    const targetAccount = selectAccountByIdStatement.get(targetAccountId) as AccountRow | undefined

    if (!targetAccount) {
      return { ok: false, code: 'not_found', message: 'Акаунтът не беше намерен.' }
    }

    if (targetAccount.role === 'admin') {
      return {
        ok: false,
        code: 'target_is_admin',
        message: 'Не можеш да промениш ролята на друг администратор.',
      }
    }

    // Одобрено продуктово решение: елевирана роля може да бъде НАЗНАЧЕНА само
    // на активен, постоянен човешки профил със свързан активен акаунт. REVOKE
    // остава разрешен независимо от статуса — пълният admin трябва винаги
    // да може да премахне правата, дори ако профилът/акаунтът вече е
    // деактивиран междувременно. Автоматично отнемане при деактивиране НЕ се
    // прави тук — извън обхвата на тази проверка (умишлено, отделно решение).
    // Проверките важат безусловно за всеки grant (дори "идемпотентен" повторен
    // grant на вече-същата роля) — запазва точното досегашно поведение.
    if (input.action === 'grant') {
      if (profileRow.is_temporary === 1) {
        return {
          ok: false,
          code: 'profile_temporary',
          message: `Не можеш да направиш временен профил ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : input.role === 'top_chat_admin' ? 'TOP чат админ' : 'субадмин'
          }.`,
        }
      }

      if (profileRow.status !== 'active') {
        return {
          ok: false,
          code: 'profile_inactive',
          message: `Не можеш да направиш неактивен профил ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : input.role === 'top_chat_admin' ? 'TOP чат админ' : 'субадмин'
          }.`,
        }
      }

      if (targetAccount.status !== 'active') {
        return {
          ok: false,
          code: 'account_inactive',
          message: `Не можеш да направиш неактивен акаунт ${
            input.role === 'chat_admin' ? 'чат админ' : input.role === 'pika_team' ? 'Екип Pika.bg' : input.role === 'top_chat_admin' ? 'TOP чат админ' : 'субадмин'
          }.`,
        }
      }
    }

    const currentRole = targetAccount.role

    if (input.action === 'grant' && currentRole === input.role) {
      // Идемпотентно повторение — вече е в желаната роля, без нов audit ред.
      return { ok: true, role: input.role }
    }

    if (input.action === 'revoke' && currentRole === 'player') {
      // Идемпотентно повторение — вече е обикновен player.
      return { ok: true, role: 'player' }
    }

    if (input.action === 'revoke' && currentRole !== input.role) {
      // Акаунтът реално има ДРУГАТА елевирана роля (напр. опит за
      // "revoke chat_admin" върху subadmin акаунт) — отказваме, не пипаме
      // чуждата роля мълчаливо.
      return {
        ok: false,
        code: 'conflict',
        message: 'Ролята на потребителя е променена междувременно. Презареди и опитай пак.',
      }
    }

    const fromRole = currentRole
    const toRole: 'player' | ElevatedRole = input.action === 'grant' ? input.role : 'player'
    const auditAction = `${input.action}_${input.role}` as
      | 'grant_subadmin' | 'revoke_subadmin'
      | 'grant_chat_admin' | 'revoke_chat_admin'
      | 'grant_pika_team' | 'revoke_pika_team'
      | 'grant_top_chat_admin' | 'revoke_top_chat_admin'

    database.exec('BEGIN IMMEDIATE;')

    try {
      const changeResult = conditionalUpdateAccountRoleStatement.run(toRole, targetAccountId, fromRole)

      if (changeResult.changes === 0) {
        // Състоянието се е променило между прочита по-горе и тази транзакция
        // (race) — прочитаме текущата роля вътре в същата транзакция, за да
        // върнем коректен резултат без частична промяна в базата.
        const currentAccount = selectAccountByIdStatement.get(targetAccountId) as AccountRow
        database.exec('ROLLBACK;')

        if (currentAccount.role === toRole) {
          return { ok: true, role: toRole }
        }

        if (currentAccount.role === 'admin') {
          return {
            ok: false,
            code: 'target_is_admin',
            message: 'Не можеш да промениш ролята на друг администратор.',
          }
        }

        return {
          ok: false,
          code: 'conflict',
          message: 'Ролята на потребителя е променена междувременно. Презареди и опитай пак.',
        }
      }

      insertAdminRoleAuditLogStatement.run(
        randomUUID(),
        input.actorAccountId,
        targetAccountId,
        auditAction,
        fromRole,
        toRole,
      )

      database.exec('COMMIT;')

      return { ok: true, role: toRole }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure and surface the original error
      }

      throw error
    }
  }

  function setSubadminRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): SubadminRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'subadmin' }) as SubadminRoleChangeResult
  }

  function setChatAdminRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): ChatAdminRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'chat_admin' }) as ChatAdminRoleChangeResult
  }

  function setPikaTeamRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): PikaTeamRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'pika_team' }) as PikaTeamRoleChangeResult
  }

  function setTopChatAdminRole(input: {
    actorAccountId: string
    targetProfileId: string
    action: 'grant' | 'revoke'
  }): TopChatAdminRoleChangeResult {
    return changeElevatedRole({ ...input, role: 'top_chat_admin' }) as TopChatAdminRoleChangeResult
  }

  function close(): void {
    database.close()
  }

  return {
    register,
    resendRegistrationVerificationCode,
    getPendingRegistrationVerificationStatus,
    verifyRegistrationEmail,
    updatePendingRegistrationDisplayName,
    hasActivePendingRegistrationForDisplayName,
    cancelPendingRegistration,
    login,
    changePassword,
    getSession,
    touchSession,
    logout,
    revokeAllSessionsForProfile,
    setSubadminRole,
    setChatAdminRole,
    setPikaTeamRole,
    setTopChatAdminRole,
    getAccountRoleForProfile,
    close,
  }
}
