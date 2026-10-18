# Свара — 2Б.3.7.8Б: одобрени поправки и реална Chromium матрица

Дата: 18.10.2026. Клон: `v2-clean-architecture`. Начален публикуван HEAD: `2e98c9b288b18abfb193337a43bc4f6f7136514c`.

Общият Chromium/HTTP/Auth/WS/SQLite пакет премина **17/17**, без повторения на неуспешен сценарий вътре в изпълнението. След последния compatibility преглед допълнителните три независими Chromium reconnect сесии също преминаха **3/3**. Финалните regression, TypeScript и build проверки са успешни; няма нов блокиращ дефект. Точният публикуван commit и Git статус са във финалния отчет. Няма SSH, production deploy или промени по реалните жълтици, production базата и резервните копия на Pika.bg.

## Одобрена поправка: „Изход“ при finished

Първоначалният дефект беше възпроизведен два пъти: действителен завършен мач, revision 16, **200 / 0**, но и двамата получават `wrong_phase`. Причината беше преобразуване на leave заявката в engine exit извън lobby; `exitMatch()` правилно изисква in-progress. Историческите доказателства са в `tmp/svara-multiplayer/terminal-exit-repro-{1,2}.log`.

След изричното одобрение `server/src/games/svara/createSvaraLobby.ts`:

- Запазва съществуващите session/profile/access проверки и проверява участието в конкретната маса.
- При finished приключва само прегледа чрез `svara_table_left`, без engine exit, финансово действие или запис в архива.
- Пази временно кой е затворил резултата. Останалите участници продължават да виждат същия резултат и могат да го възстановят при refresh или WS reconnect.
- След последния изход освобождава масата чрез `runtime.releaseMatch()`, който премахва само runtime записа. Пълният SQLite ред, включително метаданните, остава идентичен. При външно предоставен runtime без persistence архивът остава при неговия собственик.
- Повторна заявка след освобождаване проверява членството в durable архива и отговаря без възстановяване на engine. Закъснял стар изход не затваря новата маса на същия играч.
- Запазва досегашния in-progress engine път.

В реалните браузърни тестове са проверени последователен изход, останалият резултат при другите, едновременен изход с 2 и 4 играчи, повторение преди/след runtime release, външен профил, refresh/reconnect преди и след изход и закъсняла заявка след създаване на нова маса. След последния изход private IPC доказва липсата на стария matchId в действителния runtime. Архивът, ledger, банките и стековете са непроменени от изхода.

## Одобрена поправка: reconnect/offline recovery

Вторият дефект беше възпроизведен в две независими Chromium сесии: PID/порт **13856/61192** и **9768/61551**, revision 6, in-progress/ordinary, стекове 95/90, банка 15. Сървърът изпраща connected, правилния snapshot и timing; клиентът след това отваря `/lobby?offlineReload=...`.

Причината е неправилен приоритет в общата клиентска политика, а не загубено сървърно състояние: onClose задава общия reload флаг, onOpen избира forced-lobby-reload преди потвърждението за Свара, а `forceOfflineLobbyReload()` изпълнява навигацията след 300 ms. Полученият междувременно snapshot не отменя вече насрочената навигация. Исторически доказателства: `tmp/svara-multiplayer/ws-reconnect-repro-{1,2}.log/.png`.

Одобрената промяна е ограничена до `src/main.ts`, `socketReconnectPolicy.ts` и `createLobbyFlowController.ts`:

- Отделен Svara close/open/offline/retry път отлага навигацията и презаверява текущата маса чрез съществуващите read-only list/state заявки.
- Запазеният matchId и последният server-derived cache са само контекст за проверка. Членството се потвърждава от сървърния списък, след което се изчакват съответстващи snapshot и timing за същата маса/revision.
- При липсващо участие/освободена маса се изчиства старият view. При невалиден достъп се използва съществуващият access flow към „Игри“. Не се създава локална заместителна партия.
- Стар matchId, затворен резултат и по-стари revisions не заменят текущия view/cache. Равна revision може да потвърди новата връзка, без повторен presentation replay. Прясно server ACK на изрично повторно join позволява отново напусната чакаща маса.
- DOM remount не губи server-derived контекста. Изричният „Изход“ изчиства съответния контекст и остава действащ.
- Няма автоматично повторени залози, такси, изплащания, start/join/leave или нова маса. Сроковете остават абсолютните сървърни deadlines.
- Действително активни Белот/Ludo имат предимство пред остатъчен Svara cache. Съществуващите spectator/zombie/ordinary-lobby решения са запазени и проверени отделно.

