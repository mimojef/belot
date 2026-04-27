# Belot V2 — Claude Code Context

## Комуникация
Отговаряй **на български език** винаги.

## Проект
Server-authoritative белот игра (Bulgarian card game).
- **Клиент:** TypeScript + Vite (`src/`)
- **Сървър:** Node.js + WebSocket + SQLite (`server/src/`)
- **Legacy reference:** `legacy/browser-gameplay-reference/` — само за визуален reference, не се модифицира

Истината е **на сървъра**. Клиентът само визуализира snapshot-и, получени по WebSocket.

---

## Архитектура — ключови файлове

### Клиент
| Файл | Роля |
|------|------|
| `src/main.ts` | Entry point, wire-up на контролери и WebSocket клиент |
| `src/app/network/createGameServerClient.ts` | WebSocket клиент + **всички клиентски типове** (RoomGameSnapshot и т.н.) |
| `src/app/activeRoom/createActiveRoomFlowController.ts` | Master контролер за активна стая — всички фази |
| `src/app/activeRoom/cutting/renderCuttingSeatPanels.ts` | Avatar панели с dealt cards и speech bubbles |
| `src/app/activeRoom/renderCuttingScreen.ts` | Cutting фаза визуализация |
| `src/app/activeRoom/renderDealingScreen.ts` | Deal анимация (CSS пакети летят към играчите) |
| `src/app/activeRoom/renderBiddingScreen.ts` | Bidding UI — bid popup, countdown bar, bot takeover popup |
| `src/app/activeRoom/cutting/cuttingSeatLayout.ts` | Позиции на панелите, seat order, visual seat mapping |

### Сървър
| Файл | Роля |
|------|------|
| `server/src/protocol/messageTypes.ts` | Всички протоколни типове (RoomSnapshotMessage и т.н.) |
| `server/src/protocol/createRoomSnapshotMessage.ts` | Създава snapshot за клиента от authoritative state |
| `server/src/game/serverGameTypes.ts` | Authoritative game state типове |
| `server/src/game/serverTimingConfig.ts` | Таймери: bid/cut/play = 15 сек human, 1 сек bot |
| `server/src/game/advanceOneServerStep.ts` | Главен game loop стъпка |
| `server/src/game/pickServerBotBidAction.ts` | Bot bid логика |

---

## Координатна система

- **Stage:** 1600×900 px, мащабиран с `stageScale` (fit to viewport). Използва се за dealing анимации.
- **Панели:** `position:fixed`, позиционирани в viewport координати чрез `getCuttingSeatPanelAnchorStyle()`.
- **Dealt card fans:** в anchor coordinate space (преди scale transform на anchor-а).
- **Панел scale:** `transform:scale(0.8)` само на вътрешния panel div — dealt cards НЕ се засягат.

---

## Завършени фази

### ✅ Cutting фаза
- CSS анимация за цепенето
- Avatar панели с dealer badge и 15-сек countdown bar
- Server-authoritative submit

### ✅ Deal-first-3 фаза
- CSS пакет анимации (4 играча × 3 карти)
- Dealt card fans в панелите (зад avatar panel)
- Fan позиции: 200px към ръбовете (top: допълнителни 100px = 300px)

### ✅ Deal-next-2 фаза
- Същата анимация, 2 карти
- Карти 0-2 остават видими; карти 3-4 се анимират (`animStartIndex: 3`)
- Completion timer прави re-render само ако сървърът вече е минал фазата

### ✅ Bidding фаза (имплементирана, чака тестване)
- `RoomBiddingSnapshot` в протокола: `currentBidderSeat`, `canSubmitBid`, `entries`, `winningBid`, `validActions`
- Bid popup: 4 масти + Без/Всичко коз + Контра/Реконтра + Пас, 15-сек countdown bar
- Speech балончета над панелите при всяка обява (3.2 сек lifecycle анимация с fade)
- Bot takeover notification: "Поради изтичане на времето играта беше поета от робот" + "Върни се"
- `BiddingUiState` в контролера проследява: балончета, pending submission, wasMyTurn за bot detect

---

## Следващи стъпки

1. **Тестване на bidding фаза** — bid popup, speech балончета, bot takeover notification
2. **Deal-last-3 фаза** — след bidding се раздават последните 3 карти (до 8 общо)
3. **Playing Screen** — игране на карти (trick-based gameplay)
4. **Scoring Screen** — резултати след рунд
5. **Reconnect** — resume mid-game state
6. **Bot takeover** — пълна интеграция за всички фази

---

## Важни технически правила

### CSS анимации с карти
- Използвай CSS `scale:` property (Level 2), НЕ `transform:scale()` в @keyframes.
  **Защо:** `transform:scale()` в keyframes презаписва позиционния `transform:translate(...)`.
- `animation-fill-mode: both` — карти стартират невидими преди delay и остават видими след анимация.

### Dealing patch блок (в контролера)
- Ранно излизане само ако `renderedPhaseKey === activePhaseKey` (същата анимация вече рендирана).
- При нова фаза — fall-through към пълен render (актуализира и сцена, и панели).

### Deal-next-2 completion
- НЕ вика `renderActiveRoomScreen()` при нормално завършване.
- Вика го само ако `authoritativePhase !== 'deal-next-2'` (сървърът вече е минал напред).

### Bidding screen условие
- `isShowingBiddingPhase = !isShowingAnyDealPhase && authoritativePhase === 'bidding'`
- `shouldRenderCompletedDealNextTwoHands` изключва `authoritativePhase === 'bidding'`

---

## Типове за справка

```typescript
// Snapshot за обявяването (от сървъра)
RoomBiddingSnapshot {
  currentBidderSeat: Seat | null
  canSubmitBid: boolean          // true само за локалния играч при негов ред
  entries: RoomBidEntrySnapshot[]
  winningBid: RoomWinningBidSnapshot
  validActions: RoomValidBidActionsSnapshot | null
}

// Dealt cards в панелите
DealtHandsData {
  handCounts: Record<Seat, number>
  ownHand: RoomCardSnapshot[]
  localSeat: Seat
  maxCardsPerSeat: number     // 3 (deal-first-3) | 5 (deal-next-2 / bidding)
  animStartIndex: number      // 0 (deal-first-3) | 3 (deal-next-2)
  seatAnimDelays: Partial<Record<Seat, number>> | null
}

// Speech балонче
SeatBidBubble { label: string; elapsedMs: number }
```

---

## Git

- **Активен branch:** `v2-clean-architecture`
- **Main branch:** `main`
- **Git user:** mimojef
