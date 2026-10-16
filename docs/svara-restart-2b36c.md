# Свара — Етап 2Б.3.6В: реални рестарти на backend

Дата: 16.10.2026. Проверена основа: `83f9197f333a43baa355519f87e4acde5ecef264`.
Тестов подетап; няма промени в `server/src`, нова миграция или деплой.

## Стартиране и изолация

От `server`, с Node с `node:sqlite` (проверено с v24.13.1):

```powershell
npm.cmd run build
npm.cmd run check:svara-restart-2b36c
```

Harness-ът копира `src`, актуалния `dist`, миграциите и package manifest във
временна директория `pika-svara-restart-*` под системния temp. Не копира `.env`
или съществуваща DB. Dependencies се споделят чрез junction/symlink; връзките
се премахват преди почистването. Създава празна SQLite база, loopback порт,
осем профила през реалния HTTP register и реални auth cookies. Ролите,
директната регистрация и изчистването на registration rate-limit събитията
засягат само тази временна база.

Стартира директен Node child с действителния `dist/index.js`, ограничен списък
environment променливи, `NODE_ENV=test`, loopback host и съществуващия Svara
flag. Използва истинските startup, migration runner, HTTP/auth, WebSocket,
runtime, snapshot store, SQLite транзакции, WAL и shutdown handler. Не променя
durability настройките. Не използва development backend, реални потребители,
SSH, PM2 или публични домейни.

## Време, RNG и изгубен ACK

Само в частното копие два wrapper модула подават съществуващите clock/RNG
dependencies на оригиналните factory функции. Оригиналните модули изпълняват
игровата и persistence логиката; след cleanup се проверяват хешовете на
съответните repository build файлове. Няма production hook, environment
превключвател за failpoint или публичен диагностичен endpoint.

Частният IPC канал проверява nonce, parent PID и child PID. Часовникът използва
абсолютни timestamps и ограничен брой callbacks. Тестът премества времето
преди/след записаните deadlines, без реално петминутно чакане. RNG fixtures
създават конкретни равенства и main/side банки чрез действителни WS действия,
без инжектиране на готово runtime състояние.

ACK failpoint спира transport send след успешния SQLite COMMIT, преди ACK,
fan-out и автоматичното продължение. Изпраща само command metadata към
родителя и блокира до принудителното прекратяване на проверения child. След
рестарт същият ID/payload връща `duplicate`, различният payload със същия ID —
`command_id_conflict`; revision, snapshot и стековете не се променят повторно.

Нормалното спиране извиква реалния регистриран SIGTERM handler през частния IPC
канал, включително под Windows. Изисква exit 0 и нула останали Svara callbacks.
Crash използва SIGKILL само върху собствения ChildProcess след проверка на
PID, Node executable, runner path и nonce. Няма общо спиране на Node процеси.

## Матрица

| Сценарий | Проверка |
| --- | --- |
| Празна база | Истински startup/migrations, ready, празно лоби, HTTP профили и cookies |
| Активно раздаване | Залог, graceful restart, еднакъв пълен snapshot: IDs, дилър/ход, карти, стекове, банки, ledger/history, processed commands и deadlines; следващи валидни действия |
| Crash и ACK | Потвърден raise, SIGKILL, реален оставащ WAL, recovery и integrity/FK; втори crash след COMMIT преди ACK, duplicate/conflict без повторен debit |
| Отсъствие | Просрочен ход веднъж; reconnect не активира absent; pending return преживява рестарт, отказва look в старото раздаване и активира играча чак в следващото |
| Достъп и карти | Индивидуални snapshots, собствените непогледнати карти са null; няма чужди карти/вътрешни ключове; публично лоби; изместена връзка и невалидна cookie не управляват масата |
| Cross-game | Възстановеното участие отказва реални WS create команди за Белот и Ludo |
| Joining 15 s | Преди срока остават 8 s; след crash/restart след срока прозорецът се затваря и продължението започва веднъж без повторни входове |
| Един активен, 5 min | Carried pot 30, рестарт 1 ms преди/след срока; една служебна победа, една награда; следващ crash/restart не я повтаря |
| Нула активни, 5 min | Всички останали са absent, другите са излезли доброволно; банката се премахва веднъж, без победител, нов вход или промяна на свободните стекове; повторен restart е без промяна |
| Main/side банки | Реални all-in действия, crash след COMMIT с две locked банки; startup урежда страничната и главната чрез фиксирани равенство/решаващо раздаване; retry и втори restart не повтарят уреждането |
| Няколко маси | Две активни и една чакаща, същите уникални IDs; действие на една не променя другите |
| Повредени данни | Corrupt JSON, format 999 и липсващ ledger: HTTP е здрав, Svara failed, действията са отказани, SQL редът е непроменен, sentinel не се логва |
| Липсваща схема | В собствената DB таблицата е премахната след приложен migration ledger: OFF е disabled, ON е failed; store не я създава тихо |
| Durable конфликт | Реален Ludo мач през WS плюс запазен Svara ред за същите тестови профили: startup отказва Svara readiness без презапис |

Това са 11 top-level теста; някои обединяват няколко реда от матрицата.
Приетите gameplay резултати се сверяват с записаната revision и engine invariant.
Жълтиците имат еднакъв hash във всички Svara сценарии. Отделният Ludo конфликт
използва само временната DB и съществуващия Ludo път. Finished мачовете остават
на диск, но не се връщат в активното лоби.

Offline fixture копията се правят само след спиране и успешен WAL checkpoint,
за да включват всички committed страници. Негативните SQL fixture промени
са отделени от WS gameplay сценариите.

## Проверки и cleanup

| Проверка | Резултат |
| --- | --- |
| `check:svara-restart-2b36c` | 11/11; 30 стартирания, 25 graceful stops, 5 forced crashes |
| `check:svara-persistence-2b36a` | 34/34 |
| `check:svara-recovery-2b36b` | 32/32 |
| Server TypeScript / build / `git diff --check` | Успех |

Не е установен production дефект. Корекциите при разработването са в harness-а:
протоколни имена, WS fence след ACK и пълно offline WAL fixture копие.
Няма промени в engine, lifecycle, snapshot или икономиката; няма допълнителни
пълни игрови регресии, браузърни/анимационни пакети или нов benchmark.

Всеки child се изчаква; sockets се затварят; портът се проверява чрез повторно
bind след всяко спиране и в cleanup. `finally` прекратява само собствения
проверен child при грешка, премахва junction-ите и temp root след проверка на
абсолютния път. При неуспех остава JSON само с име на сценарий, броячи, PID и
startup/shutdown флагове в `tmp/svara-restart-*-failure.json`; няма cookies,
карти, суров snapshot или backend логове.

## Граници

Доказва реален single-backend process restart с локален SQLite, включително
точен crash след COMMIT преди ACK. Не симулира спиране на захранване, повреден
диск, disk-full или всеки instruction-level crash момент. Svara времето/RNG са
контролирани само в частното копие; мрежовият/auth/SQLite път е реален.
Няма multi-process ownership, worker recovery или измерване при голям брой
маси. Растящите snapshots/startup scan от 6Б остават известна граница.
2Б.3.7 и multicore worker pilot не са започнати. Няма продукционна миграция
или деплой.

Файлове: `server/scripts/checkSvaraRestart2B36C.ts`,
`server/scripts/fixtures/svaraRestartHooks.mjs`, `server/package.json`,
този отчет и §16 от `temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md`.
