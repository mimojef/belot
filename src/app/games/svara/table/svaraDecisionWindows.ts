import type {
  SvaraMatchSnapshotMessage, SvaraMatchTimingMessage, SvaraParticipantCommand, SvaraSnapshotRound,
} from '../../../network/createGameServerClient'

export type SvaraDecisionAction = 'join' | 'decline' | 'reveal' | 'hide'
export type SvaraDecisionWindow = {
  key: string
  kind: 'joining' | 'reveal'
  title: string
  fee: number | null
  remainingMs: number
  totalMs: number
  actions: Array<{ kind: SvaraDecisionAction; label: string; command: SvaraParticipantCommand }>
}

export const SVARA_JOINING_STATUS_LABEL = {
  undecided: 'ИЗЧАКВА СЕ', joined: 'ВКЛЮЧВА СЕ', declined: 'ПРОПУСКА',
} as const

export function svaraJoiningStatus(round: SvaraSnapshotRound | null, playerId: string): string | null {
  if (round?.kind !== 'svara-joining') return null
  // Missing data from an older server never becomes a guessed decision.
  const decision = round.decisions?.find((entry) => entry.playerId === playerId)
  return decision ? SVARA_JOINING_STATUS_LABEL[decision.status] : null
}

/** No local game timers or eligibility rules: require the individual server
 * permission and the corresponding absolute deadline for this revision. */
export function getSvaraDecisionWindow(snapshot: SvaraMatchSnapshotMessage | null,
  timing: SvaraMatchTimingMessage | null, serverNow: number, localProfileId: string): SvaraDecisionWindow | null {
  if (!snapshot || snapshot.phase !== 'in-progress' || snapshot.you.playerId !== localProfileId
    || snapshot.you.status !== 'active' || !timing || timing.matchId !== snapshot.matchId
    || timing.revision !== snapshot.revision || !Number.isFinite(serverNow)) return null
  const round = snapshot.round
  let window: Omit<SvaraDecisionWindow, 'remainingMs' | 'key'>
  let deadlineKind: 'svara-joining' | 'reveal-choice'
  if (round?.kind === 'svara-joining') {
    const allowed = snapshot.you.svaraDecision === 'undecided'
      && round.decisions?.some((entry) => entry.playerId === localProfileId && entry.status === 'undecided')
    const pot = snapshot.lockedPots.find((entry) => entry.potId === round.potId)
    if (!allowed || round.closed || pot?.kind !== 'ordinary') return null
    deadlineKind = 'svara-joining'
    window = {
      kind: 'joining', title: 'Включваш ли се в Свара?', fee: round.fee, totalMs: 15000,
      actions: [
        { kind: 'join', label: 'Включвам се', command: { type: 'svara-join' } },
        { kind: 'decline', label: 'Пропускам', command: { type: 'svara-decline' } },
      ],
    }
  } else if (round?.kind === 'reveal-choice' && round.decision === 'pending'
    && round.winnerId === localProfileId && snapshot.you.revealChoice?.canDecide) {
    deadlineKind = 'reveal-choice'
    window = {
      kind: 'reveal', title: 'Искаш ли да покажеш картите си?', fee: null, totalMs: 5000,
      actions: [
        { kind: 'reveal', label: 'Покажи картите', command: { type: 'reveal-cards' } },
        { kind: 'hide', label: 'Скрий картите', command: { type: 'hide-cards' } },
      ],
    }
  } else return null
  const deadline = timing.deadlines.find((entry) => entry.kind === deadlineKind)
  if (!deadline || !Number.isFinite(deadline.deadlineAt) || deadline.deadlineAt <= serverNow) return null
  return { ...window, key: JSON.stringify([snapshot.matchId, round.roundId, window.kind]),
    remainingMs: Math.max(0, Math.min(window.totalMs, deadline.deadlineAt - serverNow)) }
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]!)

export function renderSvaraDecisionWindow(window: SvaraDecisionWindow | null, pending: boolean, error: string): string {
  if (!window) return ''
  return `<div data-svara-decision-window="${window.kind}" data-svara-decision-key="${esc(window.key)}" role="dialog" aria-labelledby="svara-decision-title" style="box-sizing:border-box;pointer-events:auto;width:min(100%,360px);max-height:100%;overflow-y:auto;border:1px solid #d4a520;border-radius:14px;background:rgba(6,10,7,.97);box-shadow:0 5px 28px #000c;padding:clamp(10px,2.8vw,18px);color:#fff;text-align:center;">
    <h2 id="svara-decision-title" style="margin:0 0 8px;font-size:clamp(16px,3vw,20px);line-height:1.2;color:#f4c95b;">${esc(window.title)}</h2>
    ${window.fee !== null ? `<div data-svara-joining-fee="1" style="margin-bottom:7px;font-size:14px;">Такса за включване: <strong>${window.fee}</strong> чипа</div>` : ''}
    <div style="font-size:14px;margin-bottom:5px;">Оставащо време: <strong data-svara-decision-seconds="1">${Math.ceil(window.remainingMs / 1000)}</strong> с</div>
    <div style="height:4px;border-radius:3px;overflow:hidden;background:#ffffff25;margin-bottom:10px;"><div data-svara-decision-progress="1" style="height:100%;width:${window.remainingMs / window.totalMs * 100}%;background:#f4c95b;"></div></div>
    ${error ? `<div role="alert" style="font-size:12px;color:#fca5a5;margin-bottom:8px;overflow-wrap:anywhere;">${esc(error)}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
      ${window.actions.map((action, i) => `<button type="button" data-svara-decision-action="${action.kind}" data-svara-decision-key="${esc(window.key)}" ${pending ? 'disabled' : ''} style="box-sizing:border-box;min-height:46px;padding:7px;border-radius:9px;border:1px solid #d4a520;font-size:14px;line-height:1.2;font-weight:800;cursor:${pending ? 'wait' : 'pointer'};opacity:${pending ? '.5' : '1'};background:${i === 0 ? '#d4a520' : '#171b17'};color:${i === 0 ? '#110d00' : '#f4c95b'};">${esc(action.label)}</button>`).join('')}
    </div>
    ${pending ? '<div data-svara-decision-pending="1" style="margin-top:7px;font-size:12px;color:#f4c95b;">Изчаква се потвърждение…</div>' : ''}
  </div>`
}

/** Keep the dialog and focused buttons mounted while only the countdown changes. */
export function svaraDecisionStructureKey(window: SvaraDecisionWindow | null, pending: boolean, error: string): string {
  return JSON.stringify([window?.key, window?.fee, pending, error])
}

export function patchSvaraDecisionWindow(mount: HTMLElement | null, window: SvaraDecisionWindow | null, pending: boolean, error: string): void {
  if (!mount) return
  const structureKey = svaraDecisionStructureKey(window, pending, error)
  if (mount.dataset.structureKey !== structureKey) {
    mount.innerHTML = renderSvaraDecisionWindow(window, pending, error)
    mount.dataset.structureKey = structureKey
  }
  if (window) {
    const seconds = mount.querySelector('[data-svara-decision-seconds]')
    if (seconds) seconds.textContent = String(Math.ceil(window.remainingMs / 1000))
    const progress = mount.querySelector<HTMLElement>('[data-svara-decision-progress]')
    if (progress) progress.style.width = `${window.remainingMs / window.totalMs * 100}%`
  }
}
