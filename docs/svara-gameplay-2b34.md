# Свара — Етап 2Б.3.4: игрови WebSocket команди

Дата: 16.10.2026. Основа: `20470db`, клон `v2-clean-architecture`.
Преди промени: `git fetch --no-tags origin v2-clean-architecture`, чисто дърво,
HEAD = origin, ahead/behind 0/0. Проверени са завършените engine/chips/match,
runtime, snapshot, lobby и optimization етапи и архитектурният отчет 2Б.3.3Б.

## Протокол и свързани действия

Един нов тип, използващ съществуващите engine имена:

```json
{
  "type": "submit_svara_command",
  "matchId": "server-created-match-id",
  "commandId": "unique-client-command-id",
  "expectedRevision": 12,
  "command": { "type": "act", "action": { "kind": "bet", "total": 20 } }
}
```

Разрешени `command`:

| Команда | Значение |
| --- | --- |
| `look` | Поглеждане само на собствените карти |
| `act`, `action.kind = bet`, `total` | Първи залог или повишаване според съществуващите правила |
| `act`, `blind-bet`, `total` | Залог на тъмно, само когато engine го разрешава |
| `act`, `call` | Покриване на текущия залог |
| `act`, `all-in` | Всички свободни игрови чипове; engine определя правата/слоевете |
| `act`, `fold` | Отказ от текущото раздаване |
| `act`, `no-bet` | Само съществуващото изключение за четвърто heads-up раздаване |
| `svara-join` | Платено включване в отворена обикновена Свара |
| `exit` | Доброволен изход от започнат мач; същото engine действие като `leave_svara_table` след старт |

`total` е общият доброволен залог за раздаването, не добавка и не сума с Входа.
Дебити, банките, ол-ин права, таксата за включване, печалби и извадени чипове
се обработват единствено от непроменения engine/ledger. Не се променят wallets.
Създаване/join/start/leave/state остават със съществуващите lobby типове.
Няма отделни измислени raise/check команди.

Отговори:

- `svara_command_result`: `matchId`, `commandId`, `status: applied | duplicate`,
  `revision`, `phase`. Това е потвърждение за участническата команда; следващи
  автоматични server преходи могат да изпратят snapshot с по-нова revision.
- `svara_command_error`: фиксирани `code`/`message` и валиден bounded
  `commandId`, когато е наличен. Например `stale_action`, `not_your_turn`,
  `invalid_action`, `insufficient_chips`, `look_required`, `command_id_conflict`.
  Няма echo на engine exception или чужди данни.
- `svara_match_snapshot`: непромененият защитен индивидуален протокол 2Б.3.2.
  Публични table/list обновявания се публикуват при промяна на публичната
  projection, не при всяко поглеждане/залог.

IDs са непразни низове до 64 знака; revision е неотрицателно safe integer.
`total` е положително safe integer. Размерът спрямо stack/минимум/ход се
проверява в engine. Payload се изгражда наново по whitelist; identity,
непознати полета, RNG, колода и state не се копират. Всички системни типове
са недопустими като клиентски `command`, включително петте от runtime API.

## Удостоверяване, последователност и повторение

`createSvaraLobby.handle` проверява live session чрез съществуващия trusted
WS transport, feature flag, една от петте разрешени роли и съвпадение на
session profile с connection profile. Следват съществуване на маса,
участие, runtime revision и engine правомощия. Клиентски `playerId`,
`profileId`, `actorId`, seat или role не определят actor.
Разпознат, но невалиден Svara envelope също минава през adapter access check.

Една runtime инстанция е логическият собственик на мачовете. Handler,
command executor и runtime са синхронни: няма await между проверка и mutation,
няма втори engine state и няма паралелен ход в рамките на един callback.
Два входящи пакета се изпълняват последователно от Node; не е добавена
излишна async FIFO опашка. Cross-game admission проверките остават синхронни
и непроменени за Белот, Ludo, Свара и HTTP турнирните входове.

Runtime поддържа revision брояч, равен на броя успешно приложени engine
команди, включително системните; snapshot revision семантиката остава същата.
За **нов** gameplay ID `expectedRevision` трябва да е текущата. Това спира
закъснял ход с нов ID дори ако по-късно отново е ред на същия играч.
След `stale_action` клиентът трябва да поиска текущото състояние и да вземе
ново решение; няма автоматично преизпращане с актуализирана revision.

За вече обработен actor/ID първо се използва engine fingerprint:
идентична нормализирана команда е `duplicate`; различна команда/сума е
конфликт дори при стара revision. Revision е precondition за нов ход,
не част от fingerprint на игровото действие. Непознатите/identity полета
се премахват преди сравняване. Различни играчи/маси имат отделни ID namespaces;
системните IDs са в отделното `s` пространство. Повторена заявка получава
ack и текущ индивидуален snapshot само към заявителя, без втори broadcast
или автоматичен преход. Напуснал играч може да получи duplicate ack за стария
си изход, но не получава нов snapshot. Отказаните команди не променят game
state, не харчат чипове/ID и не публикуват измислен ход.

## Поверителност и прекъсване

След всяка приложена участническа/автоматична команда се строи отделен
snapshot за всеки все още участващ разрешен профил и се сериализира само
чрез `serializeSvaraSnapshotForClient`. Достъпът се проверява отново при
fan-out. Напусналите не получават следващи snapshots. Общите lobby projections
нямат карти; observers не получават индивидуалните съобщения.

Собствените карти са null до разрешено поглеждане; чуждите карти, колодата,
RNG, raw state, processedCommands и вътрешният ledger не се изпращат.
Запазени са решенията 2Б.3.2: showdown карти/точки се скриват, както и фактът,
че друг играч е погледнал. Не са вземани нови продуктови решения.
Грешка при socket send се логва и не превръща вече приложен ход в отказан.

