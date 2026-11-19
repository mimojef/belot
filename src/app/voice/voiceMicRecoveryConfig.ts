// Гласов чат — Етап H3: разрешено ли е АВТОМАТИЧНОТО възстановяване на микрофона.
//
// Решения на собственика (2026-11-18):
//   * production build — изключено; само бутон „Възстанови микрофона“;
//   * локална разработка/тестове (Vite dev) — включено;
//   * тестово включване/изключване — САМО от пълен администратор през панела
//     „Диагностика на звука“ и САМО за текущата клиентска сесия: в паметта на
//     страницата (без localStorage/sessionStorage), вързано за профила на
//     администратора. Refresh, ново влизане, смяна на профила или загуба на
//     администраторските права го премахват.
// Влиза в lazy chunk-а на гласа (импортира се от voiceRuntime/voiceDiagnosticsOverlay).

/** Кой е текущият потребител (от авторитетната сесия на приложението). */
export type VoiceDiagnosticsAccess = { fullAdmin: boolean; profileId: string | null }

let override: { value: boolean; profileId: string } | null = null

/** Пълен администратор с профил — единственият, който може да вижда панела и да превключва. */
export function isVoiceDiagnosticsAccessGranted(access: VoiceDiagnosticsAccess | null): access is { fullAdmin: true; profileId: string } {
  return access !== null && access.fullAdmin === true && typeof access.profileId === 'string' && access.profileId !== ''
}

function defaultEnabled(): boolean {
  return import.meta.env?.DEV === true
}

export function isVoiceMicAutoRecoveryEnabled(access: VoiceDiagnosticsAccess | null): boolean {
  if (override !== null) {
    if (isVoiceDiagnosticsAccessGranted(access) && access.profileId === override.profileId) return override.value
    // Друг профил / излизане / без права: тестовото превключване отпада окончателно.
    override = null
  }
  return defaultEnabled()
}

/** Само пълен администратор; false — отказано (без промяна). */
export function setVoiceMicAutoRecoveryOverride(value: boolean, access: VoiceDiagnosticsAccess | null): boolean {
  if (!isVoiceDiagnosticsAccessGranted(access)) return false
  override = { value, profileId: access.profileId }
  return true
}

export function resetVoiceMicAutoRecoveryOverride(): void {
  override = null
}
