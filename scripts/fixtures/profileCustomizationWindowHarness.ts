// "Персонализация", Етап 2 — browser harness (checkProfileCustomizationWindowUi.ts).
// Реалният production прозорец; HTTP заявките се обслужват от теста
// (Playwright page.route) върху реален profileCustomizationStore с временна
// база. Пренасочването към Stripe се записва, вместо да се изпълни.
import { showProfileCustomizationWindow, type ProfileCustomizationWindowDeps } from '/src/app/profileCustomization/showProfileCustomizationWindow.ts'

const navigations: string[] = []

;(window as unknown as { __customizationHarness: unknown }).__customizationHarness = {
  open: (theme: 'dark' | 'light', stripeReturn: ProfileCustomizationWindowDeps['stripeReturn'] = null) => {
    showProfileCustomizationWindow({
      getApiBaseUrl: () => '',
      displayName: 'Мишо<b>',
      theme,
      stripeReturn,
      navigateToCheckout: (url) => { navigations.push(url) },
    })
  },
  navigations: () => [...navigations],
}
