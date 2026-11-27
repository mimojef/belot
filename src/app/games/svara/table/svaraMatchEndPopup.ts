// Свара — прозорците при отпадане и край на мача (27.11.2026). Само
// представяне: изходът идва от сървърните данни (snapshot.you.status,
// result.finished/winnerId/aborted/message и финансовия резултат на масата
// table.payout); бутонът „Към лобито“ е съществуващият изход
// (data-svara-result-exit → leave_svara_table).
//
//   • 'eliminated' — играчът е отпаднал, мачът продължава (или е отпаднал
//     по-рано в вече приключил мач — тогава не се показва втори прозорец).
//   • 'loss'       — мачът приключи, играчът не е победител.
//   • 'winner'     — мачът приключи, играчът е победител.
//
// Наградата е САМО сървърната (table.payout): „Спечелихте X жълтици“ —
// единствено при изплатена ('paid') награда към този играч; задържана или
// още неуредена — без сума като изплатена; неплатен мач — без награда.

import type { SvaraMatchSnapshotMessage, SvaraPublicTable } from '../../../network/createGameServerClient'

export type SvaraMatchEndPrize =
  | { status: 'paid'; amount: number }
  | { status: 'held' | 'pending' | 'refunded' }
  | null

export type SvaraMatchEndOutcome =
  | { kind: 'eliminated' }
  | { kind: 'loss'; body: string; note: string | null }
  | { kind: 'winner'; prize: SvaraMatchEndPrize; note: string | null }

const LOSS_TEXT = 'Този път не успяхте да победите. Успех в следващата игра!'

/**
 * Кой прозорец да се покаже (null — никакъв). eliminatedEarlier — в тази
 * сесия вече е показан прозорецът за отпадане за този мач.
 */
export function resolveSvaraMatchEndOutcome(input: {
  snapshot: SvaraMatchSnapshotMessage | null
  table: SvaraPublicTable
  localProfileId: string
  eliminatedEarlier?: boolean
}): SvaraMatchEndOutcome | null {
  const { snapshot, table, localProfileId } = input
  if (!snapshot || snapshot.matchId !== table.matchId) return null
  const me = localProfileId
  const eliminated = snapshot.you.status === 'eliminated'
  if (!snapshot.result.finished) return eliminated ? { kind: 'eliminated' } : null
  const message = snapshot.result.message?.trim() || null
  if (snapshot.result.winnerId === me) return { kind: 'winner', prize: winnerPrize(table, me), note: message }
  // Отпаднал по-рано (не е участвал в последното раздаване или вече е видял
  // прозореца за отпадане) — без втори прозорец за загуба.
  const lastRound = snapshot.history.recent.at(-1) ?? null
  const eliminatedBeforeLastRound = eliminated && lastRound !== null && !lastRound.participants.includes(me)
  if (input.eliminatedEarlier || eliminatedBeforeLastRound) return { kind: 'eliminated' }
  // Прекратен мач без победител — реалната причина вместо „не успяхте да победите“.
  if (snapshot.result.aborted && message) return { kind: 'loss', body: message, note: null }
  return { kind: 'loss', body: LOSS_TEXT, note: message }
}

function winnerPrize(table: SvaraPublicTable, me: string): SvaraMatchEndPrize {
  const payout = table.payout
  if (!payout) return null // неплатен (тестов) мач — без награда
  if (payout.status === 'paid') {
    return payout.winnerId === me && typeof payout.amount === 'number' && Number.isSafeInteger(payout.amount) && payout.amount > 0
      ? { status: 'paid', amount: payout.amount }
      : { status: 'pending' }
  }
  return { status: payout.status }
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)
const amountFormatter = new Intl.NumberFormat('bg-BG', { useGrouping: 'always' })

/** Колко дълго (ms) след първото показване прозорецът се рисува с анимации. */
export const SVARA_MATCH_END_ANIMATION_MS = 3_600

const svg = (body: string, size: number, extra = '') => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false" ${extra}>${body}</svg>`

