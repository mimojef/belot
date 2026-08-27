# Локален турнирен тестов режим

Строго локален dev/test режим, който позволява да се пусне и наблюдава цял
турнир (регистрация → bracket → gameplay → advancement → финал → settlement →
cleanup) през браузъра, използвайки **реалния** tournament coordinator,
scheduler, room runtime, bot логика и settlement код — не фиктивна симулация.

Режимът е **напълно неактивен**, освен ако не са изпълнени едновременно:

- `BELOT_LOCAL_TOURNAMENT_TEST_MODE=1`
- `NODE_ENV` не е `production`
- заявката към dev endpoint-ите идва от `127.0.0.1`/`::1` (loopback)

Централният guard е в
[`server/src/localTournamentTest/localTournamentTestModeGuard.ts`](../server/src/localTournamentTest/localTournamentTestModeGuard.ts).
При `NODE_ENV=production` dev endpoint-ите връщат `404` (не `403`) — не издават
дори собственото си съществуване.

## Отделна DB

Режимът никога не пипа обичайната локална база
(`server/database/data/belot-v2.sqlite`). Вместо това пренасочва към отделен
файл:

```
server/database/data/belot-v2-tournament-test.sqlite
```

Пренасочването е автоматично (виж `getServerDatabaseFilePath`/
`ensureServerDatabaseReady` в `server/src/db/ensureServerDatabaseReady.ts`) —
активира се само когато горният guard е `true`. Може да се override-не с
`BELOT_LOCAL_TOURNAMENT_TEST_DB_PATH`, но пътят **трябва** да съдържа маркера
`tournament-test` в името си (валидирано от
`assertSafeLocalTournamentTestDatabasePath`) — сочене към споделената
production/development база спира стартирането с грешка.

Миграциите се прилагат автоматично при старт (същият `ensureServerDatabaseReady`
runner, който ползва production).

## Ускорени таймери (само в local test mode)

| Env variable | По подразбиране (production) | Пример за тест |
|---|---|---|
| `BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS` | 180000 (3 мин) | `5000` |
| `BELOT_LOCAL_TOURNAMENT_TRANSITION_MS` | 20000 (20 сек) | `3000` |
| `BELOT_LOCAL_BOT_ACTION_MIN_MS` | 100 | `100` |
| `BELOT_LOCAL_BOT_ACTION_MAX_MS` | 300 | `300` |

Всички четири стойности се четат централно от
`getLocalTournamentTestTimingOverrides()` в guard модула — без флага връщат
точно production константите. Target score, scoring, declarations, bidding,
card legality, advancement и prize проценти **не се променят**.

## Bot модел

Ботовете НЕ се създават специално за теста — преизползват се съществуващите
~300 catalog bot профила (`profile_kind='bot'`), които сървърът вече seed-ва
при всеки старт. Записват се в турнира по абсолютно същия начин като реален
solo join (`tournamentEconomyStore.joinTournamentSoloAtomically`) и след това
никога не се "connect-ват" по WebSocket — реалният no-show/attendance
механизъм на coordinator-а (виж `resolveAttendance` в
`server/src/tournament/tournamentCoordinator.ts`) е този, който ги сяда да
играят реално (`pickServerBotBidAction`/`pickServerBotPlayCard`), когато
attendance прозорецът изтече без те да са "присъствали". Никакви фалшиви
browser connections не се използват за ботове.

## Стартиране

PowerShell, от корена на проекта:

```powershell
cd D:\Project\Belot-V2\server
$env:BELOT_LOCAL_TOURNAMENT_TEST_MODE = "1"
$env:BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS = "5000"
$env:BELOT_LOCAL_TOURNAMENT_TRANSITION_MS = "3000"
$env:BELOT_LOCAL_BOT_ACTION_MIN_MS = "100"
$env:BELOT_LOCAL_BOT_ACTION_MAX_MS = "300"
npm.cmd run dev:tournament-test
```

Сървърът логва `[local-tournament-test] enabled` и пътя до тестовата база при
старт. В нов PowerShell прозорец, за фронтенда:

```powershell
cd D:\Project\Belot-V2
npm.cmd run dev
```

(Frontend-ът е напълно непроменен от тази задача — просто сочи към локалния
сървър на `http://localhost:3001` по обичайния начин.)

## Контролен панел

```
http://localhost:3001/dev/tournament-test
```

Панелът се сервира директно от сървъра (не е част от production frontend
bundle-а) и е достъпен само при активен local test mode. Изброява:

- **Създай тестов турнир** — формат (4/8/16 отбора) × режим:
  1. `one_human` — един реален играч + всички останали ботове
  2. `all_bots` — всички участници са ботове
  3. `two_humans` — двама тестови човешки профила в един отбор (реален
     partner-invite) + останалите ботове
- **Покажи техническо състояние** — tournament ID, status, кръгове, мачове,
  room IDs, attendance/settlement състояние (JSON, само локално)
- **Нулирай теста** — премахва само турнирите/профилите, създадени през този
  панел (виж "Reset" по-долу)

REST API зад панела (само loopback + флаг):

```
GET  /dev/tournament-test
GET  /dev/tournament-test/api/health
GET  /dev/tournament-test/api/list
GET  /dev/tournament-test/api/state?tournamentId=...
POST /dev/tournament-test/api/create   { teamCapacity, mode, scenarioHint? }
POST /dev/tournament-test/api/reset
```

## Full-bot турнир

1. Отвори панела → избери формат + режим `all_bots` → "Създай + стартирай".
2. Турнирът се записва през `POST /dev/tournament-test/api/create`, което
   вътрешно вика **само** реални store функции
   (`tournamentStore.createTournament` + `tournamentEconomyStore.joinTournamentSoloAtomically`
   за всеки бот, `startMode:'fill'`).