Общата WS архитектура, Auth проверките, протоколът, commandId/revisions, engine правилата, RNG, банките и финансовите реализации не са променяни.

## Реален Chromium резултат по сценарии

Всеки ред използва независими browser contexts, регистрации/сесии, собствен backend и SQLite. Стековете са в реда на тестовите играчи, изцяло виртуални.

| № | Сценарий | Резултат | Сървърна фаза; стекове | Проверен backend PID / порт |
| --- | --- | --- | --- | --- |
| 1 | Пълен мач с 2 играчи | PASS | finished; 200 / 0 | 1288 / 63785 |
| 2 | Пълен мач с 3 играчи | PASS | finished; 300 / 0 / 0 | 4916 / 63991 |
| 3 | Пълен мач с 4 играчи | PASS | finished; 400 / 0 / 0 / 0 | 15796 / 64229 |
| 4 | Едновременен finished изход с 2 играчи | PASS | finished; 200 / 0 | 13296 / 64538 |
| 5 | Независим reconnect №1; включително dealing | PASS | finished; 200 / 0 | 708 / 64714 |
| 6 | Независим reconnect №2 | PASS | finished; 200 / 0 | 4992 / 64920 |
| 7 | Независим reconnect №3; offline/online и Retry | PASS | finished; 200 / 0 | 10032 / 65131 |
| 8 | Отнет достъп при reconnect | PASS | in-progress; 95 / 95 | 16848 / 65351 |
| 9 | Изтекъл ход; reveal и presence-wait reconnect | PASS | in-progress; 95 / 105 | 5096 / 65450 |
| 10 | Забавени оригинални snapshot/timing от стара маса | PASS | finished; 200 / 0 | 960 / 49281 |
| 11 | Graceful backend restart и Chromium recovery | PASS | finished; 200 / 0 | 11404 / 49507 |
| 12 | Backend crash и Chromium recovery | PASS | finished; 200 / 0 | 16340 / 49725 |
| 13 | ×2/×3/×4/×5, Покажи/Скрий/timeout и protocol guards | PASS | finished; 200 / 0 | 12712 / 49841 |
| 14 | Основна/странична банка; различни победители | PASS | finished; 0 / 0 / 400 / 0 | 7820 / 50132 |
| 15 | Специална Ол-ин Свара; основна/странична банка | PASS | finished; 0 / 0 / 400 / 0 | 17304 / 50500 |
| 16 | Обикновена Свара; платено включване и отказ | PASS | finished; 400 / 0 / 0 / 0 | 13776 / 50888 |
| 17 | Обикновена Свара; платено включване и 15s timeout | PASS | finished; 400 / 0 / 0 / 0 | 9764 / 51299 |

В ред 8 остават 10 чипа в живата банка; отказът за достъп не променя партията. Ред 9 умишлено проверява отсъстващ играч в активен presence-wait, със запазени 200 чипа и единствено плащане след timeout. Ред 10 проверява завършения стар архив и отделно изрично създадена нова чакаща маса.

Трите независими reconnect сценария проверяват последователни прекъсвания, същите собствени карти/скрити чужди, запазен deadline, refresh, SPA remount, липса на повторен bet/look/deal animation и изход от finished с последващ reconnect без възстановяване на напуснатата маса. Native WS reconnect е изпълнен при dealing, betting, showdown, payout, joining, reveal-choice, reveal-display, presence-wait и finished. При изтеклия ход се възстановява новата сървърна фаза и timeout плащането е точно веднъж.

Изпълнение: `tmp/svara-28b-reconnect-final-matrix.log`. Пълни доказателства за PID, порт, точен DB файл, matchId, revision, крайни стекове, ledger и history броячи: `tmp/svara-multiplayer/full-final-success.json`. Родителят проверява nonce/PID/parent/listener/точен DB и worker health преди да допуска тестови заявки.

