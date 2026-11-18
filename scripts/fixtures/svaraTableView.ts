// Свара — текстов изглед на ИСТИНСКАТА маса за чистите проверки (без браузър):
// рамката (бутони, банер, прозорци за решения) + HUD-ът на местата + статусът
// в центъра + проекцията на лицата на картите, които сцената има право да
// покаже. Маркерите data-svara-showdown-cards / data-svara-reveal-cards
// описват проекцията (сцената рисува картите като спрайтове, не като HTML).
import {
  renderSvaraActiveTable, renderSvaraSceneSeatHuds, renderSvaraSceneStatusHtml, type RenderSvaraActiveTableInput,
} from '../../src/app/games/svara/table/renderSvaraActiveTable'
import { svaraSceneVisibleFaces } from '../../src/app/games/svara/table/svaraRealScene'

export function renderSvaraTableView(input: RenderSvaraActiveTableInput): string {
  const chrome = renderSvaraActiveTable(input)
  const snapshot = input.snapshot
  // Контролерът показва сцената само за snapshot-а на собствената маса.
  if (!snapshot || snapshot.matchId !== input.table.matchId) return chrome
  const huds = renderSvaraSceneSeatHuds(input).map((hud) => `<div data-svara-seat-index="${hud.seatIndex}">${hud.infoHtml}</div>`).join('')
  const round = snapshot.round
  const faces = Object.entries(svaraSceneVisibleFaces(snapshot, input.localProfileId)).map(([playerId, srcs]) => {
    const marker = round?.kind === 'reveal-choice' && round.winnerId === playerId ? 'data-svara-reveal-cards' : round?.kind === 'showdown-display' ? 'data-svara-showdown-cards' : 'data-svara-own-cards'
    return `<div ${marker}="${playerId}">${srcs.map((src) => `<img src="${src}">`).join('')}</div>`
  }).join('')
  return `${chrome}${huds}${renderSvaraSceneStatusHtml(input)}${faces}`
}