// Отпадане: вратичка със стрелка навън — неутрално „излизане от играта“.
const ICON_ELIMINATED = svg(`<rect x="14" y="10" width="26" height="44" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="34" cy="33" r="2.6" fill="currentColor"/><path d="M40 32h16M49 24l8 8-8 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`, 44)
// Загуба: четирилистна детелина — „успех следващия път“.
const ICON_LOSS = svg(`<g fill="currentColor"><circle cx="24" cy="24" r="10"/><circle cx="40" cy="24" r="10"/><circle cx="24" cy="38" r="10"/><circle cx="40" cy="38" r="10"/></g><path d="M32 33c2 8 6 15 13 20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>`, 44)
// Победа: голяма златна купа.
const ICON_TROPHY = `<svg class="sme-trophy-svg" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="smeGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4C2"/><stop offset=".45" stop-color="#F6C744"/><stop offset="1" stop-color="#C98A10"/></linearGradient>
    <linearGradient id="smeGoldDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8B23A"/><stop offset="1" stop-color="#9A6406"/></linearGradient>
  </defs>
  <path d="M26 14h44v18c0 14-9 25-22 27-13-2-22-13-22-27z" fill="url(#smeGold)" stroke="#8F5E07" stroke-width="2"/>
  <path d="M26 20H14c0 12 6 20 15 22M70 20h12c0 12-6 20-15 22" fill="none" stroke="url(#smeGoldDark)" stroke-width="6" stroke-linecap="round"/>
  <path d="M42 58h12v12H42z" fill="url(#smeGoldDark)"/>
  <rect x="30" y="70" width="36" height="10" rx="3" fill="url(#smeGold)" stroke="#8F5E07" stroke-width="2"/>
  <rect x="24" y="80" width="48" height="8" rx="3" fill="url(#smeGoldDark)"/>
  <path d="M48 24l3.4 7 7.6 1.1-5.5 5.3 1.3 7.6L48 41.4 41.2 45l1.3-7.6-5.5-5.3 7.6-1.1z" fill="#FFFBEA" opacity=".9"/>
  <path d="M33 18c0 10 2 18 7 24" fill="none" stroke="#FFFBEA" stroke-width="3" stroke-linecap="round" opacity=".55"/>
</svg>`
const COIN = '<img src="/assets/lobby/icon-coin.png" alt="" aria-hidden="true" class="sme-coin">'

const CONFETTI_COLORS = ['#F6C744', '#7CF15A', '#A78BFA', '#F472B6', '#38BDF8', '#FDE68A']
function confettiHtml(): string {
  // Детерминистично (без Math.random) — еднакъв HTML при всяко прерисуване.
  return Array.from({ length: 28 }, (_, i) => {
    const left = (i * 37) % 100
    const delay = (i % 7) * 0.12
    const duration = 1.9 + ((i * 13) % 9) / 10
    const rotate = (i * 47) % 360
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const shape = i % 3 === 0 ? 'border-radius:50%;width:7px;height:7px;' : 'width:6px;height:11px;border-radius:2px;'
    return `<i style="left:${left}%;${shape}background:${color};animation-delay:${delay}s;animation-duration:${duration}s;--sme-r:${rotate}deg;"></i>`
  }).join('')
}

