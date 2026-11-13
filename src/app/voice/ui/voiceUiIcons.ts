// Гласов чат — Lucide икони (inline SVG, currentColor) за мобилния интерфейс (Етап 4).
// Тук (основен bundle) са само иконите на лентата, бутона в игра и индикатора
// „говори“; иконите само на панела са в lazy chunk-а (renderVoicePanel.ts).

export function lucideIcon(size: number, paths: string, strokeWidth = 2): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
}

const MIC = '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'
const MIC_OFF = '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>'
const HEADPHONES = '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'

export const voiceIcon = {
  mic: (size = 18) => lucideIcon(size, MIC),
  micOff: (size = 18) => lucideIcon(size, MIC_OFF),
  headphones: (size = 18) => lucideIcon(size, HEADPHONES),
  /** Бял микрофон за зеленото индикаторче (по-плътен щрих при малки размери). */
  speakingMic: (size: number) => lucideIcon(size, MIC, 2.6),
}
