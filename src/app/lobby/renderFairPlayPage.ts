export function renderFairPlayPage(isMobile = false): string {
  const padding = isMobile ? '14px 12px 40px' : '28px 40px 60px'
  const titleSize = isMobile ? '26px' : '34px'
  const h2Size = isMobile ? '18px' : '22px'
  const h3Size = isMobile ? '15px' : '17px'
  const maxWidth = '860px'
  const gold = '#c9a84c'
  const goldDim = 'rgba(201,168,76,0.35)'
  const white = '#ffffff'
  const dimText = 'rgba(255,255,255,0.55)'
  const cardBg = 'rgba(255,255,255,0.04)'
  const borderColor = 'rgba(201,168,76,0.25)'

  const sectionStyle = `
    background:${cardBg};
    border:1px solid ${borderColor};
    border-radius:10px;
    padding:${isMobile ? '16px 14px' : '24px 28px'};
    margin-bottom:${isMobile ? '16px' : '22px'};
  `.replace(/\s+/g, ' ').trim()

  const h2Style = `margin:0 0 14px;color:${gold};font-size:${h2Size};font-weight:800;line-height:1.2;letter-spacing:0.01em;padding-bottom:10px;border-bottom:1px solid ${goldDim};`
  const h3Style = `margin:18px 0 8px;color:${white};font-size:${h3Size};font-weight:700;`
  const pStyle = `margin:0 0 10px;color:${white};font-size:${isMobile ? '14px' : '15px'};line-height:1.65;`
  const pDimStyle = `margin:0 0 10px;color:${dimText};font-size:${isMobile ? '13px' : '14px'};line-height:1.6;`
  const ulStyle = `margin:6px 0 10px;padding-left:${isMobile ? '18px' : '22px'};color:${white};font-size:${isMobile ? '14px' : '15px'};line-height:1.75;`
  const linkStyle = `color:${gold};text-decoration:underline;text-underline-offset:2px;`
  const anchorLinkStyle = `color:${gold};text-decoration:none;font-size:${isMobile ? '13px' : '14px'};line-height:1.9;`

  const navItems = [
    ['sluchayno-razdavane', 'Случайно раздаване'],
    ['slabi-karti', 'Защо понякога получаваш слаби карти'],
    ['rolyata-na-botovete', 'Ролята на ботовете'],
    ['zabrana-izmami', 'Забрана за измами и злоупотреби'],
    ['dogovorena-igra', 'Забрана за договорена игра'],
    ['sanktsii', 'Санкции при нарушения'],
    ['nauchi-poveche', 'Научи повече'],
  ]

  const navHtml = navItems.map(([id, label]) =>
    `<li><a href="#${id}" style="${anchorLinkStyle}">${label}</a></li>`
  ).join('\n        ')

  return `
<article style="padding:${padding};max-width:${maxWidth};box-sizing:border-box;">

  <header style="margin-bottom:${isMobile ? '20px' : '30px'};">
    <h1 style="margin:0 0 10px;color:${white};font-size:${titleSize};font-weight:900;line-height:1.1;letter-spacing:-0.01em;">Честна игра</h1>
    <p style="${pDimStyle}margin-bottom:0;">Всяка карта на масата в Pika.bg идва от едно и също автоматично раздаване на сървъра — за играч и за бот. Тук показваме конкретно как работи то, каква е ролята на ботовете и какво не толерираме на масите си.</p>
  </header>

  <nav style="${sectionStyle}" aria-label="Съдържание">
    <h2 style="${h2Style}">Съдържание</h2>
    <ul style="${ulStyle}list-style:none;padding-left:0;">
        ${navHtml}
    </ul>
  </nav>

  <section id="sluchayno-razdavane" style="${sectionStyle}">
    <h2 style="${h2Style}">Случайно раздаване</h2>
    <p style="${pStyle}">Всяко раздаване на карти в Pika.bg се извършва автоматично от сървъра на платформата по случаен принцип, независимо от профила, устройството или историята на играча. Тестето се разбърква наново преди всяко раздаване, а картите се разпределят поравно между четиримата участници на масата — независимо дали са реални играчи, или ботове.</p>
    <p style="${pStyle}margin-bottom:0;">Никой играч — включително администратори на платформата — не избира ръчно кой какви карти получава. Раздаването е автоматизиран, еднакъв за всички процес.</p>
  </section>

  <section id="slabi-karti" style="${sectionStyle}">
    <h2 style="${h2Style}">Защо понякога получаваш слаби карти</h2>
    <p style="${pStyle}">Случайното раздаване означава, че силата на ръцете естествено варира от раздаване на раздаване. Понякога ще получиш отлична ръка с много козове, друг път — предимно слаби карти без ясна посока за наддаване.</p>
    <p style="${pStyle}">Това е нормална статистическа особеност на всяка игра с раздавани на случаен принцип карти, а не грешка или пристрастност на системата. В дългосрочен план разпределението на силните и слабите ръце се изравнява между всички играчи.</p>
    <p style="${pStyle}margin-bottom:0;">Добрата новина е, че белотът възнаграждава и играта със слаба ръка — правилното пасуване, защитата и партньорската игра често имат по-голямо значение от самите карти. Виж <a href="/strategy" style="${linkStyle}">Съвети и стратегии</a> за повече по темата.</p>
  </section>

  <section id="rolyata-na-botovete" style="${sectionStyle}">
    <h2 style="${h2Style}">Ролята на ботовете</h2>
    <p style="${pStyle}">Ботовете в Pika.bg изпълняват две основни функции: попълват маса, когато няма достатъчно човешки играчи в момента, и временно поемат мястото на играч, който не отговаря навреме на своя ход по време на активна партия.</p>
    <h3 style="${h3Style}">Ботовете нямат специално предимство</h3>
    <p style="${pStyle}">Ботовете получават карти от същото случайно раздаване като всички човешки играчи на масата и следват същите правила за наддаване и разиграване. Те не виждат картите на останалите играчи и не получават никаква информация, недостъпна за човешки участник в същата позиция.</p>
    <p style="${pStyle}margin-bottom:0;">Ако се свържеш отново навреме след прекъсване, можеш да поемеш обратно контрола над мястото си и да продължиш партията сам.</p>
  </section>

  <section id="zabrana-izmami" style="${sectionStyle}">
    <h2 style="${h2Style}">Забрана за измами и злоупотреби</h2>
    <p style="${pStyle}">Всякакви опити за манипулиране на играта извън предвидените ѝ правила са забранени. Това включва, без да се ограничава до:</p>
    <ul style="${ulStyle}">
      <li>използване на автоматизирани инструменти или скриптове за игра вместо реален човек;</li>
      <li>експлоатиране на технически грешки или пропуски в платформата за игрово предимство;</li>
      <li>създаване на множество профили с цел заобикаляне на игрови ограничения или бонуси;</li>
      <li>всякакви опити за достъп до информация, недостъпна нормално за играч в съответната позиция.</li>
    </ul>
  </section>

  <section id="dogovorena-igra" style="${sectionStyle}">
    <h2 style="${h2Style}">Забрана за договорена игра</h2>
    <p style="${pStyle}">Договарянето между играчи за предварително определен изход от игра — например умишлено губене на точки, съзнателно слаба игра в полза на определен отбор или координация извън самата игра с цел въздействие върху резултата — е строго забранено.</p>
    <p style="${pStyle}margin-bottom:0;">Тъй като жълтиците са вътрешна виртуална валута без парична стойност, договорената игра не носи финансова изгода — но нарушава честността на играта за останалите участници и затова не се толерира.</p>
  </section>

  <section id="sanktsii" style="${sectionStyle}">
    <h2 style="${h2Style}">Санкции при нарушения</h2>
    <p style="${pStyle}margin-bottom:0;">Нарушенията по-горе, както и съзнателното често напускане на започнати игри, могат да доведат до игрови санкции — отнемане на виртуални жълтици или ограничения на профила, съгласно <a href="/terms" style="${linkStyle}">Общите условия</a> на платформата.</p>
  </section>

  <section id="nauchi-poveche" style="${sectionStyle}border-color:${goldDim};background:rgba(201,168,76,0.06);">
    <h2 style="${h2Style}">Научи повече</h2>
    <p style="${pStyle}">За пълните правила на играта, включително точкуване и специални случаи, виж <a href="/rules" style="${linkStyle}">Правила на белота</a>.</p>
    <p style="${pStyle}margin-bottom:0;">За практически съвети как да играеш по-добре, независимо какви карти ти се паднат, виж <a href="/strategy" style="${linkStyle}">Съвети и стратегии</a>.</p>
  </section>

</article>
`
}
