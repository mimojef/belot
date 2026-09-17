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

  const button = 'border:1px solid rgba(212,165,32,.55);border-radius:7px;background:#0b0b0b;color:#f4c95b;min-height:42px;padding:0 16px;font-weight:800;cursor:pointer;'
  const panel = 'background:#090909;border:1px solid rgba(212,165,32,.35);border-radius:8px;padding:16px;'

  function render(): void {
    const body = myRoom ? renderWaiting(myRoom) : renderList()
    options.root.innerHTML = `<section data-ludo-lobby="1" style="position:fixed;inset:0;overflow-y:auto;background:#030303;color:#fff;font-family:Arial,sans-serif;padding:clamp(14px,3vw,32px);box-sizing:border-box;">
      <div style="max-width:920px;margin:0 auto;">
        <header style="display:flex;align-items:center;gap:12px;margin-bottom:24px;"><button data-ludo-lobby-back="1" aria-label="Назад" style="${button}font-size:20px;width:44px;padding:0;">←</button><h1 style="margin:0;font-size:clamp(24px,4vw,34px);letter-spacing:0;">Не се сърди човече</h1></header>
        ${message ? `<div style="margin-bottom:14px;color:#f4c95b;">${esc(message)}</div>` : ''}
        ${body}
      </div>
      ${createOpen ? renderCreateModal() : ''}
    </section>`
    wire()
  }

  function renderList(): string {
    return `<div style="display:flex;justify-content:flex-end;margin-bottom:16px;"><button data-ludo-create-open="1" style="${button}background:#d4a520;color:#050505;">Създай игра</button></div>
      <div style="display:grid;gap:10px;">${rooms.length === 0 ? `<div style="${panel}color:rgba(255,255,255,.62);">Няма чакащи Ludo игри.</div>` : rooms.map((room) => {
        const host = room.players.find((player) => player.isHost)
        return `<article style="${panel}display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;">
          <div><strong>${esc(host?.displayName ?? 'Играч')}</strong><div style="margin-top:6px;color:rgba(255,255,255,.62);font-size:13px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div>
          <button data-ludo-room-join="${esc(room.id)}" aria-label="Влез в играта" style="${button}width:46px;padding:0;font-size:25px;">+</button>
        </article>`
      }).join('')}</div>`
  }

  function renderWaiting(room: LudoRoomSnapshot): string {
    const isHost = room.players.some((player) => player.profileId === options.localProfileId && player.isHost)
    return `<div style="${panel}">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;"><div><strong>Чакалня</strong><div style="color:rgba(255,255,255,.62);margin-top:5px;">${room.players.length}/${room.playerCount} · Вход ${room.stake} · ${room.manualStart ? 'Ръчен старт' : 'При запълване'}</div></div><button data-ludo-room-leave="1" style="${button}">Напусни</button></div>
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
    return `<div data-ludo-create-backdrop="1" style="position:fixed;inset:0;background:rgba(0,0,0,.78);display:grid;place-items:center;padding:14px;z-index:2;"><form data-ludo-create-form="1" style="${panel}width:min(100%,420px);max-height:calc(100dvh - 28px);overflow-y:auto;box-sizing:border-box;">
      <h2 style="margin:0 0 18px;letter-spacing:0;">Създай Ludo игра</h2>
      <label style="display:grid;gap:7px;margin-bottom:14px;">Брой играчи<select name="playerCount" style="min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;"><option value="2">2</option><option value="4">4</option></select></label>
      <label style="display:grid;gap:7px;margin-bottom:14px;">Вход<select name="stake" style="min-height:42px;background:#111;color:#fff;border:1px solid #555;border-radius:7px;padding:0 10px;">${stakes.map((stake) => `<option value="${stake}">${stake} жълтици</option>`).join('')}</select></label>
      <fieldset style="border:0;padding:0;margin:0 0 18px;display:grid;gap:10px;"><legend style="margin-bottom:8px;">Старт</legend><label><input type="radio" name="startMode" value="auto" checked> При запълване</label><label><input type="radio" name="startMode" value="manual"> Ръчен старт</label></fieldset>
      <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" data-ludo-create-close="1" style="${button}">Отказ</button><button type="submit" style="${button}background:#d4a520;color:#050505;">Създай</button></div>
    </form></div>`
  }

  function wire(): void {
    options.root.querySelector('[data-ludo-lobby-back]')?.addEventListener('click', options.onBack)
    options.root.querySelector('[data-ludo-create-open]')?.addEventListener('click', () => { createOpen = true; render() })
    options.root.querySelector('[data-ludo-create-close]')?.addEventListener('click', () => { createOpen = false; render() })
    options.root.querySelectorAll<HTMLElement>('[data-ludo-room-join]').forEach((el) => el.addEventListener('click', () => options.onJoin(el.dataset.ludoRoomJoin!)))
    options.root.querySelector('[data-ludo-room-leave]')?.addEventListener('click', options.onLeave)
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

  render()
  options.onRefresh()
  return {
    setRooms(next: LudoRoomSnapshot[]) { rooms = next; myRoom = next.find((room) => room.players.some((player) => player.profileId === options.localProfileId)) ?? null; render() },
    setMyRoom(room: LudoRoomSnapshot | null) { myRoom = room; render() },
    showMessage(next: string) { message = next; render() },
    destroy() { options.root.innerHTML = '' },
  }
}
