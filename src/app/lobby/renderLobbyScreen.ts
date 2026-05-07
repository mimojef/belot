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
  { amount: 1000, image: '/assets/lobby/coins-1000.png', width: 60, height: 53 },
  { amount: 5000, image: '/assets/lobby/coins-5000.png', width: 82, height: 74 },
  { amount: 10000, image: '/assets/lobby/coins-10000.png', width: 89, height: 85 },
  { amount: 25000, image: '/assets/lobby/coins-25000.png', width: 106, height: 93 },
  { amount: 50000, image: '/assets/lobby/coins-50000.png', width: 111, height: 98 },
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
      max-width: 1640px;
      margin: 0 auto;
      box-sizing: border-box;
      padding: 0 5px;
      display: flex;
      align-items: center;
      gap: 0;
      height: 72px;
      position: sticky;
      top: 0;
      z-index: 100;
    ">
      <a href="#" style="display:flex; align-items:center; gap:8px; text-decoration:none; margin-right:16px;">
        <img src="/assets/lobby/logo.png" alt="Pika.bg" style="width:192px; height:52px; display:block; object-fit:contain;">
      </a>

      <div style="display:flex; align-items:stretch; gap:0; height:100%; flex:1;">
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:#d4a520;
          border-bottom:2px solid #d4a520;
          background: rgba(212,165,32,0.06);
        ">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
          Лоби
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
          transition:color 0.15s;
        ">
          <img src="/assets/lobby/icon-tournaments.png" alt="" style="width:32px; height:29px; display:block; object-fit:contain; opacity:0.85;">
          Турнири
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-shop.png" alt="" style="width:31px; height:30px; display:block; object-fit:contain; opacity:0.85;">
          Магазин
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-leaderboard.png" alt="" style="width:29px; height:30px; display:block; object-fit:contain; opacity:0.85;">
          Класация
        </a>
        <a href="#" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
        ">
          <img src="/assets/lobby/icon-profile.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain; opacity:0.85;">
          Профил
        </a>
      </div>

      <div style="display:flex; align-items:center; gap:16px; margin-left:auto;">
        <button style="
          background:none; border:none; cursor:pointer; padding:6px;
          color:rgba(255,255,255,0.65); position:relative;
        ">
          <img src="/assets/lobby/icon-notifications.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain; opacity:0.85;">
          <span style="
            position:absolute; top:4px; right:4px;
            width:8px; height:8px; border-radius:50%;
            background:#ef4444; border:1.5px solid #0a0a0a;
          "></span>
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
        </button>
        <img src="/assets/lobby/icon-coin.png" alt="" style="width:33px; height:32px; display:block; object-fit:contain;">
      </div>
    </nav>
  `
}

function renderHeroSection(profileName: string, isConnected: boolean): string {
  return `
    <div style="display:flex; gap:16px; align-items:stretch; margin-bottom:16px;">
      <div style="flex:0 1 985px; min-width:0; border:2px solid rgba(212,165,32,0.75); border-radius:14px; overflow:hidden; position:relative; box-sizing:border-box;">
        <img src="/assets/lobby/hero-banner.png" alt="Добре дошъл в лобито"
          style="width:100%; height:254px; max-width:100%; display:block; object-fit:contain;">
      </div>

      <div style="
        flex:1 1 620px; min-width:580px; height:258px;
        background: linear-gradient(160deg, #050505 0%, #0d0d0d 100%);
        border: 2px solid rgba(212,165,32,0.75);
        border-radius:14px;
        padding:16px 28px;
        box-sizing:border-box;
      ">
        <div style="display:flex; align-items:center; gap:24px; height:120px;">
          <div style="position:relative; width:120px; height:120px; flex-shrink:0;">
            <div style="
              width:120px; height:120px; border-radius:12px;
              border:3px solid #d4a520;
              overflow:hidden;
              background:#111111;
              box-shadow:0 0 0 2px rgba(0,0,0,0.65), 0 0 22px rgba(212,165,32,0.18);
              box-sizing:border-box;
            ">
              <img src="/assets/lobby/player-avatar.png" alt="${escapeHtml(profileName)}"
                style="width:100%; height:100%; object-fit:cover; object-position:center;">
            </div>
            <div style="
              position:absolute; right:-6px; bottom:-6px;
              width:18px; height:18px; border-radius:50%;
              background:${isConnected ? '#22c55e' : '#ef4444'};
              border:2px solid #050505;
            "></div>
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:30px; line-height:1; font-weight:800; color:#ffffff;">${escapeHtml(profileName)}</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:12px;">
              <div style="
                width:14px; height:14px; border-radius:50%;
                background:${isConnected ? '#22c55e' : '#ef4444'};
              "></div>
              <span style="font-size:16px; color:rgba(255,255,255,0.88); font-weight:600;">
                ${isConnected ? 'Онлайн' : 'Офлайн'}
              </span>
            </div>
          </div>
          <div style="width:1px; height:92px; background:rgba(212,165,32,0.35);"></div>
          <div style="width:210px;">
            <div style="font-size:17px; color:rgba(255,255,255,0.78); font-weight:500;">Баланс</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <span style="font-size:34px; line-height:1; font-weight:900; color:#d4a520;">25 430</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="width:33px; height:32px; display:block; object-fit:contain;">
            </div>
            <div style="font-size:16px; color:rgba(255,255,255,0.72); margin-top:8px;">жълтици</div>
          </div>
        </div>

        <div style="
          height:1px;
          background:linear-gradient(90deg, transparent 0%, rgba(212,165,32,0.55) 12%, rgba(212,165,32,0.55) 88%, transparent 100%);
          margin:10px 0 8px;
        "></div>

        <div style="
          display:grid; grid-template-columns:0.82fr 1fr 1.18fr 1.42fr;
          align-items:center;
          height:76px;
        ">
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding-right:10px;">
            <img src="/assets/lobby/icon-victories.png" alt="" style="width:36px; height:36px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:rgba(255,255,255,0.82); font-weight:600;">Победи</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">1287</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-games-played.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Изиграни игри</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">2540</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-success-rate.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Успеваемост</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">63%</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; min-width:0; padding-left:10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-rank.png" alt="" style="width:48px; height:62px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:#d4a520; font-weight:700;">Ранг</div>
              <div style="font-size:18px; line-height:1.15; font-weight:800; color:#ffffff; margin-top:7px;">Майстор</div>
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
  isSearching: boolean,
): string {
  const stakeCards = MATCH_STAKE_CARDS.map((card) => {
    const isSelected = isSearching && card.stake === selectedStake
    const isDisabled = !canStartSearch

    return `
      <button
        type="button"
        data-lobby-stake-card="${card.stake}"
        ${isDisabled ? 'disabled' : ''}
        style="
          position:relative;
          background:#000000;
          border: 1px solid ${isSelected ? '#c8940e' : 'rgba(212,165,32,0.72)'};
          border-radius:12px;
          padding:16px 14px 14px;
          cursor:${isDisabled ? 'default' : 'pointer'};
          text-align:left;
          overflow:hidden;
          transition:border-color 0.15s, background 0.15s, box-shadow 0.15s;
          box-shadow: ${isSelected ? '0 0 0 1px rgba(200,148,14,0.3), 0 8px 24px rgba(0,0,0,0.4)' : '0 4px 16px rgba(0,0,0,0.3)'};
          opacity:${isDisabled && !isSelected ? '0.7' : '1'};
        "
      >
        <img src="/assets/lobby/spade-watermark.png" alt=""
          style="
            position:absolute; bottom:8px; right:18px;
            width:82px; height:97px; display:block; object-fit:contain;
            opacity:1;
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
          <span style="font-size:22px; font-weight:900; color:#d4a520; line-height:1;">${formatAmount(card.prizeAmount)}</span>
          <img src="/assets/lobby/icon-coin.png" alt="" style="height:18px;">
        </div>

        <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Вход</div>
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:14px;">
          <span style="font-size:18px; font-weight:400; color:#ffffff; line-height:1;">${formatAmount(card.stake)}</span>
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

      <style>
        [data-lobby-stake-card]:not(:disabled):hover {
          border-color:#c8940e !important;
          box-shadow:0 0 0 2px rgba(200,148,14,0.42), 0 8px 24px rgba(212,165,32,0.18) !important;
        }
      </style>
    </div>
  `
}

function renderBottomSection(): string {
  const coinPackages = COIN_PACKAGES.map((pkg, index) => {
    const isFirstPackage = index === 0

    return `
    <div style="
      background:#000000;
      border:1px solid rgba(212,165,32,0.72);
      border-radius:12px;
      padding:10px 12px;
      margin-left:${isFirstPackage ? '-8px' : '0'};
      display:grid; grid-template-columns:${pkg.width}px minmax(0, 1fr); align-items:center; gap:10px;
      flex:1; min-width:0;
      overflow:hidden;
      box-shadow:inset 0 0 18px rgba(212,165,32,0.035);
    ">
      <div style="height:98px; display:flex; align-items:center; justify-content:center;">
        <img src="${pkg.image}" alt="${formatAmount(pkg.amount)} жълтици"
          style="width:${pkg.width}px; height:${pkg.height}px; display:block; object-fit:contain;">
      </div>
      <div style="display:flex; flex-direction:column; justify-content:center; align-items:flex-start; min-width:0;">
        <div style="font-size:21px; line-height:1; font-weight:800; color:#d4a520; white-space:nowrap;">
          ${formatAmount(pkg.amount)}
        </div>
        <div style="font-size:12px; line-height:1; color:rgba(255,255,255,0.82); margin-top:6px; margin-bottom:9px; font-weight:400;">жълтици</div>
        <button data-lobby-buy-coins-button="1" style="
          background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
          border:none; border-radius:6px;
          padding:0 14px;
          height:28px;
          font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.03em;
          color:#000000; cursor:pointer;
          min-width:84px;
          transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
        ">Купи</button>
      </div>
    </div>
  `
  }).join('')

  return `
    <div style="
      display:grid;
      grid-template-columns:310px repeat(5, minmax(0, 1fr));
      gap:8px;
      align-items:stretch;
      margin-bottom:16px;
    ">
      <div style="
        background:#000000;
        border:1px solid rgba(212,165,32,0.72);
        border-right:0;
        border-radius:12px 0 0 12px;
        padding:15px 20px;
        display:flex; flex-direction:column; justify-content:center;
      ">
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <div style="
            width:45px; height:43px; border-radius:12px;
            background:#000000;
            display:flex; align-items:center; justify-content:center;
            flex-shrink:0;
          ">
            <img src="/assets/lobby/icon-shop-cart.png" alt="" style="width:45px; height:43px; display:block; object-fit:contain;">
          </div>
          <div style="min-width:0;">
            <div style="font-size:13px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Магазин за жълтици</div>
            <div style="font-size:11px; color:rgba(255,255,255,0.5); font-weight:400; line-height:1.35; margin-top:5px;">
              Купи жълтици и се върни в играта
            </div>
            <button data-lobby-buy-coins-button="1" style="
              margin-top:9px;
              height:28px;
              padding:0 14px;
              border:none;
              border-radius:6px;
              background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
              color:#000000;
              font-size:10px;
              font-weight:800;
              text-transform:uppercase;
              letter-spacing:0.03em;
              cursor:pointer;
              min-width:132px;
              transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
            ">Виж всички оферти</button>
          </div>
        </div>
      </div>

      ${coinPackages}

      <style>
        [data-lobby-buy-coins-button="1"]:hover {
          filter:brightness(1.12);
          transform:translateY(-1px);
          box-shadow:0 4px 12px rgba(212,165,32,0.26);
        }

        [data-lobby-buy-coins-button="1"]:active {
          filter:brightness(0.98);
          transform:translateY(0);
        }
      </style>
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr)) 332px;
      gap:12px;
      align-items:stretch;
    ">
      <div style="
        background:#000000;
        border:1px solid rgba(167,139,250,0.62);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-private-table.png" alt="" style="width:76px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#a78bfa; text-transform:uppercase; letter-spacing:0.05em;">Частни маси</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Създай маса и играй с приятели.</div>
        </div>
      </div>

      <div style="
        background:#000000;
        border:1px solid rgba(212,165,32,0.68);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        position:relative;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="width:74px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Ежедневни награди</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Влизай всеки ден и вземи своите награди.</div>
        </div>
      </div>

      <div style="
        background:#000000;
        border:1px solid rgba(96,165,250,0.62);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
      ">
        <img src="/assets/lobby/icon-missions.png" alt="" style="width:73px; height:76px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#60a5fa; text-transform:uppercase; letter-spacing:0.05em;">Дневни мисии</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Изпълнявай дневни мисии и печели жълтици.</div>
        </div>
      </div>

      <div style="
        min-height:137px;
        display:flex;
        align-items:flex-end;
        justify-content:flex-end;
        overflow:hidden;
      ">
        <img src="/assets/lobby/footer-decor.png" alt="" style="width:332px; height:137px; display:block; object-fit:contain;">
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
      <div data-lobby-footer-items="1" style="display:flex; align-items:center; gap:30px; flex:1;">
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
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style="display:block; flex-shrink:0; opacity:0.88;">
            <circle cx="8" cy="9" r="3.1" stroke="#d4a520" stroke-width="1.7"/>
            <path d="M3.4 19c.7-3.2 2.3-4.8 4.6-4.8s3.9 1.6 4.6 4.8" stroke="#d4a520" stroke-width="1.7" stroke-linecap="round"/>
            <circle cx="15.8" cy="8.2" r="2.5" stroke="rgba(212,165,32,0.72)" stroke-width="1.55"/>
            <path d="M13.2 14.2c.7-.7 1.6-1 2.8-1 2 0 3.5 1.5 4.1 4.4" stroke="rgba(212,165,32,0.72)" stroke-width="1.55" stroke-linecap="round"/>
          </svg>
          <img src="/assets/lobby/icon-users.png" alt="" style="display:none;">
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
      <img src="/assets/lobby/copyright-pika-2026.png" alt="© Pika.bg 2026 Всички права запазени" style="width:360px; height:31px; display:block; object-fit:contain;">
      <style>
        [data-lobby-footer-items="1"] > div:nth-child(1),
        [data-lobby-footer-items="1"] > div:nth-child(2),
        [data-lobby-footer-items="1"] > div:nth-child(4) {
          display:none !important;
        }
      </style>
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
        background: #242424;
        color: #ffffff;
        font-family: Arial, Helvetica, sans-serif;
        overflow-y: auto;
        overflow-x: hidden;
        z-index: 50;
      "
    >
      <style>
        [data-lobby-screen-root="1"] {
          --lobby-scale: 1;
        }

        @media (min-width: 2200px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.08; }
        }

        @media (min-width: 1920px) and (max-width: 2199px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.02; }
        }

        @media (max-width: 1700px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.96; }
        }

        @media (max-width: 1600px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.91; }
        }

        @media (max-width: 1500px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.86; }
        }

        @media (max-width: 1400px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.80; }
        }

        @media (max-width: 1280px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.73; }
        }

        @media (max-width: 1120px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.64; }
        }

        @media (max-width: 960px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.55; }
        }

        @media (max-width: 768px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.45; }
        }
      </style>

      <div data-lobby-scale-stage="1" style="width:1640px; margin:0 auto; zoom:var(--lobby-scale);">
        ${renderNav(state.isSearching)}

        <div style="max-width: 1640px; margin: 0 auto; padding: 16px 20px; background:#000000; box-sizing:border-box;">
          ${renderHeroSection(profileName, state.isConnected)}
          ${renderStakeSection(state.selectedStake, canStartSearch, state.isSearching)}
          ${renderBottomSection()}
          ${renderFooter()}
        </div>
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
