// Гласов чат — стабилен контейнер за отдалечените audio елементи (Етап 3).
//
// Екраните (лоби, чакалня, игра) се рендират с innerHTML на #app — audio
// елемент там би се унищожавал при всяко прерисуване. Затова има ЕДИН
// скрит контейнер директно в document.body (извън #app), създаден lazy при
// първото ползване. Елементите са keyed по trackSid -> без дублирани
// елементи; detach/clear ги премахва от DOM.

export type VoiceAudioSink = {
  /** Добавя елемента за trackSid; ако вече има такъв, старият се премахва. */
  attach: (trackSid: string, element: HTMLMediaElement) => void
  detach: (trackSid: string) => HTMLMediaElement | null
  clear: () => void
  size: () => number
}

export function createVoiceAudioSink(doc: Document = document): VoiceAudioSink {
  const elements = new Map<string, HTMLMediaElement>()
  let container: HTMLElement | null = null

  function ensureContainer(): HTMLElement {
    if (container !== null && container.isConnected) return container
    container = doc.createElement('div')
    container.setAttribute('data-voice-audio-sink', '')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;left:-9999px;top:0;'
    doc.body.appendChild(container)
    return container
  }

  return {
    attach(trackSid, element) {
      const existing = elements.get(trackSid)
      if (existing === element) return
      if (existing !== undefined) existing.remove()
      element.setAttribute('data-voice-track', trackSid)
      ensureContainer().appendChild(element)
      elements.set(trackSid, element)
    },
    detach(trackSid) {
      const element = elements.get(trackSid) ?? null
      if (element !== null) {
        element.remove()
        elements.delete(trackSid)
      }
      return element
    },
    clear() {
      for (const element of elements.values()) element.remove()
      elements.clear()
      if (container !== null) {
        container.remove()
        container = null
      }
    },
    size: () => elements.size,
  }
}