const CSS = `
  .sme-overlay { position:absolute; inset:0; z-index:45; display:grid; place-items:center; padding:12px; box-sizing:border-box;
    background:radial-gradient(70% 60% at 50% 45%, rgba(40,20,90,.55) 0%, rgba(3,2,10,.82) 100%); overflow:auto; font-family:inherit; }
  .sme-card { position:relative; box-sizing:border-box; width:min(100%, 420px); max-height:100%; overflow:auto; text-align:center;
    padding:26px 24px 22px; border-radius:24px; color:#F3EEFF;
    background:radial-gradient(120% 55% at 50% 0%, rgba(124,58,237,.34) 0%, rgba(124,58,237,0) 65%), linear-gradient(180deg,#1E1438 0%,#140D27 100%);
    border:1.5px solid rgba(239,194,90,.6); box-shadow:inset 0 0 0 1px rgba(167,139,250,.16), 0 24px 70px rgba(0,0,0,.65), 0 0 40px rgba(124,58,237,.22); }
  .sme-icon { width:84px; height:84px; margin:0 auto 14px; border-radius:50%; display:grid; place-items:center; }
  .sme-title { margin:0; font-size:26px; font-weight:900; line-height:1.15; letter-spacing:0; }
  .sme-text { margin:10px auto 0; max-width:320px; font-size:15px; font-weight:600; line-height:1.45; color:rgba(237,233,254,.8); }
  .sme-note { margin:12px auto 0; max-width:320px; font-size:13px; font-weight:700; line-height:1.4; color:#F4CB62; }
  .sme-btn { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:52px; margin-top:20px; border-radius:14px; border:1px solid rgba(255,236,170,.9);
    background:linear-gradient(180deg,#FDE59A 0%,#F2C14E 45%,#D69417 100%); color:#1A1200; font-family:inherit; font-size:18px; font-weight:900; cursor:pointer;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.6), 0 4px 0 #8F620A, 0 10px 22px rgba(217,154,28,.3); }
  .sme-btn:disabled { opacity:.6; cursor:wait; }
  .sme-btn:focus-visible { outline:2px solid #C4B5FD; outline-offset:3px; }

  /* Отпадане — неутрално */
  .sme-eliminated .sme-icon { background:rgba(167,139,250,.14); color:#C4B5FD; box-shadow:inset 0 0 0 2px rgba(167,139,250,.35); }
  .sme-eliminated .sme-title { color:#EDE9FE; }
  /* Загуба — приятно, ненатрапчиво */
  .sme-loss .sme-icon { background:rgba(124,241,90,.10); color:#86EFAC; box-shadow:inset 0 0 0 2px rgba(124,241,90,.32); }
  .sme-loss .sme-title { color:#F6D27A; }
  /* Победа — тържествено */
  .sme-winner { padding-top:18px; border-color:#F4CB62; box-shadow:inset 0 0 0 1px rgba(244,203,98,.25), 0 24px 70px rgba(0,0,0,.65), 0 0 60px rgba(244,203,98,.28); overflow:hidden; }
  .sme-trophy { position:relative; width:150px; height:150px; margin:0 auto 4px; display:grid; place-items:center; }
  .sme-trophy::before { content:""; position:absolute; inset:-10px; border-radius:50%;
    background:radial-gradient(circle, rgba(255,226,120,.55) 0%, rgba(255,226,120,.14) 45%, rgba(255,226,120,0) 70%); }
  .sme-trophy-svg { position:relative; width:128px; height:128px; filter:drop-shadow(0 8px 14px rgba(0,0,0,.45)); }
  .sme-winner .sme-title { font-size:22px; color:#EDE9FE; }
  .sme-winner-accent { margin:6px 0 0; font-size:30px; font-weight:900; line-height:1.1;
    background:linear-gradient(180deg,#FFF3CF 0%,#F4CB62 55%,#D99A1C 100%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:#F6D27A; }
  .sme-prize { display:inline-flex; flex-direction:column; align-items:center; gap:2px; margin-top:16px; padding:12px 22px; border-radius:18px;
    background:linear-gradient(180deg, rgba(22,163,74,.22) 0%, rgba(22,163,74,.10) 100%); border:1.5px solid rgba(124,241,90,.55); box-shadow:0 0 22px rgba(124,241,90,.18); }
  .sme-prize-label { font-size:13px; font-weight:800; color:#BBF7D0; }
  .sme-prize-amount { display:inline-flex; align-items:center; gap:8px; font-size:30px; font-weight:900; color:#7CF15A; font-variant-numeric:tabular-nums; text-shadow:0 0 16px rgba(124,241,90,.35); white-space:nowrap; }
  .sme-prize-amount small { font-size:16px; font-weight:800; color:#BBF7D0; }
  .sme-coin { width:26px; height:26px; object-fit:contain; display:block; }
  .sme-prize-status { margin-top:14px; font-size:14px; font-weight:700; line-height:1.4; color:#FDE68A; }
  .sme-confetti { position:absolute; inset:0; pointer-events:none; overflow:hidden; border-radius:inherit; }
  .sme-confetti i { position:absolute; top:-14px; display:block; opacity:0; }

  /* Анимации — само първия път (data-sme-animate="1") */
  [data-sme-animate="1"] .sme-card { animation:sme-pop .32s cubic-bezier(.2,.9,.3,1.2) both; }
  [data-sme-animate="1"].sme-overlay { animation:sme-fade .25s ease-out both; }
  [data-sme-animate="1"] .sme-eliminated .sme-icon, [data-sme-animate="1"] .sme-loss .sme-icon { animation:sme-rise .5s .1s ease-out both; }
  [data-sme-animate="1"] .sme-trophy-svg { animation:sme-trophy .7s .05s cubic-bezier(.2,.9,.3,1.3) both; }
  [data-sme-animate="1"] .sme-trophy::before { animation:sme-glow 1.6s .2s ease-in-out 2 both; }
  [data-sme-animate="1"] .sme-prize { animation:sme-rise .45s .45s ease-out both; }
  [data-sme-animate="1"] .sme-confetti i { animation-name:sme-confetti; animation-timing-function:cubic-bezier(.3,.6,.5,1); animation-fill-mode:both; }
  @keyframes sme-fade { from { opacity:0; } to { opacity:1; } }
  @keyframes sme-pop { from { opacity:0; transform:translateY(14px) scale(.94); } to { opacity:1; transform:none; } }
  @keyframes sme-rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @keyframes sme-trophy { 0% { opacity:0; transform:scale(.5) rotate(-8deg); } 70% { opacity:1; transform:scale(1.08) rotate(2deg); } 100% { transform:none; } }
  @keyframes sme-glow { 0%,100% { opacity:.65; transform:scale(.92); } 50% { opacity:1; transform:scale(1.06); } }
  @keyframes sme-confetti { 0% { opacity:0; transform:translateY(0) rotate(0); } 10% { opacity:1; } 100% { opacity:0; transform:translateY(520px) rotate(var(--sme-r)); } }
  @media (prefers-reduced-motion: reduce) { [data-sme-animate="1"] * , [data-sme-animate="1"].sme-overlay { animation:none !important; } .sme-confetti { display:none; } }

  /* Мобилен (светлолилав) вариант */
  @media (max-width: 767px), (max-height: 520px) {
    .sme-overlay { background:rgba(30,14,78,.55); padding:10px; }
    .sme-card { width:min(100%, 360px); padding:22px 18px 18px; color:#1C1442;
      background:radial-gradient(120% 60% at 50% 0%, #FFFFFF 0%, rgba(255,255,255,0) 60%), linear-gradient(180deg,#F6F1FF 0%,#EEE6FE 50%,#E6DBFC 100%);
      border:1.5px solid rgba(214,170,56,.75); box-shadow:inset 0 0 0 1px rgba(255,255,255,.75), 0 20px 50px rgba(30,10,90,.4); }
    .sme-title { font-size:23px; }
    .sme-text { color:#4A4370; font-size:14.5px; }
    .sme-note { color:#9A6406; }
    .sme-eliminated .sme-icon { background:#EDE7FF; color:#6941C6; box-shadow:inset 0 0 0 2px #D9CCFF; }
    .sme-eliminated .sme-title { color:#1C1442; }
    .sme-loss .sme-icon { background:#E7F8EC; color:#16A34A; box-shadow:inset 0 0 0 2px #BBF7D0; }
    .sme-loss .sme-title { color:#1C1442; }
    .sme-winner { border-color:#E7B53C; box-shadow:inset 0 0 0 1px rgba(255,255,255,.75), 0 20px 50px rgba(30,10,90,.4), 0 0 40px rgba(244,203,98,.35); }
    .sme-winner .sme-title { color:#1C1442; font-size:20px; }
    .sme-winner-accent { font-size:27px; background:linear-gradient(180deg,#E7A817 0%,#B7790A 100%); -webkit-background-clip:text; background-clip:text; }
    .sme-trophy { width:128px; height:128px; }
    .sme-trophy-svg { width:110px; height:110px; }
    .sme-prize { background:linear-gradient(180deg,#ECFDF3 0%,#DCFCE7 100%); border-color:#86EFAC; box-shadow:0 4px 14px rgba(22,163,74,.18); }
    .sme-prize-label { color:#15803D; }
    .sme-prize-amount { color:#16A34A; font-size:28px; text-shadow:none; }
    .sme-prize-amount small { color:#15803D; }
    .sme-prize-status { color:#9A6406; }
    .sme-btn { height:50px; font-size:17px; color:#FFFFFF; border:1px solid rgba(214,170,56,.85);
      background:linear-gradient(180deg,#9473F2 0%,#7950E8 52%,#5B2BC4 100%); box-shadow:inset 0 1px 0 rgba(255,255,255,.38), 0 3px 0 #4F2BB8, 0 8px 16px rgba(79,43,184,.32); }
  }
  @media (max-height: 520px) {
    .sme-card { padding-top:14px; padding-bottom:14px; }
    .sme-icon { width:60px; height:60px; margin-bottom:8px; }
    .sme-icon svg { width:32px; height:32px; }
    .sme-trophy { width:96px; height:96px; }
    .sme-trophy-svg { width:84px; height:84px; }
    .sme-btn { margin-top:12px; height:44px; }
  }
`

