export function renderFaqPage(isMobile = false): string {
  const padding = isMobile ? '14px 12px 40px' : '28px 40px 60px'
  const titleSize = isMobile ? '26px' : '34px'
  const h2Size = isMobile ? '18px' : '22px'
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
  const pStyle = `margin:0 0 10px;color:${white};font-size:${isMobile ? '14px' : '15px'};line-height:1.65;`
  const pDimStyle = `margin:0 0 10px;color:${dimText};font-size:${isMobile ? '13px' : '14px'};line-height:1.6;`
  const ulStyle = `margin:6px 0 10px;padding-left:${isMobile ? '18px' : '22px'};color:${white};font-size:${isMobile ? '14px' : '15px'};line-height:1.75;`
  const linkStyle = `color:${gold};text-decoration:underline;text-underline-offset:2px;`
  const anchorLinkStyle = `color:${gold};text-decoration:none;font-size:${isMobile ? '13px' : '14px'};line-height:1.9;`

  const qStyle = `margin:18px 0 8px;color:${white};font-size:${isMobile ? '15px' : '17px'};font-weight:700;`
  const qFirstStyle = `margin:0 0 8px;color:${white};font-size:${isMobile ? '15px' : '17px'};font-weight:700;`

  const navItems = [
    ['registracia', 'Регистрация и вход'],
    ['gost', 'Игра като гост'],
    ['jaltici', 'Жълтици и бонуси'],
    ['botove', 'Ботове в играта'],
    ['razdavane', 'Честно ли се раздава'],
    ['napuskane', 'Напускане на игра'],
    ['plashtania', 'Плащания и покупки'],
    ['kontakt', 'Контакт с екипа'],
    ['pravila', 'Правила и обучение'],
  ]

  const navHtml = navItems.map(([id, label]) =>
    `<li><a href="#${id}" style="${anchorLinkStyle}">${label}</a></li>`
  ).join('\n        ')

  return `
<article style="padding:${padding};max-width:${maxWidth};box-sizing:border-box;">

  <header style="margin-bottom:${isMobile ? '20px' : '30px'};">
    <h1 style="margin:0 0 10px;color:${white};font-size:${titleSize};font-weight:900;line-height:1.1;letter-spacing:-0.01em;">Често задавани въпроси</h1>
    <p style="${pDimStyle}margin-bottom:0;">Отговори на най-честите въпроси за играта, профила, жълтиците и функционалността на Pika.bg. Ако не намериш отговор тук, можеш да се свържеш с екипа през <a href="/contact" style="${linkStyle}">страницата за контакти</a>.</p>
  </header>

  <nav style="${sectionStyle}" aria-label="Съдържание">
    <h2 style="${h2Style}">Съдържание</h2>
    <ul style="${ulStyle}list-style:none;padding-left:0;">
        ${navHtml}
    </ul>
  </nav>

  <section id="registracia" style="${sectionStyle}">
    <h2 style="${h2Style}">Регистрация и вход</h2>

    <h3 style="${qFirstStyle}">Трябва ли да се регистрирам, за да играя?</h3>
    <p style="${pStyle}">Не е задължително — можеш да пробваш играта като гост. Регистрацията обаче ти позволява да запазиш прогреса си, ранга, статистиката и приятелите между отделните сесии.</p>

    <h3 style="${qStyle}">Какво ми е нужно, за да се регистрирам?</h3>
    <p style="${pStyle}margin-bottom:0;">Само имейл адрес, парола и потребителско име. Не се изисква въвеждане на платежна информация при самата регистрация.</p>
  </section>

  <section id="gost" style="${sectionStyle}">
    <h2 style="${h2Style}">Игра като гост</h2>

    <h3 style="${qFirstStyle}">Какви са ограниченията на гост профила?</h3>
    <p style="${pStyle}">Като гост можеш да играеш пълноценни партии, но прогресът ти е обвързан с текущата сесия на устройството. Ако искаш да запазиш профила си трайно — с ранг, статистика и приятели, — препоръчваме регистрация.</p>

    <h3 style="${qStyle}">Мога ли по-късно да превърна гост профила си в регистриран?</h3>
    <p style="${pStyle}margin-bottom:0;">Да, чрез регистрация с имейл директно от интерфейса, без да губиш текущата сесия.</p>
  </section>

  <section id="jaltici" style="${sectionStyle}">
    <h2 style="${h2Style}">Жълтици и бонуси</h2>

    <h3 style="${qFirstStyle}">Какво представляват жълтиците?</h3>
    <p style="${pStyle}">Жълтиците са вътрешна виртуална игрова валута на Pika.bg. Те се използват единствено за вход в игрови маси в самата платформа и нямат парична стойност извън нея.</p>

    <h3 style="${qStyle}">Мога ли да осребря жълтиците си или да ги изтегля като пари?</h3>
    <p style="${pStyle}">Не. Жълтиците не могат да бъдат осребрени, изтеглени или разменени за реални пари, награди или каквато и да е материална облага. Те съществуват единствено за забавление в рамките на играта.</p>

    <h3 style="${qStyle}">Получавам ли безплатни жълтици?</h3>
    <p style="${pStyle}margin-bottom:0;">Новите профили получават начален бонус жълтици при регистрация, а платформата периодично предлага допълнителни безплатни бонуси и ежедневни награди на активните играчи.</p>
  </section>

  <section id="botove" style="${sectionStyle}">
    <h2 style="${h2Style}">Ботове в играта</h2>

    <h3 style="${qFirstStyle}">Защо понякога играя срещу или с бот?</h3>
    <p style="${pStyle}">Ботовете попълват маса, когато няма достатъчно човешки играчи в момента, или временно заместват играч, който не отговаря навреме на своя ход. Това позволява играта да продължи без дълго чакане за всички участници.</p>

    <h3 style="${qStyle}">Ботовете имат ли предимство пред мен?</h3>
    <p style="${pStyle}margin-bottom:0;">Не. Ботовете играят по същите правила и получават карти от същото случайно раздаване като всички останали участници на масата. Повече подробности виж в <a href="/fair-play" style="${linkStyle}">Честна игра</a>.</p>
  </section>

  <section id="razdavane" style="${sectionStyle}">
    <h2 style="${h2Style}">Честно ли се раздава</h2>

    <h3 style="${qFirstStyle}">Как се разбъркват и раздават картите?</h3>
    <p style="${pStyle}">Раздаването се извършва изцяло от сървъра на Pika.bg по случаен принцип, независимо от устройството или профила на играчите. Никой играч, вкл. администратори, не избира ръчно кой какви карти получава.</p>

    <h3 style="${qStyle}">Защо понякога получавам слаба ръка няколко пъти подред?</h3>
    <p style="${pStyle}margin-bottom:0;">Случайното раздаване означава, че разпределението на силните и слабите карти естествено варира във времето. Поредица от по-слаби ръце е статистически нормална и не означава, че системата работи срещу теб — виж <a href="/fair-play" style="${linkStyle}">Честна игра</a> за повече подробности.</p>
  </section>

  <section id="napuskane" style="${sectionStyle}">
    <h2 style="${h2Style}">Напускане на игра</h2>

    <h3 style="${qFirstStyle}">Какво се случва, ако напусна игра по средата?</h3>
    <p style="${pStyle}">Мястото ти временно се поема от бот, за да не пречи на останалите играчи на масата. Ако се свържеш отново навреме, можеш да поемеш контрола обратно и да продължиш партията.</p>

    <h3 style="${qStyle}">Има ли последствия при често напускане?</h3>
    <p style="${pStyle}margin-bottom:0;">Съзнателното и повтарящо се напускане на започнати игри се разглежда като злоупотреба спрямо останалите играчи и може да доведе до игрови санкции, описани в <a href="/terms" style="${linkStyle}">Общите условия</a>.</p>
  </section>

  <section id="plashtania" style="${sectionStyle}">
    <h2 style="${h2Style}">Плащания и покупки</h2>

    <h3 style="${qFirstStyle}">Задължително ли е да плащам, за да играя?</h3>
    <p style="${pStyle}">Не. Играта е достъпна безплатно, включително с начални и периодични безплатни бонуси жълтици. Платените пакети са допълнителна опция за тези, които искат повече жълтици по-бързо.</p>

    <h3 style="${qStyle}">Какво получавам срещу платените пакети?</h3>
    <p style="${pStyle}margin-bottom:0;">Единствено допълнително количество вътрешна виртуална валута (жълтици) за игра в платформата — не реални пари, награди или каквато и да е стойност извън Pika.bg.</p>
  </section>

  <section id="kontakt" style="${sectionStyle}">
    <h2 style="${h2Style}">Контакт с екипа</h2>

    <h3 style="${qFirstStyle}">Как да се свържа с екипа на Pika.bg?</h3>
    <p style="${pStyle}margin-bottom:0;">Най-лесно през <a href="/contact" style="${linkStyle}">страницата за контакти</a>, където можеш да изпратиш съобщение директно през контактната форма — за въпроси, сигнали, проблеми с профил или плащане.</p>
  </section>

  <section id="pravila" style="${sectionStyle}border-color:${goldDim};background:rgba(201,168,76,0.06);">
    <h2 style="${h2Style}">Правила и обучение</h2>

    <h3 style="${qFirstStyle}">Къде да науча правилата от нулата?</h3>
    <p style="${pStyle}">Ако тепърва започваш, най-добрата отправна точка е <a href="/learn" style="${linkStyle}">Научи белот</a> — обяснява основната идея на играта на достъпен език.</p>

    <h3 style="${qStyle}">Къде са пълните формални правила?</h3>
    <p style="${pStyle}">Пълните правила, включително точкуване, специални случаи и терминология, са на страницата <a href="/rules" style="${linkStyle}">Правила на белота</a>.</p>

    <h3 style="${qStyle}">Как да играя по-добре?</h3>
    <p style="${pStyle}margin-bottom:0;">Практически съвети за наддаване, разиграване и партньорска игра ще намериш в <a href="/strategy" style="${linkStyle}">Съвети и стратегии</a>.</p>
  </section>

</article>
`
}
