import type { MatchStake } from '../network/createGameServerClient'

export type LobbyScreenState = {
  displayName: string
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  statusText: string
  errorText: string | null
}

export type RenderLobbyScreenOptions = {
  state: LobbyScreenState
  onDisplayNameChange: (value: string) => void
  onStakeChange: (stake: MatchStake) => void
  onSearchClick: () => void
  onCancelClick: () => void
}

type LobbyStakeCard = {
  stake: MatchStake
  prizeAmount: number
  onlinePlayers: number
}

const MATCH_STAKE_CARDS: LobbyStakeCard[] = [
  { stake: 5000, prizeAmount: 8000, onlinePlayers: 124 },
  { stake: 8000, prizeAmount: 12000, onlinePlayers: 98 },
  { stake: 10000, prizeAmount: 15000, onlinePlayers: 87 },
  { stake: 15000, prizeAmount: 22000, onlinePlayers: 63 },
  { stake: 20000, prizeAmount: 30000, onlinePlayers: 45 },
]

const COIN_PACKAGES = [
  { amount: 1000, image: '/assets/lobby/coins-1000.png' },
  { amount: 5000, image: '/assets/lobby/coins-5000.png' },
  { amount: 10000, image: '/assets/lobby/coins-10000.png' },
  { amount: 25000, image: '/assets/lobby/coins-25000.png' },
  { amount: 50000, image: '/assets/lobby/coins-50000.png' },
]

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function renderNav(_isSearching: boolean): string {
  return `
    <nav style="
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.10);
      padding: 0 24px;
      display: flex;
      align-items: center;
      gap: 0;
      height: 56px;
      position: sticky;
      top: 0;
      z-index: 100;
    ">
      <a href="#" style="display:flex; align-items:center; gap:8px; text-decoration:none; margin-right:16px;">
        <img src="/assets/lobby/logo.png" alt="Pika.bg" style="height:32px;">
      </a>

      <div style="display:flex; align-items:stretch; gap:0; height:100%; flex:1;">
        <a href="#" style="
          display:flex; align-items:center; gap:7px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:#d4a520;
          border-bottom:2px solid #d4a520;
          background: rgba(212,165,32,0.06);
        ">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
          Лоби
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:7px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
          transition:color 0.15s;
        ">
          <img src="/assets/lobby/icon-tournaments.png" alt="" style="height:15px; opacity:0.75;">
          Турнири
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:7px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-shop-cart.png" alt="" style="height:15px; opacity:0.75;">
          Магазин
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:7px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-leaderboard.png" alt="" style="height:15px; opacity:0.75;">
          Класация
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:7px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-profile.png" alt="" style="height:15px; opacity:0.75;">
          Профил
        </a>
      </div>

      <div style="display:flex; align-items:center; gap:16px; margin-left:auto;">
        <button style="
          background:none; border:none; cursor:pointer; padding:6px;
          color:rgba(255,255,255,0.65); position:relative;
        ">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          <span style="
            position:absolute; top:4px; right:4px;
            width:8px; height:8px; border-radius:50%;
            background:#ef4444; border:1.5px solid #0a0a0a;
          "></span>
        </button>
        <button style="background:none; border:none; cursor:pointer; padding:6px; color:rgba(255,255,255,0.65);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
        </button>
        <button style="background:none; border:none; cursor:pointer; padding:6px; color:rgba(255,255,255,0.65);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        </button>
        <button style="
          display:flex; align-items:center; gap:8px;
          background: linear-gradient(135deg, #d4a520 0%, #b8891a 100%);
          border: none; border-radius:8px;
          padding:9px 16px;
          cursor:pointer;
          font-size:13px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase;
          color:#000000;
          box-shadow: 0 2px 12px rgba(212,165,32,0.35);
        ">
          <span style="font-size:16px; font-weight:900;">+</span>
          Купи Жълтици
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:18px;">
        </button>
      </div>
    </nav>
  `
}

