# Свара — Етап 2Б.3.5: сървърни срокове, отсъствие и reconnect

Дата: 16.10.2026. Проверена основа: `7020b5ce8058dcb3def41fc8c8eef621476061f3`.
Начално състояние: `v2-clean-architecture`, чисто дърво,
`git fetch --no-tags origin v2-clean-architecture`, HEAD = origin, 0/0.
Завършените 2Б.3.1–2Б.3.4 са налични. Решенията на собственика са внесени в
[§13 на съществуващата спецификация](../temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md).
Старият „15 секунди последен шанс“ е заменен с описаното петминутно изчакване.

## Срокове и ред на обработка

`createSvaraLifecycle` е единственият сървърен собственик на дедлайни и
автоматично развитие за тази runtime инстанция. Няма WebSocket/DB в него.
Получава `SvaraClock` (`now`, `schedule`, `defer`) и plain runtime интерфейс;
в production ползва monotonic epoch milliseconds от `performance` и
Node timers с `unref`. Тестовете подават fake clock без реално изчакване.

| Срок | Ключ/обезсилване | Резултат |
| --- | --- | --- |
| Ход, 15 s | Рунд, actor и брой доброволни игрови действия | Атомарен `turn-timeout`: fold + absent |
| Включване в Свара, 15 s | Конкретният joining рунд | `close-svara-joining`, после допустимото `svara-start` |
| Изчакване, 300 s | Нула готови или точно определен един готов профил | `finish-presence-wait`: служебен победител или прекратяване без победител |

На мач има най-много един срок от всеки вид. Възможно е joining прозорец и
presence wait да съществуват едновременно, ако по време на joining има само
един готов играч; затварянето на прозореца не прескача presence условията.
Deadlines пазят phase, base revision, generation, round ID, actor/action version
и deadline като plain данни. `exportDeadlines` не връща timer handles.
Не се прави persistence/import на тези записи в този етап.

При callback първо се проверява дали точно този запис още е регистриран.
След това lifecycle сверява игровия контекст. Отменен callback е no-op,
дори да бъде извикан повторно; при преждевременно събуждане се чака остатъкът.
Engine проверява turn/round/action version отново при timeout.
System ID съдържа namespace на lifecycle инстанцията и generation/revision,
а runtime запазва отделните `p`/`s` пространства и engine dedupe.

**На самия дедлайн изтичането има предимство.** `sync` обработва дължимите
събития преди нова валидна клиентска команда, snapshot request или reconnect,
дори Node още да не е dispatch-нал timeout callback-а. Заявка при стария
expectedRevision получава `stale_action`. Преди дедлайна валидният ход се
прилага първи и обезсилва стария callback. Няма зависимост от реда на Node
callback dispatch при едно и също изтекло време.

`look` не приключва ход и не рестартира срока. Същото важи за retry,
reconnect, чуждо поглеждане/return request или промяна само на revision.
Изход/forced fold на друг играч извън реда също не дава нови 15 секунди
на оставащия на ход участник и не обезсилва неговия timeout.
Не се използва строго равенство на всяка revision за timer guard, защото то
би отменяло легитимния стар deadline при такива команди; guard е семантиката
на хода плюс generation. При действителен следващ ход се създава нов срок.

## Отсъствие и връщане

Новият `turn-timeout` е една атомарна engine команда. Тя маркира отсъствие
и използва съществуващия `forceSvaraFold`/settlement за текущото раздаване,
включително в Свара. Няма бот, доброволен заместващ залог или освобождаване
на място. Старите права върху други неразрешени банки остават до разрешаване
или служебния край. Отказът в текуща Свара има същите права като engine fold.

Отсъстващите остават в мача. При действително ново обикновено раздаване
engine плаща Входа и ги отказва, както досега; не получават нови 15 секунди.
Няма започване на ново раздаване/автоматично ново all-in продължение, ако на
границата към него няма двама активни/готови. Тогава няма нов Вход.

Участническата команда `request-return` записва `pendingReturns`, без карти,
чипове и право в текущото раздаване. Ръчни `look`/`act` остават забранени с
`player_absent`. Повторен ID е duplicate, а ново натискане със същото намерение
не дублира pending заявката и не удължава изчакването.

