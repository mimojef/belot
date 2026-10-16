# Свара — Етап 2Б.3.6Б: възстановяване след рестарт

Основа: `926464758161aab24fd33fde3dc6af7fc279d3b8`, `v2-clean-architecture`.
Преди промени: чисто дърво, fetch на origin, HEAD = origin, ahead/behind 0/0.
Прегледани са отчетите 2Б.3.5/6А, спецификацията и multicore архитектурата
2Б.3.3Б. Няма нова схема/миграция; използва се server-only формат 1 от 6А.

## Startup и готовност

`createPersistentSvaraLobby` отваря съществуващия SQLite store и изолира
грешките му от останалия startup. Lobby първоначално е `initialization`.
В `index.ts` `initializeRecovery()` се извиква непосредствено преди
`httpServer.listen`, след Belot/Ludo restore, worker startup, създаването на
турнирния coordinator и всички admission guards. Няма await в този barrier.

1. Store чете незавършените редове в една read transaction, в стабилен ID ред.
2. Всеки ред минава пълна проверка на формата и метаданните.
3. Проверяват се вече съществуващи Belot/Ludo/турнирни commitments.
4. Runtime подготвя отделни копия на **всички** записи; отказва дублирани
   match IDs и едновременно активни/отсъстващи участия на един профил.
5. Само при успешна проверка на целия batch ги приема в runtime Map.
6. Съществуващият lifecycle обработва действително изтеклите deadlines и
   насрочва остатъка от валидните срокове. Едва след това статусът е `ready`.

Докато статусът не е `ready`, lobby/gameplay/read команди получават
`server_unavailable`, а reconnect и fan-out не публикуват частични данни.
Real Node callbacks не могат да прекъснат синхронния barrier. Всички данни и
защити са инсталирани преди създаването на handles; при неуспех handles и
continuations се отменят. Повторна инициализация е no-op, включително след
неуспех; възстановяване след отстранен проблем изисква нов service/startup.

При грешка статусът е `failed` само за Свара. Няма empty overwrite,
изтриване, автоматично счетоводно „поправяне“ или мним успешен restore.
Вече успешно committed системен преход остава записан; следващ startup
започва от тази revision, без да повтаря прехода/наградата.

При липсваща Свара таблица и OFF flag статусът е `disabled`, без error log
или отказ на платформения startup. При ON flag липсващата схема е `failed`;
няма RAM fallback или автоматично създаване на таблица от store. Включване
на flag след такъв disabled startup също не заобикаля миграцията — нужни са
нормалният migration bootstrap и нов startup. Централният DB bootstrap
остава необходим за платформата; негови фатални грешки не се прикриват.

## Валидация и immutable представяне

`validateSvaraStoredMatch` е общ server-only валидатор без DB/transport.
При import/load проверява версия, match ID, ревизия спрямо processedCommands,
настройки/изчислени чипове, уникални места/банки/исторически рундове,
статуси, баланси и ledger replay инварианта. Проверява също текущия рунд,
валидни уникални карти, betting actor/lists/log, history, command namespaces,
fingerprints/outcomes, generation/semantic key/actor/round/actionVersion на
deadlines. SQL метаданните трябва да съвпадат с вътрешния запис.
Engine-валидираният write път запазва по-леката проверка от 6А.

`restoreMatchesForServer` не изпълнява команда, не раздава, не начислява
Вход, не увеличава revision и не пише в SQLite. Входните обекти се копират,
така че няма споделено изменяемо състояние между caller/runtime/масите.
`copyRestoredSvaraMatchForServer` запечатва архивите и възстановява WeakSet/
WeakMap metadata веднага, без промяна на JSON стойностите или gameplay.

Особен случай: повторна Свара/ол-ин tie може да споделя `eligible[]` между
живата банка и последния `source: locked` history outcome. JSON не пази
object identity. Restore възстановява тази връзка по pot ID, завършения
исторически рунд и запазения ред/резултати на processedCommands; последващ
exit/absence-expired означава прекъсната връзка. Началните `source: round`
locks остават отделни. Тест сравнява следваща команда върху uninterrupted и
JSON-restored state, включително history, и проверява безопасното споделяне
на frozen архиви. Не е добавен втори command registry.

## Deadlines и престой

Сегашното задание изрично избира реалните абсолютни deadlines; то заменя
историческия текст за замразяване при outage. Незавършените 15 s и 300 s
срокове използват `deadlineAt - now`, без нов начален период.
Turn, Svara joining, sole-active и all-absent сроковете са обхванати.

Изтеклите записани deadlines се изпълняват по `deadlineAt`, после generation,
чрез същите system commands → SQLite commit → RAM commit. Пример: при вече
изтекли joining и presence срокове прозорецът се затваря, после се прилага
служебният край, ако условията още са валидни. Стар/отменен callback няма
право върху новия actor/round/generation; duplicate system IDs не начисляват
или присъждат повторно. Завършените/закрити редове остават само в SQLite и
никога не стават активни маси при следващ startup.

