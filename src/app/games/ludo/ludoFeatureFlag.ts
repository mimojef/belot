// Feature flag за entry point-а към Не се сърди човече (Ludo).
//
// Изключен по подразбиране — VITE_FEATURE_LUDO идва от .env (виж
// .env.example). Липсваща/невярна стойност скрива Ludo картата от екрана
// "Игри", без да премахва самата navigation секция.

let flagOverrideForTests: boolean | undefined

function readConfiguredFlag(): boolean {
  if (flagOverrideForTests !== undefined) return flagOverrideForTests

  try {
    // import.meta.env съществува само под Vite (dev server/build). Извън
    // Vite (напр. tsx test runner) достъпът може да хвърли — тогава flag-ът
    // просто остава изключен, без runtime грешка.
    const raw = import.meta.env.VITE_FEATURE_LUDO
    return raw === 'true' || raw === '1'
  } catch {
    return false
  }
}

export function isLudoFeatureEnabled(): boolean {
  return readConfiguredFlag()
}

export function __setLudoFeatureFlagOverrideForTests(value: boolean | undefined): void {
  flagOverrideForTests = value
}
