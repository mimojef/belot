// „Теми“ — отваряне на нишка при първия непрочетен отговор, автоматично
// зареждане при скрол и отчитане на прочетеното по ръчно преминаване.
//
// Само за нишките в „Теми“ (thread view). „Лафче“ няма thread view и не
// минава оттук.
//
// Прочетеното е СЪЩИЯТ сървърен праг (topic_thread_read_state.last_seen_seq),
// не втора система: клиентът го вдига до последния отговор, достигнат
// ПОСЛЕДОВАТЕЛНО (read cursor). Отговорът е достигнат, когато долният му ръб
// е бил в изгледа — показан на екрана или преминат при ръчен скрол надолу,
// независимо от скоростта (продуктово решение: бързото скролване до края
// изчиства значката умишлено). Програмните движения (начално позициониране,
// прескок до края, корекция на позицията при зареждане/освобождаване) НЕ
// преминават през съдържанието — прескочените остават непрочетени.

/**
 * Предварително зареждане (prefetch): следващата страница тръгва, когато над
 * (под) изгледа остават най-много толкова заредени отговора ИЛИ толкова
 * височини на изгледа заредено съдържание — кое настъпи първо. Двата прага
 * заедно покриват и къси отговори, и дълги текстове/снимки. Мерят се спрямо
 * края на ЗАРЕДЕНИТЕ отговори, не спрямо root картата.
 */
export const TOPIC_THREAD_PREFETCH_REPLIES = 10
export const TOPIC_THREAD_PREFETCH_VIEWPORTS = 1.5

type ViewEdge = { top: number; bottom: number; height: number }

/**
 * Колко заредено съдържание остава над/под изгледа: брой отговори изцяло
 * извън изгледа в тази посока (до limit+1) и разстоянието в px до края на
 * заредените. Подава се списъкът с отговорите на прозореца в DOM ред.
 */
export function measureTopicThreadLoadedBeyondView(
  replyRects: readonly { top: number; bottom: number }[],
  viewRect: ViewEdge,
  limit = TOPIC_THREAD_PREFETCH_REPLIES,
): { above: { count: number; px: number }; below: { count: number; px: number } } {
  if (replyRects.length === 0) return { above: { count: 0, px: 0 }, below: { count: 0, px: 0 } }
  let countAbove = 0
  for (let i = 0; i < replyRects.length && countAbove <= limit; i++) {
    if (replyRects[i]!.bottom <= viewRect.top) countAbove++
    else break
  }
  let countBelow = 0
  for (let i = replyRects.length - 1; i >= 0 && countBelow <= limit; i--) {
    if (replyRects[i]!.top >= viewRect.bottom) countBelow++
    else break
  }
  return {
    above: { count: countAbove, px: Math.max(0, viewRect.top - replyRects[0]!.top) },
    below: { count: countBelow, px: Math.max(0, replyRects[replyRects.length - 1]!.bottom - viewRect.bottom) },
  }
}

export function shouldPrefetchTopicThreadEdge(beyond: { count: number; px: number }, viewHeight: number): boolean {
  return beyond.count <= TOPIC_THREAD_PREFETCH_REPLIES || beyond.px <= viewHeight * TOPIC_THREAD_PREFETCH_VIEWPORTS
}
const TOPIC_THREAD_WATCH_POLL_MS = 150

export type TopicThreadReadItem = { seq: number; isUnread: boolean }

/**
 * Read cursor: минава през всички известни отговори над текущия праг, докато
 * среща само прочетени (isUnread=false, напр. собствени) или достигнати;
 * спира пред първия недостигнат непрочетен. Никога не връща по-малко от
 * watermark.
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

/**
 * Достигнат ли е отговорът: долният му ръб е в изгледа сега, или е в
 * ивицата, през която ръчният скрол надолу току-що е минал (passedPx над
 * горния ръб на изгледа). Дълъг отговор, чийто край още е под изгледа, не е
 * достигнат — при частично скролване се брои само достигнатата част.
 */
export function isTopicThreadItemReached(itemRect: { bottom: number; height: number }, viewRect: { top: number; bottom: number }, passedPx: number): boolean {
  if (itemRect.height <= 0) return false
  return itemRect.bottom <= viewRect.bottom + 1 && itemRect.bottom >= viewRect.top - Math.max(0, passedPx) - 1
}

export function findTopicThreadScrollElement(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
}

/**
 * Котва за запазване на позицията: първият ОТГОВОР, който се вижда в горния
 * край (или първият зареден, ако на екрана е само root картата).
 *
 * Никога root картата: по-старите отговори се вмъкват ПОД нея, така че тя не
 * мърда и котва върху нея не коригира нищо — потребителят остава на
 * scrollTop≈0, а оттам следва лавина от зареждания до №1 (production бъг).
 *
 * Пази се ДОЛНИЯТ ръб: при вмъкване над него отговорът получава разделителна
 * линия (::before в самия елемент) — горният ръб остава, но съдържанието се
 * измества; долният ръб е неподвижен спрямо съдържанието.
 */
