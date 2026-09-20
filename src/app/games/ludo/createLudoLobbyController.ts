import type { LudoRoomSnapshot, MatchStake } from '../../network/createGameServerClient'

type Options = {
  root: HTMLElement
  localProfileId: string
  stakes: MatchStake[]
  onBack: () => void
  onRefresh: () => void
  onCreate: (stake: MatchStake, playerCount: 2 | 4, manualStart: boolean) => void
  onJoin: (roomId: string) => void
  onLeave: () => void
  onKick: (profileId: string) => void
  onStart: () => void
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

export function createLudoLobbyController(options: Options) {
  let rooms: LudoRoomSnapshot[] = []
  let myRoom: LudoRoomSnapshot | null = null
  let createOpen = false
  let message = ''
  let leavePending = false

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:42px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'
  const backButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 16px 0 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.03);color:rgba(255,255,255,.82);font-size:14px;line-height:normal;font-weight:700;cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease;'
  const createButtonStyle = 'box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 20px;border:1px solid rgba(244,201,91,.5);border-radius:10px;background:linear-gradient(135deg,#f6d27a 0%,#d4a520 55%,#c98f13 100%);color:#1a1200;font-size:14px;line-height:normal;font-weight:800;cursor:pointer;box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 6px 16px rgba(212,165,32,.22);'
  const backChevronSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18l-6-6 6-6"/></svg>'
  const createPlusSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>'

  function render(): void {
    const body = myRoom ? renderWaiting(myRoom) : renderList()
    options.root.innerHTML = `<section data-ludo-lobby="1" style="background:#030303;color:#fff;font-family:Arial,sans-serif;padding:clamp(14px,3vw,32px);box-sizing:border-box;">
      <style>
        [data-ludo-lobby-back]:hover { border-color:rgba(212,165,32,.55); color:#f4c95b; background:rgba(212,165,32,.08); }
      </style>
      <div style="max-width:920px;margin:0 auto;">
        <div style="border:2px solid rgba(212,165,32,0.78);border-radius:14px;overflow:hidden;line-height:0;margin-bottom:18px;background:#000000;">
          <img src="/images/games/ludo-lobby-banner.webp" alt="Не се сърди човече" style="display:block;width:100%;height:auto;border-radius:12px;">
        </div>
        ${message ? `<div style="margin-bottom:14px;color:#f4c95b;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
    wire()
  }

  function renderActionRow(rightContent: string): string {
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;">
      <button data-ludo-lobby-back="1" aria-label="Назад" style="${backButtonStyle}">${backChevronSvg}<span>Назад</span></button>
      ${rightContent}
    </div>`
  }

  function renderEmptyState(): string {
    return `<div style="background:linear-gradient(180deg,#0d0d0d 0%,#080808 100%);border:1px solid rgba(212,165,32,.4);border-radius:16px;padding:clamp(28px,5vw,44px) 20px;box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 14px 34px rgba(0,0,0,.35);display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;">
      <svg width="112" height="80" viewBox="0 0 112 80" fill="none" aria-hidden="true" focusable="false">
        <circle cx="24" cy="52" r="13" fill="none" stroke="#e0473e" stroke-width="2.2" opacity=".85"/>
        <circle cx="52" cy="60" r="13" fill="none" stroke="#3b82f6" stroke-width="2.2" opacity=".85"/>
        <circle cx="80" cy="52" r="13" fill="none" stroke="#22a559" stroke-width="2.2" opacity=".85"/>
        <g transform="translate(40,10)">
          <rect x="0" y="0" width="32" height="32" rx="8" fill="#141414" stroke="#f4c95b" stroke-width="1.6"/>
          <circle cx="9" cy="9" r="2.4" fill="#f4c95b"/>
          <circle cx="23" cy="9" r="2.4" fill="#f4c95b"/>
          <circle cx="9" cy="23" r="2.4" fill="#f4c95b"/>
          <circle cx="23" cy="23" r="2.4" fill="#f4c95b"/>
          <circle cx="16" cy="16" r="2.4" fill="#f4c95b"/>
        </g>
      </svg>
      <div>
        <div style="font-size:17px;font-weight:800;color:#fff;">Няма създадени игри в момента</div>
        <div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,.55);">Създай нова игра и покани приятели.</div>
      </div>
    </div>`
  }

  function renderList(): string {
    const createButton = `<button data-ludo-create-open="1" style="${createButtonStyle}">${createPlusSvg}<span>Създай игра</span></button>`
    return `${renderActionRow(createButton)}
      ${rooms.length === 0 ? renderEmptyState() : `<div style="display:grid;gap:10px;">${rooms.map((room) => {
        const host = room.players.find((player) => player.isHost)
        return `<article style="${panel}display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;">
          <div><strong>${esc(host?.displayName ?? 'Играч')}</strong><div style="margin-top:6px;color:rgba(255,255,255,.62);font-size:13px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div>
          <button data-ludo-room-join="${esc(room.id)}" aria-label="Влез в играта" style="${button}width:46px;padding:0;font-size:25px;">+</button>
        </article>`
      }).join('')}</div>`}`
  }

  function renderWaiting(room: LudoRoomSnapshot): string {
    const isHost = room.players.some((player) => player.profileId === options.localProfileId && player.isHost)
    return `<div style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;"><div><strong>Чакалня</strong><div style="color:rgba(255,255,255,.62);margin-top:5px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div><button data-ludo-room-leave="1" ${leavePending ? 'disabled' : ''} style="${button}${leavePending ? 'opacity:.55;cursor:wait;' : ''}">${leavePending ? 'Напускане…' : 'Напусни'}</button></div>
      <div style="display:grid;gap:8px;">${Array.from({ length: room.playerCount }, (_, index) => {
        const player = room.players[index]
        if (!player) return `<div style="border:1px dashed rgba(255,255,255,.18);border-radius:7px;padding:13px;color:rgba(255,255,255,.4);">Свободно място</div>`
        return `<div style="border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;"><span>${esc(player.displayName)}${player.isHost ? ' · Създател' : ''}</span>${isHost && !player.isHost ? `<button data-ludo-room-kick="${esc(player.profileId)}" style="${button}min-height:34px;color:#fecaca;">Премахни</button>` : ''}</div>`
      }).join('')}</div>
      ${room.manualStart && isHost ? `<button data-ludo-room-start="1" ${room.canManualStart ? '' : 'disabled'} style="${button}width:100%;margin-top:16px;background:${room.canManualStart ? '#d4a520' : '#242424'};color:${room.canManualStart ? '#050505' : '#777'};cursor:${room.canManualStart ? 'pointer' : 'not-allowed'};">Старт</button>` : ''}
    </div>`
  }

  function renderCreateModal(): string {
    const stakes = options.stakes.length ? options.stakes : [0]
    return `<div data-ludo-create-backdrop="1" style="position:fixed;inset:0;background:rgba(0,0,0,.78);display:grid;place-items:center;padding:14px;z-index:2;"><form data-ludo-create-form="1" style="${panel}width:min(100%,420px);max-width:100%;min-width:0;max-height:calc(100dvh - 28px);overflow-y:auto;box-sizing:border-box;">
      <h2 style="margin:0 0 18px;letter-spacing:0;">Създай игра</h2>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Брой играчи<select name="playerCount" style="width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;"><option value="2">2</option><option value="4">4</option></select></label>
      <label style="display:grid;gap:7px;margin-bottom:14px;min-width:0;">Вход<select name="stake" style="width:100%;max-width:100%;min-width:0;box-sizing:border-box;min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;">${stakes.map((stake) => `<option value="${stake}">${stake} жълтици</option>`).join('')}</select></label>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:10px;"><legend style="margin-bottom:8px;">Старт</legend><label><input type="radio" name="startMode" value="auto" checked> При запълване</label><label><input type="radio" name="startMode" value="manual"> Ръчен старт</label></fieldset>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-ludo-create-close="1" style="${button}">Отказ</button><button type="submit" style="${button}background:#d4a520;color:#050505;">Създай</button></div>
    </form></div>`
  }

  function wire(): void {
    options.root.querySelector('[data-ludo-lobby-back]')?.addEventListener('click', () => {
      requestExit()
    })
    options.root.querySelector('[data-ludo-create-open]')?.addEventListener('click', () => { createOpen = true; render() })
    options.root.querySelector('[data-ludo-create-close]')?.addEventListener('click', () => { createOpen = false; render() })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-room-join]').forEach((el) => el.addEventListener('click', () => options.onJoin(el.dataset.ludoRoomJoin!)))
    options.root.querySelector('[data-ludo-room-leave]')?.addEventListener('click', () => {
      requestExit()
    })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-room-kick]').forEach((el) => el.addEventListener('click', () => options.onKick(el.dataset.ludoRoomKick!)))
    options.root.querySelector('[data-ludo-room-start]')?.addEventListener('click', options.onStart)
    options.root.querySelector<HTMLFormElement>('[data-ludo-create-form]')?.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget as HTMLFormElement)
      createOpen = false
      options.onCreate(Number(data.get('stake')), Number(data.get('playerCount')) as 2 | 4, data.get('startMode') === 'manual')
      render()
    })
  }

  function requestExit(): void {
    if (leavePending) return
    if (myRoom === null) {
      options.onBack()
      return
    }
    leavePending = true
    message = ''
    render()
    options.onLeave()
  }

  render()
  options.onRefresh()
  return {
    setRooms(next: LudoRoomSnapshot[]) { rooms = next; myRoom = next.find((room) => room.players.some((player) => player.profileId === options.localProfileId)) ?? null; render() },
    setMyRoom(room: LudoRoomSnapshot | null) { myRoom = room; leavePending = false; render() },
    showMessage(next: string) { message = next; render() },
    requestExit,
    destroy() { options.root.innerHTML = '' },
  }
}
