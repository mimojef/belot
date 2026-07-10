/**
 * checkCuttingPileStackOrderFix.ts
 *
 * Regression check за bug fix-а на cut-deck анимацията.
 *
 * История:
 *   - Оригинален бъг: при събирането на двата пакета обратно в купчина,
 *     ДЯСНАТА половина винаги оставаше визуално ОТГОРЕ (z-index = index+1,
 *     взет от оригиналния номер на картата), независимо от cut index-а.
 *   - Първи fix (само z-index): разменяше z-index диапазоните на двата
 *     пакета, но го правеше веднага (isCutAnimationVisible е true от
 *     elapsed=0мс), т.е. ДОКАТО пакетите все още се раздалечават — визуален
 *     скок по време на самото разделяне.
 *   - Този fix: анимацията минава през три ЯВНИ фази, кодирани directно в
 *     CSS @keyframes checkpoint-и (не JS timeout):
 *       separating (0% -> CUTTING_SEPARATED_PERCENT)      — оригинален ред,
 *       separated  (CUTTING_SEPARATED_HOLD_PERCENT, hold) — тук се сменя
 *                                                            z-index (discrete
 *                                                            CSS keyframe jump,
 *                                                            пакетите вече НЕ
 *                                                            се застъпват),
 *       gathering  (CUTTING_GATHER_START_PERCENT -> 100%) — движение towards
 *                                                            финалната купчина
 *                                                            с разменен ред
 *                                                            (дясно под ляво).
 *
 * Проверява:
 *   1. server/src/game/cutServerDeck.ts продължава да разменя реда коректно
 *      (bottomPart преди topPart) — gameplay логиката НЕ е пипана.
 *   2. Фазовите константи съществуват с очаквания relative ordering
 *      (separating < separated-hold < gather-start < 100).
 *   3. Desktop keyframes (belot-active-room-cut-left/-right): z-index остава
 *      --cut-from-zindex през целия separating segment (0% И на самата
 *      CUTTING_SEPARATED_PERCENT граница) и минава на --cut-gather-zindex
 *      едва на hold checkpoint-а (discrete jump), не по-рано.
 *   4. Gathering transform (--cut-final-transform) не започва преди
 *      CUTTING_GATHER_START_PERCENT — събирането стартира СЛЕД смяната на
 *      stack order-а, не едновременно с нея.
 *   5. Мобилната "light" cut анимация ползва същия keyframe механизъм
 *      (--mobile-cut-from-zindex / --mobile-cut-gather-zindex) и десният pile
 *      завършва под левия (gather z-index на десния < gather z-index на
 *      левия), докато при separating остава обратно (десен над ляв, за да не
 *      скочи видимо докато все още се разделят).
 *   7. Desktop inline/static z-index (извън animation keyframes) НЕ разкрива
 *      разменения ред предварително: докато анимацията тече (shouldAnimateCut),
 *      static z-index трябва да е originZIndex, не gatherZIndex — защото
 *      animation-fill-mode е forwards (не backwards/both), значи 0%
 *      keyframe стойността не се прилага автоматично по време на
 *      отрицателния animation-delay и браузърът fallback-ва към inline.
 *      Едва СЛЕД като анимацията реално приключи (played through) inline
 *      трябва да пази финалния (gather) ред статично.
 *   8. Mobile pile div-овете имат inline z-index, равен на СВОЯ собствен
 *      --mobile-cut-from-zindex (не --mobile-cut-gather-zindex) — т.е.
 *      началният inline ред е винаги оригиналният, никога предварително
 *      разменен.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'renderCuttingScreen.ts')
const SERVER_CUT_PATH = join(REPO_ROOT, 'server', 'src', 'game', 'cutServerDeck.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function pathToFileUrlWithCacheBust(path: string): string {
  return `${new URL(`file:///${path.replaceAll('\\', '/')}`).href}?t=${Date.now()}`
}

const renderSrc = await readFile(RENDER_PATH, 'utf8')
const serverCutSrc = await readFile(SERVER_CUT_PATH, 'utf8')

console.log('\n=== Cutting Pile Stack Order Fix Checks ===\n')

// [1] Backend cutServerDeck реално разменя реда (bottomPart преди topPart) —
//     gameplay логиката е правилна и не е засегната от frontend фикса.
await check('[1] cutServerDeck разменя реда: bottomPart преди topPart (непроменено)', async () => {
  assert(
    /return \[\.\.\.bottomPart, \.\.\.topPart\]/.test(serverCutSrc),
    'cutServerDeck трябва да върне [...bottomPart, ...topPart], за да размени реда реално',
  )

  const { cutServerDeck } = await import(pathToFileUrlWithCacheBust(SERVER_CUT_PATH))
  const deck = Array.from({ length: 8 }, (_, i) => i + 1)
  const result = cutServerDeck(deck, 3)
  assert(
    JSON.stringify(result) === JSON.stringify([4, 5, 6, 7, 8, 1, 2, 3]),
    `cutServerDeck([1..8], 3) трябва да е [4,5,6,7,8,1,2,3], получено: ${JSON.stringify(result)}`,
  )
})

// [2] Явни фазови константи съществуват с очаквания ordering
let separatedPercent = NaN
let separatedHoldPercent = NaN
let gatherStartPercent = NaN
await check('[2] Фазовите константи съществуват: separating < separated-hold < gather-start < 100', () => {
  const separatedMatch = renderSrc.match(/CUTTING_SEPARATED_PERCENT\s*=\s*(\d+(?:\.\d+)?)/)
  const holdMatch = renderSrc.match(/CUTTING_SEPARATED_HOLD_PERCENT\s*=\s*CUTTING_SEPARATED_PERCENT\s*\+\s*(\d+(?:\.\d+)?)/)
  const gatherMatch = renderSrc.match(/CUTTING_GATHER_START_PERCENT\s*=\s*(\d+(?:\.\d+)?)/)
  assert(separatedMatch !== null, 'CUTTING_SEPARATED_PERCENT не е намерена')
  assert(holdMatch !== null, 'CUTTING_SEPARATED_HOLD_PERCENT не е намерена (очаква се = CUTTING_SEPARATED_PERCENT + delta)')
  assert(gatherMatch !== null, 'CUTTING_GATHER_START_PERCENT не е намерена')

  separatedPercent = Number(separatedMatch![1])
  separatedHoldPercent = separatedPercent + Number(holdMatch![1])
  gatherStartPercent = Number(gatherMatch![1])

  assert(separatedPercent > 0 && separatedPercent < 100, 'CUTTING_SEPARATED_PERCENT трябва да е между 0 и 100')
  assert(separatedHoldPercent > separatedPercent, 'separated-hold трябва да е строго след separated checkpoint-а')
  assert(gatherStartPercent > separatedHoldPercent, 'gather-start трябва да е строго след separated-hold checkpoint-а (explicit "separated" фаза преди gathering)')
  assert(gatherStartPercent < 100, 'CUTTING_GATHER_START_PERCENT трябва да е преди 100%')
})

// [3] Desktop keyframes: z-index остава from-zindex през целия separating
//     segment (0% и на CUTTING_SEPARATED_PERCENT), сменя се едва на hold checkpoint-а.
await check('[3] Desktop keyframes НЕ сменят z-index преди separated-hold checkpoint-а', () => {
  for (const keyframeName of ['belot-active-room-cut-left', 'belot-active-room-cut-right']) {
    const keyframeMatch = renderSrc.match(
      new RegExp(`@keyframes ${keyframeName} \\{([\\s\\S]*?)\\n      \\}`),
    )
    assert(keyframeMatch !== null, `@keyframes ${keyframeName} не е намерен`)
    const body = keyframeMatch![1]

    const zeroPercentBlock = body.match(/0%\s*\{([^}]+)\}/)
    const separatedBlock = body.match(new RegExp(`\\$\\{CUTTING_SEPARATED_PERCENT\\}%\\s*\\{([^}]+)\\}`))
    const holdBlock = body.match(/SEPARATED_HOLD_PERCENT\}%\s*\{([^}]+)\}/)
    const gatherStartBlock = body.match(new RegExp(`\\$\\{CUTTING_GATHER_START_PERCENT\\}%\\s*\\{([^}]+)\\}`))
    const hundredBlock = body.match(/100%\s*\{([^}]+)\}/)

    assert(zeroPercentBlock !== null, `${keyframeName}: 0% block не е намерен`)
    assert(separatedBlock !== null, `${keyframeName}: CUTTING_SEPARATED_PERCENT block не е намерен`)
    assert(holdBlock !== null, `${keyframeName}: SEPARATED_HOLD_PERCENT block не е намерен`)
    assert(gatherStartBlock !== null, `${keyframeName}: CUTTING_GATHER_START_PERCENT block не е намерен`)
    assert(hundredBlock !== null, `${keyframeName}: 100% block не е намерен`)

    assert(
      zeroPercentBlock![1].includes('var(--cut-from-zindex)'),
      `${keyframeName}: 0% трябва да ползва --cut-from-zindex (оригинален ред при старт)`,
    )
    assert(
      separatedBlock![1].includes('var(--cut-from-zindex)'),
      `${keyframeName}: CUTTING_SEPARATED_PERCENT checkpoint трябва все още да ползва --cut-from-zindex — z-index НЕ трябва да се сменя докато пакетите все още се разделят`,
    )
    assert(
      holdBlock![1].includes('var(--cut-gather-zindex)'),
      `${keyframeName}: SEPARATED_HOLD_PERCENT checkpoint трябва да превключи на --cut-gather-zindex (discrete jump след пълно разделяне)`,
    )
    assert(
      gatherStartBlock![1].includes('var(--cut-gather-zindex)'),
      `${keyframeName}: CUTTING_GATHER_START_PERCENT checkpoint трябва да продължи с --cut-gather-zindex`,
    )
    assert(
      hundredBlock![1].includes('var(--cut-gather-zindex)'),
      `${keyframeName}: 100% checkpoint трябва да ползва --cut-gather-zindex`,
    )
  }
})

// [4] Gathering transform (--cut-final-transform) не започва преди
//     CUTTING_GATHER_START_PERCENT — split-transform продължава да важи чак
//     до gather-start checkpoint-а, т.е. събирането стартира СЛЕД explicit
//     separated фазата, не едновременно със смяната на z-index.
await check('[4] Gathering transform стартира едва от CUTTING_GATHER_START_PERCENT, не по-рано', () => {
  for (const keyframeName of ['belot-active-room-cut-left', 'belot-active-room-cut-right']) {
    const keyframeMatch = renderSrc.match(
      new RegExp(`@keyframes ${keyframeName} \\{([\\s\\S]*?)\\n      \\}`),
    )
    const body = keyframeMatch![1]
    const holdBlock = body.match(/SEPARATED_HOLD_PERCENT\}%\s*\{([^}]+)\}/)
    const gatherStartBlock = body.match(new RegExp(`\\$\\{CUTTING_GATHER_START_PERCENT\\}%\\s*\\{([^}]+)\\}`))

    assert(
      holdBlock![1].includes('var(--cut-split-transform)'),
      `${keyframeName}: SEPARATED_HOLD_PERCENT checkpoint трябва да пази --cut-split-transform (все още разделени, не е тръгнало събирането)`,
    )
    assert(
      gatherStartBlock![1].includes('var(--cut-split-transform)'),
      `${keyframeName}: CUTTING_GATHER_START_PERCENT checkpoint трябва да СТАРТИРА от --cut-split-transform (не --cut-final-transform по-рано)`,
    )
  }
})

// [5] Desktop cut картите изчисляват --cut-from-zindex / --cut-gather-zindex
//     чрез CSS custom properties (не статичен index+1 инлайн z-index по време
//     на анимация) и дясната половина завършва под лявата.
await check('[5] gatherZIndex подрежда дясната половина ПОД лявата (само за crайния CSS var)', () => {
  assert(
    renderSrc.includes('const gatherZIndex = isLeftSplitPile ? VISUAL_CARD_COUNT + cardNumber : cardNumber'),
    'gatherZIndex трябва да дава на лявата половина по-висок диапазон (VISUAL_CARD_COUNT + cardNumber) от дясната (cardNumber)',
  )
  assert(
    renderSrc.includes('--cut-from-zindex:${originZIndex};'),
    'animationStyle трябва да подава --cut-from-zindex:${originZIndex}',
  )
  assert(
    renderSrc.includes('--cut-gather-zindex:${gatherZIndex};'),
    'animationStyle трябва да подава --cut-gather-zindex:${gatherZIndex}',
  )
})

// [6] Мобилна light cut анимация: същият from/gather z-index механизъм,
//     с обърнат ред между двете фази (десен pile е над левия при separating,
//     под левия при gathering — размяната се случва чрез CSS discrete jump,
//     не веднага).
await check('[6] Мобилна light cut анимация: from-zindex и gather-zindex се разменят между двата pile-а', () => {
  const leftPileBlockMatch = renderSrc.match(
    /--mobile-cut-from-transform:translate\(0px, 0px\) rotate\(-1deg\);[\s\S]*?<\/div>/,
  )
  const rightPileBlockMatch = renderSrc.match(
    /--mobile-cut-from-transform:translate\(0px, 0px\) rotate\(1deg\);[\s\S]*?<\/div>/,
  )
  assert(leftPileBlockMatch !== null, 'Не е намерен левият mobile pile блок (rotate(-1deg))')
  assert(rightPileBlockMatch !== null, 'Не е намерен десният mobile pile блок (rotate(1deg))')

  const leftBlock = leftPileBlockMatch![0]
  const rightBlock = rightPileBlockMatch![0]

  const leftFrom = leftBlock.match(/--mobile-cut-from-zindex:\$\{([^}]+)\}/)
  const leftGather = leftBlock.match(/--mobile-cut-gather-zindex:\$\{([^}]+)\}/)
  const rightFrom = rightBlock.match(/--mobile-cut-from-zindex:\$\{([^}]+)\}/)
  const rightGather = rightBlock.match(/--mobile-cut-gather-zindex:\$\{([^}]+)\}/)

  assert(leftFrom !== null, 'Левият pile няма --mobile-cut-from-zindex')
  assert(leftGather !== null, 'Левият pile няма --mobile-cut-gather-zindex')
  assert(rightFrom !== null, 'Десният pile няма --mobile-cut-from-zindex')
  assert(rightGather !== null, 'Десният pile няма --mobile-cut-gather-zindex')

  assert(
    leftFrom![1].trim() === 'VISUAL_CARD_COUNT + 2' && rightFrom![1].trim() === 'VISUAL_CARD_COUNT + 3',
    `При separating (from) десният pile трябва да е НАД левия (оригинален ред, без скок): ляво=${leftFrom![1]}, дясно=${rightFrom![1]}`,
  )
  assert(
    leftGather![1].trim() === 'VISUAL_CARD_COUNT + 3' && rightGather![1].trim() === 'VISUAL_CARD_COUNT + 2',
    `При gathering десният pile трябва да е ПОД левия (разменен ред): ляво=${leftGather![1]}, дясно=${rightGather![1]}`,
  )

  const keyframeMatch = renderSrc.match(
    /@keyframes belot-active-room-mobile-cut-pile \{([\s\S]*?)\n      \}/,
  )
  assert(keyframeMatch !== null, '@keyframes belot-active-room-mobile-cut-pile не е намерен')
  const body = keyframeMatch![1]
  const zeroBlock = body.match(/0%\s*\{([^}]+)\}/)
  const separatedBlock = body.match(new RegExp(`\\$\\{CUTTING_SEPARATED_PERCENT\\}%\\s*\\{([^}]+)\\}`))
  const holdBlock = body.match(/SEPARATED_HOLD_PERCENT\}%\s*\{([^}]+)\}/)

  assert(zeroBlock![1].includes('var(--mobile-cut-from-zindex)'), 'mobile keyframe 0% трябва да ползва --mobile-cut-from-zindex')
  assert(
    separatedBlock![1].includes('var(--mobile-cut-from-zindex)'),
    'mobile keyframe на CUTTING_SEPARATED_PERCENT трябва все още да ползва --mobile-cut-from-zindex (не е сменено докато се разделят)',
  )
  assert(
    holdBlock![1].includes('var(--mobile-cut-gather-zindex)'),
    'mobile keyframe на SEPARATED_HOLD_PERCENT трябва да превключи на --mobile-cut-gather-zindex',
  )
})

// [7] Desktop inline/static z-index пази оригиналния ред докато анимацията
//     тече — не разкрива gather реда преди keyframe-ите да го приложат.
await check('[7] Desktop static z-index пази оригиналния ред, освен след played-through анимация', () => {
  assert(
    renderSrc.includes('const hasAnimationPlayedThrough = isCutAnimationVisible && !shouldAnimateCut'),
    'Очаква се explicit hasAnimationPlayedThrough = isCutAnimationVisible && !shouldAnimateCut',
  )
  assert(
    renderSrc.includes('const staticZIndex = hasAnimationPlayedThrough ? gatherZIndex : originZIndex'),
    'staticZIndex трябва да е originZIndex докато анимацията тече (shouldAnimateCut), и gatherZIndex само след played-through — НЕ директно isCutAnimationVisible ? gatherZIndex : originZIndex',
  )
  assert(
    !/const staticZIndex = isCutAnimationVisible \? gatherZIndex : originZIndex/.test(renderSrc),
    'staticZIndex не трябва повече да разкрива gatherZIndex веднага при isCutAnimationVisible (тогава inline би показал разменения ред по време на самото разделяне / animation-delay)',
  )
  assert(
    renderSrc.includes('z-index:${staticZIndex};'),
    'Cut картите трябва да ползват z-index:${staticZIndex} инлайн',
  )
})

// [8] Mobile pile div-овете: inline z-index = собствения --mobile-cut-from-zindex,
//     не --mobile-cut-gather-zindex — началният ред никога не е предварително разменен.
await check('[8] Mobile pile inline z-index стартира от собствения from-zindex (не gather)', () => {
  // "-4deg" (ляв, final rotate) и "-2deg" (десен, final rotate) са уникални anchor-и
  // за всеки от двата <div> блока — избягва двусмислие с rotate(-1deg)/rotate(1deg).
  const leftPileBlockMatch = renderSrc.match(
    /<div\s+aria-hidden="true"\s+style="[\s\S]*?rotate\(-4deg\);[\s\S]*?<\/div>/,
  )
  const rightPileBlockMatch = renderSrc.match(
    /<div\s+aria-hidden="true"\s+style="[\s\S]*?rotate\(-2deg\);[\s\S]*?<\/div>/,
  )
  assert(leftPileBlockMatch !== null, 'Не е намерен левият mobile pile блок (rotate(-1deg))')
  assert(rightPileBlockMatch !== null, 'Не е намерен десният mobile pile блок (rotate(1deg))')

  for (const [label, block] of [
    ['ляв', leftPileBlockMatch![0]],
    ['десен', rightPileBlockMatch![0]],
  ] as const) {
    const inlineZIndexMatch = block.match(/\bz-index:\$\{([^}]+)\};/)
    const fromZIndexMatch = block.match(/--mobile-cut-from-zindex:\$\{([^}]+)\}/)
    const gatherZIndexMatch = block.match(/--mobile-cut-gather-zindex:\$\{([^}]+)\}/)
    assert(inlineZIndexMatch !== null, `${label} pile: не е намерен инлайн z-index:\${...}`)
    assert(fromZIndexMatch !== null, `${label} pile: не е намерен --mobile-cut-from-zindex`)
    assert(gatherZIndexMatch !== null, `${label} pile: не е намерен --mobile-cut-gather-zindex`)

    assert(
      inlineZIndexMatch![1].trim() === fromZIndexMatch![1].trim(),
      `${label} pile: инлайн z-index (${inlineZIndexMatch![1]}) трябва да съвпада с --mobile-cut-from-zindex (${fromZIndexMatch![1]}), не с gather стойността`,
    )
    assert(
      inlineZIndexMatch![1].trim() !== gatherZIndexMatch![1].trim(),
      `${label} pile: инлайн z-index не трябва да съвпада с --mobile-cut-gather-zindex (${gatherZIndexMatch![1]}) — това би разкрило разменения ред предварително`,
    )
  }
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
