export type GameAudioController = {
  playBidBubble(label: string, gender?: VoiceGender | null): void
  playDeclarationBubble(lines: string[], gender?: VoiceGender | null): void
  playCardMove(): void
  playCardOnTable(): void
  playMatchEnded(): void
  syncReactionCountdownWarning(shouldPlay: boolean): void
  scheduleDealPacketSounds(sequenceKey: string, timing?: DealPacketSoundTiming): void
  clearDealPacketSounds(): void
  primeGameplaySfx(): void
  reset(): void
}

export type DealPacketSoundTiming = {
  packetCount?: number
  packetStartDelayMs?: number
  packetDelayStepMs?: number
  packetLiftOffsetMs?: number
}

type CreateGameAudioControllerOptions = {
  bidBasePath?: string
  declarationBasePath?: string
  femaleBidBasePath?: string
  femaleDeclarationBasePath?: string
  sfxBasePath?: string
  dealPacketCount?: number
  dealPacketStartDelayMs?: number
  dealPacketDelayStepMs?: number
  dealPacketLiftOffsetMs?: number
}

type VoiceGender = 'male' | 'female'

const DEFAULT_BID_BASE_PATH = '/audio/table-calls'
const DEFAULT_DECLARATION_BASE_PATH = '/audio/table-calls'
const DEFAULT_FEMALE_BID_BASE_PATH = '/audio/table-calls-women'
const DEFAULT_FEMALE_DECLARATION_BASE_PATH = '/audio/table-calls-women'
const DEFAULT_SFX_BASE_PATH = '/audio/card-sfx'
const DEFAULT_GAME_SOUNDS_BASE_PATH = '/audio/game-sounds'
const REACTION_COUNTDOWN_WARNING_FILE = 'counter.mp3'
const REACTION_COUNTDOWN_WARNING_OVERLAP_MS = 90

const DEFAULT_DEAL_PACKET_COUNT = 4
const DEFAULT_DEAL_PACKET_START_DELAY_MS = 220
const DEFAULT_DEAL_PACKET_DELAY_STEP_MS = 420
const DEFAULT_DEAL_PACKET_LIFT_OFFSET_MS = 138

const BID_AUDIO_BY_LABEL: Record<string, string[] | string> = {
  'Спатия': 'clubs.mp3',
  'Каро': 'diamonds.mp3',
  'Купа': 'hearts.mp3',
  'Пика': 'spades.mp3',
  'Без коз': 'no-trumps.mp3',
  'Всичко коз': 'all-trumps.mp3',
  'Контра': 'double.mp3',
  'Ре контра': 'redouble.mp3',
  'Реконтра': 'redouble.mp3',
  'Пас': ['pass-1.mp3', 'pass-2.mp3', 'pass-3.mp3'],
}

const DECLARATION_AUDIO_BY_LABEL: Record<string, string> = {
  'Белот': 'belote',
  'Каре': 'square',
  'Терца': 'terca',
  'Кварта': 'fifty',
  '50': 'fifty',
  'Квинта': 'hundred',
  '100': 'hundred',
  '2 белота': 'two-belotes',
  '2 карета': 'two-squares',
  '2 терци': 'two-terci',
  '2 кварти': 'two-fifties',
  '2 петици': 'two-hundreds',
  '2 50': 'two-fifties',
  '2 100': 'two-hundreds',
}

const DECLARATION_COMBO_ORDER = [
  'belote',
  'two-belotes',
  'square',
  'two-squares',
  'terca',
  'two-terci',
  'fifty',
  'two-fifties',
  'hundred',
  'two-hundreds',
]

type ReactionCountdownLoop = {
  audios: [HTMLAudioElement, HTMLAudioElement]
  timeoutId: number | null
  nextIndex: number
  isStopped: boolean
}