Backend restart/crash сценарии запазват същия собствен SQLite файл и браузърни сесии. Gateway не препраща заявки към освободен или непроверен порт; след новото identity потвърждение използва новия backend. Действителните карти, балансите, ledger и deadline са идентични преди/след restart, после мачът завършва 200/0.

Тестът за закъснели съобщения задържа оригинални native MessageEvent snapshot/timing от действителния удостоверен сървър и ги доставя след реален изход и нова маса. Не фабрикува клиентски state или заместителен сървърен отговор. Това е отделен тест за забавена доставка; нормалните reconnect сценарии използват непроменени действителни WS съобщения.

## Финансови и времеви доказателства

- При entryFee 1000 тестовият server starting stack е 100, а UI default ante 5%. В двуиграчния мач първото изплащане е 20; след второто раздаване спорната банка 180 и непокритите 20 дават финални 200/0.
- Четирииграчният банков сценарий достига стекове 90/130/70/90 и банки **300 / 60 / 40**, с права съответно 4/3/1. Основната банка 300 печели играч с индекс 2, страничната 60 — индекс 0, а 40 са непокрита част, върната на индекс 1. След следващия контролиран рунд резултатът е 0/0/400/0.
- При специалната Ол-ин Свара се заключват две отделни банки 300 и 60, показва се „СВАРА!“, няма обикновен прозорец за платено включване и действителният allin-svara history запис урежда банките по веднъж.
- При обикновената Свара заключената банка е 30; такса за включване 15 я прави 45. При уреждане се плащат 45 плюс новата банка 15. Повтореният commandId връща duplicate без повторна такса. Отказът не дебитира играча; undecided изборът изтича след действителните 15 секунди.
- Проверени са ×3/×4/×5 след „Погледни“ със суми 15/20/25 и отделен залог на тъмно ×2 със сума 20. Минимумът на тъмно е 10; обикновеният е 5.
- Showdown, payout, 3s публично показване и 15s joining използват реалния часовник. Read-only reconnect не рестартира сроковете. Presence-wait reconnect запазва действителния петминутен deadline.
- При всяко прочитане независим double-entry replay се сверява с engine инвариантите и реалния SQLite. Индивидуалните WS snapshot-и и DOM се сравняват при една и съща revision; скритите чужди карти никога не са разрешени. Плащанията и балончетата за всяка банка се наблюдават паралелно с reconnect, включително при естествен преход на фаза.
- Тестовите `profile_wallets` остават идентични. Архивът след finished изход е byte-identical като пълен SQLite ред. В пълните мачове removedChips е 0 и сумите са 200/300/400 според броя играчи.

## Регресии и builds

| Пакет | Резултат / ниво |
| --- | --- |
| Engine | 88/88 във финалното изпълнение |
| Access | 55/55 във финалното изпълнение |
| Node HTTP/Auth/WS/SQLite restart | 13/13 във финалното изпълнение; 34 старта, 28 graceful stop, 6 crash |
| Recovery / Snapshot security | 37/37; 20/20 |
| Lifecycle | 30/30, включително новия finished dismissal тест |
| Chips / Match | 25/25; 72/72 |
| Gameplay / Showdown / Lobby WS | 14/14; 25/25; 14/14 във финалните изпълнения |
| Infrastructure | 9/9 във финалното изпълнение |
| Базов реален Chromium 8А | 24/24 |
| Общ реален Chromium 8Б | 17/17 |
| Допълнителен Chromium reconnect след compatibility прегледа | 3/3; пресни PID/порт 16604/54676, 1336/54891, 2100/55103; всички завършват 200/0 |
| Client lobby / Reconnect policy | 17/17; 8/8, source/unit, отделно от Chromium |
| Betting UI / Decision windows | 28/28; 15/15, unit/source |
| PWA auto-update | 35/35, unit/source |
| Private-room client resync | 10/10, source |
| TypeScript | Клиент чрез npm build, сървър чрез изолираните builds; strict проверка на деветте засегнати TS test/helper файла — PASS |
| Vite/PWA build | PASS; остава съществуващото предупреждение за големи chunks |
| Diff checks | PASS: git diff --check и проверки на двата нови файла |