function renderHeroSection(profileName: string, isConnected: boolean): string {
  return `
    <div style="display:flex; gap:16px; margin-bottom:16px;">
      <div style="flex:1; min-width:0; border-radius:14px; overflow:hidden; position:relative;">
        <img src="/assets/lobby/hero-banner.png" alt="Добре дошъл в лобито"
          style="width:100%; display:block; object-fit:cover; min-height:180px;">
      </div>

      <div style="
        width:320px; flex-shrink:0;
        background: linear-gradient(160deg, #141414 0%, #0d0d0d 100%);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius:14px;
        padding:20px;
      ">
        <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px;">
          <div style="
            width:64px; height:64px; border-radius:50%;
            border:2px solid #d4a520;
            overflow:hidden; flex-shrink:0;
            background:#111111;
          ">
            <img src="/assets/lobby/player-avatar.png" alt="${escapeHtml(profileName)}"
              style="width:100%; height:100%; object-fit:cover;">
          </div>
          <div>
            <div style="font-size:18px; font-weight:800; color:#ffffff;">${escapeHtml(profileName)}</div>
            <div style="display:flex; align-items:center; gap:5px; margin-top:3px;">
              <div style="
                width:8px; height:8px; border-radius:50%;
                background:${isConnected ? '#22c55e' : '#ef4444'};
              "></div>
              <span style="font-size:12px; color:${isConnected ? '#86efac' : '#fca5a5'}; font-weight:600;">
                ${isConnected ? 'Онлайн' : 'Офлайн'}
              </span>
            </div>
          </div>
          <div style="margin-left:auto; text-align:right;">
            <div style="font-size:11px; color:rgba(255,255,255,0.5); font-weight:600; text-transform:uppercase; letter-spacing:0.06em;">Баланс</div>
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:5px; margin-top:2px;">
              <span style="font-size:20px; font-weight:900; color:#d4a520;">25 430</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="height:20px;">
            </div>
          </div>
        </div>

        <div style="
          display:grid; grid-template-columns:1fr 1fr;
          gap:8px;
        ">
          <div style="
            background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07);
            border-radius:10px; padding:10px 12px;
            display:flex; align-items:center; gap:8px;
          ">
            <img src="/assets/lobby/icon-victories.png" alt="" style="height:22px; flex-shrink:0;">
            <div>
              <div style="font-size:10px; color:rgba(255,255,255,0.5); font-weight:600; text-transform:uppercase;">Победи</div>
              <div style="font-size:15px; font-weight:800; color:#fff;">1 287</div>
            </div>
          </div>
          <div style="
            background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07);
            border-radius:10px; padding:10px 12px;
            display:flex; align-items:center; gap:8px;
          ">
            <img src="/assets/lobby/icon-games-played.png" alt="" style="height:22px; flex-shrink:0;">
            <div>
              <div style="font-size:10px; color:rgba(255,255,255,0.5); font-weight:600; text-transform:uppercase;">Изиграни</div>
              <div style="font-size:15px; font-weight:800; color:#fff;">2 540</div>
            </div>
          </div>
          <div style="
            background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07);
            border-radius:10px; padding:10px 12px;
            display:flex; align-items:center; gap:8px;
          ">
            <img src="/assets/lobby/icon-success-rate.png" alt="" style="height:22px; flex-shrink:0;">
            <div>
              <div style="font-size:10px; color:rgba(255,255,255,0.5); font-weight:600; text-transform:uppercase;">Успеваемост</div>
              <div style="font-size:15px; font-weight:800; color:#d4a520;">63%</div>
            </div>
          </div>
          <div style="
            background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07);
            border-radius:10px; padding:10px 12px;
            display:flex; align-items:center; gap:8px;
          ">
            <img src="/assets/lobby/icon-rank.png" alt="" style="height:22px; flex-shrink:0;">
            <div>
              <div style="font-size:10px; color:rgba(255,255,255,0.5); font-weight:600; text-transform:uppercase;">Ранг</div>
              <div style="font-size:15px; font-weight:800; color:#fff;">Майстор</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderStakeSection(
  selectedStake: MatchStake,
  canStartSearch: boolean,
  _isSearching: boolean,
): string {
  const stakeCards = MATCH_STAKE_CARDS.map((card) => {
    const isSelected = card.stake === selectedStake
    const isDisabled = !canStartSearch

    return `
      <button
        type="button"
        data-lobby-stake-card="${card.stake}"
        ${isDisabled ? 'disabled' : ''}
        style="
          position:relative;
          background: ${isSelected
            ? 'linear-gradient(160deg, #131008 0%, #0c0a04 100%)'
            : 'linear-gradient(160deg, #141414 0%, #0d0d0d 100%)'
          };
          border: 1px solid ${isSelected ? '#c8940e' : 'rgba(255,255,255,0.08)'};
          border-radius:12px;
          padding:16px 14px 14px;
          cursor:${isDisabled ? 'default' : 'pointer'};
          text-align:left;
          overflow:hidden;
          transition:border-color 0.15s, background 0.15s;
          box-shadow: ${isSelected ? '0 0 0 1px rgba(200,148,14,0.3), 0 8px 24px rgba(0,0,0,0.4)' : '0 4px 16px rgba(0,0,0,0.3)'};
          opacity:${isDisabled && !isSelected ? '0.7' : '1'};
        "
      >
        <img src="/assets/lobby/spade-watermark.png" alt=""
          style="
            position:absolute; bottom:-10px; right:-6px;
            height:80px; opacity:${isSelected ? '0.12' : '0.07'};
            pointer-events:none;
          ">

        ${isSelected ? `
          <div style="
            position:absolute; top:10px; right:10px;
            background:linear-gradient(135deg, #d4a520 0%, #a07010 100%);
            border-radius:20px; padding:3px 9px;
            font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:0.06em;
            color:#000000;
          ">ИЗБРАНО ★</div>
        ` : ''}

        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Награда</div>
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:12px;">
          <span style="font-size:22px; font-weight:900; color:#ffffff; line-height:1;">${formatAmount(card.prizeAmount)}</span>
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:18px;">
        </div>

        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Вход</div>
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:14px;">
          <span style="font-size:18px; font-weight:900; color:#d4a520; line-height:1;">${formatAmount(card.stake)}</span>
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:15px;">
        </div>

        <div style="
          display:flex; align-items:center; gap:5px;
          font-size:11px; font-weight:600; color:rgba(255,255,255,0.45);
        ">
          <img src="/assets/lobby/icon-users.png" alt="" style="height:12px; opacity:0.6;">
          Играчи онлайн: ${card.onlinePlayers}
        </div>
      </button>
    `
  }).join('')

  return `
    <div style="margin-bottom:16px;">
      <div style="
        display:flex; align-items:center; justify-content:center; gap:12px;
        margin-bottom:14px;
      ">
        <div style="flex:1; height:1px; background:linear-gradient(90deg, transparent, rgba(212,165,32,0.4));"></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="color:#d4a520; font-size:13px;">◆</span>
          <span style="font-size:13px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#d4a520;">Избери маса</span>
          <span style="color:#d4a520; font-size:13px;">◆</span>
        </div>
        <div style="flex:1; height:1px; background:linear-gradient(90deg, rgba(212,165,32,0.4), transparent);"></div>
      </div>

      <div style="
        display:grid;
        grid-template-columns:repeat(5, minmax(0, 1fr));
        gap:12px;
      ">
        ${stakeCards}
      </div>
    </div>
  `
}

function renderBottomSection(): string {
  const coinPackages = COIN_PACKAGES.map((pkg) => `
    <div style="
      background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07);
      border-radius:10px; padding:12px 10px;
      display:flex; flex-direction:column; align-items:center; gap:8px;
      flex:1; min-width:0;
    ">
      <img src="${pkg.image}" alt="${formatAmount(pkg.amount)} жълтици"
        style="height:52px; object-fit:contain;">
      <div style="font-size:13px; font-weight:800; color:#ffffff; white-space:nowrap;">
        ${formatAmount(pkg.amount)}
        <img src="/assets/lobby/icon-coin.png" alt="" style="height:13px; vertical-align:middle;">
      </div>
      <button style="
        background:linear-gradient(135deg, #d4a520 0%, #a07010 100%);
        border:none; border-radius:6px;
        padding:5px 14px;
        font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.06em;
        color:#000000; cursor:pointer;
        width:100%;
      ">Купи</button>
    </div>
  `).join('')

  return `
    <div style="
      display:grid;
      grid-template-columns:200px 1fr 1fr 1fr 1fr 1fr 180px;
      gap:12px;
      align-items:stretch;
      margin-bottom:16px;
    ">
      <div style="
        background:linear-gradient(160deg, #141414 0%, #0d0d0d 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:16px;
        display:flex; flex-direction:column; justify-content:center;
      ">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
          <div style="
            width:32px; height:32px; border-radius:8px;
            background:rgba(212,165,32,0.15);
            display:flex; align-items:center; justify-content:center;
          ">
            <img src="/assets/lobby/icon-shop-cart.png" alt="" style="height:18px;">
          </div>
          <div style="font-size:13px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Магазин за жълтици</div>
        </div>
        <div style="font-size:11px; color:rgba(255,255,255,0.5); font-weight:600; line-height:1.4;">
          Зареди своя баланс и се върни в играта!
        </div>
      </div>

      ${coinPackages}

      <div style="
        background:linear-gradient(160deg, #0d0d0d 0%, #080808 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        overflow:hidden;
        display:flex; align-items:flex-end; justify-content:flex-end;
      ">
        <img src="/assets/lobby/footer-decor.png" alt=""
          style="width:100%; height:100%; object-fit:cover; object-position:center;">
      </div>
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(4, minmax(0, 1fr));
      gap:12px;
    ">
      <div style="
        background:linear-gradient(160deg, #0d0d0d 0%, #080808 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:12px;
        cursor:pointer;
      ">
        <div style="
          width:44px; height:44px; border-radius:50%;
          background:rgba(34,197,94,0.12);
          display:flex; align-items:center; justify-content:center;
          flex-shrink:0;
        ">
          <img src="/assets/lobby/icon-quick-game.png" alt="" style="height:26px;">
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:800; color:#22c55e; text-transform:uppercase; letter-spacing:0.05em;">Бърза игра</div>
          <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:2px; font-weight:600;">Намери противници и влез в игра веднага.</div>
        </div>
        <span style="color:rgba(255,255,255,0.3); font-size:18px;">→</span>
      </div>

      <div style="
        background:linear-gradient(160deg, #0d0d0d 0%, #080808 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:12px;
        cursor:pointer;
      ">
        <div style="
          width:44px; height:44px; border-radius:50%;
          background:rgba(139,92,246,0.12);
          display:flex; align-items:center; justify-content:center;
          flex-shrink:0;
        ">
          <img src="/assets/lobby/icon-private-table.png" alt="" style="height:26px;">
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:800; color:#a78bfa; text-transform:uppercase; letter-spacing:0.05em;">Частни маси</div>
          <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:2px; font-weight:600;">Създай маса и играй с приятели.</div>
        </div>
        <span style="color:rgba(255,255,255,0.3); font-size:18px;">→</span>
      </div>

      <div style="
        background:linear-gradient(160deg, #131008 0%, #0c0a04 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:12px;
        cursor:pointer;
        position:relative;
      ">
        <div style="
          width:44px; height:44px; border-radius:50%;
          background:rgba(212,165,32,0.12);
          display:flex; align-items:center; justify-content:center;
          flex-shrink:0;
        ">
          <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="height:26px;">
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Ежедневни награди</div>
          <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:2px; font-weight:600;">Влизай всеки ден и вземи своите награди.</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <div style="
            width:18px; height:18px; border-radius:50%;
            background:#ef4444; font-size:10px; font-weight:900; color:#fff;
            display:flex; align-items:center; justify-content:center;
          ">1</div>
          <span style="color:rgba(255,255,255,0.3); font-size:18px;">→</span>
        </div>
      </div>

      <div style="
        background:linear-gradient(160deg, #0d0d0d 0%, #080808 100%);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:12px;
        cursor:pointer;
      ">
        <div style="
          width:44px; height:44px; border-radius:50%;
          background:rgba(59,130,246,0.12);
          display:flex; align-items:center; justify-content:center;
          flex-shrink:0;
        ">
          <img src="/assets/lobby/icon-missions.png" alt="" style="height:26px;">
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:800; color:#60a5fa; text-transform:uppercase; letter-spacing:0.05em;">Мисии</div>
          <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:2px; font-weight:600;">Изпълнявай мисии и печели жълтици.</div>
        </div>
        <span style="color:rgba(255,255,255,0.3); font-size:18px;">→</span>
      </div>
    </div>
  `
}

function renderFooter(): string {
  return `
    <footer style="
      margin-top:16px;
      border-top:1px solid rgba(255,255,255,0.07);
      padding:16px 0;
      display:flex;
      align-items:center;
      gap:0;
    ">
      <div style="display:flex; align-items:center; gap:30px; flex:1;">
        <div style="display:flex; align-items:center; gap:10px;">
          <img src="/assets/lobby/icon-fair-play.png" alt="" style="height:28px; opacity:0.7;">
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Честна игра</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">За коректна и безопасна среда</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="opacity:0.7;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,0.6)"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
          </div>
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Сигурност</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">Защита на данни</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <img src="/assets/lobby/icon-users.png" alt="" style="height:28px; opacity:0.7;">
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Онлайн играчи</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">2 456</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="opacity:0.7;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="rgba(255,255,255,0.6)"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <div>
            <div style="font-size:12px; font-weight:700; color:rgba(255,255,255,0.75);">Помощ</div>
            <div style="font-size:10px; color:rgba(255,255,255,0.4); font-weight:600;">Свържи се с нас</div>
          </div>
        </div>
      </div>
      <div style="font-size:11px; color:rgba(255,255,255,0.3); font-weight:600; white-space:nowrap;">
        © Belot.bg&nbsp; Всички права запазени
      </div>
    </footer>
  `
}

export function renderLobbyScreen(
  root: HTMLElement,
  options: RenderLobbyScreenOptions,
): void {
  const { state } = options
  const canStartSearch = state.isConnected && !state.isSearching
  const profileName = state.displayName.trim() || 'Играч'

  root.innerHTML = `
    <div
      data-lobby-screen-root="1"
      style="
        position: fixed;
        inset: 0;
        background: #000000;
        color: #ffffff;
        font-family: Arial, Helvetica, sans-serif;
        overflow-y: auto;
        overflow-x: hidden;
        z-index: 50;
      "
    >
      ${renderNav(state.isSearching)}

      <div style="max-width: 1360px; margin: 0 auto; padding: 16px 20px;">
        ${renderHeroSection(profileName, state.isConnected)}
        ${renderStakeSection(state.selectedStake, canStartSearch, state.isSearching)}
        ${renderBottomSection()}
        ${renderFooter()}
      </div>

      ${state.isSearching ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:linear-gradient(135deg, #111111 0%, #080808 100%);
          border:1px solid rgba(212,165,32,0.4);
          border-radius:16px;
          padding:14px 24px;
          display:flex; align-items:center; gap:16px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          min-width:360px;
        ">
          <div style="
            width:12px; height:12px; border-radius:50%;
            background:#d4a520;
            animation:pulse 1.2s ease-in-out infinite;
            flex-shrink:0;
          "></div>
          <div style="flex:1;">
            <div style="font-size:14px; font-weight:800; color:#d4a520;">${escapeHtml(state.statusText)}</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); margin-top:2px; font-weight:600;">Търсенето е активно. Играта ще стартира автоматично.</div>
          </div>
          <button
            type="button"
            data-lobby-cancel-button="1"
            style="
              background:linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
              border:none; border-radius:10px;
              padding:9px 16px;
              font-size:13px; font-weight:800;
              color:#f5f3ff; cursor:pointer;
              white-space:nowrap;
            "
          >Откажи</button>
        </div>

        <style>
          @keyframes pulse {
            0%, 100% { opacity:1; transform:scale(1); }
            50% { opacity:0.5; transform:scale(0.8); }
          }
        </style>
      ` : ''}

      ${state.errorText ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:rgba(127,29,29,0.95);
          border:1px solid rgba(248,113,113,0.3);
          border-radius:12px;
          padding:12px 20px;
          font-size:13px; font-weight:700; color:#fecaca;
          box-shadow:0 8px 24px rgba(0,0,0,0.4);
          max-width:480px;
          text-align:center;
        ">
          ${escapeHtml(state.errorText)}
        </div>
      ` : ''}
    </div>
  `

  const stakeButtons = root.querySelectorAll<HTMLButtonElement>('[data-lobby-stake-card]')

  stakeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!canStartSearch) {
        return
      }

      const rawStake = Number(button.dataset.lobbyStakeCard)
      const selectedCard = MATCH_STAKE_CARDS.find((card) => card.stake === rawStake)

      if (!selectedCard) {
        return
      }

      options.onStakeChange(selectedCard.stake)
      options.onSearchClick()
    })
  })

  const cancelButton = root.querySelector<HTMLButtonElement>('[data-lobby-cancel-button="1"]')

  cancelButton?.addEventListener('click', () => {
    options.onCancelClick()
  })
}
