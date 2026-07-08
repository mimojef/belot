export function renderLearnPage(isMobile = false): string {
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

  const navItems = [
    ['kakvo', 'Какво е белот'],
    ['zashto-otborna', 'Защо е отборна игра'],
    ['s-kakvo-shte-svikvash', 'С какво ще свикнеш бързо'],
    ['purvi-stupki', 'Първи стъпки в Pika.bg'],
    ['naddavane-vkratse', 'Наддаването накратко'],
    ['razigravane-vkratse', 'Разиграването накратко'],
    ['anonsi-i-belot', 'Анонси и белот накратко'],
    ['tochki-vkratse', 'Точкуване накратко'],
    ['greshki-na-nachinaeshtia', 'Чести грешки на начинаещия'],
    ['sledvashti-stupki', 'Какво да четеш след това'],
  ]

  const navHtml = navItems.map(([id, label]) =>
    `<li><a href="#${id}" style="${anchorLinkStyle}">${label}</a></li>`
  ).join('\n        ')

  return `
<article style="padding:${padding};max-width:${maxWidth};box-sizing:border-box;">

  <header style="margin-bottom:${isMobile ? '20px' : '30px'};">
    <h1 style="margin:0 0 10px;color:${white};font-size:${titleSize};font-weight:900;line-height:1.1;letter-spacing:-0.01em;">Научи белот</h1>
    <p style="${pDimStyle}margin-bottom:0;">В Pika.bg белотът е представен като бърза онлайн отборна игра — с автоматично раздаване от сървъра, ясно подчертани позволени ходове и възможност да седнеш на маса дори когато нямаш трима приятели на линия в момента.</p>
    <p style="${pDimStyle}margin-bottom:0;margin-top:8px;">Тази страница е първата спирка за нов играч в лобито ни. Тя не замества пълните правила, а показва как изглежда едно раздаване в Pika.bg и накъде да продължиш, за да навлезеш по-дълбоко.</p>
  </header>

  <nav style="${sectionStyle}" aria-label="Съдържание">
    <h2 style="${h2Style}">Съдържание</h2>
    <ul style="${ulStyle}list-style:none;padding-left:0;">
        ${navHtml}
    </ul>
  </nav>

  <section id="kakvo" style="${sectionStyle}">
    <h2 style="${h2Style}">Какво е белот</h2>
    <p style="${pStyle}">На маса в Pika.bg играят четирима души в два отбора по двама, с тесте от 32 карти. Всяко раздаване минава през наддаване, разиграване на осем ръце и автоматично изчисляване на резултата от системата — партията продължава, докато някой отбор събере достатъчно точки, за да спечели.</p>
    <p style="${pStyle}margin-bottom:0;">За разлика от много карти игри, в белота печели не просто този с по-силни карти, а отборът, който по-добре чете ситуацията на масата — какво е обявено, какво вече е изиграно и какво най-вероятно държи партньорът.</p>
  </section>

  <section id="zashto-otborna" style="${sectionStyle}">
    <h2 style="${h2Style}">Защо е отборна игра</h2>
    <p style="${pStyle}">Партньорите седят един срещу друг и играят като екип през цялото раздаване, въпреки че всеки вижда само собствените си карти. Това прави комуникацията чрез самата игра — какви карти хвърляш, кога цакаш, кога пасуваш — също толкова важна, колкото и картите в ръката ти.</p>
    <p style="${pStyle}margin-bottom:0;">Добрият партньор не просто играе силните си карти при първа възможност — той чете какво се случва на масата и решава кога да подкрепи атаката, а кога да пази собствените си силни карти за по-късно.</p>
  </section>

  <section id="s-kakvo-shte-svikvash" style="${sectionStyle}">
    <h2 style="${h2Style}">С какво ще свикнеш бързо</h2>
    <ul style="${ulStyle}">
      <li>Силата на картите се различава в зависимост от боята — коз или не.</li>
      <li>Задължението да „отговориш“ в поисканата боя, ако имаш карта от нея.</li>
      <li>„Цакането“ — играенето на коз, когато нямаш поисканата боя и партньорът ти не печели ръката.</li>
      <li>Допълнителните точки от анонси (поредици, карета) и от белот.</li>
    </ul>
    <p style="${pStyle}margin-bottom:0;">Никое от тези понятия не е сложно само по себе си. Комбинацията им е това, което прави белота интересен — и точно затова има смисъл да играеш няколко раздавания, преди да очакваш да ти се получава всичко.</p>
  </section>

  <section id="purvi-stupki" style="${sectionStyle}">
    <h2 style="${h2Style}">Първи стъпки в Pika.bg</h2>
    <p style="${pStyle}">Влизаш в лобито, избираш маса според залога в жълтици, който ти е удобен, и играта тръгва веднага — не се налага да чакаш трима приятели да са налични едновременно. Ако в момента липсва играч на масата, мястото временно се заема от бот, докато не се включи истински човек.</p>
    <p style="${pStyle}">Интерфейсът те насочва през цялото раздаване: показва ти само валидните обяви при наддаване и само позволените карти при всеки ход, така че не можеш да нарушиш правило по невнимание.</p>
    <p style="${pStyle}margin-bottom:0;">Ако предпочиташ да играеш само с познати, частните стаи ти позволяват да поканиш приятели на собствена маса. За пълните формални правила, преди или след да пробваш игра, виж <a href="/rules" style="${linkStyle}">Правила на белота</a>.</p>
  </section>

  <section id="naddavane-vkratse" style="${sectionStyle}">
    <h2 style="${h2Style}">Наддаването накратко</h2>
    <p style="${pStyle}">След като получиш първите си карти, наддаването определя как ще се играе раздаването — коя боя ще е коз, дали ще се играе „без коз“, или „всичко коз“. Всеки играч по ред или обявява нещо по-силно от предходната обява, или пасува.</p>
    <p style="${pStyle}margin-bottom:0;">Наддаването приключва след три последователни паса, а последната обява става договорът за цялото раздаване. Затова си струва да преценяваш ръката си внимателно, преди да наддадеш — виж <a href="/strategy" style="${linkStyle}">Съвети и стратегии</a> за практически насоки как да го правиш.</p>
  </section>

  <section id="razigravane-vkratse" style="${sectionStyle}">
    <h2 style="${h2Style}">Разиграването накратко</h2>
    <p style="${pStyle}">Всяко раздаване съдържа осем ръце. Първият играч в ръката поставя карта и определя коя боя се търси. Останалите играят по ред, а печели най-силната карта от поисканата боя — освен ако някой не изиграе по-висок коз.</p>
    <p style="${pStyle}margin-bottom:0;">Победителят в ръката прибира картите и започва следващата. Едно раздаване завършва, след като изиграете и осемте ръце.</p>
  </section>

  <section id="anonsi-i-belot" style="${sectionStyle}">
    <h2 style="${h2Style}">Анонси и белот накратко</h2>
    <p style="${pStyle}">Освен точките от самите ръце, определени комбинации карти носят допълнителни точки — например три или повече последователни карти от една боя, или четири карти от един ранг. Специална комбинация е белотът — поп и дама от козовата боя, — който сам по себе си носи 20 точки.</p>
    <p style="${pStyle}margin-bottom:0;">Тези комбинации не са задължителни, за да играеш добре, но познаването им ти позволява да извлечеш максимума от силна ръка.</p>
  </section>

  <section id="tochki-vkratse" style="${sectionStyle}">
    <h2 style="${h2Style}">Точкуване накратко</h2>
    <p style="${pStyle}">В края на раздаването системата автоматично сумира точките от изиграните карти, анонсите и белота в записан резултат. Партията продължава, докато някой отбор не достигне определен праг игрови точки с решаващо предимство — тези точки определят единствено изхода на партията в Pika.bg, не носят паричен еквивалент.</p>
    <p style="${pStyle}margin-bottom:0;">Пълните числа, изключения и специални случаи (като „вътре“ или контра) са описани подробно в <a href="/rules" style="${linkStyle}">Правилата на белота</a> — тази страница умишлено остава на ниво общо разбиране.</p>
  </section>

  <section id="greshki-na-nachinaeshtia" style="${sectionStyle}">
    <h2 style="${h2Style}">Чести грешки на начинаещия</h2>
    <ul style="${ulStyle}">
      <li>Наддаване само по силата на собствената ръка, без да се съобразява какво вече са казали останалите.</li>
      <li>Игнориране на партньора — изиграване на силна карта, без да се обръща внимание какво партньорът вече е показал.</li>
      <li>Прекалено ранно „изчерпване“ на силните козове, вместо да се изчака подходящият момент.</li>
      <li>Забравяне да се обяви анонс или белот навреме.</li>
    </ul>
    <p style="${pStyle}margin-bottom:0;">Всички тези навици се коригират с игра и внимание — не е нужно да ги запомниш отведнъж.</p>
  </section>

  <section id="sledvashti-stupki" style="${sectionStyle}border-color:${goldDim};background:rgba(201,168,76,0.06);">
    <h2 style="${h2Style}">Какво да четеш след това</h2>
    <p style="${pStyle}">Щом усетиш основния ритъм на играта, тези страници ще ти помогнат да продължиш напред:</p>
    <ul style="${ulStyle}margin-bottom:0;">
      <li><a href="/rules" style="${linkStyle}">Правила на белота</a> — пълните правила, точкуване и специални случаи.</li>
      <li><a href="/strategy" style="${linkStyle}">Съвети и стратегии</a> — как да наддаваш и играеш по-добре с времето.</li>
      <li><a href="/fair-play" style="${linkStyle}">Честна игра</a> — как работи случайното раздаване и ролята на ботовете.</li>
      <li><a href="/faq" style="${linkStyle}">Често задавани въпроси</a> — кратки отговори на конкретни въпроси за играта и профила ти.</li>
    </ul>
  </section>

</article>
`
}
