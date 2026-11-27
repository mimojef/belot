// Fixture за checkSvaraSeatGrid.ts — РЕАЛНИЯТ createSvaraLobbyController (през
// Vite), без backend. ?light=1 — светлата мобилна рамка (data-lobby-member-mobile-light).
// Таблиците идват така, както ги праща сървърът (svara_tables_list → setTables).
import '/src/style.css'
import { createSvaraLobbyController } from '/src/app/games/svara/createSvaraLobbyController.ts'

const params = new URLSearchParams(window.location.search)
const app = document.getElementById('app') as HTMLElement
let root = app
if (params.get('light') === '1') {
  const frame = document.createElement('div')
  frame.setAttribute('data-lobby-member-mobile-light', '1')
  const mount = document.createElement('div')
  frame.appendChild(mount)
  app.appendChild(frame)
  root = mount
}
const joins: Array<{ matchId: string; seat: number | null }> = []
const controller = createSvaraLobbyController({
  root,
  localProfileId: 'viewer',
  onRefresh() {}, onCreate() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() {},
  onJoin: (matchId: string, seat?: number) => { joins.push({ matchId, seat: seat ?? null }) },
} as any)

;(window as any).__svaraSeats = {
  joins,
  setTables: (tables: unknown[]) => controller.setTables(tables as any, []),
  setMyTable: (table: unknown) => controller.setMyTable(table as any),
  showMessage: (text: string) => controller.showMessage(text),
}