Между раздаванията pending return се брои като готовност. При двама готови
`activate-returns` ги активира на границата към следващото раздаване, включително
преди раздаване за Свара. Няма реактивиране на старо betting раздаване.
Един върнал се от нула остава pending/готов за новото петминутно изчакване;
така възобновяването не изисква невъзможното условие първо да е започнал рунд.
При изход/отпадане pending заявката се изчиства и не възкресява участника.

## Disconnect/reconnect и клиентски данни

Disconnect премахва само transport/subscription. Не променя presence и не
спира/рестартира deadline. При reconnect main първо прилага съществуващото
изместване на старата WS връзка, след което извиква `svaraLobby.reconnect`.
Live session, role, feature, profile и connection status се проверяват както
при командите. Старата изместена връзка не може да управлява масата.

Автоматично се изпращат текущият индивидуален snapshot и
`svara_match_timing` с match/revision, `serverNow` и масив от `kind`,
`deadlineAt`, `remainingMs`, `playerId`. Клиентът следва тези сървърни данни,
а не собствения си часовник. Няма ползване на клиентски countdown за резултата.
Преди изпращане се обработва вече изтекъл срок. Reconnect не заявява връщане
и не преизпълнява стари участнически команди.

Snapshot builder/защитеният serializer остават единственият път за карти.
Добавени са whitelist полета `you.returnPending`, собствено `you.svaraDecision`,
`round.closed` за joining и `result.aborted/reason/message`. Показват се само
собствените карти след разрешено поглеждане; showdown картите/чуждото
поглеждане остават скрити. Няма raw state, ledger, RNG, колода или чужди ръце.
Съобщението за timing съдържа само изрично изброените технически полета.

## Прозорец за обикновена Свара

Engine вече пази `declined` и `closed` към joining рунда; `joiners` остава
съществуващият списък на платилите. Минималната нова участническа команда
`svara-decline` отбелязва отказ без такса. Вече отказалият не може да се
включи в същото продължение. Не се променят допустимостта, размерът на
таксата, закръглянето, плащането, дилърът или наддаването.

Един общ 15-секунден прозорец започва, когато има допустим нерешил участник
със средства. Join/decline на всички допустими го приключва по-рано;
решение само на един от двама outsiders не рестартира срока на другия.
При expiry нерешилите не плащат и не участват. Късна заявка се отказва
чрез revision/closed/current-phase checks. Повторната Свара е нов рунд/прозорец.

## Петминутни режими и виртуално счетоводство

След текущото раздаване при един активен/готов профил масата чака 300 s.
Връщане на втори отменя срока. Ако същият профил остане единствен, печели
с причина **„Победа поради продължително отсъствие на противниците“**,
дори да е с нула свободни чипове. `absence-pot-award` прехвърля всички
неразрешени locked/carried банки към stack на победителя. Служебното право
идва от новото изрично правило, независимо от старите eligible на тези банки.

При нула активни/готови има отделен 300-секунден срок. Изтичането приключва
мача с `winnerId: null`, `finishReason: all-absent`, `result.aborted: true`.
`abandoned-pot-removed` закрива unresolved locked/carried сметките към
съществуващото `removed`, като увеличава `removedChips` със същата сума.
Няма произволен победител. Свободните стекове остават крайните салда на
собствениците; не са изплатени награди/refunds. Няма отворен рунд/банки.

И двата изхода са една атомарна команда, с пълния непроменен ledger audit.
Историята и старите ID не се режат. Новите операции не разпределят суми от
free stacks на загубилите и не ги ползват като източник на реално плащане.
Повторение на system ID не присъжда/премахва стойност втори път; нов опит
за приключване на вече завършен мач се отказва. Последен оцелял, но отсъстващ
профил не получава нормална автоматична победа само защото другите са излезли.

Смяна на единствения готов профил/преминаване към нула обезсилва стария срок.
Един върнал се от нула започва **нови** 300 s за втори; двама възобновяват
при изпълнени engine условия. Това са presence статуси, не брояч на отворени
sockets: disconnect сам по себе си не прави последния играч отсъстващ.

**Реални жълтици:** решенията „без връщане на входа“ са документирани, но
няма добавен debit, credit, payout, refund, ranking/progression операция.
Свара още няма такава икономическа интеграция. Cross-game guards се пазят;
absent/pending участник остава committed до действителен изход/край.

