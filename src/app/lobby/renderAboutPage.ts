export function renderAboutPage(isMobile = false): string {
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

  const warningStyle = `
    background:rgba(201,168,76,0.08);
    border:1px solid rgba(201,168,76,0.5);
    border-left:4px solid ${gold};
    border-radius:6px;
    padding:${isMobile ? '12px 14px' : '14px 18px'};
    margin:14px 0 10px;
  `.replace(/\s+/g, ' ').trim()

  return `
<article style="padding:${padding};max-width:${maxWidth};box-sizing:border-box;">

  <header style="margin-bottom:${isMobile ? '20px' : '30px'};">
    <h1 style="margin:0 0 10px;color:${white};font-size:${titleSize};font-weight:900;line-height:1.1;letter-spacing:-0.01em;">За Pika.bg</h1>
    <p style="${pDimStyle}margin-bottom:0;">Pika.bg събира любителите на белот на едно място онлайн — с лоби, маси по избран залог в жълтици и частни стаи за игра с приятели, независимо дали играеш с десетилетия на карти или тепърва сядаш на маса за пръв път.</p>
  </header>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Развлекателна игра на белот</h2>
    <p style="${pStyle}">Целта на Pika.bg е проста: да направи белота лесно достъпен онлайн, без да е нужно да събираш трима приятели физически на маса. Влизаш в лобито, избираш маса според залога в жълтици, който ти е удобен, и играта започва веднага — сама по себе си сред други играчи или с приятели в частна стая.</p>
    <p style="${pStyle}margin-bottom:0;">Платформата поддържа профили, ранг система, статистика на изиграните партии и класации, за да можеш да следиш собствения си напредък и да се сравняваш с други играчи във времето.</p>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Виртуална валута, не реални пари</h2>
    <div style="${warningStyle}">
      <p style="${pStyle}margin-bottom:0;"><strong>Жълтиците в Pika.bg са изцяло вътрешна виртуална игрова валута.</strong> Те се използват единствено за вход в игрови маси в самата платформа. Жълтиците нямат парична стойност извън Pika.bg, не могат да бъдат осребрени, изтеглени или разменени за реални пари, награди или каквато и да е материална облага.</p>
    </div>
    <p style="${pStyle}margin-top:12px;">Pika.bg не е хазартна платформа — не организира залози с реални пари и не изплаща парични или предметни печалби. Игрите се играят изцяло за забавление и спортен интерес.</p>
    <p style="${pStyle}margin-bottom:0;">Подробности за виртуалната валута, регистрацията и плащанията за допълнителни жълтици са описани в <a href="/terms" style="${linkStyle}">Общите условия</a>.</p>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Какво целим да предложим</h2>
    <ul style="${ulStyle}">
      <li>Лесен и бърз достъп до игра на белот — без чакане на четирима налични приятели.</li>
      <li>Възможност за игра с реални приятели чрез частни стаи, както и с други играчи от общността.</li>
      <li>Ранг и класации, които отразяват реалния ти напредък във времето.</li>
      <li>Честно и случайно раздаване на карти за всеки участник на масата, включително ботовете.</li>
      <li>Публично достъпни и ясно описани правила на играта, без скрити условия.</li>
    </ul>
  </section>

  <section style="${sectionStyle}border-color:${goldDim};background:rgba(201,168,76,0.06);">
    <h2 style="${h2Style}">Продължи напред</h2>
    <p style="${pStyle}">Ако тепърва опознаваш играта, започни от <a href="/learn" style="${linkStyle}">Научи белот</a>. Ако искаш пълните формални правила, виж <a href="/rules" style="${linkStyle}">Правила на белота</a>. За въпроси относно честността на раздаването и ротата на ботовете, прочети <a href="/fair-play" style="${linkStyle}">Честна игра</a>.</p>
    <p style="${pStyle}margin-bottom:0;">За всякакви други въпроси или сигнали, свържи се с нас през <a href="/contact" style="${linkStyle}">страницата за контакти</a>.</p>
  </section>

</article>
`
}