Не се създават хипотетични deadlines назад във времето. Ако записаният turn
изтече през престоя, timeout го приключва сега; следващият действителен ход
получава нормален нов срок от своя преход. Няма replay на непроведени рундове
или Входове за дните престой. Запазен е лимитът 16 автоматични стъпки преди
event-loop yield; това е продължение на текущата игра, не историческа симулация.

## Reconnect, лоби и cross-game защита

Местата принадлежат на profile IDs, без стари sockets/connection IDs в state.
Съществуващият authenticated connection bootstrap извиква reconnect след
displacement на старата сесия. Live session/profile/role/feature checks остават
за всяка команда и доставка. Изпращат се само индивидуалният whitelist
snapshot и timing; чужди карти, raw state, ledger и fingerprints не излизат.
Reconnect/restart сами по себе си не сменят presence. Absent/pending return
остават такива; „Върни се“ продължава да важи от следващото раздаване.

Публичният списък използва възстановените runtime таблици със същите IDs,
места, настройки и фази; няма празни заместители или дублиране при init.
Съществуващите WS и HTTP турнирни guards четат същия `findCommitment`,
включително за disconnected/absent профили. Преди/при неуспешно recovery
работи и durable membership lookup. Отделно се валидират места/статуси в
тази проекция: повредени карти/баланс могат да изолират Свара, като пазят
известните commitments и позволяват други игри на несвързани профили.
Ако membership/SQLite е нечетим, липсата на участие не може да се докаже и
новите cross-game admissions се отказват консервативно. Започнатите други
игри не се спират от Свара. Доказано липсваща таблица няма commitments.

Съществуващ конфликт с възстановен Belot/Ludo/турнир изключва Свара recovery,
без автоматично местене/forfeit/промяна на която и да е игра. Липсващ
турнирен coordinator също не се приема за доказана липса на ангажимент.
Няма обща атомарна reservation система/owner lease; deployment остава
един авторитетен Node процес. Multi-process/worker recovery не е реализиран.

## Проверки и граници

| Проверка | Резултат |
| --- | --- |
| `check:svara-recovery-2b36b` | 32/32, временни SQLite бази и fake clock |
| `check:svara-persistence-2b36a` | 34/34 |
| `check:svara-lifecycle-2b35` | 23/23 |
| `check:svara-runtime-2b31` | 23/23 |
| `check:svara-snapshot-2b32` | 20/20 |
| `check:svara-lobby-2b33` | 14/14 |
| Server TypeScript / build / `git diff --check` | Успех |

Recovery тестовете използват нови runtime/store/lobby инстанции, контролирани
часовници и реален SQLite. Покрити са identity roundtrip, всички срокове,
partial commit failure/retry, quarantine, duplicate/conflict/stale, reconnect,
петминутен край/abort, main/side банки, immutable aliases, multi-table import,
дублирани IDs/профили, липсваща схема OFF/ON, нечетима DB и integrity/FK checks.
Допълнителният съществуващ WS/lobby тест е за риска от новия production
startup път; не прави persistence restart сценарии от следващия подетап.

Няма пълни Belot/Ludo пакети, нови benchmarks или браузърни тестове.
Full Node stop/start с една и съща тестова база, outage/kill матрицата и
end-to-end restart/reconnect/cross-game доказателствата остават за **2Б.3.6В**.
Такова изпитване не е започнато и не се заявява пълна restart-safe верификация.
Синхронният startup/JSON/ledger scan расте с броя и историята на масите;
durable fallback membership lookup също чете активните snapshots.
Няма нов retention, multicore, PM2, UI, публично включване, икономически
операции, SSH, продукционна миграция или deploy. **2Б.3.7 не е започнат.**

Променени файлове:

- `server/src/games/svara/createPersistentSvaraLobby.ts`
- `server/src/games/svara/createSvaraLobby.ts`
- `server/src/db/svaraMatchSnapshotStore.ts`
- `server/src/games/svara/runtime/svaraStoredMatchValidation.ts`
- `server/src/games/svara/runtime/svaraMatchRuntime.ts`
- `server/src/games/svara/runtime/svaraPersistence.ts`
- `server/src/games/svara/engine/svaraMatch.ts` — само server restore helper.
- `server/src/index.ts`
- `server/scripts/checkSvaraRecovery2B36B.ts`
- `server/scripts/checkSvaraPersistence2B36A.ts`
- `server/scripts/checkSvaraRuntime2B31.ts`
- `server/package.json`
- `docs/svara-recovery-2b36b.md`
- `temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md`
