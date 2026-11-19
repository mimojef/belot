// Гласов чат — Етап H3: ЗАЯВКАТА за панела „Диагностика на звука“ (?voicediag=1).
//
// Заявката сама НЕ дава достъп — панелът е само за пълен администратор
// (voiceDiagnosticsOverlay.ts проверява правото при показване и на всяко
// обновяване). Тук е само „поискан ли е панелът в този таб“.
//
// Prerendering (Chrome, вкл. Android): когато адресът се въведе в адресната
// лента, Chrome може да зареди страницата предварително. Страницата тогава има
// ОТДЕЛЕН sessionStorage, а записаното в него се губи при активирането
// (потвърдено с реален Chromium без DevTools: записът е видим по време на
// prerender, след активирането — null). main.ts се изпълнява по време на
// prerender-а, затова заявката се записва и повторно при `prerenderingchange`.
// Playwright/DevTools забранява prerender-а — затова E2E тестовете не го виждат.
//
// Малък модул без зависимости: импортира се от main.ts (основният bundle) и от
// voiceDiagnosticsOverlay.ts (lazy chunk-а на гласа).

export const VOICE_DIAGNOSTICS_STORAGE_KEY = 'pika.voice.diag'

type RequestEnv = {
  search: () => string
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

const browserEnv: RequestEnv = {
  search: () => window.location.search,
  storage: () => window.sessionStorage,
}

/** '1' — поискан, '0' — изрично отказан, null — адресът не казва нищо. */
export function parseVoiceDiagnosticsQuery(search: string): '1' | '0' | null {
  const value = new URLSearchParams(search).get('voicediag')
  return value === '1' || value === '0' ? value : null
}

/** Записва заявката от адреса за таба (?voicediag=1 -> запис, ?voicediag=0 -> премахване). */
export function recordVoiceDiagnosticsRequest(env: RequestEnv = browserEnv): void {
  try {
    const query = parseVoiceDiagnosticsQuery(env.search())
    if (query === '1') env.storage()?.setItem(VOICE_DIAGNOSTICS_STORAGE_KEY, '1')
    else if (query === '0') env.storage()?.removeItem(VOICE_DIAGNOSTICS_STORAGE_KEY)
  } catch {
    /* без sessionStorage — остава само адресът (isVoiceDiagnosticsRequested) */
  }
}

/**
 * При стартиране на приложението: записва заявката веднага и — ако страницата
 * е prerender-ната — още веднъж при активирането (тогава sessionStorage вече е
 * този на таба).
 */
export function installVoiceDiagnosticsRequest(
  doc: Pick<Document, 'addEventListener'> & { prerendering?: boolean } = document,
  env: RequestEnv = browserEnv,
): void {
  recordVoiceDiagnosticsRequest(env)
  if (doc.prerendering === true) {
    doc.addEventListener('prerenderingchange', () => recordVoiceDiagnosticsRequest(env), { once: true })
  }
}

/** Поискан ли е панелът: адресът (ако казва нещо) има предимство, иначе запомненото за таба. */
export function isVoiceDiagnosticsRequested(env: RequestEnv = browserEnv): boolean {
  try {
    const query = parseVoiceDiagnosticsQuery(env.search())
    if (query !== null) return query === '1'
    return env.storage()?.getItem(VOICE_DIAGNOSTICS_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