## Оптимизация, worker граница и ограничения

`copyMatchForCommand`, immutable archive WeakSet/WeakMap и запечатването от
`2455221` не са променени. Новите малки lifecycle полета са live state;
ledger/history/processedCommands продължават да се споделят само неизменяемо.
Тестът пази стари версии през timeout/termination, проверява липса на мутация,
shared frozen ledger/history записи и duplicate termination no-op.

Lifecycle приема plain engine scheduling facts, не второ копие на game state.
Не носи sockets в engine; всички mutations са през runtime. Един in-process
owner и синхронен ред се запазват. Дълги готови автоматични вериги отстъпват
след 16 операции чрез `defer`. Правилата на залозите/банките остават в engine.
Това подготвя IPC граница, но не реализира worker или PM2 cluster. Преди worker
pilot остават atomic admission reservations и recovery от 2Б.3.3Б.

Няма SQLite persistence или Node restart recovery. Дедлайните и мачовете са
в паметта. Бъдещият 2Б.3.6 трябва да възстановява/замразява сроковете изрично,
без санкции за престоя. Не е започнат. Няма публично активиране или деплой.
Остават петте тестови роли и flag. Дългите мачове още имат O(n) audit/memory
растеж; таймерите не правят отделна тежка команда паралелна. Неочакван engine
отказ при expiry се логва и пази expired record, без скрито удължаване на срока.

## Проверки

| Проверка | Резултат |
| --- | --- |
| `check:svara-lifecycle-2b35` | 23/23; fake clock, без реално 15 s/5 min чакане |
| `check:svara-match-2b2b` | 57/57 |
| `check:svara-runtime-2b31` | 23/23 |
| `check:svara-snapshot-2b32` | 20/20 |
| `check:svara-gameplay-2b34` | 14/14 |
| `check:svara-lobby-2b33` | 14/14; disposable DB/server, автоматичен reconnect snapshot и непроменен deadline |
| Server TypeScript `--noEmit`, server build | Успех |
| `git diff --check` | Успех |

Покрити са valid-before-deadline/exact-expiry, look без удължаване, timeout fold,
absent entry/no bot, pending return/забранени текущи действия, двата reconnect
случая и displacement, stale callbacks, early/expired joining и explicit decline,
one/zero waits, zero-chip служебен победител, locked/carried closure, no-winner
termination, смяна на wait owner, повторни системни събития, privacy, access,
cross-game commitment, две маси, plain deadline export и shutdown cleanup.
Старите проверки на ниско ниво за `absence-expired` остават съвместимост на
engine API; новият lifecycle не ги насрочва и не използва стария 15 s last-chance.
Няма пълни Belot/Ludo регресии или повторни optimization benchmarks.

## Файлове

- `server/src/games/svara/runtime/createSvaraLifecycle.ts` — нов scheduling/lifecycle owner.
- `server/src/games/svara/engine/svaraMatch.ts` — атомарни timeout/return/decline/termination операции и safe scheduling view.
- `server/src/games/svara/runtime/svaraMatchRuntime.ts` — whitelist, normalization и automatic progression hints.
- `server/src/games/svara/runtime/createSvaraCommandExecutor.ts` — премахнат вторият automatic advancement път.
- `server/src/games/svara/createSvaraLobby.ts` — lifecycle wiring, timing, re-authenticated reconnect.
- `server/src/games/svara/protocol/svaraLobbyProtocol.ts` — двете участнически действия, timing и absent error.
- `server/src/games/svara/protocol/svaraSnapshotProtocol.ts` — whitelist presence/decision/result полета.
- `server/src/index.ts` — една Svara reconnect интеграция след съществуващото displacement.
- `server/scripts/checkSvaraLifecycle2B35.ts` — новите детерминистични проверки.
- `server/scripts/checkSvaraLobby2B33.ts` — timing-aware adapter checks и реален WS reconnect тест.
- `server/package.json` — една целева test команда.
- `temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md` — окончателните решения в §13.
- `docs/svara-lifecycle-2b35.md` — този отчет.

Един целеви commit/push след финалните проверки; без промени по Белот/Ludo,
чатове, подаръци, реални баланси, deployment скриптове или production настройки.
