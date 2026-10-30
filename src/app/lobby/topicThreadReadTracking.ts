// „Теми“ — отваряне на нишка при първия непрочетен отговор, автоматично
// зареждане при скрол и отчитане на прочетеното по реална видимост.
//
// Само за нишките в „Теми“ (thread view). „Лафче“ няма thread view и не
// минава оттук.
//
// Прочетеното е СЪЩИЯТ сървърен праг (topic_thread_read_state.last_seen_seq),
// не втора система: клиентът го вдига само до последния НЕПРЕКЪСНАТО видян
// непрочетен отговор. Прескочен (невидян) отговор спира прага пред себе си —
// при следващо отваряне разделителят „Нови отговори“ застава точно там.

/** Колко дълго отговорът трябва да е на екрана, за да се брои за прочетен. */
export const TOPIC_THREAD_SEEN_DWELL_MS = 600
/** Разстояние до ръба на скрола, при което се зарежда следващата страница. */
export const TOPIC_THREAD_AUTOLOAD_EDGE_PX = 360
const TOPIC_THREAD_WATCH_POLL_MS = 150

export type TopicThreadReadItem = { seq: number; isUnread: boolean }

/**
 * Новият праг: минава през всички заредени елементи над текущия праг, докато
 * среща само прочетени (isUnread=false, напр. собствени) или реално видени;
 * спира пред първия невиден непрочетен. Никога не връща по-малко от watermark.
 */
export function computeTopicThreadContiguousSeenSeq(
  items: readonly TopicThreadReadItem[],
  seenSeqs: ReadonlySet<number>,
  watermark: number,
): number {
  let next = watermark
  const sorted = [...items].sort((a, b) => a.seq - b.seq)
  for (const item of sorted) {
    if (item.seq <= watermark) continue
    if (item.isUnread && !seenSeqs.has(item.seq)) break
    next = item.seq
  }
  return next
}

type VerticalRect = { top: number; bottom: number; height: number }

/** По-висок от изгледа → не може да се види наведнъж; отчита се по ленти. */
export function isTopicThreadItemTall(itemRect: VerticalRect, viewRect: VerticalRect): boolean {
  return itemRect.height > viewRect.height
}

/**
 * Отговор, който се събира в изгледа, е „видян“, ако поне 60% от него е на
 * екрана. Дългите (isTopicThreadItemTall) никога не минават оттук — иначе
 * първият екран от многоекранен отговор би маркирал и невидяното под него.
 */
export function isTopicThreadItemReadable(itemRect: VerticalRect, viewRect: VerticalRect): boolean {
  if (itemRect.height <= 0 || isTopicThreadItemTall(itemRect, viewRect)) return false
  const visible = Math.min(itemRect.bottom, viewRect.bottom) - Math.max(itemRect.top, viewRect.top)
  return visible > 0 && visible / itemRect.height >= 0.6
}

/**
 * Дълъг отговор, разделен на ленти по половин изглед (последната може да е
 * по-къса). Връща индексите на лентите, които са ИЗЦЯЛО на екрана в момента.
 * Отговорът е прочетен, когато всяка лента е стояла на екрана поне dwell —
 * при постепенно четене това става естествено, а при рязко прескачане
 * лентите минават твърде бързо и не се броят.
 */
export function getTopicThreadFullyVisibleBands(itemRect: VerticalRect, viewRect: VerticalRect): { bandHeight: number; bandCount: number; visibleBands: number[] } {
  const bandHeight = Math.max(40, Math.floor(viewRect.height / 2))
  const bandCount = Math.max(1, Math.ceil(itemRect.height / bandHeight))
  const visibleBands: number[] = []
  for (let index = 0; index < bandCount; index++) {
    const bandTop = itemRect.top + index * bandHeight
    const bandBottom = Math.min(bandTop + bandHeight, itemRect.bottom)
    if (bandTop >= viewRect.top - 1 && bandBottom <= viewRect.bottom + 1) visibleBands.push(index)
  }
  return { bandHeight, bandCount, visibleBands }
}

export function findTopicThreadScrollElement(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
}

/** Котва за запазване на позицията: първият елемент, който се вижда в горния край. */
export function captureTopicThreadScrollAnchor(root: ParentNode): { seq: number; top: number } | null {
  const scrollEl = findTopicThreadScrollElement(root)
  if (scrollEl === null) return null
  const viewTop = scrollEl.getBoundingClientRect().top
  for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-thread-seq]'))) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > viewTop) {
      const seq = Number(el.dataset.topicThreadSeq)
      return Number.isFinite(seq) ? { seq, top: rect.top } : null
    }
  }
  return null
}

export function restoreTopicThreadScrollAnchor(root: ParentNode, anchor: { seq: number; top: number } | null): void {
  if (anchor === null) return
  const scrollEl = findTopicThreadScrollElement(root)
  const el = scrollEl?.querySelector<HTMLElement>(`[data-topic-thread-seq="${anchor.seq}"]`) ?? null
  if (scrollEl === null || el === null) return
  const delta = el.getBoundingClientRect().top - anchor.top
  if (Math.abs(delta) >= 0.5) scrollEl.scrollTop += delta
}

