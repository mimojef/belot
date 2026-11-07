// "Персонализация", Етап 1 — browser harness (checkAdminProfileCustomizationUi.ts).
// Ползва ДИРЕКТНО реалния production панел; HTTP заявките се обслужват от
// теста (Playwright page.route) върху реален profileCustomizationStore с
// временна база. Правата и feature flag-ът са покрити от
// server/scripts/checkProfileCustomizationAdminHttp.ts.
import { showAdminProfileCustomizationPanel } from '/src/app/adminProfileCustomization/showAdminProfileCustomizationPanel.ts'

;(window as unknown as { __adminCustomizationHarness: { open: () => void } }).__adminCustomizationHarness = {
  open: () => {
    showAdminProfileCustomizationPanel({ getApiBaseUrl: () => '' })
  },
}
