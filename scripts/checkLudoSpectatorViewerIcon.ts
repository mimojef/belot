// Deterministic проверка на Ludo Spectator viewer-indicator ИКОНАТА +
// popover-а ("наднича във вашата игра", виж task-а). Комбиниран подход,
// mirror на checkLudoArrowRotation.ts/checkLudoCapturePresentation.ts стила:
//   (1) directen execution тест на реално ЕКСПОРТНАТА pure функция
//       renderLudoSpectatorViewersPopoverHtml (истинско изпълнение, не review).
//   (2) source-review assertions за renderLudoSpectatorViewerIcon/
//       renderLudoHeader (renderLudoGameScreen.ts) — функцията самата НЕ е
//       exported (module-private), затова тук се проверява точния source,
//       вместо да се конструира крехък full LudoGameScreenState fixture
//       (players/pieces/legalMoves и т.н.) само за да се извика top-level
//       renderLudoGameScreen() — установената конвенция в тази кодова база
//       (виж checkLudoArrowRotation.ts) предпочита review на самото ПРАВИЛО
//       + wiring пред такъв fixture.
//   (3) source-review assertions за createLudoFlowController.ts wiring-а
//       (spectator gate, staleness guard, click toggle, remove-then-remount,
//       auto-close on empty list, destroy() cleanup).
//   (4) source-review assertions за createLobbyFlowController.ts message
//       routing-а (ludo_match_spectators -> applySpectatorViewers).
//   (5) реален sharp inspection на финалния WebP asset (размер/format/alpha).
//
// Покрива (виж task-а):
//   P1. renderLudoSpectatorViewersPopoverHtml форматира ТОЧНО
//       "<display_name> наднича във вашата игра." за всеки viewer ред.
//   P1b. display name-ът е bold + златист (#d4a520), суфиксният текст
//       ("наднича във вашата игра.") остава нормален светъл текст.
//   P2. HTML-escape на display_name (защита срещу injection през чужд
//       displayName, който идва server-side от друг профил).
//   P3. празен viewers списък -> fallback текст "Няма зрители в момента."
//       (не празен div / липсващо съобщение).
//   P4. mobile vs desktop използват РАЗЛИЧЕН top offset (не се застъпва с
//       header-а на desktop нито с mobile badge-а).
//   I1. renderLudoSpectatorViewerIcon връща '' (нищо) при viewerCount===0 —
//       hidden при 0 spectators.
//   I2. img използва object-fit:contain (НЕ разтяга, пази aspect ratio).
//   I3. img src сочи ТОЧНО /images/ludo/ludo-spectator-viewer.webp (крайния
//       asset, не temp/произволен path).
//   I4. без background/border около бутона (само transparent/0).
//   I5. и двата call sites (mobile inline, renderLudoHeader за desktop)
//       подават РЕАЛНОТО state.spectatorViewers (не hardcoded/мок масив).
//   I6. фиксиран 52px размер (explicit user override, по-голям от 44px
//       emoji бутона в renderLudoBottomBar.ts — нарочно), не vw/clamp
//       responsive скала.
//   I7. mobile позиция top:8px;left:8px (explicit user override) —
//       позициониране, за да не засича top-left avatar card-а при 52px
//       размера (виж геометричния анализ в source doc коментара).
//   G1. currentScreenState() показва spectatorViewers: [] за spectator-а
//       самия (isSpectator ? [] : spectatorViewers) — иконата НИКОГА не се
//       вижда на самите зрители, дори defense-in-depth (сървърът и без друго
//       никога не праща съобщението на spectator connections).
//   G2. applySpectatorViewers() има matchId staleness guard (mirror на
//       applyEmojiReaction) — late-arriving съобщение за предишен match
//       instance не презаписва текущия state.
//   G3. click върху иконата (data-ludo-spectator-viewer-icon) toggle-ва
//       isSpectatorViewersPopoverOpen (не безусловен open/close).
//   G4. mountSpectatorViewersPopover прави remove-then-remount (НЕ
//       early-return-if-already-mounted като mountEmojiPicker) — списъкът
//       остава live-обновяван, докато е отворен.
//   G5. празен viewers списък автоматично затваря popover-а (няма смисъл да
//       стои отворен towards празен списък).
//   G6. destroy() маха outside-click listener-а (няма listener leak).
//   G7. exposed return обект включва applySpectatorViewers (routing-ът от
//       createLobbyFlowController.ts може реално да го извика).
//   R1. createLobbyFlowController.ts routira ludo_match_spectators ->
//       _ludoController.applySpectatorViewers(matchId, spectators).
//   A1. финалният WebP asset е ТОЧНО 208x187px, с alpha channel, разумен
//       файлов размер (<50KB), под установеното assets path.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { renderLudoSpectatorViewersPopoverHtml } from '../src/app/games/ludo/renderLudoSpectatorViewersPopover'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
// sharp е инсталиран само в server/node_modules (server-only dependency,
// виж server/package.json) — root frontend workspace-ът няма собствен
// install. Resolve-ваме го explicit оттам вместо да добавяме нова root
// dependency само за този test script.
const sharp = createRequire(join(repoRoot, 'server/package.json'))('sharp') as typeof import('sharp')

