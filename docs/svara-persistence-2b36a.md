# Свара — Етап 2Б.3.6А: атомарно SQLite съхранение

Основа: `bda94daa69432a1044271013f461306e69788e9a`, `v2-clean-architecture`.
Преди промени: чисто дърво, успешен `git fetch --no-tags origin v2-clean-architecture`,
HEAD = origin, ahead/behind 0/0. Прегледани са спецификацията, отчетите
2Б.3.3–2Б.3.5 и текущите Belot/Ludo snapshot stores и migration runner.

## Схема и пълно състояние

Нова миграция `20261023_001_create_svara_match_snapshots.sql` използва
съществуващия runner и **същия databaseFilePath**, който bootstrap подава
на останалите stores. Няма втора продукционна база или backup механизъм.
Файлът е след последната налична миграция `20261022_001`.

`svara_match_snapshots` има `match_id` PRIMARY KEY, `format_version`,
`revision`, `match_status`, `snapshot_json` с `json_valid`, `created_at`,
`updated_at`, `finished_at`. Един частичен индекс обхваща активните фази
`lobby`/`in-progress`. Завършените/закритите записи се пазят; няма DELETE,
retention или промени по Belot/Ludo таблиците и финансовите дневници.

Сървърният JSON формат 1 съдържа:

- `matchId`, `revision`, `formatVersion`;
- целия `SvaraMatchState`: настройки, ред на местата, статуси, чипове,
  дилъри, текущ рунд/actor, всички раздадени карти и betting state,
  вноски, locked/carried банки, history, ledger, processedCommands,
  pendingReturns, резултат и причина за край;
- `deadlines` и `deadlineSequence` като обикновени JSON данни.

Няма втори ledger в отделна таблица. Няма sockets, connection/session IDs,
callback функции, timer handles или диагностични runtime броячи в записа.
Няма client snapshot builder в persistence пътя. Пълното състояние няма
HTTP/WS endpoint и не се логва. Грешките са фиксиран `SvaraPersistenceError`
без оригинален SQL, JSON, карти или exception cause.

Engine използва CSPRNG при бъдещо раздаване; текущите раздадени карти са в
state. Не пази необходим за продължаване нераздаден deck или RNG cursor.
Тестовият seeded RNG остава тестова зависимост. WeakSet/WeakMap оптимизацията
е извън JSON и не носи отделна игрова истина. След JSON read първата нова
engine команда копира/запечатва архивите безопасно; следващите споделят
immutable archive записи. Engine кодът от `2455221` не е променен.

## Граница на commit и всички пътища за промяна

`registerMatch` прави INSERT преди добавянето в runtime Map. При колизия
никога не използва UPSERT и не презаписва останал активен мач.

Всички участнически и системни команди остават в съществуващия синхронен
runtime/executor. Редът е: normalize/identity/revision/engine validation →
чисто изчислен candidate → deadline planning → строга JSON сериализация и
валидация → `BEGIN IMMEDIATE` → CAS UPDATE → успешен `COMMIT` → приемане на
state/revision/deadlines в RAM → връщане на резултат → защитен ACK/fan-out.
CAS изисква точно предишната revision, формат 1 и незавършена фаза.
Новата revision трябва да е предишната + 1. Няма await или втори собственик
между проверките и commit; per-match guard отказва reentrant mutation/release.

Този път обхваща create/join/leave/closure/start, look, всякакви залози,
blind/all-in/fold, join/decline на Свара, нови раздавания, all-in продължения,
timeout/absence/return/activation, служебна победа, abort и нормален край.
Disconnect, subscriptions, transport sessions, handles и runtime статистика
остават временни транспортни/диагностични данни.

При неуспешен statement **или COMMIT** се прави ROLLBACK. RAM state,
revision, command IDs и deadlines остават старите; няма успешен отговор или
публикация на candidate. Същата команда може безопасно да се повтори.
Ако участническа команда вече е committed, а следващата автоматична стъпка
не успее, участническият ACK остава валиден; не се публикува неизвършената
автоматична стъпка. Последващ sync може да я опита отново.
Няма RAM-only fallback при DB грешка. Lobby без persistence изисква изрично
инжектиран runtime (изолираните engine/adapter тестове използват такъв).
Production index винаги подава SQLite store и го затваря при shutdown.

## Идемпотентност и срокове

Всички `processedCommands`, fingerprints и outcomes се записват със state
в същия JSON/транзакция. Не се режат стари IDs. Запазени са отделните
пространства `['p', playerId, clientId]` и `['s', systemId]`.
Идентичен retry е duplicate, различно съдържание е conflict; това се проверява
преди stale revision. Duplicate няма втори запис/залог/банка/нова revision.
Read от SQLite и подаване на същата engine команда доказва dedupe и при
изгубен ACK, без да се добавя startup recovery в този подетап.

Чистият `planSvaraDeadlines` е преместен преди runtime commit. Записва
абсолютен epoch `deadlineAt`, semantic key, kind, generation, phase,
baseRevision, playerId, roundId и actionVersion, плюс monotonic sequence
за мача. Трите вида са 15 s turn, 15 s Svara joining и 300 s presence wait
(нула или един готов). Същият semantic key запазва целия стар deadline:
look, retry, reconnect и SQL операция не започват нов период.
Началният момент е подготовката на прехода; времето за commit не се добавя
като подарени секунди. Lifecycle насрочва само committed данните с остатъка
до абсолютния срок. Failed expiry запазва изтеклия запис за безопасен retry.
Няма възстановяване/изпълнение на timer callbacks след процесен рестарт.

