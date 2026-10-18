# Свара — Етап 2Б.3.7.7

## Минимално разширение на snapshot-а

Само индивидуалният `round.kind === 'svara-joining'` вече съдържа:

```ts
decisions: Array<{ playerId: string; status: 'undecided' | 'joined' | 'declined' }>
```

`joined` идва от записаните `round.joiners` и текущите права върху обикновената заключена банка; `declined` — единствено от записаните `round.declined`. Чакащите идват от съществуващия `describeSvaraLifecycle(state).joining.undecided`. Първоначалните правоимащи, напусналите и недопустимите за включване играчи не се представят като чакащи. Действителен engine сценарий с недостатъчен баланс проверява изключването на играчи, които не могат да платят пълната такса.

Списъкът се проектира при четене. Няма ново engine състояние, миграция, промяна на durable формата или recovery. Съществуващото `you.svaraDecision` е запазено. Клиентският тип е синхронизиран; липсващо поле от стар сървър не води до отгатнати статуси или разрешени действия.

Статусите минават през съществуващия удостоверен, ограничен до участник в съответния мач snapshot път. Публичният списък, чужда маса, неучастниците и историята не получават тези детайли. Самото поле не съдържа ръце, ledger или вътрешни списъци на engine.

## Прозорци и синхронизация

„Включваш ли се в Свара?“ се показва само при едновременно индивидуално разрешение `you.svaraDecision === 'undecided'`, публичен собствен статус `undecided`, обикновена банка и валиден текущ `svara-joining` deadline. Таксата е точно `round.fee`. Бутоните изпращат съществуващите `svara-join` и `svara-decline`. До профилите се показват „ИЗЧАКВА СЕ“, „ВКЛЮЧВА СЕ“ и „ПРОПУСКА“ директно от сървърния списък. Специалната Свара с Ол-ин няма този прозорец.

„Искаш ли да покажеш картите си?“ се показва само на активния победител с индивидуалното `you.revealChoice.canDecide`, pending `reveal-choice` и валиден deadline. Изпращат се `reveal-cards`/`hide-cards`. Противниците виждат изчакване без бутони или чужди частни карти. При `revealed` съществуващият визуален слой от 2Б.3.7.6Б показва трите карти и сървърните точки за абсолютния `reveal-display` срок от три секунди. Нормален showdown няма този избор.

Двата countdown-а използват `sharedServerClock` и абсолютния deadline за същите matchId/revision. 15 и 5 секунди са само общата дължина за визуалната лента; няма клиентски начален момент или нов игрови таймер. Използва се съществуващият UI tick. При изтичане прозорецът изчезва, без локална команда за отказ/скриване или измислен публичен статус. Всеки клик проверява срока отново, включително преди следващия UI tick.

Бутоните се заключват при изпращане. `commandId` и expected revision се запазват в съществуващия протокол. Сам ACK не отключва повторно същия избор, ако обновеният snapshot още не е пристигнал. Потвърдено решение/нов round премахва pending състоянието; съответстваща грешка показва сървърното съобщение и допуска нов опит. Стар ACK/error или бутон от предишен прозорец не управлява новия избор. Няма локално намаляване на баланс, присъждане или повторно изплащане.

Прозорците са в DOM поддървото на самата маса. Countdown-ът не подменя диалога и фокусираните бутони. При fullscreen актуализациите запазват същия fullscreen table елемент. Това поправя конкретното отпадане от fullscreen при пълна подмяна на root. Бутоните са поне 46px високи, а масата и визуалните ресурси са запазени.

## Проверки

| Пакет | Резултат |
| --- | --- |
| Нови логически проверки с fake clock | 15/15 |
| Нов Chromium компонентен harness | 49 проверки на всеки от 320×568, 390×844, 844×390, 1280×900 |
| Lifecycle, включително 5 нови сървърни сценария | 29/29 |
| Snapshot / Showdown 2Б.3.7.6А / Gameplay | 20/20, 25/25, 14/14 |
| Persistence / Recovery / Runtime | 34/34, 37/37, 23/23 |
| Реални HTTP/WS/SQLite restart проверки | 13/13; 34 старта, 28 нормални спирания, 6 crash сценария |
| Engine / Chips / Match | 86 успешни + 1 стар провал; 25/25; 72/72 |
| Client lobby / Betting / Layout / Dealing animation / Result animation | 17/17, 28/28, 16/16, 28/28, 17/17 |
| Предишен Chromium result animation harness | 82 проверки × 4 размера, плюс reduced motion |
| TypeScript: клиент, сървър и новите тестове | Успешни |
| Vite production build с PWA | Успешен; остава съществуващото предупреждение за големи chunks |
| `git diff --check` | Успешен |

Новите сървърни проверки покриват реални engine решения, payload-ите до всички участници, реално платена такса/права, duplicate commandId без второ плащане, липса на данните в public lobby/чужда маса, недостатъчен баланс и възстановяване от същия durable формат с идентични deadlines и чипове.

Chromium компонентните проверки използват действителните клиентски модули с изрично подадени тестови snapshots. Проверени са размерите, touch targets, фокус при countdown, fullscreen през server updates, join/decline/reveal/hide, отказ/повторен опит, двойно натискане, ACK преди snapshot, стари бутони/errors, deadline преди UI tick, ранно затваряне, недублиране след remount, възстановяване на приключили статуси и действителен page refresh по средата на двата прозореца. Това не е HTTP/auth/WS end-to-end проверка. Снимките и отчетът са в игнорирания `tmp/svara-decision-browser/`.

Реалният `checkSvaraClientRealIntegration.ts` е стартиран с изолиран backend и спира при регистрация:

```text
Registration failed for a: {"ok":false,"message":"Регистрацията временно не е налична."}
```

Този отказ се връща от `authStore.register()` при невалидна конфигурация на регистрационния secret (`isRegistrationSecretConfigured`, минимум 32 символа). Реалният клиентски HTTP/auth/WS сценарий остава блокиран в тази тестова среда. Регистрацията, конфигурацията ѝ и integration harness-ът не са променяни за заобикаляне на отказа. При приключване на неуспешния Windows процес е отчетено и Node/libuv `UV_HANDLE_CLOSING` assertion; успешните изолирани restart тестове са отделен harness.

Старият engine провал остава `H2`: `git grep games/svara/engine -- src` брои коментари в `svaraBettingActions.ts` и `createGameServerClient.ts` като imports. Те присъстват и в началния commit `1bfaa7e`. Проверката не е отслабвана или променяна.

## Променени файлове

- `server/src/games/svara/protocol/svaraSnapshotProtocol.ts`
- `src/app/network/createGameServerClient.ts`
- `src/app/games/svara/table/svaraDecisionWindows.ts`
- `src/app/games/svara/table/renderSvaraActiveTable.ts`
- `src/app/games/svara/createSvaraLobbyController.ts`
- `server/scripts/checkSvaraLifecycle2B35.ts`
- `scripts/checkSvaraDecisionWindows.ts`
- `scripts/checkSvaraDecisionWindowsBrowser.ts`
- `scripts/fixtures/svaraDecisionFixtures.ts`
- `scripts/checkSvaraBettingActions.ts` — актуализирана типизирана joining fixture
- `package.json`
- `.gitignore`
- `docs/svara-decision-windows-2b377.md`

Без промени по игрови правила, банки, залози, Ол-ин, deadlines, счетоводство, SQLite схема, жълтици, други игри или production инфраструктура. Няма SSH/деплой. Етап 2Б.3.7.8 не е започван.
