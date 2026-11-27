/**
 * checkSvaraMatchEndPopup.ts — прозорците при отпадане и край на мача в
 * „Свара“ (27.11.2026): кой прозорец (само от сървърните данни), наградата
 * (само от table.payout) и HTML-ът (без случайност — еднакъв при повторни
 * съобщения; анимации само при първо показване).
 *
 * Пускане: npx tsx scripts/checkSvaraMatchEndPopup.ts
 */

import { renderSvaraMatchEndPopupHtml, resolveSvaraMatchEndOutcome } from '../src/app/games/svara/table/svaraMatchEndPopup'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`  PASS  ${name}`) } else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const ME = 'me'
type Result = { finished: boolean; winnerId: string | null; aborted?: boolean; message?: string | null }
function snap(status: string, result: Result, lastRoundParticipants: string[] | null = [ME, 'b']) {
  return {
    matchId: 'm1',
    you: { status },
    result: { finished: result.finished, closed: false, winnerId: result.winnerId, aborted: result.aborted ?? false, reason: null, message: result.message ?? null },
    history: { recent: lastRoundParticipants ? [{ participants: lastRoundParticipants }] : [] },
  } as never
}
function table(payout?: { status: 'paid' | 'held' | 'pending' | 'refunded'; winnerId: string | null; amount: number | null }) {
  return { matchId: 'm1', ...(payout ? { payout } : {}) } as never
}
const resolve = (snapshot: never, t: never = table(), eliminatedEarlier = false) => resolveSvaraMatchEndOutcome({ snapshot, table: t, localProfileId: ME, eliminatedEarlier })

console.log('\n[1] Кой прозорец')
check('мачът тече, играчът е активен → без прозорец', resolve(snap('active', { finished: false, winnerId: null })) === null)
check('мачът тече, играчът отпадна → „Играта приключи за вас!“', resolve(snap('eliminated', { finished: false, winnerId: null }))?.kind === 'eliminated')
check('край, победител → победа', resolve(snap('active', { finished: true, winnerId: ME }))?.kind === 'winner')
check('край, загуба в последното раздаване (последните двама) → загуба', resolve(snap('eliminated', { finished: true, winnerId: 'b' }))?.kind === 'loss')
check('край, отпаднал по-рано (не е в последното раздаване) → без втори прозорец за загуба', resolve(snap('eliminated', { finished: true, winnerId: 'b' }, ['b', 'c']))?.kind === 'eliminated')
check('край, вече видял отпадането в сесията → без втори прозорец за загуба', resolve(snap('eliminated', { finished: true, winnerId: 'b' }), table(), true)?.kind === 'eliminated')
check('край, победа поради отсъствие → победа + реалната причина', (() => { const o = resolve(snap('active', { finished: true, winnerId: ME, message: 'Победа поради продължително отсъствие на противниците' })); return o?.kind === 'winner' && o.note === 'Победа поради продължително отсъствие на противниците' })())
check('край, загуба поради отсъствие → загуба + реалната причина', (() => { const o = resolve(snap('absent', { finished: true, winnerId: 'b', message: 'Победа поради продължително отсъствие на противниците' })); return o?.kind === 'loss' && o.note !== null })())
check('прекратен мач без победител → реалната причина вместо „не успяхте да победите“', (() => { const o = resolve(snap('absent', { finished: true, winnerId: null, aborted: true, message: 'Мачът е прекратен, защото всички играчи отсъстват' })); return o?.kind === 'loss' && o.body.startsWith('Мачът е прекратен') })())

console.log('\n[2] Наградата — само сървърният финансов резултат')
const prize = (t: never) => { const o = resolve(snap('active', { finished: true, winnerId: ME }), t); return o?.kind === 'winner' ? o.prize : 'n/a' }
check('изплатена на мен → „Спечелихте“ с реалната сума', JSON.stringify(prize(table({ status: 'paid', winnerId: ME, amount: 48_000 }))) === JSON.stringify({ status: 'paid', amount: 48_000 }))
check('задържана → без сума като изплатена', JSON.stringify(prize(table({ status: 'held', winnerId: null, amount: null }))) === JSON.stringify({ status: 'held' }))
check('неуредена → „обработва се“, без сума', JSON.stringify(prize(table({ status: 'pending', winnerId: null, amount: null }))) === JSON.stringify({ status: 'pending' }))
check('изплатена на друг (несъответствие) → без сума', JSON.stringify(prize(table({ status: 'paid', winnerId: 'b', amount: 48_000 }))) === JSON.stringify({ status: 'pending' }))
check('неплатен (тестов) мач → без награда', prize(table()) === null)

console.log('\n[3] HTML')
const winnerPaid = resolve(snap('active', { finished: true, winnerId: ME }), table({ status: 'paid', winnerId: ME, amount: 48_000 }))!
const htmlA = renderSvaraMatchEndPopupHtml(winnerPaid, { animate: true, leavePending: false })
const htmlB = renderSvaraMatchEndPopupHtml(winnerPaid, { animate: true, leavePending: false })
check('детерминиран (еднакъв при повторни съобщения — без повторно създаване/анимация)', htmlA === htmlB)
check('победа: „Играта завърши!“, „Вие сте победител!“, „Спечелихте 48 000 жълтици“, купа, конфети', htmlA.includes('Играта завърши!') && htmlA.includes('Вие сте победител!') && htmlA.includes('Спечелихте') && htmlA.includes('48') && htmlA.includes('sme-trophy') && htmlA.includes('sme-confetti'))
check('анимации само при първо показване (без конфети и data-sme-animate="0" след това)', (() => { const h = renderSvaraMatchEndPopupHtml(winnerPaid, { animate: false, leavePending: false }); return h.includes('data-sme-animate="0"') && !h.includes('sme-confetti"') })())
const held = renderSvaraMatchEndPopupHtml(resolve(snap('active', { finished: true, winnerId: ME }), table({ status: 'held', winnerId: null, amount: null }))!, { animate: false, leavePending: false })
check('задържана: без „Спечелихте“ и без сума', !held.includes('Спечелихте') && held.includes('ще бъде изплатена след потвърждение'))
const unpaid = renderSvaraMatchEndPopupHtml(resolve(snap('active', { finished: true, winnerId: ME }))!, { animate: false, leavePending: false })
check('неплатен мач: без ред за награда', !unpaid.includes('class="sme-prize') && !unpaid.includes('data-svara-match-end-prize'))
const elim = renderSvaraMatchEndPopupHtml({ kind: 'eliminated' }, { animate: false, leavePending: false })
check('отпадане: „Играта приключи за вас!“ и „Отпаднахте от играта. Останалите участници продължават.“, без „Играта завърши!“', elim.includes('Играта приключи за вас!') && elim.includes('Отпаднахте от играта. Останалите участници продължават.') && !elim.includes('Играта завърши!'))
const loss = renderSvaraMatchEndPopupHtml(resolve(snap('eliminated', { finished: true, winnerId: 'b' }))!, { animate: false, leavePending: false })
check('загуба: „Играта завърши!“ и „Този път не успяхте да победите. Успех в следващата игра!“', loss.includes('Играта завърши!') && loss.includes('Този път не успяхте да победите. Успех в следващата игра!'))
check('„Към лобито“ е съществуващият изход (data-svara-result-exit) във всички прозорци', [htmlA, held, elim, loss].every((h) => h.includes('data-svara-result-exit="1"') && h.includes('Към лобито')))
check('при изпратен изход бутонът е неактивен („Излизане…“)', renderSvaraMatchEndPopupHtml({ kind: 'eliminated' }, { animate: false, leavePending: true }).includes('Излизане…'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
