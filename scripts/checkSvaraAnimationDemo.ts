/**
 * checkSvaraAnimationDemo.ts — Свара, Етап 2А / 2А.1 (без браузър).
 *
 *  A. Модел на движението: крайни точки, асиметрична височина, отскок,
 *     обръщане, извита траектория, пътечки.
 *  B. Хореография: детерминизъм, 32 карти + 20 чипа, фази, вериги
 *     from/to без застъпване, само 3 заредени лица, коректна банка,
 *     без изчезване/удвояване на чипове, граници при различни размери.
 *  C. Измерител на кадрите (чиста функция).
 *  D. Изолация: pixi.js само в Pixi renderer-а, Белот/Ludo непроменени,
 *     svara chunks извън PWA precache (и проверка на dist/, ако има build).
 *
 * Пускане: npm run check:svara-animation-demo
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSvaraTracks, sampleSvaraMove, sampleSvaraTrack, SVARA_DEPTH_SCALE, SVARA_EASINGS, svaraHeightProfile, type SvaraMove } from '../src/app/games/svara/demo/svaraDemoMotion'
import { buildSvaraDemoScript, getSvaraDemoFinalStates, SVARA_DEMO_SOUND_SRCS } from '../src/app/games/svara/demo/svaraDemoScript'
import { summarizeSvaraFrameDeltas } from '../src/app/games/svara/demo/svaraDemoFrameMeter'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
// Мобилни (ширина × 1.25) и desktop размери, вкл. ограничена височина.
const SIZES: Array<[number, number]> = [[320, 432], [342, 462], [366, 494], [390, 527], [560, 380], [700, 420], [940, 564], [1100, 560], [1140, 684]]

console.log('\ncheckSvaraAnimationDemo')

// ─── A ───
console.log('\n=== A. движение ===')
const baseMove: SvaraMove = {
  id: 'x',
  from: { x: 10, y: 20, rotation: -4, scale: 1, alpha: 1, z: 1, faceUp: false },
  to: { x: 210, y: 120, rotation: 30, scale: 1.5, alpha: 0.5, z: 9, faceUp: true },
  delayMs: 0,
  durationMs: 400,
  easing: 'outQuart',
  rotationEasing: 'outBackSoft',
  curve: 0.12,
  lift: 0.6,
  liftPeak: 0.38,
  raisePx: 20,
  spinDeg: 10,
  bounce: 0,
}

check('A1. t=0 и t=1 дават точно началното и крайното състояние (вкл. крива и завъртане)', () => {
  const s0 = sampleSvaraMove(baseMove, 0)
  const s1 = sampleSvaraMove(baseMove, 1)
  assert(near(s0.x, 10) && near(s0.y, 20) && near(s0.rotation, -4) && near(s0.scaleY, 1) && near(s0.alpha, 1) && s0.faceUp === false && near(s0.height, 0), JSON.stringify(s0))
  assert(near(s1.x, 210) && near(s1.y, 120) && near(s1.rotation, 30) && near(s1.scaleY, 1.5) && near(s1.alpha, 0.5) && s1.faceUp === true && near(s1.height, 0), JSON.stringify(s1))
})

check('A2. височина: асиметричен профил — връх при liftPeak, 0 в краищата, „падане“ с ненулева скорост', () => {
  assert(near(svaraHeightProfile(baseMove, 0.38), 1, 1e-9), 'peak at liftPeak')
  assert(svaraHeightProfile(baseMove, 0.2) > 0.5 && svaraHeightProfile(baseMove, 0.95) > 0.02, 'shape')
  const slopeEnd = (svaraHeightProfile(baseMove, 1) - svaraHeightProfile(baseMove, 0.99)) / 0.01
  assert(slopeEnd < -1, `impact slope ${slopeEnd}`)
  const peak = sampleSvaraMove(baseMove, 0.38)
  const expectedScale = (1 + (1.5 - 1) * SVARA_EASINGS.outQuart(0.38)) * (1 + SVARA_DEPTH_SCALE * 0.6)
  assert(near(peak.scaleY, expectedScale, 1e-9), `peak scale ${peak.scaleY} vs ${expectedScale}`)
})

check('A3. отскок: малка втора гърбица в края, после 0', () => {
  const bouncy = { ...baseMove, bounce: 0.12 }
  assert(near(svaraHeightProfile(bouncy, 0.8), 0, 1e-9) && svaraHeightProfile(bouncy, 0.9) > 0.1 && near(svaraHeightProfile(bouncy, 1), 0, 1e-9), 'bounce hump')
})

check('A4. обръщане: лицето се сменя в средата, при |scaleX|≈0', () => {
  const before = sampleSvaraMove(baseMove, 0.498)
  const after = sampleSvaraMove(baseMove, 0.502)
  assert(before.faceUp === false && after.faceUp === true, 'face switch moment')
  assert(Math.abs(before.scaleX) < 0.05 * before.scaleY && Math.abs(after.scaleX) < 0.05 * after.scaleY, `scaleX ${before.scaleX} / ${after.scaleX}`)
})

check('A5. извита траектория: средата е встрани от правата линия', () => {
  const a = sampleSvaraMove({ ...baseMove, curve: 0, raisePx: 0 }, 0.3)
  const b = sampleSvaraMove({ ...baseMove, raisePx: 0 }, 0.3)
  assert(Math.hypot(a.x - b.x, a.y - b.y) > 5, 'curve offset')
})

check('A6. пътечка: паузата между движенията пази крайното състояние, стойностите са крайни', () => {
  const m1: SvaraMove = { ...baseMove, id: 't', delayMs: 0, durationMs: 100 }
  const m2: SvaraMove = { ...baseMove, id: 't', from: m1.to, to: { ...m1.to, x: 400 }, delayMs: 300, durationMs: 100 }
  const [track] = buildSvaraTracks([m2, m1])
  assert(track!.moves[0] === m1 && track!.startMs === 0 && track!.endMs === 400, 'sorted track')
  const hold = sampleSvaraTrack(track!, 200)
  assert(near(hold.x, 210) && near(hold.height, 0), `hold ${JSON.stringify(hold)}`)
  for (const t of [-50, 0, 50, 150, 350, 500]) {
    assert(Object.values(sampleSvaraTrack(track!, t)).every((v) => typeof v === 'boolean' || Number.isFinite(v)), `t=${t}`)
  }
})

// ─── B ───
console.log('\n=== B. хореография ===')

check('B1. детерминистична (два build-а са идентични)', () => {
  assert(JSON.stringify(buildSvaraDemoScript(1100, 650)) === JSON.stringify(buildSvaraDemoScript(1100, 650)), 'non-deterministic')
})

check('B2. 32 уникални карти + 20 чипа (по 5 на място), уникални id', () => {
  const script = buildSvaraDemoScript(1100, 650)
  const cards = script.sprites.filter((s) => s.kind === 'card')
  const chips = script.sprites.filter((s) => s.kind === 'chip')
  assert(cards.length === 32 && chips.length === 20, `${cards.length}/${chips.length}`)
  assert(new Set(script.sprites.map((s) => s.id)).size === script.sprites.length, 'duplicate ids')
})

check('B3. фази, пренареждане на ветрилото и звук при всяка раздадена карта', () => {
  const script = buildSvaraDemoScript(1100, 650)
  assert(script.phases.map((p) => p.name).join(',') === 'deal,reveal,bet,svarka,collect', script.phases.map((p) => p.name).join(','))
  const deal = script.phases[0]!
  assert(new Set(deal.moves.map((m) => m.id)).size === 12, 'dealt cards')
  // 12 полета + пренареждане (на място: 1 + 2 хода = 3) → 12 + 12 = 24
  assert(deal.moves.length === 24, `deal moves ${deal.moves.length}`)
  assert(deal.events.filter((e) => e.kind === 'sound').length === 12, 'deal sound per card')
  assert(script.phases[1]!.moves.length === 3 && script.phases[1]!.moves.every((m) => m.to.faceUp && !m.from.faceUp), 'reveal')
  assert(script.phases[3]!.showSvarkaBanner && script.phases.filter((p) => p.showSvarkaBanner).length === 1, 'svarka banner')
})

check('B4. вериги: всеки ход започва от предишното състояние; ходовете на един спрайт не се застъпват', () => {
  const script = buildSvaraDemoScript(390, 488)
  let current = script.initial
  script.phases.forEach((phase, i) => {
    const running = { ...current }
    for (const move of [...phase.moves].sort((a, b) => a.delayMs - b.delayMs)) {
      assert(JSON.stringify(move.from) === JSON.stringify(running[move.id]), `phase ${phase.name} ${move.id}`)
      running[move.id] = move.to
    }
    for (const track of buildSvaraTracks(phase.moves)) {
      for (let k = 1; k < track.moves.length; k += 1) {
        const prev = track.moves[k - 1]!
        assert(track.moves[k]!.delayMs >= prev.delayMs + prev.durationMs, `overlap ${track.id} in ${phase.name}`)
      }
    }
    assert(JSON.stringify(running) === JSON.stringify(script.statesAfter[i]), `statesAfter ${phase.name}`)
    current = script.statesAfter[i]!
  })
  assert(getSvaraDemoFinalStates(script) === current, 'final state')
})

check('B5. лице се зарежда само за 3-те обърнати карти; звуковите файлове съществуват', () => {
  const script = buildSvaraDemoScript(1100, 650)
  const withFace = script.sprites.filter((s) => s.kind === 'card' && s.faceSrc !== null).map((s) => s.id).sort()
  const revealed = script.phases[1]!.moves.map((m) => m.id).sort()
  assert(JSON.stringify(withFace) === JSON.stringify(revealed), `${withFace} vs ${revealed}`)
  for (const sprite of script.sprites) {
    if (sprite.kind === 'card' && sprite.faceSrc) assert(existsSync(join('public', sprite.faceSrc)), `missing ${sprite.faceSrc}`)
  }
  for (const src of Object.values(SVARA_DEMO_SOUND_SRCS)) assert(existsSync(join('public', src)), `missing ${src}`)
})

check('B6. банка: сумата = сумата на заложените чипове; при прибиране пада до 0; „+N“ = банката', () => {
  const script = buildSvaraDemoScript(1100, 650)
  const bet = script.phases[2]!
  const betSum = bet.moves.reduce((sum, m) => sum + script.chipValues[m.id]!, 0)
  const potEvents = bet.events.flatMap((e) => (e.kind === 'pot' ? [e.value] : []))
  assert(potEvents.length === 12 && potEvents[potEvents.length - 1] === betSum && bet.potAfter === betSum, `pot ${potEvents} vs ${betSum}`)
  assert(potEvents.every((v, i) => i === 0 || v > potEvents[i - 1]!), 'pot grows monotonically')
  const collect = script.phases[4]!
  const collectPots = collect.events.flatMap((e) => (e.kind === 'pot' ? [e.value] : []))
  assert(collectPots[collectPots.length - 1] === 0, 'pot ends at 0')
  const win = collect.events.find((e) => e.kind === 'winner')
  assert(win?.kind === 'winner' && win.amount === betSum && win.seat === 0, `winner ${JSON.stringify(win)}`)
})

check('B7. чиповете не изчезват и не се удвояват: винаги видими, без два на едно място; победителят има 14', () => {
  for (const [w, h] of SIZES) {
    const script = buildSvaraDemoScript(w, h)
    const final = getSvaraDemoFinalStates(script)
    const chips = script.sprites.filter((s) => s.kind === 'chip').map((s) => s.id)
    for (const snapshot of [script.initial, ...script.statesAfter]) {
      for (const id of chips) assert(snapshot[id]!.alpha === 1, `${id} hidden`)
      const positions = chips.map((id) => `${snapshot[id]!.x.toFixed(2)},${snapshot[id]!.y.toFixed(2)}`)
      assert(new Set(positions).size === positions.length, `${w}×${h}: two chips share a position (visual doubling)`)
    }
    const winnerStack = script.layout.seats[0]!.chipStack
    const onWinner = chips.filter((id) => near(final[id]!.x, winnerStack.x, 0.01))
    assert(onWinner.length === 14, `${w}×${h}: winner stack ${onWinner.length}`)
  }
})

for (const [w, h] of SIZES) {
  check(`B8. ${w}×${h}: спрайтовете и аватарите са в масата, без NaN (вкл. по време на полет)`, () => {
    const script = buildSvaraDemoScript(w, h)
    const { layout } = script
    const half = (id: string, scale: number) => ((id.startsWith('card') ? layout.cardHeight : layout.chipSize) * scale) / 2
    for (const snapshot of [script.initial, ...script.statesAfter]) {
      for (const [id, s] of Object.entries(snapshot)) {
        assert([s.x, s.y, s.rotation, s.scale, s.alpha].every(Number.isFinite), `${id} NaN`)
        const r = half(id, s.scale)
        assert(s.x - r >= -2 && s.x + r <= layout.width + 2 && s.y - r >= -2 && s.y + r <= layout.height + 2, `${id} out of bounds at ${s.x.toFixed(1)},${s.y.toFixed(1)}`)
      }
    }
    for (const phase of script.phases) {
      for (const move of phase.moves) {
        for (const t of [0.25, 0.4, 0.5, 0.75]) {
          const s = sampleSvaraMove(move, t)
          assert(Number.isFinite(s.x) && Number.isFinite(s.y), 'NaN in flight')
          const r = half(move.id, s.scaleY) * 0.7
          assert(s.x + r >= 0 && s.x - r <= layout.width && s.y + r >= 0 && s.y - r <= layout.height, `${move.id} flies off-table in ${phase.name}`)
        }
      }
    }
    for (const seat of layout.seats) {
      const r = layout.avatarSize / 2
      assert(seat.avatar.x - r >= 0 && seat.avatar.x + r <= layout.width && seat.avatar.y - r >= 0 && seat.avatar.y + r <= layout.height, `seat ${seat.index}`)
    }
  })
}

check('B9. обърнатите карти не застъпват собствения аватар; картите са ≥ 40 px на телефон', () => {
  for (const [w, h] of SIZES) {
    const script = buildSvaraDemoScript(w, h)
    const { layout } = script
    const avatar = layout.seats[0]!.avatar
    for (const move of script.phases[1]!.moves) {
      const bottom = move.to.y + (layout.cardHeight * move.to.scale) / 2
      assert(bottom <= avatar.y - layout.avatarSize / 2 + 2, `${w}×${h}: card bottom ${bottom.toFixed(1)} over avatar`)
    }
    if (w >= 340) assert(layout.cardWidth >= 40, `${w}×${h}: card ${layout.cardWidth}`)
  }
})

type Box = { x0: number; y0: number; x1: number; y1: number }
const boxOf = (s: { x: number; y: number; rotation: number; scale: number }, w: number, h: number): Box => {
  const a = (s.rotation * Math.PI) / 180
  const hw = ((Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) * s.scale) / 2
  const hh = ((Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) * s.scale) / 2
  return { x0: s.x - hw, y0: s.y - hh, x1: s.x + hw, y1: s.y + hh }
}
const union = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
})
const overlaps = (a: Box, b: Box, tolerance = 2) => a.x0 < b.x1 - tolerance && b.x0 < a.x1 - tolerance && a.y0 < b.y1 - tolerance && b.y0 < a.y1 - tolerance

check('B10. подредба: тестето, банката, ръцете и обърнатите карти не се застъпват (всички размери)', () => {
  for (const [w, h] of SIZES) {
    const script = buildSvaraDemoScript(w, h)
    const { layout } = script
    const card = (id: string, snapshot: Record<string, { x: number; y: number; rotation: number; scale: number }>) => boxOf(snapshot[id]!, layout.cardWidth, layout.cardHeight)
    const chip = (id: string, snapshot: Record<string, { x: number; y: number; rotation: number; scale: number }>) => boxOf(snapshot[id]!, layout.chipSize, layout.chipSize)
    const afterDeal = script.statesAfter[0]!
    const afterBet = script.statesAfter[2]!
    const dealt = new Set(script.phases[0]!.moves.map((m) => m.id))
    const revealed = new Set(script.phases[1]!.moves.map((m) => m.id))
    const deck = union(script.sprites.filter((s) => s.kind === 'card' && !dealt.has(s.id)).map((s) => card(s.id, afterDeal)))
    // Всяка раздадена карта принадлежи на най-близкия аватар.
    const seatOf = (id: string) => {
      const s = afterDeal[id]!
      const distances = layout.seats.map((seat) => Math.hypot(s.x - seat.avatar.x, s.y - seat.avatar.y))
      return distances.indexOf(Math.min(...distances))
    }
    const hands = [0, 1, 2, 3].map((seat) => union([...dealt].filter((id) => seatOf(id) === seat).map((id) => card(id, afterDeal))))
    const reveal = union([...revealed].map((id) => card(id, script.statesAfter[1]!)))
    const potChips = script.phases[2]!.moves.map((m) => m.id)
    const pot = union(potChips.map((id) => chip(id, afterBet)))
    const gathered = union(script.phases[4]!.moves.filter((m) => m.delayMs < 600).map((m) => boxOf(m.to, layout.chipSize, layout.chipSize)))
    for (const [seat, hand] of hands.entries()) {
      assert(!overlaps(deck, hand), `${w}×${h}: deck overlaps hand of seat ${seat}`)
      assert(!overlaps(pot, hand), `${w}×${h}: pot overlaps hand of seat ${seat}`)
      if (seat !== 0) assert(!overlaps(gathered, hand), `${w}×${h}: gathered pot overlaps hand of seat ${seat}`)
    }
    assert(!overlaps(pot, reveal), `${w}×${h}: pot overlaps revealed cards`)
    assert(!overlaps(gathered, reveal), `${w}×${h}: gathered pot overlaps revealed cards`)
    assert(!overlaps(deck, pot), `${w}×${h}: deck overlaps pot`)
  }
})

// ─── C ───
console.log('\n=== C. измерител ===')
check('C1. summarizeSvaraFrameDeltas: fps, p95, дълги кадри и моментите им', () => {
  const deltas = [...Array(58).fill(16.7), 50, 33.4]
  const ends = deltas.reduce<number[]>((acc, d) => [...acc, (acc[acc.length - 1] ?? 0) + d], [])
  const stats = summarizeSvaraFrameDeltas(deltas, 1000, ends)!
  assert(stats.frames === 60 && near(stats.avgFps, 60) && stats.longFrames === 2 && stats.maxFrameMs === 50, JSON.stringify(stats))
  assert(stats.longFrameAtMs.length === 2 && stats.longFrameAtMs[0] === Math.round(ends[58]!), JSON.stringify(stats.longFrameAtMs))
  assert(summarizeSvaraFrameDeltas([], 100) === null, 'empty')
})

// ─── D ───
console.log('\n=== D. изолация ===')
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(dir, e.name)] : []))
}

check('D1. pixi.js се импортира само от svaraDemoPixiRenderer.ts (и то само чрез dynamic import)', () => {
  const importers = walk('src').filter((f) => /from ['"]pixi\.js['"]|import\(['"]pixi\.js['"]\)/.test(readFileSync(f, 'utf8')))
  assert(importers.length === 1 && importers[0]!.replace(/\\/g, '/').endsWith('games/svara/demo/svaraDemoPixiRenderer.ts'), importers.join(', '))
  const staticImporters = walk('src').filter((f) => /from ['"]\.\/svaraDemoPixiRenderer['"]|from ['"].*svara\/demo\/svaraDemoPixiRenderer['"]/.test(readFileSync(f, 'utf8')))
  assert(staticImporters.length === 0, `static import of pixi renderer: ${staticImporters.join(', ')}`)
  const lobby = readFileSync(join('src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  assert(lobby.includes("await import('../games/svara/demo/createSvaraAnimationDemo')"), 'demo is not lazy-loaded')
  assert(!/^import .*svara\/demo/m.test(lobby), 'static import of demo in lobby controller')
})

check('D2. Белот (activeRoom) и Ludo модулите не са променени спрямо Етап 1 (9e0bc8b)', () => {
  const changed = execFileSync('git', ['diff', '--name-only', '9e0bc8b', '--', 'src/app/activeRoom', 'src/app/games/ludo', 'server/src/game'], { encoding: 'utf8' }).trim()
  assert(changed === '', changed)
})

check('D3. vite.config: svara chunks са именувани и изключени от PWA precache', () => {
  const config = readFileSync('vite.config.ts', 'utf8')
  assert(config.includes("globIgnores: ['index.html', 'assets/svara-*']"), 'globIgnores')
  assert(config.includes("'assets/svara-[name]-[hash].js'") && config.includes('facadeModuleId'), 'chunkFileNames')
})

if (existsSync(join('dist', 'sw.js'))) {
  check('D4. [dist] svara-* не са в precache манифеста; pixi кодът е само в svara-* chunks', () => {
    const sw = readFileSync(join('dist', 'sw.js'), 'utf8')
    assert(!sw.includes('svara-'), 'svara chunk in precache manifest')
    const assets = readdirSync(join('dist', 'assets')).filter((f) => f.endsWith('.js'))
    assert(assets.some((f) => f.startsWith('svara-') && f.includes('svaraDemoPixiRenderer')), 'pixi renderer chunk missing (stale build?)')
    const leaked = assets.filter((f) => !f.startsWith('svara-') && /autoDetectRenderer|GlProgram|svaraDemoPixiRenderer\(/.test(readFileSync(join('dist', 'assets', f), 'utf8')))
    assert(leaked.length === 0, `pixi code outside svara chunks: ${leaked.join(', ')}`)
    const html = readFileSync(join('dist', 'index.html'), 'utf8')
    assert(!html.includes('svara-'), 'svara chunk referenced from index.html (modulepreload)')
  })
} else {
  console.log('  skip D4 (няма dist/ — пусни npm run build)')
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