function normalizeDeclarationLines(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function mapDeclarationLineToSlug(line: string): string | null {
  return DECLARATION_AUDIO_BY_LABEL[line] ?? null
}

function sortDeclarationSlugs(slugs: string[]): string[] {
  return [...slugs].sort((left, right) => {
    const leftIndex = DECLARATION_COMBO_ORDER.indexOf(left)
    const rightIndex = DECLARATION_COMBO_ORDER.indexOf(right)

    const safeLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
    const safeRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex

    if (safeLeftIndex !== safeRightIndex) {
      return safeLeftIndex - safeRightIndex
    }

    return left.localeCompare(right)
  })
}

function createAudio(src: string): HTMLAudioElement {
  const audio = new Audio(src)
  audio.preload = 'auto'
  return audio
}

// card-on-table/card-move are latency-sensitive: they fire in direct
// response to a visible card animation, so unlike other SFX they can't
// afford a per-play `new Audio()` (fetch+decode start-up cost, worst on
// iOS Safari). Elements are created and `.load()`-ed once at controller
// init and round-robin reused. Pool size 4 covers the maximum realistic
// overlap — one full trick's worth of card-on-table plays, or one full
// deal packet burst (DEFAULT_DEAL_PACKET_COUNT) — without a later play
// cutting off an earlier one still finishing.
const CARD_SFX_POOL_SIZE = 4

type PreloadedSfxPool = {
  play(): void
  prime(): void
}

function createPreloadedSfxPool(src: string, size: number): PreloadedSfxPool {
  const elements: HTMLAudioElement[] = []

  for (let i = 0; i < size; i += 1) {
    const audio = createAudio(src)
    audio.load()
    elements.push(audio)
  }

  let nextIndex = 0

  function play(): void {
    if (!canPlayAudioNow()) {
      return
    }

    const audio = elements[nextIndex]
    nextIndex = (nextIndex + 1) % elements.length

    try {
      audio.currentTime = 0
    } catch {
      // Safari can throw if the element isn't seekable yet (readyState too
      // low) — playback below still proceeds from wherever it currently is.
    }

    void audio.play().catch(() => {})
  }

  // One-time iOS unlock: play()+pause() a preloaded element synchronously
  // inside a real user gesture so later programmatic play() calls (fired
  // from timers/animation callbacks, not gestures) aren't blocked/delayed.
  // Muted for the duration of the unlock so it can't produce an audible
  // blip — play() resolves once playback has *started*, not once it's
  // silent again, so the brief window between play() and pause() would
  // otherwise be audible at full volume. Mute state is captured/restored
  // per element (not hardcoded to false) and restored on both the success
  // and failure path, so a pool element can never get stuck muted for
  // real gameplay playback afterwards.
  function prime(): void {
    for (const audio of elements) {
      const wasMuted = audio.muted
      audio.muted = true

      const restore = () => {
        audio.pause()
        audio.currentTime = 0
        audio.muted = wasMuted
      }

      const playResult = audio.play()

      if (playResult && typeof playResult.then === 'function') {
        playResult.then(restore).catch(restore)
      } else {
        restore()
      }
    }
  }

  return { play, prime }
}

function buildFilePath(basePath: string, fileName: string): string {
  return `${basePath.replace(/\/+$/, '')}/${fileName}`
}

function canPlayAudioNow(): boolean {
  if (typeof document === 'undefined') {
    return true
  }

  if (document.visibilityState !== 'visible') {
    return false
  }

  if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return false
  }

  return true
}