Disconnect премахва transport/subscription, не освобождава място и не налага
отсъствие/наказание. Съществуващото удостоверено повторно свързване може да
поиска snapshot и да повтори същото ID без двойно плащане в живия процес.
Не е добавян нов reconnect механизъм. След process restart няма тази гаранция.

## Системни преходи и точната оставаща зависимост

Довереният server executor прилага само готовите engine системни команди:

1. След пълен auto-start или успешен manual-start започва първото раздаване
   чрез `start-next-round`. След приключен рунд започва следващият допустим
   рунд, като engine избира обикновено раздаване или чакаща заключена Свара.
2. `advance-allin-svara` разрешава специалното продължение без Вход/залози,
   включително странични банки и повторно равенство в основната банка.
3. `svara-start` се прилага автоматично само ако всички правоимащи са активни
   и **няма останал външен участник в мача, който може да плати пълната такса**.
   Отсъстващ външен играч със средства също запазва възможността си.
4. При завършен/закрит мач няма следващ автоматичен рунд. Ако няма допустим
   рунд поради присъствие/права/средства, server не измисля ново действие.

**Оставаща зависимост за 2Б.3.5:** a и b завършват наравно, а c е участник
в мача, не е правоимащ и има чипове за включване. Engine отваря
`svara-joining`; c може да изпрати `svara-join`. Ако c не се включи и не
напусне, няма зададен срок/decline събитие за затваряне на прозореца.
Масата остава в тази фаза. При четирима включването само на единия външен
играч също не отнема правото на другия. Няма клиентски `svara-start`,
произволен timeout или заобикаляне. Това ограничава някои нормални мачове
до бъдещото утвърждаване/реализиране на server join-window политиката.
Не са започвани таймери за ход/присъствие или Етап 2Б.3.5.

Няма зададени reaction deadlines. Поредиците от готови автоматични преходи
са ограничени до 16 на event-loop turn, след което `setImmediate` продължава
същата server работа. Това е yield при многократни равенства, не срок за
действие или автоматичен отказ. Shutdown отменя pending continuations.
Неочаквана грешка в автоматичен преход се логва и запазва state; вече
успешната участническа команда не се обявява за отказана. Няма crash recovery.

## Worker граница и ограничения

`createSvaraCommandExecutor` приема trusted actor и plain typed command и
връща сериализируем резултат; няма WebSocket/DB/session/raw state в contract-а.
`executeParticipantCommand` и `executeSystemCommand` остават различни API.
Server-only `getAutomaticCommand` е orchestration hint; всички промени,
правила и invariant проверки остават в съществуващия engine.

Това е синхронният in-process adapter. Няма внедрен worker, споделена Map
между процеси или промяна на Belot pool/PM2. Преди async admission/worker pilot
остават задължителни atomic reservations, persistence/restore и ownership
fencing от 2Б.3.3Б. Не се въвежда Promise/await прозорец в сегашния admission.
При бъдещ IPC snapshot builder и branded serializer трябва да са в един isolate.

Свара остава тестова, само под сегашния flag/пет роли, без SQLite persistence,
restart recovery, multiplayer UI, реална икономика или публично отваряне.
По-дългите мачове още имат O(n) audit/archive разход и memory растеж; yield
между автоматични команди не прави единична дълга команда неблокираща.

## Проверки и файлове

| Проверка | Резултат |
| --- | --- |
| `check:svara-gameplay-2b34` | 14/14 детерминистични групи през parser/adapter/real runtime |
| `check:svara-runtime-2b31` | 23/23, включително съществуващия дълъг runtime тест |
| `check:svara-snapshot-2b32` | 20/20 |
| `check:svara-lobby-2b33` | 14/14, включително новия реален WS gameplay сценарий |
| `check:svara-match-2b2b` | 57/57 |
| Server TypeScript `--noEmit` / server build | Успех |
| `git diff --check` | Успех |

Новите проверки покриват hidden/look, bet/raise/call/blind/all-in/fold/no-bet,
несъществуваща маса/неучастник/фаза/ход, системна команда, подменена самоличност,
граници на входа, duplicate/conflict/stale, две бързи команди/различни играчи,
обикновена и повторна Свара, joining fee, all-in main/side-pot repeat,
автоматичен следващ рунд, всички индивидуални payload-и, flag/role/session,
cross-game guards, две маси в един runtime, disconnect/retry и shutdown yield.
Тестовете използват детерминистичния RNG интерфейс без тестов deck/restore hook
в production runtime. WS/турнирните проверки са върху disposable DB/server.
Не са пускани пълни Belot/Ludo пакети или повторни optimization benchmarks.

Променени/добавени файлове:

- `server/src/games/svara/protocol/svaraLobbyProtocol.ts` — типове/whitelist parser.
- `server/src/games/svara/runtime/svaraMatchRuntime.ts` — revision precondition и server progression hint.
- `server/src/games/svara/runtime/createSvaraCommandExecutor.ts` — изолиран command/result интерфейс.
- `server/src/games/svara/createSvaraLobby.ts` — routing, ack/error, индивидуален fan-out и progression.
- `server/src/index.ts` — Svara shutdown case, malformed-input routing и continuation shutdown.
- `server/scripts/checkSvaraGameplay2B34.ts` — новите детерминистични проверки.
- `server/scripts/checkSvaraLobby2B33.ts` — първо раздаване и реален WS gameplay/security тест.
- `server/package.json` — една целева check команда.
- `docs/svara-gameplay-2b34.md` — този отчет.

Engine/betting/snapshot правилата и чуждите игри не са променяни.
Един целеви commit/push след проверките; няма продукционен деплой.