export function captureTopicThreadScrollAnchor(root: ParentNode): { seq: number; bottom: number } | null {
  const scrollEl = findTopicThreadScrollElement(root)
  if (scrollEl === null) return null
  const viewTop = scrollEl.getBoundingClientRect().top
  const replies = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-reply][data-topic-thread-seq]'))
  const anchorEl = replies.find((el) => el.getBoundingClientRect().bottom > viewTop + 1) ?? replies[0] ?? null
  if (anchorEl === null) return null
  const seq = Number(anchorEl.dataset.topicThreadSeq)
  return Number.isFinite(seq) ? { seq, bottom: anchorEl.getBoundingClientRect().bottom } : null
}

export function restoreTopicThreadScrollAnchor(root: ParentNode, anchor: { seq: number; bottom: number } | null): void {
  if (anchor === null) return
  const scrollEl = findTopicThreadScrollElement(root)
  const el = scrollEl?.querySelector<HTMLElement>(`[data-topic-thread-seq="${anchor.seq}"]`) ?? null
  if (scrollEl === null || el === null) return
  const delta = el.getBoundingClientRect().bottom - anchor.bottom
  if (Math.abs(delta) >= 0.5) scrollEl.scrollTop += delta
}

export function isTopicThreadNearBottom(root: ParentNode, thresholdPx = 96): boolean {
  const scrollEl = findTopicThreadScrollElement(root)
  return scrollEl === null || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= thresholdPx
}

export type TopicThreadViewportWatcher = {
  start: () => void
  stop: () => void
  /** Незабавна проверка (след показване/вмъкване). */
  evaluate: () => void
  /** Заявка за страница в тази посока е тръгнала — ръбът не се задейства повторно. */
  suspendEdge: (edge: 'top' | 'bottom') => void
  /**
   * Страницата е приложена (позицията — възстановена). Следващо зареждане в
   * тази посока само след РЕАЛНО действие на потребителя натам (скрол
   * отвъд текущата позиция, колелце или плъзгане), никога от таймера.
   */
  resumeEdge: (edge: 'top' | 'bottom') => void
  /**
   * Преди промяна на DOM-а на прозореца (вмъкване/освобождаване): отчита
   * преминатото до момента — после освободените отговори вече ги няма.
   */
  beginLayoutChange: () => void
  /**
   * След промяната и корекцията на позицията: компенсацията на scrollTop не
   * е преминаване през съдържание (същото съдържание остава на екрана).
   */
  endLayoutChange: () => void
  /** Програмен прескок (до края и т.н.) — прескоченото НЕ е преминато. */
  notifyJump: () => void
}

/**
 * Следи thread скрола: достигнатите отговори (read cursor) и близост до
 * ръбовете за автоматично зареждане. Скрол елементът се открива наново при
 * всяка проверка, защото пълен render() го подменя.
 */