export function createGameAudioController(
  options: CreateGameAudioControllerOptions = {},
): GameAudioController {
  const bidBasePath = options.bidBasePath ?? DEFAULT_BID_BASE_PATH
  const declarationBasePath =
    options.declarationBasePath ?? DEFAULT_DECLARATION_BASE_PATH
  const femaleBidBasePath =
    options.femaleBidBasePath ?? DEFAULT_FEMALE_BID_BASE_PATH
  const femaleDeclarationBasePath =
    options.femaleDeclarationBasePath ?? DEFAULT_FEMALE_DECLARATION_BASE_PATH
  const sfxBasePath = options.sfxBasePath ?? DEFAULT_SFX_BASE_PATH

  const dealPacketCount = options.dealPacketCount ?? DEFAULT_DEAL_PACKET_COUNT
  const dealPacketStartDelayMs =
    options.dealPacketStartDelayMs ?? DEFAULT_DEAL_PACKET_START_DELAY_MS
  const dealPacketDelayStepMs =
    options.dealPacketDelayStepMs ?? DEFAULT_DEAL_PACKET_DELAY_STEP_MS
  const dealPacketLiftOffsetMs =
    options.dealPacketLiftOffsetMs ?? DEFAULT_DEAL_PACKET_LIFT_OFFSET_MS

  const cardOnTablePool = createPreloadedSfxPool(
    buildFilePath(sfxBasePath, 'card-on-table.mp3'),
    CARD_SFX_POOL_SIZE,
  )
  const cardMovePool = createPreloadedSfxPool(
    buildFilePath(sfxBasePath, 'card-move.mp3'),
    CARD_SFX_POOL_SIZE,
  )
  let hasPrimedGameplaySfx = false

  let lastPassVariantIndex = -1
  let speechQueue: string[] = []
  let activeSpeechAudio: HTMLAudioElement | null = null
  let activeReactionCountdownLoop: ReactionCountdownLoop | null = null
  let activeDealPacketSequenceKey: string | null = null
  let dealPacketTimeoutIds: number[] = []

  function clearSpeechAudio(): void {
    if (!activeSpeechAudio) {
      return
    }

    activeSpeechAudio.pause()
    activeSpeechAudio.currentTime = 0
    activeSpeechAudio = null
  }

  function clearSpeechQueue(): void {
    speechQueue = []
  }

  function clearDealPacketSounds(): void {
    for (const timeoutId of dealPacketTimeoutIds) {
      window.clearTimeout(timeoutId)
    }

    dealPacketTimeoutIds = []
    activeDealPacketSequenceKey = null
  }

  function stopReactionCountdownWarning(): void {
    if (!activeReactionCountdownLoop) {
      return
    }

    const loop = activeReactionCountdownLoop
    loop.isStopped = true

    if (loop.timeoutId !== null) {
      window.clearTimeout(loop.timeoutId)
    }

    for (const audio of loop.audios) {
      audio.pause()
      audio.currentTime = 0
    }

    activeReactionCountdownLoop = null
  }

  function stopBackgroundAudio(): void {
    clearSpeechQueue()
    clearSpeechAudio()
    clearDealPacketSounds()
    stopReactionCountdownWarning()
  }

  function playNextSpeechFromQueue(): void {
    if (activeSpeechAudio || speechQueue.length === 0) {
      return
    }

    if (!canPlayAudioNow()) {
      clearSpeechQueue()
      return
    }

    const nextSrc = speechQueue.shift()

    if (!nextSrc) {
      return
    }

    const audio = createAudio(nextSrc)
    activeSpeechAudio = audio

    const finalize = () => {
      if (activeSpeechAudio !== audio) {
        return
      }

      activeSpeechAudio = null
      playNextSpeechFromQueue()
    }

    audio.onended = finalize
    audio.onerror = finalize

    void audio.play().catch(() => {
      finalize()
    })
  }

  function enqueueSpeech(src: string): void {
    if (!canPlayAudioNow()) {
      return
    }

    speechQueue.push(src)
    playNextSpeechFromQueue()
  }

  function enqueueSpeechSequence(sources: string[]): void {
    if (!canPlayAudioNow()) {
      return
    }

    for (const src of sources) {
      enqueueSpeech(src)
    }
  }

  function playSfx(src: string): void {
    if (!canPlayAudioNow()) {
      return
    }

    const audio = createAudio(src)
    void audio.play().catch(() => {})
  }

  function pickPassVariant(): string {
    const options = BID_AUDIO_BY_LABEL['Пас']

    if (!Array.isArray(options) || options.length === 0) {
      return 'pass-1.mp3'
    }

    if (options.length === 1) {
      lastPassVariantIndex = 0
      return options[0]
    }

    let nextIndex = Math.floor(Math.random() * options.length)

    if (nextIndex === lastPassVariantIndex) {
      nextIndex = (nextIndex + 1) % options.length
    }

    lastPassVariantIndex = nextIndex
    return options[nextIndex]
  }

  function getBidBasePath(gender?: VoiceGender | null): string {
    return gender === 'female' ? femaleBidBasePath : bidBasePath
  }

  function getDeclarationBasePath(gender?: VoiceGender | null): string {
    return gender === 'female' ? femaleDeclarationBasePath : declarationBasePath
  }

  function resolveBidAudioFiles(label: string, gender?: VoiceGender | null): string[] {
    const entry = BID_AUDIO_BY_LABEL[label]

    if (!entry) {
      return []
    }

    if (label === 'Пас') {
      return [buildFilePath(getBidBasePath(gender), pickPassVariant())]
    }

    const fileNames = Array.isArray(entry) ? entry : [entry]
    return fileNames.map((fileName) => buildFilePath(getBidBasePath(gender), fileName))
  }

  function resolveDeclarationSpeechSources(lines: string[], gender?: VoiceGender | null): string[] {
    const normalizedLines = normalizeDeclarationLines(lines)
    const slugs = normalizedLines
      .map(mapDeclarationLineToSlug)
      .filter((slug): slug is string => Boolean(slug))

    if (slugs.length === 0) {
      return []
    }

    const sortedSlugs = sortDeclarationSlugs(slugs)
    const comboFileBaseName = sortedSlugs.join('-')

    const comboFilesThatExist = new Set([
      'belote-fifty',
      'belote-hundred',
      'belote-terca',
      'belote-square',
      'square-fifty',
      'square-terca',
      'terca-fifty',
      'terca-hundred',
      'belote-square-fifty',
      'belote-square-terca',
      'belote-terca-fifty',
      'belote-terca-hundred',
      'belote-two-fifties',
      'belote-two-squares',
      'belote-two-terci',
    ])

    if (comboFilesThatExist.has(comboFileBaseName)) {
      return [buildFilePath(getDeclarationBasePath(gender), `${comboFileBaseName}.mp3`)]
    }

    return sortedSlugs.map((slug) =>
      buildFilePath(getDeclarationBasePath(gender), `${slug}.mp3`),
    )
  }

  function playBidBubble(label: string, gender?: VoiceGender | null): void {
    const sources = resolveBidAudioFiles(label, gender)

    if (sources.length === 0) {
      return
    }

    enqueueSpeechSequence(sources)
  }

  function playDeclarationBubble(lines: string[], gender?: VoiceGender | null): void {
    const sources = resolveDeclarationSpeechSources(lines, gender)

    if (sources.length === 0) {
      return
    }

    enqueueSpeechSequence(sources)
  }

  function playCardMove(): void {
    cardMovePool.play()
  }

  function playCardOnTable(): void {
    cardOnTablePool.play()
  }

  function playMatchEnded(): void {
    playSfx(buildFilePath(DEFAULT_GAME_SOUNDS_BASE_PATH, 'EndGame.mp3'))
  }

  function primeGameplaySfx(): void {
    if (hasPrimedGameplaySfx) {
      return
    }

    hasPrimedGameplaySfx = true
    cardOnTablePool.prime()
    cardMovePool.prime()
  }

  function syncReactionCountdownWarning(shouldPlay: boolean): void {
    if (!shouldPlay || !canPlayAudioNow()) {
      stopReactionCountdownWarning()
      return
    }

    if (activeReactionCountdownLoop !== null) {
      return
    }

    const src = buildFilePath(
      DEFAULT_GAME_SOUNDS_BASE_PATH,
      REACTION_COUNTDOWN_WARNING_FILE,
    )
    const loop: ReactionCountdownLoop = {
      audios: [createAudio(src), createAudio(src)],
      timeoutId: null,
      nextIndex: 1,
      isStopped: false,
    }
    activeReactionCountdownLoop = loop

    function playLoopAudio(audio: HTMLAudioElement): void {
      audio.pause()
      audio.currentTime = 0
      void audio.play().catch(() => {
        if (activeReactionCountdownLoop === loop) {
          stopReactionCountdownWarning()
        }
      })
    }

    function scheduleNextFrom(audio: HTMLAudioElement): void {
      if (loop.isStopped || activeReactionCountdownLoop !== loop) {
        return
      }

      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        audio.addEventListener(
          'loadedmetadata',
          () => {
            scheduleNextFrom(audio)
          },
          { once: true },
        )
        return
      }

      const durationMs = audio.duration * 1000
      const delayMs = Math.max(
        60,
        durationMs - REACTION_COUNTDOWN_WARNING_OVERLAP_MS,
      )

      loop.timeoutId = window.setTimeout(() => {
        if (loop.isStopped || activeReactionCountdownLoop !== loop) {
          return
        }

        const nextAudio = loop.audios[loop.nextIndex]
        loop.nextIndex = (loop.nextIndex + 1) % loop.audios.length

        playLoopAudio(nextAudio)
        scheduleNextFrom(nextAudio)
      }, delayMs)
    }

    for (const audio of loop.audios) {
      audio.load()
    }

    const firstAudio = loop.audios[0]
    playLoopAudio(firstAudio)
    scheduleNextFrom(firstAudio)
  }

  function scheduleDealPacketSounds(sequenceKey: string, timing: DealPacketSoundTiming = {}): void {
    if (!sequenceKey) {
      return
    }

    if (activeDealPacketSequenceKey === sequenceKey) {
      return
    }

    clearDealPacketSounds()
    activeDealPacketSequenceKey = sequenceKey

    const packetCount = timing.packetCount ?? dealPacketCount
    const packetStartDelayMs = timing.packetStartDelayMs ?? dealPacketStartDelayMs
    const packetDelayStepMs = timing.packetDelayStepMs ?? dealPacketDelayStepMs
    const packetLiftOffsetMs = timing.packetLiftOffsetMs ?? dealPacketLiftOffsetMs

    for (let index = 0; index < packetCount; index += 1) {
      const delay =
        packetStartDelayMs +
        index * packetDelayStepMs +
        packetLiftOffsetMs

      const timeoutId = window.setTimeout(() => {
        if (activeDealPacketSequenceKey !== sequenceKey) {
          return
        }

        if (!canPlayAudioNow()) {
          return
        }

        playCardMove()
      }, delay)

      dealPacketTimeoutIds.push(timeoutId)
    }
  }

  function reset(): void {
    stopBackgroundAudio()
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!canPlayAudioNow()) {
        stopBackgroundAudio()
      }
    })
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('blur', () => {
      stopBackgroundAudio()
    })
  }

  return {
    playBidBubble,
    playDeclarationBubble,
    playCardMove,
    playCardOnTable,
    playMatchEnded,
    syncReactionCountdownWarning,
    scheduleDealPacketSounds,
    clearDealPacketSounds,
    primeGameplaySfx,
    reset,
  }
}