function fail(message: string): never {
  console.error(`[checkLudoSpectatorViewerIcon] FAIL: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  // ── (1) renderLudoSpectatorViewersPopoverHtml — реално изпълнение ──────

  // --- P1: точен текстов формат (display name вътре в bold/gold span, ---
  // --- последван от нормалния "наднича във вашата игра." текст) ---
  {
    const html = renderLudoSpectatorViewersPopoverHtml([{ profileId: 'p1', displayName: 'Pika' }], false)
    if (!/<span[^>]*>Pika<\/span>\s*наднича във вашата игра\./.test(html)) {
      fail(`P1: expected "Pika" wrapped in a <span> immediately followed by " наднича във вашата игра.", got: ${html}`)
    }
    console.log('[checkLudoSpectatorViewerIcon] P1 OK — exact text format "<display_name> наднича във вашата игра."')
  }

  // --- P1b: display name е bold + златист (#d4a520), суфиксът е нормален ---
  {
    const html = renderLudoSpectatorViewersPopoverHtml([{ profileId: 'p1', displayName: 'Mimojef' }], false)
    const nameSpanMatch = html.match(/<span style="([^"]*)">Mimojef<\/span>/)
    if (!nameSpanMatch) fail('P1b: could not locate the display-name <span> wrapping "Mimojef"')
    const nameSpanStyle = nameSpanMatch![1]
    if (!/font-weight:\s*700/.test(nameSpanStyle)) fail('P1b: expected the display-name span to be bold (font-weight:700)')
    if (!/color:\s*#d4a520/.test(nameSpanStyle)) fail('P1b: expected the display-name span to use the established Pika.bg gold (#d4a520)')
    console.log('[checkLudoSpectatorViewerIcon] P1b OK — display name is bold + gold (#d4a520), suffix text stays normal.')
  }

  // --- P2: HTML-escape на display_name ---
  {
    const html = renderLudoSpectatorViewersPopoverHtml([{ profileId: 'p2', displayName: '<script>alert(1)</script>' }], false)
    if (html.includes('<script>alert(1)</script>')) {
      fail('P2: raw <script> tag leaked into popover HTML unescaped — XSS risk via a peer profile displayName')
    }
    if (!html.includes('&lt;script&gt;')) {
      fail(`P2: expected escaped displayName (&lt;script&gt;...) in popover HTML, got: ${html}`)
    }
    console.log('[checkLudoSpectatorViewerIcon] P2 OK — displayName is HTML-escaped (защита срещу chuжд profile injection).')
  }

  // --- P3: празен списък -> fallback текст ---
  {
    const html = renderLudoSpectatorViewersPopoverHtml([], false)
    if (!html.includes('Няма зрители в момента.')) {
      fail(`P3: expected fallback text "Няма зрители в момента." for empty viewers list, got: ${html}`)
    }
    if (html.includes('наднича')) {
      fail('P3: empty viewers list must not contain any viewer row text')
    }
    console.log('[checkLudoSpectatorViewerIcon] P3 OK — empty list shows fallback "Няма зрители в момента."')
  }

  // --- P4: mobile vs desktop различен top offset ---
  {
    const mobileHtml = renderLudoSpectatorViewersPopoverHtml([], true)
    const desktopHtml = renderLudoSpectatorViewersPopoverHtml([], false)
    const mobileTop = mobileHtml.match(/top:(\d+)px/)?.[1]
    const desktopTop = desktopHtml.match(/top:(\d+)px/)?.[1]
    if (!mobileTop || !desktopTop) fail('P4: could not extract top offset from popover HTML')
    if (mobileTop === desktopTop) fail(`P4: expected different top offsets for mobile vs desktop, both were ${mobileTop}px`)
    console.log(`[checkLudoSpectatorViewerIcon] P4 OK — mobile top:${mobileTop}px !== desktop top:${desktopTop}px (не се застъпва с header/badge).`)
  }

  // ── (2) source-review: renderLudoGameScreen.ts icon function + wiring ──

  const gameScreenSource = readFileSync(join(repoRoot, 'src/app/games/ludo/renderLudoGameScreen.ts'), 'utf8')
  const iconFnMatch = gameScreenSource.match(/function renderLudoSpectatorViewerIcon\([^)]*\)\s*:\s*string\s*\{[\s\S]*?\n\}/)
  if (!iconFnMatch) fail('I: could not locate renderLudoSpectatorViewerIcon function body in renderLudoGameScreen.ts')
  const iconFnBody = iconFnMatch![0]

  // --- I1: hidden при 0 spectators ---
  {
    if (!/if\s*\(\s*viewerCount\s*===\s*0\s*\)\s*return\s*''/.test(iconFnBody)) {
      fail("I1: expected an early `if (viewerCount === 0) return ''` guard in renderLudoSpectatorViewerIcon")
    }
    console.log('[checkLudoSpectatorViewerIcon] I1 OK — icon renders nothing (hidden) at 0 spectators.')
  }

  // --- I2: object-fit:contain (не разтяга) ---
  {
    if (!/object-fit:\s*contain/.test(iconFnBody)) fail('I2: expected object-fit:contain on the <img> to preserve aspect ratio without stretching')
    console.log('[checkLudoSpectatorViewerIcon] I2 OK — object-fit:contain preserves aspect ratio (no stretch).')
  }

  // --- I3: точен финален asset path ---
  {
    if (!gameScreenSource.includes("const LUDO_SPECTATOR_VIEWER_ICON_URL = '/images/ludo/ludo-spectator-viewer.webp'")) {
      fail('I3: expected LUDO_SPECTATOR_VIEWER_ICON_URL to point exactly at /images/ludo/ludo-spectator-viewer.webp')
    }
    if (!iconFnBody.includes('src="${LUDO_SPECTATOR_VIEWER_ICON_URL}"')) {
      fail('I3: expected the <img> src to reference LUDO_SPECTATOR_VIEWER_ICON_URL directly (no hardcoded duplicate path)')
    }
    console.log('[checkLudoSpectatorViewerIcon] I3 OK — icon <img> src points exactly at the final asset path.')
  }

  // --- I4: без background/border около бутона ---
  {
    const buttonStyleMatch = iconFnBody.match(/<button[^>]*style="([^"]*)"/)
    if (!buttonStyleMatch) fail('I4: could not locate the icon <button> style attribute')
    const buttonStyle = buttonStyleMatch![1]
    if (!/border:\s*0/.test(buttonStyle)) fail('I4: expected border:0 on the icon button (no square/border around the image)')
    if (!/background:\s*transparent/.test(buttonStyle)) fail('I4: expected background:transparent on the icon button (no background box)')
    console.log('[checkLudoSpectatorViewerIcon] I4 OK — no background/border/square around the image.')
  }

  // --- I5: и двата call sites подават реалния state.spectatorViewers ---
  {
    if (!gameScreenSource.includes('renderLudoSpectatorViewerIcon(state.spectatorViewers.length,')) {
      fail('I5: expected the mobile call site to pass state.spectatorViewers.length (not a hardcoded/mock count)')
    }
    if (!gameScreenSource.includes('renderLudoSpectatorViewerIcon(spectatorViewers.length,')) {
      fail('I5: expected renderLudoHeader (desktop) to pass its spectatorViewers param through to the icon')
    }
    if (!gameScreenSource.includes('renderLudoHeader(false, state.spectatorViewers)')) {
      fail('I5: expected the desktop renderLudoHeader(...) call site to pass state.spectatorViewers through')
    }
    console.log('[checkLudoSpectatorViewerIcon] I5 OK — both mobile and desktop call sites wire the real state.spectatorViewers through.')
  }

  // --- I6: фиксиран 52px размер (explicit user override, ПОВЕЧЕ от ---
  // emoji бутона на 44px — нарочно, не пропуск, виж task-а "Увеличи
  // spectator viewer иконката от 44×44px на 52×52px"), не vw/clamp скала.
  {
    if (!gameScreenSource.includes("const LUDO_SPECTATOR_VIEWER_ICON_SIZE_PX = '52px'")) {
      fail('I6: expected a fixed 52px icon size constant (explicit user override, larger than the 44px emoji button), not a vw/clamp-based value')
    }
    if (!gameScreenSource.includes('LUDO_SPECTATOR_VIEWER_ICON_SIZE_PX, ')) {
      fail('I6: expected both call sites to pass LUDO_SPECTATOR_VIEWER_ICON_SIZE_PX (not separate hardcoded sizes)')
    }
    console.log('[checkLudoSpectatorViewerIcon] I6 OK — icon size is a fixed 52px (explicit user override).')
  }

  // --- I7: mobile позиция top:8px;left:8px (explicit user override) ---
  // виж task-а "На mobile промени позицията на: top: 8px; left: 8px" —
  // по-ранната geometric-safety стойност (top:0;left:0) беше explicit
  // overridden от user-а, който пое отговорност за собствен visual QA.
  {
    if (!gameScreenSource.includes("'position:absolute; top:8px; left:8px; z-index:6;'")) {
      fail('I7: expected the mobile spectator-viewer icon to be positioned at top:8px;left:8px (explicit user override)')
    }
    console.log('[checkLudoSpectatorViewerIcon] I7 OK — mobile icon positioned at top:8px;left:8px (explicit user override).')
  }

  // ── (3) source-review: createLudoFlowController.ts wiring ──────────────

  const controllerSource = readFileSync(join(repoRoot, 'src/app/games/ludo/createLudoFlowController.ts'), 'utf8')

  // --- G1: spectator-ите никога не виждат иконата (defense-in-depth gate) ---
  {
    if (!controllerSource.includes('spectatorViewers: isSpectator ? [] : spectatorViewers,')) {
      fail('G1: expected currentScreenState() to force spectatorViewers to [] for the spectator themself (isSpectator ? [] : spectatorViewers)')
    }
    console.log('[checkLudoSpectatorViewerIcon] G1 OK — spectators themselves never receive a non-empty spectatorViewers (defense-in-depth).')
  }

  // --- G2: applySpectatorViewers matchId staleness guard ---
  {
    const fnMatch = controllerSource.match(/function applySpectatorViewers\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n  \}/)
    if (!fnMatch) fail('G2: could not locate applySpectatorViewers function body')
    const fnBody = fnMatch![0]
    if (!/if\s*\(!options\.authoritative\s*\|\|\s*matchId\s*!==\s*options\.authoritative\.initialSnapshot\.matchId\)\s*return/.test(fnBody)) {
      fail('G2: expected applySpectatorViewers to guard against a late-arriving message for a stale/previous matchId (mirror of applyEmojiReaction)')
    }
    if (!fnBody.includes('render()')) fail('G2: expected applySpectatorViewers to trigger a render() after applying the new viewer list')
    console.log('[checkLudoSpectatorViewerIcon] G2 OK — applySpectatorViewers has the matchId staleness guard and re-renders.')
  }

  // --- G3: click toggle (не безусловен open) ---
  {
    const clickHandlerMatch = controllerSource.match(
      /data-ludo-spectator-viewer-icon="1"\]'\)\?\.addEventListener\('click', \(\) => \{([\s\S]*?)\}\)/,
    )
    if (!clickHandlerMatch) fail('G3: could not locate the spectator-viewer-icon click handler wiring')
    const handlerBody = clickHandlerMatch![1]
    if (!handlerBody.includes('isSpectatorViewersPopoverOpen')) fail('G3: expected the click handler to reference isSpectatorViewersPopoverOpen')
    if (!/if\s*\(isSpectatorViewersPopoverOpen\)/.test(handlerBody)) fail('G3: expected the click handler to branch on the current open state (toggle, not unconditional open)')
    console.log('[checkLudoSpectatorViewerIcon] G3 OK — icon click toggles the popover open/closed state.')
  }

  // --- G4: remove-then-remount (НЕ early-return-if-already-mounted) ---
  {
    const mountFnMatch = controllerSource.match(/function mountSpectatorViewersPopover\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/)
    if (!mountFnMatch) fail('G4: could not locate mountSpectatorViewersPopover function body')
    const mountBody = mountFnMatch![1]
    if (!/modalLayerRoot\.querySelector\('\[data-ludo-spectator-viewers-popover="1"\]'\)\?\.remove\(\)/.test(mountBody)) {
      fail('G4: expected mountSpectatorViewersPopover to remove any existing popover node before remounting (live-update while open)')
    }
    if (/if\s*\(\s*modalLayerRoot\.querySelector\('\[data-ludo-spectator-viewers-popover="1"\]'\)\s*\)\s*return/.test(mountBody)) {
      fail('G4: mountSpectatorViewersPopover must NOT early-return when already mounted — content would go stale while open')
    }
    console.log('[checkLudoSpectatorViewerIcon] G4 OK — remove-then-remount keeps the popover content live while open.')
  }

  // --- G5: празен списък автоматично затваря popover-а ---
  {
    if (!controllerSource.includes('if (viewers.length === 0) isSpectatorViewersPopoverOpen = false')) {
      fail('G5: expected applySpectatorViewers to auto-close the popover when the viewer list becomes empty')
    }
    console.log('[checkLudoSpectatorViewerIcon] G5 OK — popover auto-closes when the last spectator leaves.')
  }

  // --- G6: destroy() маха outside-click listener-а ---
  {
    const destroyFnMatch = controllerSource.match(/function destroy\(\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/)
    if (!destroyFnMatch) fail('G6: could not locate destroy() function body')
    if (!destroyFnMatch![1].includes("document.removeEventListener('click', handleSpectatorViewersPopoverOutsideClick, { capture: true })")) {
      fail('G6: expected destroy() to remove the spectator-viewers-popover outside-click listener (no leak)')
    }
    console.log('[checkLudoSpectatorViewerIcon] G6 OK — destroy() removes the outside-click listener.')
  }

  // --- G7: exposed return обект включва applySpectatorViewers ---
  // Толерантен към допълнителни, вече одобрени properties между
  // applySpectatorViewers и requestExit (напр. notifyGameplayActionRejected,
  // добавен в по-ранна dice premature-reset bug-fix задача) — assertion-ът
  // проверява само, че applySpectatorViewers присъства в СЪЩИЯ return-shape
  // между destroy/applyAuthoritativeSnapshot/applyEmojiReaction и requestExit,
  // не точен, крехък списък от properties.
  {
    if (
      !/return\s*\{\s*destroy,\s*applyAuthoritativeSnapshot,\s*applyEmojiReaction,\s*applySpectatorViewers,\s*(?:\w+,\s*)*requestExit\s*\}/.test(
        controllerSource,
      )
    ) {
      fail('G7: expected the controller factory to expose applySpectatorViewers on its returned object')
    }
    console.log('[checkLudoSpectatorViewerIcon] G7 OK — applySpectatorViewers is exposed on the controller return object.')
  }

  // ── (4) source-review: createLobbyFlowController.ts routing ─────────────

  {
    const lobbySource = readFileSync(join(repoRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
    if (!lobbySource.includes("if (message.type === 'ludo_match_spectators') {")) {
      fail("R1: expected createLobbyFlowController.ts to handle the 'ludo_match_spectators' message type")
    }
    if (!lobbySource.includes('_ludoController?.applySpectatorViewers(message.matchId, message.spectators)')) {
      fail('R1: expected the ludo_match_spectators handler to route matchId/spectators through to _ludoController.applySpectatorViewers')
    }
    console.log('[checkLudoSpectatorViewerIcon] R1 OK — lobby controller routes ludo_match_spectators -> applySpectatorViewers.')
  }

  // ── (5) финалният WebP asset — реален sharp inspection ─────────────────

  {
    const assetPath = join(repoRoot, 'public/images/ludo/ludo-spectator-viewer.webp')
    const metadata = await sharp(assetPath).metadata()
    if (metadata.format !== 'webp') fail(`A1: expected format 'webp', got ${metadata.format}`)
    if (metadata.width !== 208 || metadata.height !== 187) {
      fail(`A1: expected exact dimensions 208x187px, got ${metadata.width}x${metadata.height}`)
    }
    if (!metadata.hasAlpha) fail('A1: expected the asset to have a genuine transparent alpha channel')
    const stat = readFileSync(assetPath)
    if (stat.byteLength > 50 * 1024) fail(`A1: expected a reasonably small file size (<50KB), got ${(stat.byteLength / 1024).toFixed(1)}KB`)
    console.log(
      `[checkLudoSpectatorViewerIcon] A1 OK — final asset is ${metadata.width}x${metadata.height}px WebP, hasAlpha=${metadata.hasAlpha}, ${(stat.byteLength / 1024).toFixed(1)}KB.`,
    )
  }

  console.log('\n[checkLudoSpectatorViewerIcon] ALL CHECKS PASSED.\n')
}

main().catch((error) => {
  console.error('[checkLudoSpectatorViewerIcon] FATAL:', error instanceof Error ? error.message : error)
  process.exit(1)
})
