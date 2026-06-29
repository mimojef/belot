export function renderRulesPage(isMobile = false): string {
  const padding = isMobile ? '14px 12px' : '28px 32px'
  const titleSize = isMobile ? '22px' : '28px'

  return `
    <section style="padding:${padding};max-width:820px;">
      <h1 style="margin:0 0 8px;color:#ffffff;font-size:${titleSize};font-weight:900;line-height:1.1;">Правила на белота</h1>
      <p style="margin:0;color:rgba(255,255,255,0.5);font-size:13px;font-weight:700;">Съдържанието ще бъде добавено скоро.</p>
    </section>
  `
}