Логовете за последните проверки са `tmp/svara-28b-reconnect-*.log`. Engine/access/restart проверките не са отслабвани. Запазени са AST import guard-ът (88 проверки), access UI проверките и compiled isolated startup, както и restart наблюдението на всяка showdown/payout граница при deadline−1 и точно на deadline.

Последното тройно Chromium потвърждение е в `tmp/svara-28b-reconnect-final-confirmation.log` и `tmp/svara-multiplayer/final-confirmation-success.json`. То използва окончателните guards за Белот/Ludo; предишният общ пакет е запазен отделно като full-final-success.json.

По време на развитието са поправени чисто тестови предположения: минимум 5 вместо 10 при blind bet; очакван history запис преди приключване на reveal-choice; очакване за стара display фаза след естествено изтекъл срок; неатомарно сравнение на WS/DOM/SQLite от две revisions. Проверки за точните суми, всички payout стъпки, privacy и deadlines остават. Неуспешните развойни логове са запазени; общият пакет остава fail-fast, без прикриване чрез автоматични сценарийни повторения.

Старият private-room source тест даваше 8/10 и върху публикувания HEAD: търсеше премахнат inline active-room клон и първото PWA извикване от различен early-return клон. Обновено е само извличането на действителните recovery клонове и ефектния ред в обикновения lobby път. Сега проверява и трите active-game early-return клона; поведението на private rooms не е променяно. Доказателство: `tmp/svara-28b-private-resync-head-baseline.log`.

## Изолация и ограничения

Детерминистичният RNG е инсталиран само в частното копие чрез съществуващата restart fixture, защитена с NODE_ENV=test, точни parent/nonce и private IPC. В Chromium няма fake clock, прескачане или скъсяване на игровите срокове. Няма публични test endpoints или engine imports в клиента. Диагностиката съдържа само собствени тестови игрови данни и се игнорира от Git, без cookies/пароли.

Крайният read-only audit установи **0** останали browser/lobby/restart/access временни директории от тези пакети и **0** съответстващи тестови Node процеса. Съществуваща отделна optimization директория не е създавана или използвана от настоящото изпълнение и е оставена непокътната.

Chromium backend restart/crash са проверени по време на betting. По-широките restart фази, корупция/quarantine и финансови crash граници се проверяват от отделния Node HTTP/Auth/WS/SQLite пакет; това не се представя за допълнително Chromium покритие. Пълното изтичане на петминутния presence-wait не е изчаквано в Chromium; проверено е запазването му при reconnect. Не са изпълнявани нови пълни Chromium партии Белот/Ludo или production/load тестове. Споделената политика има изрични compatibility guards и отделни регресии.

## Променени файлове и Git

Запазени са всички наследени 12 файла и тестове, без reset, clean, stash или презаписване от checkout. Общо са променени/добавени 17 файла:

- Одобреният сървърен lifecycle и тест: `server/src/games/svara/createSvaraLobby.ts`, `server/scripts/checkSvaraLifecycle2B35.ts`.
- Клиентски recovery: `src/main.ts`, `src/app/network/socketReconnectPolicy.ts`, `src/app/lobby/createLobbyFlowController.ts`.
- Client/source регресии: `scripts/checkSocketReconnectPolicy.ts`, `server/scripts/checkPrivateRoomReconnectClientResync.ts`.
- Реален harness и матрица: `scripts/checkSvaraMultiplayerReal.ts`, `scripts/svaraRealIntegrationHarness.ts`, `scripts/checkSvaraRealIntegrationHarness.ts`, `server/scripts/fixtures/svaraRestartHooks.mjs`.
- Запазени тестови поправки: `server/scripts/checkSvaraEngine2B1.ts`, `server/scripts/checkSvaraStage1Access.ts`, `server/scripts/checkSvaraRestart2B36C.ts`.
- `.gitignore`, `package.json` и този отчет.

След fetch HEAD и origin са началният `2e98c9b288b18abfb193337a43bc4f6f7136514c`, ahead/behind 0/0, origin `https://github.com/mimojef/belot.git`. Commit/push се изпълняват само след успешните финални проверки. Свара не се обявява за готова за продукция без следващо одобрение.