export function isTopicThreadNearBottom(root: ParentNode, thresholdPx = 96): boolean {
  const scrollEl = findTopicThreadScrollElement(root)
  return scrollEl === null || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= thresholdPx
}

export type TopicThreadViewportWatcher = {
  start: () => void
  stop: () => void
  /** Незабавна проверка (след програмен скрол/вмъкване). */
  evaluate: () => void
}

/**
 * Следи thread скрола: видимост с dwell (бързо прескочените отговори не се
 * броят) и близост до ръбовете за автоматично зареждане. Скрол елементът се
 * открива наново при всяка проверка, защото пълен render() го подменя.
 */
export function createTopicThreadViewportWatcher(options: {
  root: HTMLElement
  onSeen: (seqs: number[]) => void
  onNearTop: () => void
  onNearBottom: () => void
  dwellMs?: number
}): TopicThreadViewportWatcher {
  const dwellMs = options.dwellMs ?? TOPIC_THREAD_SEEN_DWELL_MS
  // Ключ: "seq" за отговор, който се събира в изгледа; "seq:лента" за дълъг.
  const visibleSince = new Map<string, number>()
  const reported = new Set<number>()
  const tallProgress = new Map<number, { bandHeight: number; bandCount: number; done: Set<number> }>()
  let boundScrollEl: HTMLElement | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null

  const onScroll = (): void => evaluate()

  function bind(): HTMLElement | null {
    const scrollEl = findTopicThreadScrollElement(options.root)
    if (scrollEl === boundScrollEl) return scrollEl
    boundScrollEl?.removeEventListener('scroll', onScroll)
    boundScrollEl = scrollEl
    boundScrollEl?.addEventListener('scroll', onScroll, { passive: true })
    return scrollEl
  }

  function evaluate(): void {
    const scrollEl = bind()
    if (scrollEl === null || !scrollEl.isConnected) {
      visibleSince.clear()
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      visibleSince.clear()
      return
    }

    const now = Date.now()
    const viewRect = scrollEl.getBoundingClientRect()
    const visibleNow = new Map<string, { seq: number; band: number | null }>()
    if (viewRect.height > 0) {
      for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-thread-seq]'))) {
        const seq = Number(el.dataset.topicThreadSeq)
        if (!Number.isFinite(seq) || reported.has(seq)) continue
        const itemRect = el.getBoundingClientRect()
        if (!isTopicThreadItemTall(itemRect, viewRect)) {
          if (isTopicThreadItemReadable(itemRect, viewRect)) visibleNow.set(String(seq), { seq, band: null })
          continue
        }
        const bands = getTopicThreadFullyVisibleBands(itemRect, viewRect)
        const progress = tallProgress.get(seq)
        // Смяна на размера (снимка, завъртане) → ново разделение; натрупаното
        // се губи — консервативно, никога не брои невидяно.
        if (progress === undefined || progress.bandHeight !== bands.bandHeight || progress.bandCount !== bands.bandCount) {
          tallProgress.set(seq, { bandHeight: bands.bandHeight, bandCount: bands.bandCount, done: new Set() })
        }
        for (const band of bands.visibleBands) visibleNow.set(`${seq}:${band}`, { seq, band })
      }
    }
    for (const key of [...visibleSince.keys()]) {
      if (!visibleNow.has(key)) visibleSince.delete(key)
    }
    const seen: number[] = []
    for (const [key, item] of visibleNow) {
      const since = visibleSince.get(key)
      if (since === undefined) {
        visibleSince.set(key, now)
        continue
      }
      if (now - since < dwellMs) continue
      visibleSince.delete(key)
      if (item.band !== null) {
        const progress = tallProgress.get(item.seq)
        progress?.done.add(item.band)
        if (progress === undefined || progress.done.size < progress.bandCount) continue
        tallProgress.delete(item.seq)
      }
      if (!reported.has(item.seq)) {
        reported.add(item.seq)
        seen.push(item.seq)
      }
    }
    if (seen.length > 0) options.onSeen(seen)

    if (scrollEl.scrollTop <= TOPIC_THREAD_AUTOLOAD_EDGE_PX) options.onNearTop()
    if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= TOPIC_THREAD_AUTOLOAD_EDGE_PX) options.onNearBottom()
  }

  function start(): void {
    if (intervalId !== null) return
    intervalId = setInterval(evaluate, TOPIC_THREAD_WATCH_POLL_MS)
    evaluate()
  }

  function stop(): void {
    if (intervalId !== null) clearInterval(intervalId)
    intervalId = null
    boundScrollEl?.removeEventListener('scroll', onScroll)
    boundScrollEl = null
    visibleSince.clear()
    reported.clear()
    tallProgress.clear()
  }

  return { start, stop, evaluate }
}
