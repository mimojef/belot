/**
 * Debounce + "latest-request-wins" обвивка за server-side търсене на играчи.
 * Чист, без DOM зависимост — тестваем в изолация.
 *
 * - schedule(query): чака `delayMs` след последното повикване, преди да
 *   изпълни `run`. Всяко ново schedule() отменя предходния timer И
 *   in-flight заявка (AbortController).
 * - Дори ако `run` не уважи AbortSignal-а и все пак resolve-не, резултат
 *   от вече изпреварена (не най-новата) заявка се игнорира чрез sequence
 *   номер — двойна защита срещу stale response overwrite.
 * - Explicit AbortError (или всяка грешка след cancel()) никога не стига
 *   до onResult — не се третира като реална грешка.
 */
export type DebouncedPlayerSearchResult<T> =
  | { ok: true; query: string; value: T }
  | { ok: false; query: string; error: unknown }

export type DebouncedPlayerSearchOptions<T> = {
  run: (query: string, signal: AbortSignal) => Promise<T>
  onResult: (result: DebouncedPlayerSearchResult<T>) => void
  delayMs?: number
}

export type DebouncedPlayerSearch = {
  schedule: (query: string) => void
  cancel: () => void
}

export function createDebouncedPlayerSearch<T>(
  options: DebouncedPlayerSearchOptions<T>,
): DebouncedPlayerSearch {
  const delayMs = options.delayMs ?? 300
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let requestSeq = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function abortInFlight(): void {
    if (controller !== null) {
      controller.abort()
      controller = null
    }
  }

  function cancel(): void {
    requestSeq++
    clearTimer()
    abortInFlight()
  }

  function schedule(query: string): void {
    clearTimer()
    abortInFlight()

    const mySeq = ++requestSeq

    timer = setTimeout(() => {
      timer = null
      const myController = new AbortController()
      controller = myController

      options.run(query, myController.signal).then(
        (value) => {
          if (controller === myController) controller = null
          if (mySeq !== requestSeq) return
          if (myController.signal.aborted) return
          options.onResult({ ok: true, query, value })
        },
        (error: unknown) => {
          if (controller === myController) controller = null
          if (mySeq !== requestSeq) return
          if (myController.signal.aborted) return
          options.onResult({ ok: false, query, error })
        },
      )
    }, delayMs)
  }

  return { schedule, cancel }
}