export function createTopicThreadViewportWatcher(options: {
  root: HTMLElement
  onSeen: (seqs: number[]) => void
  onNearTop: () => void
  onNearBottom: () => void
}): TopicThreadViewportWatcher {
  const reported = new Set<number>()
  let boundScrollEl: HTMLElement | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  // scrollTop при последната проверка — разликата до текущия е ръчното
  // преминаване надолу (програмните движения го пренастройват).
  let lastScrollTop: number | null = null
  let layoutStartScrollTop: number | null = null
  // Ръбовете за автоматично зареждане: armed = може да зареди; ref = позицията
  // след последната приложена страница (програмните корекции не я местят).
  const edges = {
    top: { armed: true, ref: null as number | null },
    bottom: { armed: true, ref: null as number | null },
  }
  let touchY: number | null = null

  function armFromScrollPosition(scrollTop: number): void {
    if (!edges.top.armed && edges.top.ref !== null && scrollTop < edges.top.ref - 2) edges.top.armed = true
    if (!edges.bottom.armed && edges.bottom.ref !== null && scrollTop > edges.bottom.ref + 2) edges.bottom.armed = true
  }

  const onScroll = (): void => {
    if (boundScrollEl !== null) armFromScrollPosition(boundScrollEl.scrollTop)
    evaluate()
  }
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0 && edges.top.ref !== null) edges.top.armed = true
    if (event.deltaY > 0 && edges.bottom.ref !== null) edges.bottom.armed = true
  }
  const onTouchStart = (event: TouchEvent): void => {
    touchY = event.touches[0]?.clientY ?? null
  }
  const onTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY ?? null
    if (y === null || touchY === null) return
    // Пръстът надолу = съдържанието нагоре (към по-старите).
    if (y > touchY + 4 && edges.top.ref !== null) edges.top.armed = true
    if (y < touchY - 4 && edges.bottom.ref !== null) edges.bottom.armed = true
  }

  function bind(): HTMLElement | null {
    const scrollEl = findTopicThreadScrollElement(options.root)
    if (scrollEl === boundScrollEl) return scrollEl
    if (boundScrollEl !== null) {
      boundScrollEl.removeEventListener('scroll', onScroll)
      boundScrollEl.removeEventListener('wheel', onWheel)
      boundScrollEl.removeEventListener('touchstart', onTouchStart)
      boundScrollEl.removeEventListener('touchmove', onTouchMove)
    }
    boundScrollEl = scrollEl
    // Нов елемент от пълен render: същото съдържание, същият scrollTop (render-ът
    // го възстановява) — lastScrollTop се пази, за да не се загуби преминатото
    // между последната проверка и подмяната.
    if (boundScrollEl !== null) {
      boundScrollEl.addEventListener('scroll', onScroll, { passive: true })
      boundScrollEl.addEventListener('wheel', onWheel, { passive: true })
      boundScrollEl.addEventListener('touchstart', onTouchStart, { passive: true })
      boundScrollEl.addEventListener('touchmove', onTouchMove, { passive: true })
    }
    return scrollEl
  }

  function suspendEdge(edge: 'top' | 'bottom'): void {
    edges[edge].armed = false
    edges[edge].ref = null
  }

  function resumeEdge(edge: 'top' | 'bottom'): void {
    edges[edge].armed = false
    edges[edge].ref = findTopicThreadScrollElement(options.root)?.scrollTop ?? 0
  }

  function beginLayoutChange(): void {
    if (intervalId === null) return
    evaluate()
    layoutStartScrollTop = boundScrollEl?.scrollTop ?? null
  }

  function endLayoutChange(): void {
    if (intervalId === null) return
    const scrollEl = bind()
    if (scrollEl !== null && layoutStartScrollTop !== null && lastScrollTop !== null) {
      lastScrollTop += scrollEl.scrollTop - layoutStartScrollTop
    }
    layoutStartScrollTop = null
    evaluate()
  }

  function notifyJump(): void {
    if (intervalId === null) return
    const scrollEl = bind()
    lastScrollTop = scrollEl?.scrollTop ?? null
    evaluate()
  }

  function evaluate(): void {
    // Само докато нишката е отворена (start → stop).
    if (intervalId === null) return
    const scrollEl = bind()
    if (scrollEl === null || !scrollEl.isConnected) return
    const scrollTop = scrollEl.scrollTop
    const passedPx = lastScrollTop === null ? 0 : Math.max(0, scrollTop - lastScrollTop)
    lastScrollTop = scrollTop
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return

    const viewRect = scrollEl.getBoundingClientRect()
    const seen: number[] = []
    if (viewRect.height > 0) {
      for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-thread-seq]'))) {
        const seq = Number(el.dataset.topicThreadSeq)
        if (!Number.isFinite(seq) || reported.has(seq)) continue
        if (isTopicThreadItemReached(el.getBoundingClientRect(), viewRect, passedPx)) {
          reported.add(seq)
          seen.push(seq)
        }
      }
    }
    if (seen.length > 0) options.onSeen(seen)

    if (!edges.top.armed && !edges.bottom.armed) return
    // Измерват се само отговорите на прозореца (root картата е просто
    // началото на нишката, не тригер).
    const replyEls = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-reply][data-topic-thread-seq]'))
    if (replyEls.length === 0 || viewRect.height <= 0) return
    const beyond = measureTopicThreadLoadedBeyondView(replyEls.map((el) => el.getBoundingClientRect()), viewRect)
    if (edges.top.armed && shouldPrefetchTopicThreadEdge(beyond.above, viewRect.height)) options.onNearTop()
    if (edges.bottom.armed && shouldPrefetchTopicThreadEdge(beyond.below, viewRect.height)) options.onNearBottom()
  }

  function start(): void {
    if (intervalId !== null) return
    intervalId = setInterval(evaluate, TOPIC_THREAD_WATCH_POLL_MS)
    evaluate()
  }

  function stop(): void {
    if (intervalId !== null) clearInterval(intervalId)
    intervalId = null
    if (boundScrollEl !== null) {
      boundScrollEl.removeEventListener('scroll', onScroll)
      boundScrollEl.removeEventListener('wheel', onWheel)
      boundScrollEl.removeEventListener('touchstart', onTouchStart)
      boundScrollEl.removeEventListener('touchmove', onTouchMove)
    }
    boundScrollEl = null
    lastScrollTop = null
    layoutStartScrollTop = null
    edges.top = { armed: true, ref: null }
    edges.bottom = { armed: true, ref: null }
    touchY = null
    reported.clear()
  }

  return { start, stop, evaluate, suspendEdge, resumeEdge, beginLayoutChange, endLayoutChange, notifyJump }
}