function prizeHtml(prize: SvaraMatchEndPrize): string {
  if (prize === null) return ''
  if (prize.status === 'paid') {
    return `<div class="sme-prize" data-svara-match-end-prize="${prize.amount}">
        <span class="sme-prize-label">Спечелихте</span>
        <span class="sme-prize-amount">${COIN}${esc(amountFormatter.format(prize.amount))} <small>жълтици</small></span>
      </div>`
  }
  const text = prize.status === 'held' ? 'Наградата се проверява и ще бъде изплатена след потвърждение.'
    : prize.status === 'pending' ? 'Изплащането на наградата се обработва.'
    : 'Входовете бяха върнати.'
  return `<div class="sme-prize-status" data-svara-match-end-prize-status="${prize.status}">${esc(text)}</div>`
}

/** HTML на прозореца. Еднакъв при всяко прерисуване със същите данни (без случайност). */
export function renderSvaraMatchEndPopupHtml(outcome: SvaraMatchEndOutcome, options: { animate: boolean; leavePending: boolean }): string {
  const button = `<button type="button" class="sme-btn" data-svara-result-exit="1" ${options.leavePending ? 'disabled' : ''}>${options.leavePending ? 'Излизане…' : 'Към лобито'}</button>`
  let card: string
  if (outcome.kind === 'eliminated') {
    card = `<div class="sme-card sme-eliminated" role="dialog" aria-modal="true" aria-labelledby="sme-title">
        <div class="sme-icon">${ICON_ELIMINATED}</div>
        <h2 class="sme-title" id="sme-title">Играта приключи за вас!</h2>
        <p class="sme-text">Отпаднахте от играта. Останалите участници продължават.</p>
        ${button}
      </div>`
  } else if (outcome.kind === 'loss') {
    card = `<div class="sme-card sme-loss" role="dialog" aria-modal="true" aria-labelledby="sme-title">
        <div class="sme-icon">${ICON_LOSS}</div>
        <h2 class="sme-title" id="sme-title">Играта завърши!</h2>
        <p class="sme-text">${esc(outcome.body)}</p>
        ${outcome.note ? `<p class="sme-note">${esc(outcome.note)}</p>` : ''}
        ${button}
      </div>`
  } else {
    card = `<div class="sme-card sme-winner" role="dialog" aria-modal="true" aria-labelledby="sme-title">
        ${options.animate ? `<div class="sme-confetti" aria-hidden="true">${confettiHtml()}</div>` : ''}
        <div class="sme-trophy">${ICON_TROPHY}</div>
        <h2 class="sme-title" id="sme-title">Играта завърши!</h2>
        <p class="sme-winner-accent">Вие сте победител!</p>
        ${prizeHtml(outcome.prize)}
        ${outcome.note ? `<p class="sme-note">${esc(outcome.note)}</p>` : ''}
        ${button}
      </div>`
  }
  return `<div class="sme-overlay" data-svara-result-banner="1" data-svara-match-end="${outcome.kind}" data-sme-animate="${options.animate ? '1' : '0'}">
      <style>${CSS}</style>
      ${card}
    </div>`
}
