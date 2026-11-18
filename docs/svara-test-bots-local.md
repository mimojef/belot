# Свара — тестови ботове (ВРЕМЕННО, само локално)

Изходен HEAD: `6b6bc936`, клон `v2-clean-architecture` (последен Svara commit: `202cf003`).
Функционалността е **временна**: служи само за локално тестване на реалната мултиплейър Свара от един администратор. Преди окончателното пускане на Свара се премахва изцяло — виж „Премахване“.

## Какво прави

- На **чакаща** маса администраторът-създател вижда бутон **„Запълни с ботове“**. Той запълва всички свободни места със сървърно управлявани ботове (маси за 2, 3 и 4; работи и когато вече има други хора).
- Ботовете имат имена „Бот Петър“, „Бот Мария“… (уникални за масата), аватари от `/assets/avatars/` и синьо означение **БОТ** в чакащата маса; на активната маса името им е в синьо.
- **„При запълване“** — последното сядане стартира мача от самия engine. **„Ръчен старт“** — мачът чака създателят да натисне „Старт“.
- Ботовете играят през **реалния runtime**: същите виртуални стартови чипове, същото анте, същите таймери, банки, snapshot-и и recovery.

## Как работи

- Ботът е обикновен участник в мача с игрови `playerId` `svara-test-bot:<слот>:<uuid>`. **Няма профил в базата**; името и аватарът се извеждат от слота.
- Сяда с участническата команда `join-seat` и действа през `executeParticipantCommand` — същия lobby път като човешка `submit_svara_command` (`lifecycle.sync` → команда → `publish` → `progress`).
- Решава **само** по собствения защитен snapshot (`getPlayerSnapshot(botId)`) — същото, което получава човек-клиент: собствените карти едва след „Погледни“, чужди карти никога, позволените действия (`you.betting`) само на неговия ход. Engine валидира всяко действие.
- Пауза 1–3 сек преди решение (0,6–1,2 сек след собственото „Погледни“). Всяка нова промяна на мача рестартира чакащия таймер, затова ботът не реагира мигновено по остарял план.
- Ако на масата не остане човек (всички излезли или отпаднали), ботовете излизат и мачът приключва. Таймерите се освобождават при край, при закриване, при изключен флаг и при спиране на сървъра. Затварянето на финалния резултат от човека освобождава мача от паметта (ботовете се броят за затворили).

### Минимална тестова стратегия

Претеглен случаен избор според силата на собствената ръка (оценката от `evaluateSvaraHand`); не е режим „винаги плащай/бягай/ол-ин“:

| Ситуация | Поведение |
| --- | --- |
| Непогледнал | обикновено „Погледни“; ~12% залог на тъмно |
| Слаба ръка (< 20 т.) | „Без залог“, плащане или бягане; рядко повишаване |
| Средна (20–23) | предимно плащане |
| Добра (24–28) | плащане или повишаване |
| Силна (≥ 29) | повишаване/плащане, понякога ол-ин |
| Само ол-ин възможен (къс стек) | при прилична ръка |
| Включване в Свара | ~55%, ако таксата е до 30% от стека, иначе ~30% |
| Покажи/Скрий | 50/50 |
| Отсъстващ бот | „Връщане“ |

Правилата на engine не са променяни.

## Сигурност

- Флаг `SVARA_TEST_BOTS_ENABLED`: активен **само** при точно `1` **и** `SVARA_TEST_ENABLED=1` **и** `NODE_ENV` ≠ `production`. По подразбиране е изключен; не се включва в production.
- Сървърът проверява правото при всяка заявка `fill_svara_table_with_bots`: флаг → `feature_disabled`; роля различна от `admin` → `forbidden_role`; не е създател/не седи → `not_allowed`; маса извън чакащ етап → `wrong_phase`; няма свободни места → `table_full`. Видимостта на бутона е само UX (сървърът праща `testBotFill` само на admin-създателя).
- Ботовете не ползват реални баланси, жълтици или финансови операции; само виртуалните чипове на Свара.
- Без връзка с ботовете от Белот; ботове има само в тестовата Свара.

## Локално стартиране

1. В `server/.env` (игнориран от Git) добави към вече наличния `SVARA_TEST_ENABLED=1`:
   ```
   SVARA_TEST_BOTS_ENABLED=1
   ```
   Не задавай `NODE_ENV=production`.
2. Стартирай, в отделни PowerShell терминали:
   ```powershell
   cd D:\Project\belot-v2\server
   npm.cmd run dev
   ```
   ```powershell
   cd D:\Project\belot-v2
   npm.cmd run dev -- --host localhost --port 5173 --strictPort
   ```
   В лога на сървъра трябва да има `[svara-test-bots] ENABLED — local testing only`.
