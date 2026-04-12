export type GameAudioController = {
  playBidBubble(label: string): void
  playDeclarationBubble(lines: string[]): void
  playCardMove(): void
  scheduleDealPacketSounds(sequenceKey: string): void
  clearDealPacketSounds(): void
  reset(): void
}

type CreateGameAudioControllerOptions = {
  bidBasePath?: string
  declarationBasePath?: string
  sfxBasePath?: string
  dealPacketCount?: number
  dealPacketStartDelayMs?: number
  dealPacketDelayStepMs?: number
  dealPacketLiftOffsetMs?: number
}

const DEFAULT_BID_BASE_PATH = '/audio/table-calls'
const DEFAULT_DECLARATION_BASE_PATH = '/audio/table-calls'
const DEFAULT_SFX_BASE_PATH = '/audio/card-sfx'

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
  const declarationBasePath = options.declarationBasePath ?? DEFAULT_DECLARATION_BASE_PATH
  const sfxBasePath = options.sfxBasePath ?? DEFAULT_SFX_BASE_PATH

  const dealPacketCount = options.dealPacketCount ?? DEFAULT_DEAL_PACKET_COUNT
  const dealPacketStartDelayMs =
    options.dealPacketStartDelayMs ?? DEFAULT_DEAL_PACKET_START_DELAY_MS
  const dealPacketDelayStepMs =
    options.dealPacketDelayStepMs ?? DEFAULT_DEAL_PACKET_DELAY_STEP_MS
  const dealPacketLiftOffsetMs =
    options.dealPacketLiftOffsetMs ?? DEFAULT_DEAL_PACKET_LIFT_OFFSET_MS

  let lastPassVariantIndex = -1
  let speechQueue: string[] = []
  let activeSpeechAudio: HTMLAudioElement | null = null
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

  function stopBackgroundAudio(): void {
    clearSpeechQueue()
    clearSpeechAudio()
    clearDealPacketSounds()
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

  function resolveBidAudioFiles(label: string): string[] {
    const entry = BID_AUDIO_BY_LABEL[label]

    if (!entry) {
      return []
    }

    if (label === 'Пас') {
      return [buildFilePath(bidBasePath, pickPassVariant())]
    }

    const fileNames = Array.isArray(entry) ? entry : [entry]
    return fileNames.map((fileName) => buildFilePath(bidBasePath, fileName))
  }

  function resolveDeclarationSpeechSources(lines: string[]): string[] {
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
      return [buildFilePath(declarationBasePath, `${comboFileBaseName}.mp3`)]
    }

    return sortedSlugs.map((slug) => buildFilePath(declarationBasePath, `${slug}.mp3`))
  }

  function playBidBubble(label: string): void {
    const sources = resolveBidAudioFiles(label)

    if (sources.length === 0) {
      return
    }

    enqueueSpeechSequence(sources)
  }

  function playDeclarationBubble(lines: string[]): void {
    const sources = resolveDeclarationSpeechSources(lines)

    if (sources.length === 0) {
      return
    }

    enqueueSpeechSequence(sources)
  }

  function playCardMove(): void {
    playSfx(buildFilePath(sfxBasePath, 'card-move.mp3'))
  }

  function scheduleDealPacketSounds(sequenceKey: string): void {
    if (!sequenceKey) {
      return
    }

    if (activeDealPacketSequenceKey === sequenceKey) {
      return
    }

    clearDealPacketSounds()
    activeDealPacketSequenceKey = sequenceKey

    for (let index = 0; index < dealPacketCount; index += 1) {
      const delay =
        dealPacketStartDelayMs +
        index * dealPacketDelayStepMs +
        dealPacketLiftOffsetMs

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
    scheduleDealPacketSounds,
    clearDealPacketSounds,
    reset,
  }
}