3. Оттам нататък всичко минава през production кода без намеса: реалният
   `tournamentScheduler` стартира турнира при запълване, реалният
   `tournamentCoordinator` създава bracket/rooms, attendance изтича (ускорено),
   ботовете реално играят до target score, coordinator-ът advance-ва кръговете,
   финалът приключва, `settleTournamentPrizesAtomically` изпълнява settlement.
4. Следи прогреса през "Покажи техническо състояние" или `GET /health`
   (`tournamentCoordinator`/`tournamentScheduler` health полета).

## One-human турнир

1. Панел → режим `one_human` → "Създай + стартирай".
2. Отговорът съдържа `humanCredentials[0]` (`email`/`password`) за нов тестов
   профил, регистриран през реалния `authStore.register` flow.
3. Отвори реалния клиент (`http://localhost:5173` или конфигурирания Vite dev
   порт), влез с тези credentials през нормалния login екран (реален
   session/cookie flow — не bypass).
4. Отиди в Турнири екрана — турнирът е реален ред в базата, ще се появи
   нормално. При стартиране на мача ще получиш нормален match-ready
   notification (`tournament_match_assigned` през WS) → "Влез в масата" →
   реален `resume_room`.
5. Играй нормално (режи, наддавай, играй карти) — партньорът и противниците
   са реални bot participants, вкарани от coordinator-а след изтичане на
   (ускорения) attendance прозорец.

## Ускоряване на таймерите — накратко

Виж таблицата по-горе. С стойностите от примера, attendance прозорецът за
първи мач пада от 3 минути на 5 секунди, а преходът между кръгове — от 20 на
3 секунди.

## Потвърждение за реалния coordinator/runtime

Нищо в `server/src/localTournamentTest/` не дублира gameplay, bracket,
attendance, settlement или cleanup логика. Единствените промени в production
файлове са:

- `server/src/db/ensureServerDatabaseReady.ts` — опционален DB path override,
  no-op без флага.
- `server/src/game/serverTimingConfig.ts` — опционален bot-delay override,
  изчислен веднъж при module load, no-op без флага.
- `server/src/tournament/tournamentCoordinator.ts` — опционален
  attendance/transition timing override, изчислен веднъж при module load,
  no-op без флага.
- `server/src/index.ts` — startup log + регистрация на dev route + по-чест
  poll interval за coordinator/scheduler, всичко строго условно на флага.

## Walkover сценарии

- **Един отбор изцяло липсва** (или частично, докато отсрещният е 100%
  присъстващ) → реален walkover (`resolveAttendance` в
  `tournamentCoordinator.ts`) — печелившият вижда service-win, губещият —
  service-loss, `myActiveMatch` пада на `null` и за двамата, само печелившият
  получава feeder състояние за другия полуфинал.
- **По един липсващ играч от двата отбора** → "mixed missing" клон — coordinator-ът
  вкарва реални bot participants само за липсващите места, мачът се играе
  реално с оставащите хора + ботове.
- **Финален walkover** → шампион/финалист се определят коректно, settlement
  се изпълнява точно веднъж (idempotent при следващи coordinator тикове).

Тези сценарии се доказват автоматизирано в `check:local-tournament-bot-flow`
(секции D) — реални регистрирани профили, реални WebSocket клиенти, реален
(не форсиран в базата) ускорен attendance таймер.

## Reset

"Нулирай теста" (`POST /dev/tournament-test/api/reset`):

- премахва **само** турнири, чието име носи маркера `[local-test:...]`
  (създадени през dev API `create`) — cascade delete през реалните FK
  (`tournaments` → teams/entries/rounds/matches/invites/ledger/events);
- премахва **само** тестови човешки профили с email домейн
  `@local.belot-tournament-test.invalid` (IANA-резервиран `.invalid` TLD —
  никога не е реален домейн);
- ако някой от турнирните мачове все още има отворена runtime стая, тя се
  затваря принудително (същия детерминиран removal path като
  `closeCompletedRoom`);
- връща баланса на catalog bot профилите към нормалната цел
  (`playerProgressStore.refillCatalogBotWallets()` — реална production
  функция, не дублирана логика);
- **не пипа** нормални локални профили/турнири извън тези маркери, и е
  idempotent (втори reset без нови dev-API турнири връща 0/0).

## Автоматизиран end-to-end тест

```powershell
cd D:\Project\Belot-V2\server
npm.cmd run check:local-tournament-bot-flow
```

Спавва два отделни изолирани сървър процеса (temp SQLite копия, никога срещу
постоянната база):

1. Главен сървър с `BELOT_LOCAL_TOURNAMENT_TEST_MODE=1` + ускорени таймери —
   guard/DB redirection, full-bot турнир до settlement, one-human flow (реален
   WS клиент + auto-responder за реални cut/bid/play действия), walkover
   (полуфинал + финал, реални регистрирани профили, реален ускорен таймер —
   не forced DB poke), reset (scoped + idempotent + не пипа control турнир).
2. Отделен сървър с `NODE_ENV=production` + флаг=1 — доказва dev endpoint-ите
   връщат 404 и startup log-ът липсва.

## Спиране / почистване

Скриптът спира процесите и трие temp директориите си сам (`finally` блокове).
При ръчно стартиран `dev:tournament-test`:

```powershell
# В прозореца, където тече npm run dev:tournament-test:
Ctrl+C
```

За да изтриеш тестовата база след спиране:

```powershell
Remove-Item D:\Project\Belot-V2\server\database\data\belot-v2-tournament-test.sqlite* -Force
```

(Никога не трие `belot-v2.sqlite` — това е обичайната локална development
база.)
