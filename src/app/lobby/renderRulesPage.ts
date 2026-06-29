export function renderRulesPage(isMobile = false): string {
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
  const olStyle = `margin:6px 0 10px;padding-left:${isMobile ? '18px' : '22px'};color:${white};font-size:${isMobile ? '14px' : '15px'};line-height:1.85;`

  const tableWrapStyle = `overflow-x:auto;-webkit-overflow-scrolling:touch;margin:10px 0 14px;border-radius:6px;`
  const tableStyle = `border-collapse:collapse;min-width:${isMobile ? '280px' : '340px'};width:100%;font-size:${isMobile ? '13px' : '14px'};`
  const thStyle = `background:rgba(201,168,76,0.12);color:${gold};font-weight:700;padding:8px 12px;text-align:left;border-bottom:1px solid ${goldDim};white-space:nowrap;`
  const tdStyle = `padding:7px 12px;color:${white};border-bottom:1px solid rgba(255,255,255,0.06);vertical-align:middle;`
  const tdNumStyle = `padding:7px 12px;color:${white};border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:middle;`
  const tdCenterStyle = `padding:7px 12px;color:${white};border-bottom:1px solid rgba(255,255,255,0.06);text-align:center;vertical-align:middle;`
  const tdDimStyle = `padding:7px 12px;color:${dimText};border-bottom:1px solid rgba(255,255,255,0.06);text-align:right;vertical-align:middle;`

  const anchorLinkStyle = `color:${gold};text-decoration:none;font-size:${isMobile ? '13px' : '14px'};line-height:1.9;`

  const navItems = [
    ['tese', 'Тесте, играчи и отбори'],
    ['razdavane', 'Раздаване'],
    ['naddavane', 'Наддаване'],
    ['karti', 'Сила и стойност на картите'],
    ['boia', 'Разиграване при боя'],
    ['vsichko', 'Разиграване на „Всичко коз”'],
    ['bez', 'Разиграване на „Без коз”'],
    ['anonsi', 'Анонси'],
    ['belot', 'Белот'],
    ['tochki', 'Точкуване и закръгляване'],
    ['vutre', 'Вътре и висяща игра'],
    ['kontra', 'Контра и реконтра'],
    ['kapo', 'Капо'],
    ['krai', 'Край на партията'],
    ['online', 'Онлайн игра в Pika.bg'],
  ]

  const navHtml = navItems.map(([id, label]) =>
    `<li><a href="#${id}" style="${anchorLinkStyle}">${label}</a></li>`
  ).join('\n        ')

  return `
<article style="padding:${padding};max-width:${maxWidth};box-sizing:border-box;">

  <header style="margin-bottom:${isMobile ? '20px' : '30px'};">
    <h1 style="margin:0 0 10px;color:${white};font-size:${titleSize};font-weight:900;line-height:1.1;letter-spacing:-0.01em;">Правила на белота</h1>
    <p style="${pDimStyle}margin-bottom:0;">Белотът е отборна игра за четирима души. Играчите са разделени на два отбора, като партньорите седят един срещу друг. Всяко раздаване включва наддаване, разиграване на осем ръце и изчисляване на резултата.</p>
    <p style="${pDimStyle}margin-bottom:0;margin-top:8px;">Целта е отборът да достигне поне 151 записани точки и да има повече точки от противника. Ако двата отбора имат равен резултат над целта, партията продължава, докато единият поведе.</p>
    <p style="${pDimStyle}margin-bottom:0;margin-top:8px;">Тази страница описва правилата, които се използват в Pika.bg. При игра на живо могат да се срещнат различни местни уговорки.</p>
  </header>

  <nav style="${sectionStyle}" aria-label="Съдържание">
    <h2 style="${h2Style}">Съдържание</h2>
    <ul style="${ulStyle}list-style:none;padding-left:0;">
        ${navHtml}
    </ul>
  </nav>

  <section id="tese" style="${sectionStyle}">
    <h2 style="${h2Style}">Тесте, играчи и отбори</h2>
    <p style="${pStyle}">Играе се с 32 карти. Във всяка от четирите бои участват:</p>
    <p style="margin:0 0 12px;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">7, 8, 9, 10, вале, дама, поп и асо.</p>
    <p style="${pStyle}">Боите са:</p>
    <ul style="${ulStyle}">
      <li>спатия;</li>
      <li>каро;</li>
      <li>купа;</li>
      <li>пика.</li>
    </ul>
    <p style="${pStyle}margin-bottom:0;">Четиримата играчи образуват два отбора. Партньорите са разположени един срещу друг. Редът на игра се запазва през цялото раздаване.</p>
  </section>

  <section id="razdavane" style="${sectionStyle}">
    <h2 style="${h2Style}">Раздаване</h2>
    <p style="${pStyle}">Pika.bg автоматично определя раздаващия и играча, който реже тестето. След всяко приключило или пропуснато раздаване ролята на раздаващ преминава към следващия играч.</p>
    <p style="${pStyle}">Картите се раздават обратно на часовниковата стрелка на три етапа:</p>
    <ol style="${olStyle}">
      <li>първо по 3 карти;</li>
      <li>след това по още 2 карти;</li>
      <li>след приключване на наддаването — последните 3 карти.</li>
    </ol>
    <p style="${pStyle}">Всеки играч получава общо 8 карти.</p>
    <p style="${pStyle}margin-bottom:0;">Наддаването започва още по време на поетапното раздаване. Играчът след раздаващия по реда на игра наддава пръв и започва първата ръка след определяне на договора.</p>
  </section>

  <section id="naddavane" style="${sectionStyle}">
    <h2 style="${h2Style}">Наддаване</h2>
    <p style="${pStyle}">Чрез наддаването се определя как ще се играе раздаването.</p>
    <p style="${pStyle}">Възможните действия са:</p>
    <ul style="${ulStyle}">
      <li>пас;</li>
      <li>спатия;</li>
      <li>каро;</li>
      <li>купа;</li>
      <li>пика;</li>
      <li>без коз;</li>
      <li>всичко коз;</li>
      <li>контра;</li>
      <li>реконтра.</li>
    </ul>
    <h3 style="${h3Style}">Сила на обявите</h3>
    <p style="${pStyle}">Обявите са подредени от най-ниска към най-висока така:</p>
    <ol style="${olStyle}">
      <li>спатия;</li>
      <li>каро;</li>
      <li>купа;</li>
      <li>пика;</li>
      <li>без коз;</li>
      <li>всичко коз.</li>
    </ol>
    <p style="${pStyle}">Следващата обява трябва да бъде по-висока от текущата. Играчът може и да пасува.</p>
    <h3 style="${h3Style}">Край на наддаването</h3>
    <p style="${pStyle}">Ако вече има направена обява, наддаването приключва след три последователни паса. Последната валидна обява става договорът за раздаването.</p>
    <p style="${pStyle}margin-bottom:0;">Ако и четиримата играчи пасуват, раздаването приключва без разиграване и без начисляване на точки. Раздаващият се сменя, тестето отново се реже и започва ново раздаване.</p>
  </section>

  <section id="karti" style="${sectionStyle}">
    <h2 style="${h2Style}">Сила и стойност на картите</h2>
    <p style="${pStyle}">Силата на картата определя коя карта печели ръката. Точковата стойност определя колко точки носи картата при изчисляването на резултата.</p>

    <h3 style="${h3Style}">Козови карти</h3>
    <p style="${pStyle}">При договор на боя картите от избраната козова боя са подредени така:</p>
    <div style="${tableWrapStyle}">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th style="${thStyle}text-align:right;">Сила</th>
            <th style="${thStyle}text-align:center;">Карта</th>
            <th style="${thStyle}text-align:right;">Точки</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="${tdDimStyle}">1</td><td style="${tdCenterStyle}">Вале</td><td style="${tdNumStyle}">20</td></tr>
          <tr><td style="${tdDimStyle}">2</td><td style="${tdCenterStyle}">9</td><td style="${tdNumStyle}">14</td></tr>
          <tr><td style="${tdDimStyle}">3</td><td style="${tdCenterStyle}">Асо</td><td style="${tdNumStyle}">11</td></tr>
          <tr><td style="${tdDimStyle}">4</td><td style="${tdCenterStyle}">10</td><td style="${tdNumStyle}">10</td></tr>
          <tr><td style="${tdDimStyle}">5</td><td style="${tdCenterStyle}">Поп</td><td style="${tdNumStyle}">4</td></tr>
          <tr><td style="${tdDimStyle}">6</td><td style="${tdCenterStyle}">Дама</td><td style="${tdNumStyle}">3</td></tr>
          <tr><td style="${tdDimStyle}">7</td><td style="${tdCenterStyle}">8</td><td style="${tdNumStyle}">0</td></tr>
          <tr><td style="${tdDimStyle}">8</td><td style="${tdCenterStyle}">7</td><td style="${tdNumStyle}">0</td></tr>
        </tbody>
      </table>
    </div>
    <p style="${pStyle}">Валето е най-силният коз, а деветката е вторият по сила.</p>

    <h3 style="${h3Style}">Некозови карти</h3>
    <p style="${pStyle}">Картите от останалите бои при договор на боя, както и всички карти при „Без коз”, са подредени така:</p>
    <div style="${tableWrapStyle}">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th style="${thStyle}text-align:right;">Сила</th>
            <th style="${thStyle}text-align:center;">Карта</th>
            <th style="${thStyle}text-align:right;">Точки</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="${tdDimStyle}">1</td><td style="${tdCenterStyle}">Асо</td><td style="${tdNumStyle}">11</td></tr>
          <tr><td style="${tdDimStyle}">2</td><td style="${tdCenterStyle}">10</td><td style="${tdNumStyle}">10</td></tr>
          <tr><td style="${tdDimStyle}">3</td><td style="${tdCenterStyle}">Поп</td><td style="${tdNumStyle}">4</td></tr>
          <tr><td style="${tdDimStyle}">4</td><td style="${tdCenterStyle}">Дама</td><td style="${tdNumStyle}">3</td></tr>
          <tr><td style="${tdDimStyle}">5</td><td style="${tdCenterStyle}">Вале</td><td style="${tdNumStyle}">2</td></tr>
          <tr><td style="${tdDimStyle}">6</td><td style="${tdCenterStyle}">9</td><td style="${tdNumStyle}">0</td></tr>
          <tr><td style="${tdDimStyle}">7</td><td style="${tdCenterStyle}">8</td><td style="${tdNumStyle}">0</td></tr>
          <tr><td style="${tdDimStyle}">8</td><td style="${tdCenterStyle}">7</td><td style="${tdNumStyle}">0</td></tr>
        </tbody>
      </table>
    </div>
    <p style="${pStyle}">При „Без коз” валето е по-силно от деветката, осмицата и седмицата.</p>

    <h3 style="${h3Style}">Карти при „Всичко коз”</h3>
    <p style="${pStyle}">При „Всичко коз” всяка от четирите бои използва козовия ред:</p>
    <p style="margin:0 0 0;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">Вале, 9, асо, 10, поп, дама, 8, 7.</p>
    <p style="${pDimStyle}margin-top:8px;margin-bottom:0;">Точките също са като при козова боя.</p>
  </section>

  <section id="boia" style="${sectionStyle}">
    <h2 style="${h2Style}">Разиграване при договор на боя</h2>
    <p style="${pStyle}">При договор на боя една от четирите бои е коз. Козова карта може да спечели срещу карта от всяка друга боя.</p>
    <p style="${pDimStyle}">Първият играч поставя карта и определя поисканата боя. Останалите играят по една карта по установения ред. След като четиримата изиграят карта, се определя победителят в ръката. Той прибира четирите карти и започва следващата ръка. В едно раздаване има общо осем ръце.</p>

    <h3 style="${h3Style}">Отговаряне в поисканата боя</h3>
    <p style="${pStyle}">Ако имаш карта от поисканата боя, задължително трябва да играеш от нея. Не можеш да играеш коз или друга боя, докато имаш карта от поисканата боя.</p>

    <h3 style="${h3Style}">Когато е поискан коз</h3>
    <p style="${pStyle}">Ако ръката започва с коз и имаш коз, трябва да играеш коз. Ако можеш да поставиш по-висок коз от най-високия, изигран до момента, си длъжен да го направиш. Ако нямаш по-висок коз, трябва да играеш някой от наличните си козове.</p>

    <h3 style="${h3Style}">Когато нямаш от поисканата боя</h3>
    <p style="${pStyle}">Ако нямаш карта от поисканата некозова боя, се проверява кой печели ръката в момента.</p>
    <ul style="${ulStyle}">
      <li>Ако партньорът ти печели, можеш да играеш произволна карта. Можеш да изчистиш друга боя или по желание да използваш коз.</li>
      <li>Ако противникът печели и в ръката още няма коз, трябва да цакаш, когато имаш коз.</li>
      <li>Ако противникът вече е цакал и разполагаш с по-висок коз, трябва да надцакаш.</li>
      <li>Ако имаш само по-нисък коз от вече изиграния, можеш да изиграеш произволна карта. Не си длъжен да дадеш по-ниския коз.</li>
      <li>Ако нямаш нито от поисканата боя, нито коз, можеш да играеш която и да е карта.</li>
    </ul>
  </section>

  <section id="vsichko" style="${sectionStyle}">
    <h2 style="${h2Style}">Разиграване на „Всичко коз”</h2>
    <p style="${pStyle}">При „Всичко коз” картите във всяка боя използват козовата сила и козовата точкова стойност. Това не означава, че карта от произволна боя може да цака друга боя. Ръката се решава в поисканата боя.</p>
    <p style="${pStyle}">Правилата са:</p>
    <ul style="${ulStyle}">
      <li>ако имаш карта от поисканата боя, трябва да отговориш;</li>
      <li>ако имаш по-висока карта от най-високата изиграна карта в тази боя, трябва да я поставиш;</li>
      <li>задължението за качване важи и когато партньорът ти печели ръката;</li>
      <li>ако нямаш от поисканата боя, можеш да играеш произволна карта.</li>
    </ul>
  </section>

  <section id="bez" style="${sectionStyle}">
    <h2 style="${h2Style}">Разиграване на „Без коз”</h2>
    <p style="${pStyle}">При „Без коз” няма козова боя и не може да се цака. Ако имаш карта от поисканата боя, трябва да играеш от нея. Ако нямаш от поисканата боя, можеш да изиграеш произволна карта.</p>
    <p style="${pStyle}">Ръката се печели от най-силната карта в поисканата боя според реда:</p>
    <p style="margin:0 0 12px;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">Асо, 10, поп, дама, вале, 9, 8, 7.</p>
    <p style="${pStyle}margin-bottom:0;">При „Без коз” точките от картите и последната ръка се удвояват преди записването на резултата.</p>
  </section>

  <section id="anonsi" style="${sectionStyle}">
    <h2 style="${h2Style}">Анонси</h2>
    <p style="${pStyle}">Анонсите са допълнителни комбинации от карти, които носят премийни точки. При „Без коз” няма анонси и няма белот.</p>

    <h3 style="${h3Style}">Поредици</h3>
    <p style="${pStyle}">Картите в поредиците се подреждат така:</p>
    <p style="margin:0 0 12px;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">7, 8, 9, 10, вале, дама, поп, асо.</p>
    <div style="${tableWrapStyle}">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th style="${thStyle}">Комбинация</th>
            <th style="${thStyle}">Условие</th>
            <th style="${thStyle}text-align:right;">Точки</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="${tdStyle}">Терца</td><td style="${tdStyle}">3 последователни карти от една боя</td><td style="${tdNumStyle}">20</td></tr>
          <tr><td style="${tdStyle}">Петдесет</td><td style="${tdStyle}">4 последователни карти от една боя</td><td style="${tdNumStyle}">50</td></tr>
          <tr><td style="${tdStyle}">Сто</td><td style="${tdStyle}">5 или повече последователни карти от една боя</td><td style="${tdNumStyle}">100</td></tr>
        </tbody>
      </table>
    </div>

    <h3 style="${h3Style}">Карета</h3>
    <div style="${tableWrapStyle}">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th style="${thStyle}">Каре</th>
            <th style="${thStyle}text-align:right;">Точки</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="${tdStyle}">Четири валета</td><td style="${tdNumStyle}">200</td></tr>
          <tr><td style="${tdStyle}">Четири деветки</td><td style="${tdNumStyle}">150</td></tr>
          <tr><td style="${tdStyle}">Четири аса</td><td style="${tdNumStyle}">100</td></tr>
          <tr><td style="${tdStyle}">Четири десетки</td><td style="${tdNumStyle}">100</td></tr>
          <tr><td style="${tdStyle}">Четири попа</td><td style="${tdNumStyle}">100</td></tr>
          <tr><td style="${tdStyle}">Четири дами</td><td style="${tdNumStyle}">100</td></tr>
        </tbody>
      </table>
    </div>
    <p style="${pStyle}">Карета от седмици и осмици не се признават.</p>

    <h3 style="${h3Style}">Сравняване на анонсите</h3>
    <p style="${pStyle}">Поредиците и каретата се сравняват отделно. При поредиците първо се сравнява дължината и стойността на анонса, а след това най-високата карта в него.</p>
    <p style="${pStyle}">Отборът с по-силния анонс получава точките от всички свои анонси от съответния вид.</p>
    <p style="${pStyle}">Ако най-силните анонси на двата отбора са напълно равни, никой от двата отбора не получава точки за тази група анонси.</p>
    <p style="${pStyle}">Каретата се сравняват по следния ред:</p>
    <p style="margin:0 0 12px;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">Валета, деветки, аса, попове, дами, десетки.</p>
    <p style="${pStyle}">Една карта не може да участва едновременно в две застъпващи се поредици или в поредица и каре. Белотът е изключение — дама или поп могат да участват едновременно в белот и в поредица.</p>
    <p style="${pStyle}margin-bottom:0;">Поредиците и каретата се заявяват при първата ръка на раздаването.</p>
  </section>

  <section id="belot" style="${sectionStyle}">
    <h2 style="${h2Style}">Белот</h2>
    <p style="${pStyle}">Белот е комбинация от поп и дама от една и съща козова боя. Белотът носи 20 точки.</p>
    <ul style="${ulStyle}">
      <li>При договор на боя белот може да има само в избраната козова боя.</li>
      <li>При „Всичко коз” белот може да има във всяка боя. В едно раздаване е възможно да бъдат признати повече от един белот, включително по един във всяка от четирите бои.</li>
      <li>При „Без коз” белот не се признава.</li>
    </ul>
    <p style="${pStyle}">В Pika.bg белотът се заявява при изиграването на попа или дамата от съответната двойка.</p>
    <p style="${pStyle}margin-bottom:0;">Белотът се отчита независимо от сравнението между останалите анонси, освен когато обявилият отбор е „вътре” или договорът се играе с контра или реконтра и всички точки се присъждат на победителя.</p>
  </section>

  <section id="tochki" style="${sectionStyle}">
    <h2 style="${h2Style}">Точкуване и закръгляване</h2>
    <p style="${pStyle}">В края на раздаването се събират точките от всички спечелени карти. Отборът, който спечели осмата и последна ръка, получава допълнително 10 сурови точки. При „Без коз” точките от картите и бонусът за последната ръка се удвояват.</p>
    <p style="${pStyle}">След събирането на суровите точки резултатът се преобразува в записани игрови точки чрез деление на 10 и закръгляване.</p>

    <h3 style="${h3Style}">При договор на боя</h3>
    <p style="${pStyle}">Остатък от 6 или повече се закръгля нагоре. Остатък под 6 се закръгля надолу.</p>
    <p style="${pDimStyle}">Пример: 25 сурови точки се записват като 2; 26 сурови точки се записват като 3.</p>

    <h3 style="${h3Style}">При „Без коз”</h3>
    <p style="${pStyle}">Остатък от 5 или повече се закръгля нагоре. Остатък под 5 се закръгля надолу.</p>

    <h3 style="${h3Style}">При „Всичко коз”</h3>
    <p style="${pStyle}">Остатък от 4 или повече се закръгля нагоре. Остатък под 4 се закръгля надолу.</p>
    <p style="${pStyle}margin-bottom:0;">Ако отделното закръгляване на двата отбора не съвпада с общия резултат за раздаването, една точка се присъжда на отбора с повече сурови точки.</p>
  </section>

  <section id="vutre" style="${sectionStyle}">
    <h2 style="${h2Style}">Вътре и висяща игра</h2>

    <h3 style="${h3Style}">Успешен договор</h3>
    <p style="${pStyle}">Обявилият отбор изпълнява договора, когато има повече точки от защитниците. При успешен договор без контра всеки отбор записва собствените си точки от ръце, анонси и белот.</p>

    <h3 style="${h3Style}">„Вътре”</h3>
    <p style="${pStyle}">Обявилият отбор е „вътре”, когато има по-малко точки от защитниците. В този случай защитниците получават целия резултат от раздаването:</p>
    <ul style="${ulStyle}">
      <li>точките от картите и на двата отбора;</li>
      <li>бонуса за последната ръка;</li>
      <li>всички анонси;</li>
      <li>всички белоти;</li>
      <li>бонуса за капо, ако има такъв.</li>
    </ul>
    <p style="${pStyle}">Обявилият отбор записва 0 точки за раздаването. Това означава, че при „вътре” белотът на обявилия отбор също се прехвърля към защитниците.</p>

    <h3 style="${h3Style}">Висяща игра</h3>
    <p style="${pStyle}">Ако двата отбора имат равен брой точки, раздаването е висящо. Защитниците записват своята част от резултата. Частта на обявилия отбор не се записва веднага, а остава висяща за следващото раздаване.</p>
    <p style="${pStyle}margin-bottom:0;">Висящите точки се присъждат на отбора, който спечели следващото решено раздаване. Ако и следващото раздаване завърши наравно, висящата стойност се запазва и може да се натрупа.</p>
  </section>

  <section id="kontra" style="${sectionStyle}">
    <h2 style="${h2Style}">Контра и реконтра</h2>

    <h3 style="${h3Style}">Контра</h3>
    <p style="${pStyle}">Контра може да бъде обявена само от противниковия отбор на играча, направил текущата обява. Контрата означава, че резултатът от раздаването се удвоява.</p>
    <p style="${pStyle}">При решено раздаване победилият отбор получава целия точков пул, включително точките от всички ръце, последната ръка, анонсите и белотите на двата отбора и бонуса за капо. След това целият резултат се умножава по 2. Загубилият отбор записва 0 точки.</p>

    <h3 style="${h3Style}">Реконтра</h3>
    <p style="${pStyle}">Реконтра може да обяви само отборът, направил основната обява, след като противниците са казали контра. При реконтра се използват същите правила като при контра, но целият резултат се умножава по 4. Победилият отбор получава целия учетворен пул, а загубилият записва 0.</p>

    <h3 style="${h3Style}">Висяща контра или реконтра</h3>
    <p style="${pStyle}margin-bottom:0;">При равенство защитниците записват своята част, умножена по 2 при контра или по 4 при реконтра. Частта на обявилия отбор също се умножава и остава като висяща стойност за следващото решено раздаване.</p>
  </section>

  <section id="kapo" style="${sectionStyle}">
    <h2 style="${h2Style}">Капо</h2>
    <p style="${pStyle}">Капо има, когато един отбор спечели всичките осем ръце в раздаването.</p>
    <p style="${pStyle}">Бонусът е:</p>
    <ul style="${ulStyle}">
      <li>90 сурови точки при договор на боя;</li>
      <li>90 сурови точки при „Всичко коз”;</li>
      <li>180 сурови точки при „Без коз”.</li>
    </ul>
    <p style="${pStyle}">При контра или реконтра бонусът за капо е част от общия резултат и също се умножава.</p>
    <p style="${pStyle}">В Pika.bg се прилага правилото:</p>
    <p style="margin:0 0 12px;color:${gold};font-size:${isMobile ? '14px' : '15px'};font-weight:700;">„С капо не се излиза.”</p>
    <p style="${pStyle}margin-bottom:0;">Ако отбор премине целта от 151 точки чрез раздаване с капо, партията не приключва веднага. Трябва да се изиграе още едно решено раздаване, което не завършва с капо. Раздаване, при което всички са пасували, не изпълнява това условие.</p>
  </section>

  <section id="krai" style="${sectionStyle}">
    <h2 style="${h2Style}">Край на партията</h2>
    <p style="${pStyle}">Партията приключва, когато след допустимо решено раздаване:</p>
    <ul style="${ulStyle}">
      <li>поне единият отбор има 151 или повече точки;</li>
      <li>двата отбора нямат равен резултат;</li>
      <li>последното раздаване не е капо.</li>
    </ul>
    <p style="${pStyle}">Ако само единият отбор е достигнал 151 точки, той печели. Ако и двата отбора са достигнали или преминали 151 точки, печели отборът с повече точки. Ако резултатът е равен, партията продължава до следващото решено раздаване.</p>
  </section>

  <section id="online" style="${sectionStyle}">
    <h2 style="${h2Style}">Онлайн игра в Pika.bg</h2>
    <p style="${pStyle}">За да протича играта без продължително чакане, всеки човешки играч разполага с 20 секунди за рязане, обява по време на наддаването и изиграване на карта.</p>
    <p style="${pStyle}">Ако времето изтече, управлението на мястото може временно да бъде поето от бот. При повторно свързване играчът може да възстанови управлението и да продължи участието си в текущата партия.</p>
    <p style="${pStyle}">Интерфейсът на Pika.bg автоматично:</p>
    <ul style="${ulStyle}">
      <li>показва позволените обяви;</li>
      <li>разрешава само валидните карти за текущия ход;</li>
      <li>изчислява победителя във всяка ръка;</li>
      <li>отчита анонсите и белотите;</li>
      <li>изчислява и закръглява резултата;</li>
      <li>преминава към следващото раздаване.</li>
    </ul>
  </section>

  <section style="${sectionStyle}border-color:${goldDim};background:rgba(201,168,76,0.06);">
    <h2 style="${h2Style}">Кратко обобщение</h2>
    <p style="${pStyle}">За начинаещия най-важните правила са:</p>
    <ol style="${olStyle}">
      <li>Винаги отговаряй в поисканата боя, когато имаш такава карта.</li>
      <li>При договор на боя цакай, когато нямаш от поисканата боя, противникът печели и разполагаш с коз.</li>
      <li>Надцакай, когато противникът е цакал и имаш по-висок коз.</li>
      <li>При „Всичко коз” трябва да качваш в поисканата боя, когато имаш по-висока карта.</li>
      <li>При „Без коз” няма цакане и няма анонси.</li>
      <li>Следи валето и деветката — те са най-силните козове.</li>
      <li>Последната ръка носи допълнителни 10 точки.</li>
      <li>Обявилият трябва да има повече точки от защитниците, за да изпълни договора.</li>
      <li>Контрата удвоява целия пул, а реконтрата го учетворява.</li>
      <li>Партията обикновено завършва при 151 или повече точки, но с капо не се излиза.</li>
    </ol>
  </section>

</article>
`
}