3. Отвори **http://localhost:5173/games/svara** с профил с роля `admin` (напр. `Mimojef`) → „Истинска игра“ → „+ Създай игра“ → избери брой участници и режим на старт.
4. В чакащата маса натисни **„Запълни с ботове“**.
   - „При запълване“: играта започва веднага.
   - „Ръчен старт“: натисни „Старт“.
5. За смесена маса: втори профил с разрешена Svara роля (в друг браузърен профил/инкогнито) се присъединява преди „Запълни с ботове“; бутонът запълва само останалите места.

## Проверки

| Проверка | Резултат |
| --- | --- |
| `cd server; npm run check:svara-test-bots` — реален lobby/runtime/lifecycle + persistence порт, контролиран часовник | 9/9; 30/30 последователни пускания |
| `npm run check:svara-test-bots-real` — компилиран backend, собствена SQLite, реален часовник, WS, Chromium UI | 6/6 (3 пълни пускания) |
| Съществуващи Svara проверки (lobby, lifecycle, snapshot, runtime, recovery, dealing, showdown, creation, waiting profiles, клиентските) | без регресии |
| Svara проверки, които падат и на изходния HEAD | engine-2b1 (1), gameplay-2b34 (12), persistence-2b36a (1), stage1-access (2), match-optimization — **същите** преди и след промяната |
| TypeScript сървър/клиент, `server npm run build`, `npm run build` | OK |

Покрити сценарии: 1 срещу 1/2/3 бота, смесена маса, „При запълване“ и „Ръчен старт“, reload/reconnect, рестарт на сървъра посред мач, изход и приключване, освобождаване на таймерите, без чужди карти в snapshot-а на бота, без реални жълтици и без бот редове в базата извън snapshot-а на мача, изключен флаг → няма бутон и заявката се отказва.

## Премахване (при окончателното пускане на Свара)

Изтрий изцяло:

- `server/src/games/svara/testBots/` (флаг, идентичност, стратегия, контролер)
- `server/scripts/checkSvaraTestBots.ts`
- `scripts/checkSvaraTestBotsReal.ts`
- този документ

Махни маркираните с `ВРЕМЕННО — тестови ботове` места:

| Файл | Какво |
| --- | --- |
| `server/src/games/svara/createSvaraLobby.ts` | import, `deps.testBots`, `testBots`/`testBotFillViewer`, бот профили в `tableWithProfiles`, клона `fill_svara_table_with_bots`, `testBots?.onMatchChanged` в `publish` и recovery, `testBots?.isBot` при освобождаване на финален мач, `testBots?.shutdown()` |
| `server/src/games/svara/createPersistentSvaraLobby.ts` | import и `testBots` в deps |
| `server/src/games/svara/protocol/svaraLobbyProtocol.ts` | типа `fill_svara_table_with_bots`, записа в `SVARA_LOBBY_MESSAGE_TYPES`, клона в парсера |
| `server/src/games/svara/protocol/svaraSnapshotProtocol.ts` | `isBot?` и `testBotFill?` в `SvaraPublicTable` |
| `server/src/index.ts` | двата import-а, `testBots:` в `createPersistentSvaraLobby`, startup предупреждението, `case 'fill_svara_table_with_bots'` |
| `server/package.json` | `check:svara-test-bots` |
| `server/.env.example` (и локалния `server/.env`) | `SVARA_TEST_BOTS_ENABLED` |
| `package.json` | `check:svara-test-bots-real` |
| `scripts/svaraRealIntegrationHarness.ts` | опцията `extraEnv` |
| `src/app/network/createGameServerClient.ts` | типа на съобщението, `fillSvaraTableWithBots`, `isBot?`/`testBotFill?` |
| `src/app/lobby/createLobbyFlowController.ts` | `onSvaraTableFillWithBots` и `onFillWithBots` |
| `src/main.ts` | `onSvaraTableFillWithBots` |
| `src/app/games/svara/createSvaraLobbyController.ts` | `onFillWithBots`, `fillBotsPending`, бутона, означението БОТ, проверката `!player.isBot` |
| `src/app/games/svara/table/renderSvaraActiveTable.ts` | `testBot` и бот името/аватара |

Проверка след премахването: `git grep -n "ВРЕМЕННО — тестови ботове\|testBot\|svara-test-bot\|SVARA_TEST_BOTS"` да не връща нищо.

Мачове с ботове, останали в локалната SQLite база (`svara_match_snapshots`), се възстановяват и без модула: ботовете не действат, затова техните ходове изтичат по съществуващите таймери. Препоръчително е такива локални тестови мачове да се приключат преди премахването.