## Проверки и кратко измерване

Всички DB проверки използват нова временна SQLite база с целия migration
runner, затварят връзките и изтриват само собствената временна директория.
Няма продукционни данни или реални 15 s/5 min изчаквания.

| Проверка | Резултат |
| --- | --- |
| `check:svara-persistence-2b36a` | 34/34 |
| `check:svara-match-2b2b` | 57/57 |
| `check:svara-runtime-2b31` | 23/23 |
| `check:svara-lifecycle-2b35` | 23/23 |
| `check:svara-snapshot-2b32` | 20/20 |
| `check:svara-gameplay-2b34` | 14/14 |
| `check:svara-lobby-2b33` | 14/14, disposable DB/server |
| Server TypeScript / build / `git diff --check` | Успех |

Допълнителните gameplay/lobby/snapshot проверки са за конкретния риск от
преместен deadline ownership, нов production store wiring и защита на
индивидуалните WS данни. Не са пускани пълни Belot/Ludo пакети, клиентски
браузърни тестове или optimization benchmarks.

Persistence тестовете включват действителна SQL trigger грешка и deferred FK
грешка на COMMIT, липса на ACK/publication преди запис, безопасни retries,
CAS/stale/reentrant команди, JSON roundtrip във всички режими, main/side/
carried банки, служебен край/abort, immutable архиви, lossy/cyclic JSON,
няколко маси, уникални IDs и `integrity_check=ok`, празен `foreign_key_check`.

Кратката проба е 400 команди / 402 записа, без намалена durability:
`WAL`, `synchronous=FULL`, foreign keys ON, busy timeout 5000 ms.
Сериализацията включва строгата проверка на JSON и игровите инварианти.

| Измерване | Локален резултат |
| --- | --- |
| Сериализация + валидация, средно | 0,995 ms |
| SQLite транзакция + COMMIT, средно | 4,377 ms |
| Общо допълнително persistence време, средно | 5,372 ms |
| Пълна команда + тестови observations, средно | 7,062 ms |
| Пълен JSON след 20 команди | 13 150 bytes |
| Пълен JSON след 400 команди | 237 894 bytes |

Това е кратко локално измерване върху временна база, не гаранция за production
latency/капацитет. Всяка маса има независим ред/state и CAS; записите към
SQLite остават последователни. FULL fsync и пълният JSON блокират event loop
за времето на commit; сериализацията, audit и размерът растат с history/IDs.
Подходът е приемлив за текущия ограничен тестов достъп; голям брой натоварени
или дълги маси изисква отделна капацитетна оценка. Не е обещано multicore
ускорение или фиксирана latency, не са изключени sync/fsync настройки.

## Граница със следващите подетапи

SQLite `load(matchId)` е сървърен read API с версия/метаданни/инварианти и
deadline consistency validation. В 2Б.3.6Б ще се използва за валидирано
startup откриване/import, повторно свързване на масите и timer orchestration.
В този етап няма такава регистрация, timer callbacks, просрочени санкции,
worker recovery, PM2 cluster или реален restart integration test.
Решението за замразяването/преизчисляването на срока при outage остава
изрично за 2Б.3.6Б; текущият запис запазва точния предишен абсолютен срок.

До recovery: активните редове остават активни. Read-only admission lookup
запазва commitment и спира нова маса/друга игра за този профил; reconnect
не се преструва, че липсващата RAM маса е възстановена. При грешка в lookup
admission се отказва. Няма автоматично затваряне или празен overwrite.
CAS е защита от lost update, **не** owner lease/достатъчна cluster координация;
все още е необходим един процес/owner и общ cross-game admission ред.

Правилата, петте тестови роли/flag, UI, реалните жълтици, подаръците и чатовете
не са променени. **Няма продукционен deploy, SSH или продукционна миграция.**
Бъдещият smart migration deploy трябва да потвърди успешно автоматично
резервно копие и проверката му преди прилагане на миграцията.
**2Б.3.6Б и 2Б.3.6В не са започнати; системата още не е restart-safe.**

## Променени файлове

- `server/database/migrations/20261023_001_create_svara_match_snapshots.sql`
- `server/src/db/svaraMatchSnapshotStore.ts`
- `server/src/games/svara/runtime/svaraPersistence.ts`
- `server/src/games/svara/runtime/svaraDeadlines.ts`
- `server/src/games/svara/runtime/svaraMatchRuntime.ts`
- `server/src/games/svara/runtime/createSvaraLifecycle.ts`
- `server/src/games/svara/createSvaraLobby.ts`
- `server/src/index.ts`
- `server/scripts/checkSvaraPersistence2B36A.ts`
- `server/scripts/checkSvaraLifecycle2B35.ts` — един общ fake clock за runtime/scheduler.
- `server/scripts/checkSvaraRuntime2B31.ts` — whitelist на новите чисти runtime модули.
- `server/package.json`
- `temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md`
- `docs/svara-persistence-2b36a.md`
