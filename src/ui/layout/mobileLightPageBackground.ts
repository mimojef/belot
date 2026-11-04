// Общ декоративен фон на светлия мобилен дизайн (941×1672 WebP). Слага се
// само на елементи с position:fixed на цял екран, които сами са scroll
// container-ът (или не скролват) — фон със стандартното
// background-attachment:scroll тогава не се движи със съдържанието, без
// background-attachment:fixed. Лекото потъмняване е, за да изпъкват белите
// карти и виолетовите бутони; #F5F7FC остава, докато картинката се зареди.
// Без двойни кавички — стойността влиза в inline style="..." атрибути.
export const MOBILE_LIGHT_PAGE_BACKGROUND = "linear-gradient(rgba(23,16,64,0.06), rgba(23,16,64,0.06)), url('/assets/lobby-mobile/mobile-lobby-bg.webp') center / cover no-repeat, #F5F7FC"
