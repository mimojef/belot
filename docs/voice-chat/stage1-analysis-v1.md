> **Архивен документ от Етап 1 (2026-11-12).** Окончателните решения на собственика и актуалният план са в [HANDOFF.md](HANDOFF.md) и имат приоритет при противоречие. Части от този отчет са заменени (например: слушането вече е безплатно за всички реални играчи, а speaking индикацията е само зелено микрофонче). Номерата на редовете в препратките са към HEAD `6b3b9cb`.

# Гласов чат в частните маси на Белот — Етап 1: анализ и проект

Дата: 2026-11-12 · Branch `v2-clean-architecture` · HEAD `6b3b9cb`

Легенда:
- **[ФАКТ]** — установено от кода (с файл:ред).
- **[ПРЕДЛОЖЕНИЕ]** — мое предложение за обсъждане.
- **[НЕРЕШЕНО]** — изисква решение от собственика.
- **[LK]** — твърдение за LiveKit от документацията/SDK по мои знания. Подлежи на проверка срещу LiveKit Server v1.13.11 в Етап 2. Не е проверено на твоя сървър.

---

## A. Git състояние

- [ФАКТ] Branch `v2-clean-architecture`, HEAD `6b3b9cb` („fix(lobby): animate mobile carousel arrow navigation“). Working tree е чист, stash е празен.
- [ФАКТ] `origin/v2-clean-architecture` е на същия commit (0 напред и 0 назад, проверено с `git ls-remote`).
- [ФАКТ] `feature/mobile-redesign` (`61c1e86`) е изцяло влят с merge `f61954a` (2026-11-04). След него има още 19 commit-а.
- [ФАКТ] Няма LiveKit или WebRTC код и няма такива зависимости в нито един branch в origin. Не съм променял файлове.

---

## B. Инвентар на съществуващата архитектура

### B1. Два различни обекта за „частна маса“ (ключов факт)

| Етап | Обект | Къде живее | Id | Persist при рестарт |
|---|---|---|---|---|
| Чакалня (до старта) | `PrivateRoom` | [privateRoomsStore.ts](../../server/src/game/privateRoomsStore.ts) — in-memory `Map` | `randomUUID()` (`createRoom`, ред 641) | **Не** — губи се при рестарт |
| Игра | `ServerRoom` | `serverState.rooms` в [index.ts](../../server/src/index.ts) | **ново** id от `createServerRoom` в `handlePrivateRoomReady` (ред 5806) | **Да** — JSON snapshot (`activeRoomSnapshotStore`, `loadPersistedServerState` ред 4911) |

- [ФАКТ] При 4/4 + readiness (или ръчен СТАРТ) `detachReadyRoom` (ред 597) изтрива `PrivateRoom`, а `handlePrivateRoomReady` създава `ServerRoom` с `config.isPrivateTableOrigin: true`. Връзката `privateRoomId → roomId` се пази само в `privateRoomMatchStore.recordMatchStarted` (index.ts:5378).
- **Следствие:** гласовата маса трябва да е **отделна сущност `voiceTableId`**, която минава от `PrivateRoom` към `ServerRoom` в `handlePrivateRoomReady`. Не може да се върже директно към нито едно от двете id.

### B2. Повторна игра
- [ФАКТ] „Преиграй“ (`request_replay`, `applyReplayRestart`, index.ts:26483–26560) **използва същия `ServerRoom.id` и същите места**. Нулира само `game` и гласовете и отново събира залозите.
- [ФАКТ] За маси от частна маса бутонът „Нова игра“ (matchmaking) е скрит, а „Преиграй“ остава ([renderMatchEndedScreen.ts:711–754](../../src/app/activeRoom/renderMatchEndedScreen.ts#L711)).
- **Следствие:** гласовата стая може да преживее повторната игра без прекъсване. Повторната игра е и естествената граница за проверка на VIP (виж P3).

### B3. Участие, disconnect, бот, окончателно напускане
- [ФАКТ] `HumanRoomParticipant` ([serverTypes.ts:93](../../server/src/core/serverTypes.ts#L93)) има `connectionId | null`, `isConnected`, `reconnectToken` и **`permanentlyLeftAt`**. Последното е non-null само при окончателно доброволно напускане (`leave_active_room`, index.ts:27353). При временен disconnect или поемане от бот `kind` остава `'human'`.
- [ФАКТ] `reconnectGraceMs = 30000` ([createServerRoom.ts:35](../../server/src/core/createServerRoom.ts#L35)). Ботът поема хода при изтекъл таймер (`controlledByBot` в authoritative state, `abandonHumanControlForRoom.ts` / `resumeHumanControlForRoom.ts`).
- [ФАКТ] Всяко премахване на `ServerRoom` минава през **[removeCommittedServerRoom](../../server/src/index.ts#L5089)**. Коментарът там я нарича „единствената choke point за room removal“. Това е идеалната кука за край на гласовата маса.

### B4. Сесии, табове, устройства
- [ФАКТ] Нов WebSocket на същия профил **измества** старите връзки чрез `displaceProfileConnections` (index.ts:7952, съобщение `session_displaced` + close), освен ако профилът е в игра (`sendSessionInGameIfNeeded`, ред 7884 → `session_in_game`). При `resume_room` също се вика displacement (ред 26928).
- [ФАКТ] При бан се затварят всички връзки (`banProfileConnections`, около ред 7999, `session_banned`).
- **Следствие:** един профил има най-много една жива игрова връзка. [LK] LiveKit изхвърля стария участник при влизане със същия identity (`DUPLICATE_IDENTITY`). Двете поведения се допълват.

### B5. VIP
- [ФАКТ] Единственият източник на истина е `vipStore.getStatus(profileId)` ([vipStore.ts:161](../../server/src/db/vipStore.ts#L161)), т.е. `vip_status.active_until > now`, изчислено при всяко извикване. Синхронно SQLite четене с prepared statement.
- [ФАКТ] Има прецедент за чиста gate функция без bypass по роля: [evaluateVipSpectatorGateEligibility.ts](../../server/src/core/evaluateVipSpectatorGateEligibility.ts) („Гледай“ изисква VIP, админите минават същата проверка).
- [ФАКТ] HTTP `GET /api/vip/status` (`handleVipStatusRequest`, index.ts:13855) връща `status`, `hasClaimedLaunchGift` и `launchGiftDays`.
- [ФАКТ] Клиентът ползва каноничния gate `state.topicsVipGate` + `ensureTopicsVipGateLoaded()` и reusable popup [renderVipRequiredPopup.ts](../../src/ui/overlays/renderVipRequiredPopup.ts) със светъл вариант. Popup-ът има **три състояния**, включително „Вземи X дни безплатно“ (launch gift).
- [ФАКТ] Магазинът на VIP секция се отваря с `state.shopActiveTab = 'vip'; await showShopPanel()` ([createLobbyFlowController.ts:11736](../../src/app/lobby/createLobbyFlowController.ts#L11736)). Това е панел на **лоби контролера** и не е достъпен в активна игра.

### B6. Feature flags и админ настройки
- [ФАКТ] Има готов шаблон за режим от админ панела с авариен стоп от env: „Персонализация“.
  - Режимът се пази в SQLite (`profile_customization_mode_changes`, audit история). Без записи се връща `'admin_only'` и функцията никога не е публична по подразбиране.
  - `PROFILE_CUSTOMIZATION_ENABLED=0` е авариен стоп и се чете при всяко извикване ([profileCustomizationFeatureFlag.ts](../../server/src/profileCustomization/profileCustomizationFeatureFlag.ts)).
  - Gate: `canSessionUseProfileCustomization` (index.ts:2413), `'public' || role === 'admin'`.
- [ФАКТ] `admin_settings` е key-value таблица, а `AdminSettingsSnapshot` ([adminSettingsStore.ts:25](../../server/src/db/adminSettingsStore.ts#L25)) се чете свежо без кеш. Тук е естественото място за лимита от 10 гласови маси.
- [ФАКТ] Пълен админ се проверява с `isFullAdminSession(session)` (`role === 'admin'`, [authStore.ts:200](../../server/src/db/authStore.ts#L200)).
- [ФАКТ] Админ панелите са самостоятелни overlay-и (`showAdminProfileCustomizationPanel` и т.н.), които викат `/api/admin/...` с проверка на ролята на сървъра.

### B7. HTTP и сигурност на заявките
- [ФАКТ] Сесията идва от HttpOnly cookie със `SameSite=Lax` ([authStore.ts:1075](../../server/src/db/authStore.ts#L1075)) чрез `getSessionTokenFromCookieHeader` + `authStore.getSession`.
- [ФАКТ] Има origin guard `isAllowedVisitorRequestOrigin` (index.ts:9145): отказва `Sec-Fetch-Site: cross-site` и чужд `Origin`.
- [ФАКТ] Изходящите HTTP заявки ползват `fetch` + `AbortSignal.timeout(...)` (Brevo, `sendPasswordResetEmail.ts:76`). Node е v24.

### B8. Процесен модел
- [ФАКТ] WebSocket, HTTP и `serverState` са в главния thread. Игровата логика е в worker threads (`createWorkerBackedActiveRoomRuntime`).
- [ФАКТ] Коментари в кода споменават „PM2 споделя SQLite между няколко process instances“ (authStore.ts:1130, index.ts:23840). Игровото състояние (частни маси, стаи) обаче е in-memory в един процес.
- **[НЕРЕШЕНО/ПРОВЕРКА]** Реалната PM2 топология в production (`instances`, `exec_mode`). От нея зависи дали лимитът може да е само в паметта. Предлагам лимитът да се пази в SQLite транзакция и да работи и в двата случая (виж E5).

### B9. Клиентска мрежа
- [ФАКТ] [createGameServerClient.ts:3894](../../src/app/network/createGameServerClient.ts#L3894) **логва всяко входящо съобщение в конзолата** (`console.log('[game-server] message', ...)`).
- **Следствие:** LiveKit токен **не бива** да минава през игровия WebSocket. Ще се издава по HTTPS `fetch` (`credentials: 'include'`), какъвто е шаблонът и за останалите API-та.

### B10. Frontend bundle и PWA
- [ФАКТ] Главният bundle е **2,79 MB** (`dist/assets/index-*.js`), а PWA precache лимитът е **3 MiB** ([vite.config.ts](../../vite.config.ts), `maximumFileSizeToCacheInBytes`).
- [ФАКТ] Има прецедент chunk-ове да се изключват от precache: `assets/svara-*` в `globIgnores`, плюс `chunkFileNames` с префикс за Свара и pixi.js.
- **Следствие:** `livekit-client` трябва да е **отделен lazy chunk** (`assets/voice-*`), изключен от precache. Статичното включване би минало над лимита.

### B11. Други факти от кода
- [ФАКТ] В `index.html` е `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` **без `viewport-fit=cover`**. Затова `env(safe-area-inset-*)`, ползвано на места в кода, на iOS ще е 0 и браузърът сам оставя полета.
- [ФАКТ] В repo няма CSP, Permissions-Policy или nginx конфигурация за production.
- **[ПРОВЕРКА]** Production nginx може да има `Permissions-Policy: microphone=()` или CSP `connect-src`, които биха блокирали `getUserMedia` или `wss://voice.pika.bg`. Трябва `nginx -T` преглед от собственика, без промяна.
- [ФАКТ] Визиторската статистика пази само OS и тип устройство, не браузър (`detectOsType`, `detectDeviceType`). На iOS всички браузъри са WebKit, така че „iPhone Safari“ покрива и Chrome за iOS.
- [ФАКТ] Не намерих механизъм с име „инкогнито“ или скрит наблюдател. Зрителите в „Гледай“ са **видими** за играчите („{име} гледа вашата игра“, `buildBelotRoomSpectatorsMessage.ts`). **[НЕРЕШЕНО]** Уточни кой механизъм имаш предвид под „инкогнито режим“, за да го опазим изрично.

---

## C. Засегнати backend файлове и куки

| Файл / функция | Какво ще се добави (предложение) |
|---|---|
| [privateRoomsStore.ts](../../server/src/game/privateRoomsStore.ts) `PrivateRoom`, `CreateRoomInput`, `createRoom` (641) | `voiceTableId: string \| null` (readonly). Store-ът остава без зависимост от гласа и само носи id-то. |
| `leaveRoom` (1048), `kickMember` (967), `closeRoom` (1131), `scheduleExpiry`/`runExpiry` (552) | Чрез съществуващите callback-и (`onMemberLeft`, `onMemberKicked`, `onRoomClosed`, `onRoomExpired`) → ротация или край на гласовата маса. |
| `reconnectMember` (1610), `removeConnection` (1638) | **Без** гласови действия (временен disconnect не отнема права). |
| index.ts `create_private_room` (28295) | Ново поле `voiceEnabled` в съобщението. Проверки за режим, VIP и лимит; синхронна резервация на слот (E5); код `voice_capacity_reached`. |
| index.ts `handlePrivateRoomReady` (5806) | `voiceTableId` се записва в `ServerRoomConfig` (persist-ва се със snapshot-а) и се обвързва `serverRoomId`. |
| index.ts `buildPrivateRoomSnapshot` (5255), `broadcastPrivateRoomsListToLobbyConnections` (5317) | `voice: { enabled, serviceAvailable }` в `PrivateRoomSnapshot` за лобито. |
| index.ts `recordPrivateRoomMatchStarted` (5352) / `privateRoomMatchStore` | `voiceEnabled` за списъка „Играещи“ (колона или in-memory join). |
| `createRoomSnapshotMessage.ts` | Блок `voice` в room snapshot-а **само за участници**: enabled, generation, достъп, състояние на услугата. Никога в spectator snapshot. |
| index.ts `leave_active_room` (27353) | `permanentlyLeftAt` → отнемане на правото + ротация. |
| index.ts `request_replay` / `applyReplayRestart` (26483/26527) | Граница на мача: повторна проверка на VIP за гласовите участници. |
| index.ts `removeCommittedServerRoom` (5089) | Край на гласовата маса (освобождава слота, асинхронен DeleteRoom). |
| index.ts `displaceProfileConnections` (7952), `banProfileConnections` | Displacement: без ротация (същият профил). Бан: отнемане + ротация. |
| index.ts `loadPersistedServerState` (4911) / boot | Reconciliation на гласовите маси (виж H6). |
| `adminSettingsStore.ts` | `voiceChatMaxTables` (default 10). |
| index.ts HTTP router | `POST /api/voice/token`, `GET/POST /api/admin/voice-chat*`, по желание `POST /api/voice/webhook` и `POST /api/voice/client-report`. |
| `server/package.json` | `livekit-server-sdk` (виж N). |
| Нов модул `server/src/voice/` | Виж E. |

---

## D. Засегнати frontend файлове и куки

| Файл | Засягане |
|---|---|
| [src/main.ts](../../src/main.ts) | Създаване на **глобален** voice controller (както `gameAudio`, ред 253). Wire към WebSocket съобщенията, logout, `session_displaced`, `session_banned`. Отваряне на админ панела. |
| [createGameServerClient.ts](../../src/app/network/createGameServerClient.ts) | Типове: `voice` в `PrivateRoomSnapshot` и room snapshot, `voiceEnabled` в `create_private_room`, ново съобщение `voice_table_updated`. |
| [renderLobbyScreen.ts](../../src/app/lobby/renderLobbyScreen.ts) `renderPrivateRoomsPage` (14538; светла карта 14719–14749), `renderPrivateRoomsCreatePopup` (15090; `checkboxRow` 15110) | Икона за гласова маса; нов ред в прозореца за създаване; popup-и за VIP и за пълен капацитет. |
| [createLobbyFlowController.ts](../../src/app/lobby/createLobbyFlowController.ts) | Submit с `voiceEnabled`; non-VIP gate (reuse на `ensureTopicsVipGateLoaded`); „Вземи VIP“ → `shopActiveTab='vip'`. |
| [renderPrivateRoomWaitingScreen.ts](../../src/app/lobby/renderPrivateRoomWaitingScreen.ts) header (1565), `.prw-waiting-actions` (1577), `renderSlotCard` (267) | Гласова лента в чакалнята; индикатори върху `.prw-slot-avatar`. |
| [renderActiveRoomActionBar.ts](../../src/app/activeRoom/renderActiveRoomActionBar.ts) (mobile 89, desktop 152, settings panel) | Гласов бутон и панел. Mobile: в долната лента. Desktop: след ⚙️. |
| [createActiveRoomFlowController.ts](../../src/app/activeRoom/createActiveRoomFlowController.ts) `renderActiveRoomScreen` (3424), `ensureEmojiButton` (2852) | Hook след render за повторно прилагане на speaking и mute атрибутите. Взаимно изключване на гласовия панел и emoji/phrase picker-ите. |
| [renderCuttingSeatPanels.ts](../../src/app/activeRoom/cutting/renderCuttingSeatPanels.ts) `createCuttingSeatPanelHtml` (1240; avatar `[data-profile-seat-btn]`) | `data-voice-*` атрибути и CSS за пръстен и badge. Без нови елементи в layout-а. |
| [renderMatchEndedScreen.ts](../../src/app/activeRoom/renderMatchEndedScreen.ts) | Без промяна. Гласовият бутон в долната лента остава видим. |
| [renderVipRequiredPopup.ts](../../src/ui/overlays/renderVipRequiredPopup.ts) | Reuse с namespace `voice`. **Нужна е промяна на текста:** шаблонът е „${featureLabel} е достъпно…“, което е граматически грешно за „Гласовият чат“ (мъжки род). |
| [vite.config.ts](../../vite.config.ts) | `chunkFileNames` префикс `voice-` и `globIgnores: 'assets/voice-*'`. |
| Нов модул `src/app/voice/` | Виж F. |

---

## E. Предложена backend архитектура [ПРЕДЛОЖЕНИЕ]

### E1. Модул `server/src/voice/`
```
voiceFeatureFlag.ts        env авариен стоп VOICE_CHAT_ENABLED=0 + наличие на LIVEKIT_* конфигурация
voiceChatStore.ts          SQLite: режим (+audit), voice_tables, voice_room_generations
voiceEligibility.ts        ЧИСТА функция evaluateVoiceTokenEligibility(...) — unit-testable
voiceTableRegistry.ts      in-memory: voiceTableId → {privateRoomId|serverRoomId, generation,
                           issuedIdentities, status}; индекси по privateRoomId/serverRoomId
voiceRoomLifecycle.ts      create/rotate/retire; retry опашка; reconciliation
livekitApi.ts              тънък клиент: timeout, bounded concurrency, circuit breaker
voiceTokenIssuer.ts        AccessToken (HS256) — само локално подписване
voiceMetrics.ts            in-memory броячи + LiveKit RoomService snapshot (за админа)
```
`index.ts` само вика тези модули от изброените в C куки. Логиката остава извън 31-хилядния файл.

### E2. Поток „искане на токен“ (`POST /api/voice/token`)
1. Сесия от cookie, origin guard, профил ≠ null.
2. Режимът е активен и няма авариен стоп.
3. Membership: профилът е human occupant на `PrivateRoom` с `voiceTableId` (чакалня) **или** human участник на `ServerRoom` с `config.voiceTableId`, без `permanentlyLeftAt` (игра).
4. VIP: `vipStore.getStatus(profileId).isActive` (според одобрената политика, P2/P3).
5. Гласовата маса е `active`, текущата генерация е известна и **не** е в `retiring`.
6. Circuit breaker не е отворен. Иначе `503 voice_unavailable` веднага, без мрежова заявка.
7. `CreateRoom(name)` [LK: идемпотентна операция; връща съществуващата стая] с timeout ~3 s.
8. Подписване на токен (локално, без мрежа). Записва се `issuedIdentities[generation].add(profileId)`.
9. Отговор: `{ wsUrl, token, roomName, generation, identity }`. URL-ът е от env, frontend-ът няма hardcode.
- Токенът **не** се логва и не влиза в WebSocket. Броячите (успех, отказ по причина) са in-memory.

### E3. Grants на токена
- `roomJoin: true`, `room: <точно име>`, `canSubscribe: true`, `canPublish: true`, `canPublishSources: ['microphone']`, `canPublishData: false`, `canUpdateOwnMetadata: false`. Без `roomCreate`, `roomAdmin`, `roomList`, `recorder`, `hidden`. TTL ~10 мин (само за влизането).
- **„Само слушай“ — два варианта [НЕРЕШЕНО, препоръка А]:**
  - **А (препоръка):** един токен с `canPublish` само за микрофон. Микрофонът се включва единствено с изрично действие на клиента. Предимство: преминаването към говорене не зависи от LiveKit API (работи и при проблем с API-то) и е без прекъсване.
  - **Б:** listen-only токен (`canPublish:false`). Преминаването към говорене минава през backend `UpdateParticipant(permission)` [LK] или реконект с нов токен. Предимство: защита на ниво сървър срещу случайно публикуване. Недостатък: зависимост от API и забавяне.
  - И в двата варианта **микрофонът никога не се активира, само защото токенът позволява** (F5).

### E4. Identity
- [ПРЕДЛОЖЕНИЕ] `identity = "p_" + profileId`, без `name` и metadata. Клиентът свързва участника с място чрез `profileId`, който вече е в `RoomSeatSnapshot`. Така LiveKit не съхранява имена.
- Алтернатива: непрозрачен HMAC identity за всяка маса + mapping в snapshot-а. По-добра поверителност в LiveKit логовете, малко повече код.

### E5. Атомарен лимит
- Слотът се заема **синхронно** в `create_private_room` с една SQLite транзакция `BEGIN IMMEDIATE` (`COUNT(*) WHERE status='active'` спрямо `voiceChatMaxTables` → `INSERT`). Тя е атомарна и при няколко PM2 процеса, и в един процес (там JS и без това е еднонишков между двете операции). Честотата е ниска (само при създаване на гласова маса), така че цената е под милисекунда и не попада в hot path.
- **LiveKit не участва в създаването.** `CreateRoom` е lazy, при първото искане на токен. Създаването на маса никога не чака гласовия сървър.
- Кога се освобождава слотът [ПРЕДЛОЖЕНИЕ]: при изтичане, затваряне или разпадане на чакалнята; при премахване на `ServerRoom` (`removeCommittedServerRoom`); при изключване на гласа от админа (P10).
- При намаляване на лимита [ПРЕДЛОЖЕНИЕ = предпочитанието ти]: активните маси продължават, нови не се разрешават, докато `active < limit`.
- Празна или неактивна гласова стая [ПРЕДЛОЖЕНИЕ]: слотът се пази за целия живот на масата. Животът е ограничен: до 30 мин изчакване + мача + повторните игри. Масата е 4-местна и няма смисъл слотът да се „отнема“, докато тя съществува. Алтернатива: освобождаване след N минути без нито един гласов участник [НЕРЕШЕНО].

### E6. Устойчивост (виж и T)
- `livekitApi.ts`:
  - timeout 3 s за всяко извикване (`AbortSignal.timeout`);
  - най-много 4 едновременни извиквания;
  - опашка до 50 елемента, при препълване бърз отказ;
  - retry само за идемпотентни операции (`CreateRoom`, `DeleteRoom` с „not found = успех“, `ListRooms`, `RemoveParticipant`), 2 опита с експоненциален backoff и jitter;
  - circuit breaker: след 5 поредни грешки се отваря за 30 s, после half-open с една пробна заявка.
- Нищо от това не се изпълнява в game worker-ите. Всичко е `async` в главния thread и никога не се `await`-ва в WebSocket handler-ите на играта.
- **[ПРОВЕРКА в Етап 2]** Дали `RoomServiceClient` от `livekit-server-sdk` 2.19.x поддържа timeout и abort за отделна заявка. Ако не, ще напиша тънък fetch клиент към Twirp endpoint-ите и ще ползвам SDK-то само за `AccessToken` и `WebhookReceiver`.

---

## F. Предложена frontend архитектура [ПРЕДЛОЖЕНИЕ]

### F1. Модул `src/app/voice/` (независим от екраните)
```
createVoiceController.ts   ЕДИН instance, създаден в main.ts; state machine (G); subscribe/getSnapshot
loadLiveKitClient.ts       await import('livekit-client') → chunk assets/voice-*.js (извън PWA precache)
voiceAudioSink.ts          ЕДИН скрит <div data-voice-audio-sink> в document.body (извън #app);
                           Map<trackSid, HTMLAudioElement> — dedupe, detach при unsubscribe/disconnect
voiceSeatIndicators.ts     прилага data-voice-state/data-voice-speaking върху [data-seat-profile-card]
                           и .prw-slot-avatar — БЕЗ re-render; reapply() след всеки render
voiceDiagnostics.ts        getStats() на всеки 60 s и при край: RTT, jitter, loss, тип кандидат
                           (host/srflx/relay), брой reconnect-и → един POST, без hot path
renderVoice*.ts            popup с трите избора, бутон и панел (mobile/desktop), лента в чакалнята
```

### F2. Защо глобален контролер
- [ФАКТ] Екраните (лоби, чакалня, игра) се рендират с `innerHTML` (в контролера на активната стая има 51 места с `innerHTML`). Audio елемент или `Room` instance в такъв DOM би се унищожавал при всяко прерисуване.
- Контролерът живее над екраните и получава само „контекст“: `{voiceTableId, generation, role, seats}` от snapshot-ите. Връзката се пипа единствено при смяна на `voiceTableId` или `generation`, при загуба на правото или при действие на потребителя. Нова ръка, резултати, повторна игра и re-render не я засягат.

### F3. Lazy loading и разход
- Потребител, който не натисне „Включи микрофона“ или „Само слушай“, не зарежда SDK-то и няма `Room`, timer-и, tracks или permission заявки.
- [ПРЕДЛОЖЕНИЕ] Prefetch с `modulepreload` на chunk-а **само** когато VIP участник влезе в гласова маса. Така кликът не чака мрежата. Без prefetch за всички останали.

### F4. Autoplay (критично за „Само слушай“)
- Мобилните браузъри разрешават възпроизвеждане само в user gesture. [LK] `room.startAudio()` се вика **синхронно в click handler-а** на „Само слушай“ и „Включи микрофона“, преди `await` на мрежата. Ако gesture-ът е изгубен (`RoomEvent.AudioPlaybackStatusChanged`, `room.canPlaybackAudio === false`), показваме „Натисни, за да чуваш“ и не се правим, че звукът тече.
- Затова SDK-то трябва да е зареден предварително (F3). Ако `import()` е в click-а, iOS може да счете gesture-а за изтекъл.

### F5. Правила за микрофона
- `setMicrophoneEnabled(true)` се вика само от явен бутон. Никога от refresh, reconnect или ротация. След ротация режимът се възстановява същият, защото потребителят вече е дал съгласие. Ако OS е прекъснала track-а, показваме състояние и не включваме сами.
- **[НЕРЕШЕНО]** `stopMicTrackOnMute` [LK, опция на `RoomOptions`]. При `true` OS индикаторът за микрофон изгасва при mute (по-честно към потребителя), но unmute е по-бавен. При `false` unmute е мигновен, но индикаторът остава. Препоръка: `true` на мобилни устройства. Това е и потенциално свързано с наблюдавания проблем, който се оправи с mute/unmute.

### F6. Dedupe и cleanup
- Едно `Room` на контролер. Генерация на връзка (`connectSeq`), като закъснелите събития от стари `Room` се игнорират. Същият шаблон като `thisSocket` guard-а в `createGameServerClient.ts`.
- `pagehide`, `visibilitychange`: **не** създават втора връзка. При връщане се проверява `room.state`.
- Logout, `session_displaced`, `session_banned`: незабавен `room.disconnect()` и чистене на sink, listeners и timer-и, без auto-rejoin.

---

## G. Lifecycle state machine [ПРЕДЛОЖЕНИЕ]

### G1. Клиент (за един `voiceTableId`)
```
                      ┌──────────────────────────── (масата без глас / flag off / не си участник)
                      ▼
               ┌─────────────┐
               │ unavailable │
               └─────┬───────┘
     voice context   │        non-VIP
     + eligible      │──────────────────► not_entitled ──(VIP придобит)──┐
                     ▼                                                   │
               ┌───────────┐ показва 3-те избора веднъж                  │
               │   offer   │◄────────────────────────────────────────────┘
               └─┬───┬───┬─┘
       "Не сега" │   │   │ "Включи микрофона"          
                 ▼   │   └──────────────┐
             ┌──────┐│ "Само слушай"    │
             │ idle ││                  │
             └──┬───┘▼                  ▼
   "Включи се"  │ authorizing ──(HTTP 503/timeout)──► service_unavailable ──(backoff/ръчно)──► authorizing
                └──►    │  ──(403: загубено право)──► unavailable / not_entitled
                        ▼
                   connecting ──(fail)──► service_unavailable
                        │
            ┌───────────┴─────────────┐
            ▼                         ▼
     connected_listen ◄──────► connected_mic  (подсъстояния: on | muted | speaking)
       │  "Включи микрофона"        │   mic_requesting → (denied) → mic_denied (остава listen)
       │                            │                   → (няма устройство) → mic_unavailable
       ├── LiveKit Reconnecting ──► reconnecting ──(Reconnected)──► предишното
       │                                         ──(Disconnected)──► authorizing (нов токен, backoff)
       ├── voice_table_updated(gen+1) ──► rotating ──► authorizing (нов токен) ──► предишния режим
       ├── "Напусни гласовия чат" ──► idle   (масата НЕ се напуска)
       └── загубено право / край на масата / logout / displaced ──► unavailable (пълен cleanup)
Флагове (ортогонални): audio_blocked (нужен е tap), speaking (по участник), track_interrupted (OS)
```

### G2. Сървър — гласова маса
```
reserved ──(старт на играта: bind serverRoomId)──► active
   │                                                │  ├─ rotate (член с токен е загубил право) → active (gen+1)
   │                                                │  └─ ...
   └─(чакалнята изтича/затваря/разпада)──► ended ◄──(removeCommittedServerRoom / admin off / boot без маса)
generation: pending → live → retiring → retired   (retiring = DeleteRoom чака/се повтаря)
```

### G3. Таблица на преходите в Pika

| Събитие | Глас (предложение) |
|---|---|
| Създаване с глас | слот `reserved`; създателят получава прозореца с трите избора |
| Сядане на свободно място (VIP) | прозорецът с трите избора; токен за текущата генерация |
| Сядане (non-VIP) | информативен popup; без токен |
| Напускане на чакалнята / изгонване | **ротация**, ако е получил токен (иначе нищо) |
| Смяна на участник | = напускане + сядане |
| Старт на игра | без прекъсване (същото `voiceTableId` и генерация) |
| Ново раздаване, резултати, прерисуване | нищо |
| Временно отпадане на игровия WS | LiveKit продължава; виж P11 за граничен срок |
| Временно заместване от бот | нищо (правото остава) |
| Връщане на играча | нищо |
| Окончателно напускане (`permanentlyLeftAt`) | **ротация** |
| Край на мача (match-ended) | продължава до повторна игра или премахване на стаята |
| Повторна игра (всички гласуват) | същата генерация; VIP проверка → ротация само при загубен VIP |
| „Към лобито“ на финала | [НЕРЕШЕНО] третира се като напускане на гласа, а при повторна игра на останалите — като отнемане |
| Разпадане на масата / премахване на стаята | `ended` + DeleteRoom |
| Изтичане на VIP | виж P3 |
| Logout | клиентски cleanup; сървърът: best-effort `RemoveParticipant`, **без** ротация (членството остава) |
| Влизане в друг профил | различна identity, без връзка със старата; старата сесия вече е почистена |
| Два таба / две устройства | displacement + `DUPLICATE_IDENTITY` [LK]; изместеният таб не прави auto-rejoin |
| Refresh | [НЕРЕШЕНО] без автоматично свързване (autoplay и permission); компактен бутон „Възстанови гласовия чат“ |
| Възстановяване на игровата сесия | същото като refresh |
| Бан | отнемане + ротация |
| Backend restart | ротация на **всички** активни маси при boot (H6) |

---

## H. Authorization, токени и ротация [ПРЕДЛОЖЕНИЕ]

### H1. Име на стая
`pv_<voiceTableId-без-тирета>_<generation>_<16-байта-random-base32>`
- `voiceTableId` е отделен UUID, който не съвпада с `privateRoomId` или `roomId`.
- Генерацията е монотонна, а случайният суфикс гарантира, че име **никога** не се повтаря (дори при рестарт без DB).
- Името на всяка генерация се записва в `voice_room_generations` преди първия токен.

### H2. Ротация (отнемане на право)
1. **Синхронно:** `generation++`, старото име се маркира `retiring`. Оттук нататък **не се издават токени** за него. Пише се в DB (нисък трафик).
2. Останалите легитимни участници получават `voice_table_updated {voiceTableId, generation}` по игровия WebSocket (без токен). Клиентите сами напускат старата стая и искат нов токен. Прекъсването е около 1–2 s.
3. **Асинхронно:** `DeleteRoom(old)` [LK: изхвърля всички в нея] с retry и backoff. При успех `retired`, при трайна грешка `delete_pending` и reconciler.
4. Новата стая се създава lazy при първия токен за `gen+1`.

### H3. Защо е нужна ротацията
- [LK] `RemoveParticipant` не анулира вече издадени JWT. Изтичането на JWT не прекъсва активна връзка. Свързаните клиенти получават **обновени токени от LiveKit** за автоматично възстановяване.
- Затова единствената сигурна гаранция срещу „стар токен“ е: стаята е изтрита, името никога не се създава отново, а `auto_create: false` пречи на клиента да я създаде сам.

### H4. Race conditions

| Race | Поведение |
|---|---|
| Вход и напускане едновременно | Node обработва съобщенията последователно. Ротацията е синхронна. Токен се издава само след проверка на текущото членство и **текущата** генерация. |
| Токен по време на ротация | Издава се само за `current` генерация. Ако клиентът поиска стара (в заявката), получава 409 и автоматично иска нова. |
| Reconnect към стара генерация | [LK] Resume с LiveKit refresh token е възможен, докато старата стая съществува. Затова DeleteRoom е задължителен. До потвърждението старата стая съдържа само отпадналия (честните клиенти са я напуснали). |
| Забавен CreateRoom | Клиентът е в `connecting` с timeout. При неуспех `service_unavailable` + backoff. Играта не чака. |
| Забавен DeleteRoom | Старото име е изключено от издаване. Новите участници влизат само в `gen+1`. |
| Закъснял или дублиран webhook | Ако има webhooks, те са само сигнал. Проверка по `roomName` + generation, idempotent, без ново състояние от тях. |
| Невалиден webhook | `WebhookReceiver` [LK, JWT подпис с API secret + sha256 на тялото] → 401. Без лог на тялото. |
| Backend restart | Издадените токени не се пазят. При boot се ротира всяка активна маса (новата генерация е безопасна), стари имена се трият с `ListRooms(pv_*)` + DeleteRoom. |
| LiveKit restart | [LK] Стаите в паметта на LiveKit (без Redis) изчезват. Клиентите получават Disconnected, искат нов токен, а CreateRoom отново създава текущото име. Това е безопасно, защото името е на текуща легитимна генерация. |
| Връзката Pika → LiveKit API е прекъсната | Circuit breaker → нови присъединявания `service_unavailable`. Ротацията продължава локално (без токени за старото име, известяване на клиентите), а DeleteRoom чака в опашка. |

### H5. Fail-closed и какво **може** и какво **не може** да се гарантира

**Гарантирано (при работещ Pika backend):**
- Non-VIP, зрители, ботове, администратори като зрители, чужди играчи и напуснали **никога не получават нов токен**. Това е локална проверка без външни зависимости.
- След потвърден DeleteRoom стар токен или refresh token **не може** да влезе в нито една бъдеща стая на масата.
- Нов участник **никога** не влиза в генерация, маркирана за отнемане.

**Не може да се гарантира мигновено:**
- Изхвърляне на вече свързан отпаднал участник, докато LiveKit API е недостъпен за Pika.
  - Смекчаване: честните клиенти напускат старата стая по сигнал от игровия WebSocket, така че отпадналият остава сам.
  - Остатъчен риск: честен клиент, който едновременно е без игрови WebSocket, но с жива LiveKit връзка (фонов режим, частичен network partition), остава в старата стая. Ограничава се от граничния срок в P11.
- Нищо не пречи на участник да запише разговора със собственото си устройство.

**Voice-side watchdog** [НЕ препоръчвам за MVP]:
- Би изисквал нов компонент на гласовия VPS и двупосочна свързаност.
- При симетричен partition не помага.
- Ако се реши, най-евтиният вариант е webhook `participant_joined` → Pika проверява identity + generation → RemoveParticipant. Това обаче е промяна в LiveKit конфигурацията (webhook URL) и изисква твое одобрение.

### H6. Reconciliation
- **При boot:** активните `voice_tables` без съответна `ServerRoom` (чакалните се губят при рестарт) → `ended`. За останалите → ротация. Една асинхронна заявка `ListRooms` → DeleteRoom за всяка `pv_*` стая, която не е текуща.
- **По време на работа:** reconciler **само докато има `delete_pending`**, на всеки 30 s с backoff. Без периодично сканиране на таблици. `ListRooms` за админ dashboard само при отворен панел, не по-често от веднъж на 15 s.

---

## I. Мобилен дизайн — конкретни предложения [ПРЕДЛОЖЕНИЕ; позициите не са окончателни]

### I0. Установени факти за визуалния език
- [ФАКТ] **Новият светъл мобилен дизайн покрива лобито, чакалнята на частната маса, popup-ите и известията.** Маркери: `data-lobby-member-mobile-light`, `data-private-room-light`, `getMobileLightUiContext()` → `'frame' | 'standalone'`. Коментарът в `mobileLightUi.ts` изрично казва „null — desktop/таблет, тъмен мобилен екран **или игра**“.
- [ФАКТ] **Игралната маса на Белот не е редизайнвана.** Нито един от commit-ите на редизайна не пипа `src/app/activeRoom/`. Тя е тъмна: `rgba(15,23,42,0.98)` и черно, златни акценти `#d4a520` / `#f6d36b → #c98b1a`, бели avatar кутии.
- **⚠ Противоречие със заданието:** „гласовият чат да изглежда като предвиден в новия мобилен дизайн“ е напълно постижимо за лоби, създаване и чакалня. В играта обаче той трябва да следва **съществуващия тъмен и златен игрови език**, иначе ще изглежда залепен. Предлагам: светъл език извън играта, игрови език в играта. [НЕРЕШЕНО — потвърди]
- [ФАКТ] Светли токени:
  - карти `#FFFFFF`, рамки `#E4E7EC`, радиус 12 (карти) и 16 (popup), сенки `0 1px 2px rgba(16,24,40,.05)` и `0 20px 48px rgba(16,24,40,.18)`;
  - текст `#17233C` / `#111827` / мета `#667085`;
  - акцент виолетово `#6941C6`, бутон `lobby-violet-btn violet-3d-btn` (градиент `#9473F2 → #6639DB` + 3D ръб);
  - pill `#F4F0FF` / `#D9CCFF`, успех `#067647` / `#ECFDF3` / `#ABEFC6`, грешка `#B42318` / `#FEF3F2` / `#FECDCA`;
  - шрифт `system-ui`;
  - icon стил: Lucide SVG със stroke 2 (например `VIP_POPUP_CROWN_ICON`).
- [ФАКТ] Телефонен layout: `isPhoneLayoutViewport()` ([viewportStage.ts:105](../../src/ui/layout/viewportStage.ts#L105)) = coarse touch с къса страна ≤480 и дълга ≤1050, **или** тесен portrait с къса ≤640 и дълга ≤1200. Покрива и landscape на телефон. CSS: `(hover:none) and (pointer:coarse)`, `max-width:640px`.
- [ФАКТ] Viewport-и в Playwright проверките: 390×844 (основен, 88×), 360×800, 320×568, 375×812, 430×932, landscape 844×390. Desktop: 1280×800/850/900, 1366×768/900, 1920×1080.

### I1. Прозорец „Нова маса“ (светъл) — `renderPrivateRoomsCreatePopup`
Нов `checkboxRow` **след „Покани партньор“**, в същия стил и с невключено поле по подразбиране:
```
┌──────────────────────────────────────┐
│ Нова маса                        [×] │
│ Вход  [ 100 жълтици            ▾ ]   │
│ ┌──────────────────────────────────┐ │
│ │☐ Заключена маса                  │ │
│ │  Само с покана                   │ │
│ └──────────────────────────────────┘ │
│ ┌ ☐ Ръчен старт от създателя ─────┐ │
│ ┌ ☐ Покани партньор ──────────────┐ │
│ ┌──────────────────────────────────┐ │
│ │☐ 🎙 Гласов чат        [VIP]      │ │  ← нов ред; иконата е Lucide "mic",
│ │  Говорете с играчите на масата   │ │    pill "VIP" = стила на "Ръчен старт"
│ └──────────────────────────────────┘ │
│ Време за изчакване  [ 15 минути ▾ ]  │
│ Време за реакция    [ 15 секунди ▾ ] │
│ [        Създай маса         ]       │
└──────────────────────────────────────┘
```
- Без VIP: редът е видим (в публичен режим). Tap върху checkbox-а не го отмята, а отваря VIP popup-а (I3).
- В режим „Само админ“: редът се вижда **само** от пълен админ.
- При капацитета: сървърът връща `voice_capacity_reached`. Показва се popup „В момента всички гласови маси са заети. Можете да създадете масата без гласов чат.“ с бутони **[Създай без гласов чат] [Отказ]**. Без автоматично създаване.
- Popup-ът е `max-height: calc(100dvh - 32px)` + scroll, така че новият ред не чупи 320×568.

### I2. Икона в лобито — светлата карта (`renderLobbyScreen.ts:14732–14749`)
Иконата е на реда на името на домакина, до pill-а „Ръчен старт“, в същото pill семейство. Само икона, без текст (≈22×20):
```
┌────────────────────────────────────────────┐
│ ТВОЯТА МАСА                                │
│ Иван Петров (Ръчен старт) (🎙)    [ ВЛЕЗ ] │ ← pill 🎙: bg #F4F0FF, border #D9CCFF, icon #6941C6
│ Вход 100 жълт. · 2/4 места · ~12 мин.      │
│  ОТБОР А        │        ОТБОР Б           │
│ [av] Иван       │  [ + ]                   │
│ [av] Мария      │  [ + ]                   │
└────────────────────────────────────────────┘
```
- Не пипа аватарите, слотовете, мета реда и бутона. Редът вече е `flex` с `min-width:0` и ellipsis на името, така че pill-ът е `flex:0 0 auto` и името се свива. Височината на картата не се променя.
- `aria-label="Гласов чат"`, `title="Гласов чат (VIP)"`.
- Същата икона се показва и в табовете „Играещи“ и „Приключили“ (по желание).
- **Три състояния:**
  1. **Гласов чат включен** → виолетов pill (MVP).
  2. **Има реално свързани** → [препоръка: **не за MVP**]. Изисква сървърът да знае живите участници (webhooks или polling към LiveKit), а заданието забранява излишно polling. При нужда по-късно: малка зелена точка `#067647` в pill-а.
  3. **Услугата временно не работи** → сив pill `#F2F4F7` / `#D0D5DD`, икона `mic-off` `#667085`, `title="Гласовият чат временно не е наличен"`. Източник е circuit breaker-ът на сървъра. Broadcast само при промяна.

### I3. VIP popup — reuse на `renderVipRequiredPopup` (namespace `voice`, `light`)
- Текстът се подава като пълно изречение, а не като `featureLabel`: „**Гласовият чат е VIP привилегия.**“ + „Слушането и говоренето са достъпни само за играчи с активен VIP.“
- Бутони:
  - В лоби или чакалня (магазинът е достъпен): **[ОК] [Вземи VIP]**. „Вземи VIP“ → `shopActiveTab='vip'` + `showShopPanel()`.
  - В игра: само **[ОК]**.
- **[НЕРЕШЕНО]** Да се показва ли и съществуващото „Вземи X дни безплатно“ (launch gift), ако профилът не го е взел?
- В играта се използва тъмният вариант на същия компонент (вече съществува 1:1).

### I4. Прозорец с трите избора (при влизане на VIP в гласова маса)
- **Чакалня (светъл):** bottom sheet ако е `(max-width:640px)`, иначе центриран.
```
┌──────────────────────────────────────┐
│  🎙  Гласов чат на масата            │
│  Говорете с играчите на тази маса.   │
│  Разговорите не се записват от       │
│  Pika.bg. (ⓘ Повече)                 │ ← P14 информиране
│ ┌──────────────────────────────────┐ │
│ │   🎙  Включи микрофона           │ │ ← violet-3d primary, 48px
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │   🎧  Само слушай                │ │ ← secondary (бяло, рамка #D0D5DD), 48px
│ └──────────────────────────────────┘ │
│            Не сега                   │ ← текстов бутон #667085, 44px hit area
└──────────────────────────────────────┘
```
- **В игра (тъмен):** същата структура в стила на settings панела (`rgba(15,23,42,.98)`, рамка `rgba(212,165,32,.45)`), primary бутон златен (`#f6d36b → #c98b1a`, като „Изход“).
- Показва се **веднъж за участие** (ключ `voiceTableId + profileId` в паметта на контролера, а за refresh в `sessionStorage`). Не се показва при re-render, раздаване или ротация.
- Ако се появи по време на твой ход, модалът блокира tap-а към картите. [ПРЕДЛОЖЕНИЕ] В игра да не се показва модално по време на собствения ход, а да изчака края му. [НЕРЕШЕНО]

### I5. Чакалня (светъл, standalone) — гласова лента
Между header-а и `.prw-waiting-actions` (над „Изчакай в лоби“) се добавя тънка бяла карта с височина 52px:
```
│ Чакалня — частна маса          ⏱ 12:40 │
│ Отворена · Залог 100 · 2/4 · 🎙 Гласов  │
├────────────────────────────────────────┤
│ 🎧 Слушаш                [🎙 Микрофон] │ ← карта: статус вляво, 1 действие вдясно (44px)
├────────────────────────────────────────┤
│ [Изчакай в лоби] [+ Покани приятели]    │
│  ОТБОР А            │       ОТБОР Б     │
│ (◎av) Иван · ТИ     │ ( av) Петър       │ ← ◎ = speaking ring (#067647), mute badge горе вляво
```
- Лентата има едно основно действие според състоянието (Включи се / Микрофон / Включи микрофона). Менюто „⋯“ (44px) съдържа „Напусни гласовия чат“ и „Само слушай“.
- **[НЕРЕШЕНО]** „Изчакай в лоби“ при активен глас: (а) връзката остава + компактен pill в лоби рамката, или (б) гласът се спира и при връщане се предлага отново. Препоръка: (б) за MVP. Лоби рамката е сложна (горна и долна навигация) и не искам там нов плаващ елемент без одобрение.

### I6. Игрален екран (тъмен) — **основното предложение**
[ФАКТ] Мобилната долна лента ([renderActiveRoomActionBar.ts:89](../../src/app/activeRoom/renderActiveRoomActionBar.ts#L89)) е черна, височина 50px (`ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT`):
- „Изход“ на 16–104px, ⚙️ на 112–152px (невидима tap зона 40px);
- вдясно: „Фрази“ (`right:64px`, 40px кръг) и „Емоджи“ (`right:18px`, 40px кръг), бутоните са `fixed` с `bottom:5px`, тъмен фон и рамка `rgba(212,165,32,.8)`.
- Свободната зона е от 152px до `W − 104px`: **134px при 390px, 104px при 360px, 64px при 320px**.

**Предложение M1 (препоръка):** един кръгъл гласов бутон 40px в стила на „Фрази“ и „Емоджи“, вдясно в групата за комуникация, на 8px от „Фрази“ → `right:112px` (заема `[W−152, W−112]`).
```
360px:
┌────────────────────────────────────────────────────────────┐
│ [ Изход ] ⚙                (🎙)   (💬)  (😀)              │ 50px, #000
└────────────────────────────────────────────────────────────┘
  16    104 112 152         208 248 256 296 302 342
320px: Изход 16–104 · ⚙ 112–152 · 🎙 168–208 · 💬 216–256 · 😀 262–302  (16px до ⚙)
```
- Никой съществуващ бутон не се мести.
- Hit area 44×48 (невидимо разширение, като ⚙️), визуално 40px.
- Иконата и пръстенът показват състоянието (I8).
- **Tap отваря компактен гласов панел** (не превключва директно). Така случаен tap не включва и не изключва микрофона. Панелът има прозрачен backdrop, както settings панела: **първият tap извън него само го затваря и не стига до картите**.
```
                         ┌──────────────────────────┐
                         │ Гласов чат        ● Свързан│
                         │ Микрофон      [  Вкл.  ]  │ ← pill стил renderGameSoundsToggleState
                         │ 🎧 Слушаш без микрофон    │   (зелено #22c55e / червено #ef4444)
                         │ ───────────────────────── │
                         │ Напусни гласовия чат      │ ← текст, червено; масата остава
                         └──────────────────────────┘
 [ Изход ] ⚙                (🎙)   (💬)  (😀)
```
- Панелът е подравнен вдясно (`right:16px; bottom:58px; width:min(280px, 100vw−32px)`), огледално на settings панела, който е вляво.
- Отварянето му затваря emoji и phrase picker-ите, както те се изключват взаимно сега.
- **Алтернатива M2:** tap директно превключва mute, а панелът се отваря с long-press или малка стрелка. По-бързо е, но с риск от случайно превключване и по-лошо откриване. Не я препоръчвам за MVP.
- Във фазите scoring и match-ended бутонът **остава видим** (емоджитата се крият), защото разговорът продължава.

### I7. Индикации на аватара (тъмна маса) — без нови layout елементи
[ФАКТ] Avatar кутията е `[data-profile-seat-btn]` (бяла, радиус 18 и 16). Level badge е долу вдясно. Dealer badge е в долния ъгъл на панела. Gift иконата е встрани или над панела. Текущият ход се маркира със **златна** рамка и glow (`rgba(245,187,55,.96)`).
- **Говори:** зелен пръстен 3px `#22c55e` с мек glow около avatar кутията. Реализация: `::after` с `opacity` transition (compositor-only, без repaint на панела). Различим е от златния „на ход“ и не променя размера.
- **Заглушен:** badge 22px **горе вляво** на avatar кутията (единственият свободен ъгъл) — тъмен кръг с червен `mic-off`.
- **Само слуша:** същият слот, неутрален `headphones` (сиво-бял).
- **Не е в гласовия чат:** нищо (без визуален шум).
- **Свързване или reconnect (само за теб):** на гласовия бутон, не на аватара.
- Атрибути `data-voice-state="speaking|muted|listening"` върху `[data-seat-profile-card]`, плюс един глобален `<style>`. Speaking промените пипат **само атрибута** (`setAttribute`), без render. След всеки `renderActiveRoomScreen` контролерът вика `reapply()` (O(4)).
- Гарантирано без застъпване с картите: нищо не излиза извън съществуващата кутия, а пръстенът е в нейните 3px отвън, в padding-а на панела.

### I8. Гласовият бутон — всички състояния (тъмна маса)

| Състояние | Икона | Пръстен / акцент | Текст в панела |
|---|---|---|---|
| Наличен, не си включен | `mic` със „+“ (outline) | златна рамка (като фразите) | „Включи се“ (2 бутона: микрофон / слушай) |
| Свързване | `mic` + въртяща се дъга | — | „Свързване…“ |
| Само слушай | `headphones` | синьо-сив | „Слушаш“ + [Включи микрофона] |
| Микрофон вкл. | `mic` (плътна) | зелен `#22c55e` | „Микрофонът е включен“ [Изкл.] |
| Говориш | `mic` | зелен пулсиращ glow | — |
| Заглушен | `mic-off` | червен `#ef4444` | „Микрофонът е изключен · все още чуваш“ |
| Reconnect / възстановяване | `mic` + пунктирана дъга | кехлибарен `#f59e0b` | „Възстановяване на връзката…“ |
| Отказан permission | `mic-off` + „!“ | кехлибарен | инструкция за разрешаване + „Продължи само да слушаш“ |
| Няма устройство | `mic-off` + „!“ | кехлибарен | „Не е открит микрофон“ |
| Сървърът е недостъпен | `mic-off` (сив) | сив | „Гласовият чат временно не е наличен“ + [Опитай отново] |
| Звукът е блокиран (autoplay) | `volume-x` | кехлибарен | „Натисни, за да чуваш“ (tap → `startAudio`) |

**Изрично:** в панела mute е „Микрофон: Вкл./Изкл.“, а „Напусни гласовия чат“ е **отделен** червен текстов бутон. Така е ясно, че mute ≠ напускане.

### I9. Отказан permission / липсващо устройство — текстове
- Отказан: „Pika.bg няма достъп до микрофона. Разрешете го от настройките на браузъра (🔒 до адреса → Микрофон) и опитайте пак. Можете да продължите само да слушате.“
- Няма устройство: „Не е открит микрофон. Свържете слушалки с микрофон или продължете само да слушате.“
- In-app браузър (Facebook, Instagram): „Гласовият чат може да не работи във вградения браузър. Отворете Pika.bg в Chrome или Safari.“ [ПРЕДЛОЖЕНИЕ: откриване по UA, само съвет]

### I10. Landscape на телефон
- Долната лента е същата, а свободната зона е по-широка. Панелът е `max-height: calc(100dvh − 66px)` със scroll. Prompt-ът е центриран с `max-height`.

### I11. Screenshots
- **Не съм ги направил.** Реален screenshot на игралния екран изисква пуснат backend (`tsx watch` прилага миграции и пише в локалната база и логове), вход с профил и стартирана маса. Това е в разрез с „не променяй базата и файловете“.
- Предлагам в началото на Етап 4, с твое разрешение, Playwright screenshots на 320×568, 360×800, 390×844, 430×932 и 844×390 за всички фази. Проектът вече има такава инфраструктура (`scripts/checkGuestMobileLobby.ts` + fixtures). Схемите по-горе са от реалните координати в кода.

---

## J. Desktop [ПРЕДЛОЖЕНИЕ]
- [ФАКТ] Desktop action bar: долу вляво (`left:18, bottom:24`, flex gap 6): „Изход“ (52px) + ⚙️ (52px tap зона). Емоджи и фрази са 80px кръгове долу вдясно (`right:16` / `right:108`), мащабирани със `stageScale`.
- **Игра:** гласов бутон **след ⚙️** в същия flex (52px, в стила на ⚙️: икона без фон, злато `#f6d36b`; състоянието е цветен пръстен около иконата). Нищо не се мести, защото бутонът се добавя накрая. Панелът се отваря над лентата (`placement 'desktop'`, като settings). Индикациите на аватарите са същите като I7.
- **Лоби и чакалня (тъмни desktop варианти):** същото място на иконата (до „Ръчен старт“) в тъмния pill стил (`rgba(167,139,250,.14)` / `#a78bfa`). В тъмния вариант на прозореца за създаване се добавя label ред като останалите три. Гласовата лента в desktop чакалнята е над отборите.
- Поведението и правата са идентични, различава се само визията.

---

## K. Схеми
Виж I1, I2, I4, I5, I6 по-горе. Screenshots — I11.

---

## L. Админ интерфейс [ПРЕДЛОЖЕНИЕ]
Нова секция „Гласов чат“ в админ менюто (до „Персонализация“, само пълен админ), overlay `showAdminVoiceChatPanel` по шаблона на `showAdminProfileCustomizationPanel`.

**Управление:**
- Режим: Изключен / Само админ / Активен (SQLite + audit история кой и кога). Авариен стоп `VOICE_CHAT_ENABLED=0` от env има приоритет.
- Лимит на едновременните гласови маси (default 10), без deploy.
- Показва „LiveKit конфигурация: налична / липсва“ (само дали env е подаден, **никога** стойностите).

**MVP показатели:**

| Показател | Източник | Вид |
|---|---|---|
| Състояние на услугата (OK / деградирала / недостъпна) | circuit breaker + последен успешен API call | актуално |
| Активни гласови маси / лимит | Pika (in-memory + DB) | актуално |
| Активни LiveKit стаи, участници, публикуващи | `ListRooms` / `ListParticipants` [LK], само при отворен панел, ≥15 s | актуално |
| Издадени и отказани токени (по причина) | in-memory броячи от старта на процеса | натрупващи се броячи |
| Неуспешни свързвания, reconnect-и | клиентски отчети (F1 `voiceDiagnostics`) | броячи |
| Ротации, `delete_pending` | Pika | актуално + брояч |

**Втори етап (не MVP):**
- Packet loss, jitter, RTT, direct/TURN: от клиентските `getStats()` отчети. Това е **клиентска** статистика, не сървърна, и се показва агрегирана (медиана / p95 за 24 ч).
- CPU, RAM, CPU steal на гласовия VPS: Node Exporter (`node_cpu_seconds_total{mode="steal"}` е стандартна метрика).
- Сървърни LiveKit метрики: **имената трябва да се видят** с `curl 127.0.0.1:6789/metrics` от собственика. Не измислям имена.
- Безопасен път до игровия backend [НЕРЕШЕНО, изисква промяна в инфраструктурата]:
  - (а) Caddy route на гласовия VPS с **mTLS или Bearer + IP allowlist (само IP на игровия VPS)**, който проксира *филтриран* `/metrics`;
  - (б) SSH туннел (autossh) от игровия VPS;
  - (в) нищо и dashboard без VPS метрики.
  - Препоръка: (а) след MVP.

---

## M. Database промени [ПРЕДЛОЖЕНИЕ]
Една миграция `server/database/migrations/2026MMDD_001_create_voice_chat.sql`:
```sql
-- режим (audit; без записи -> 'off')
CREATE TABLE voice_chat_mode_changes (
  change_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('off','admin_only','public')),
  previous_mode TEXT, changed_by_profile_id TEXT, changed_by_display_name_snapshot TEXT,
  changed_at TEXT NOT NULL);
-- гласова маса (слот от лимита)
CREATE TABLE voice_tables (
  voice_table_id TEXT PRIMARY KEY, private_room_id TEXT NOT NULL, server_room_id TEXT,
  creator_profile_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','ended')),
  current_generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);
CREATE INDEX idx_voice_tables_status ON voice_tables(status);          -- COUNT за лимита
CREATE INDEX idx_voice_tables_server_room ON voice_tables(server_room_id);
-- генерации (никога не преизползвано име)
CREATE TABLE voice_room_generations (
  livekit_room_name TEXT PRIMARY KEY, voice_table_id TEXT NOT NULL, generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live','retiring','retired','delete_pending')),
  created_at TEXT NOT NULL, retired_at TEXT, retire_reason TEXT, delete_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (voice_table_id, generation));
INSERT OR IGNORE INTO admin_settings (setting_key, setting_value) VALUES ('voice_chat_max_tables','10');
```
- Писане само при създаване, старт, ротация и край (ниска честота). При издаване на токен **няма** запис.
- Без аудио, без съдържание, без IP.
- `ServerRoomConfig.voiceTableId?: string` влиза в съществуващия JSON snapshot (без нова колона). `PrivateRoom.voiceTableId` е in-memory.
- Таблиците не растат неограничено. [НЕРЕШЕНО] Политика за чистене на `ended` записи, например по-стари от 90 дни при boot.

---

## N. SDK зависимости (проверено в npm registry днес, без инсталация)
- **Frontend:** `livekit-client` **2.24.0** (deps: `@livekit/protocol` 1.53.0, `jose`, `webrtc-adapter` 9.0.6, `sdp-transform`, …). Само `import()` → отделен chunk.
- **Backend:** `livekit-server-sdk` **2.19.3** (`engines.node >= 19`; Node v24 е OK; deps: `jose` ^5, `@livekit/protocol` 1.53.0, `@bufbuild/protobuf`).
- Съвместимост със сървър v1.13.11: SDK v2 работи с протокола на v1.x сървърите. **[ПРОВЕРКА в Етап 2]** Release notes на v1.13.x и changelog на SDK-тата за минимална версия на сървъра. Точна pin версия (без `^`) и в двата `package.json`.
- [ПРОВЕРКА] Реалният gzip размер на lazy chunk-а след build, с цел да се отчете в Етап 3.

---

## O. Рискове и edge cases

**Мобилни браузъри (не обещавам повече от това, което платформата позволява):**
1. **iOS Safari, фонов режим и заключване:** WebKit спира JS. Capture от микрофона и възпроизвеждането обикновено спират или се заглушават. Връзката може да умре. **Не може да се гарантира** разговор със заключен телефон. При връщане: проверка на `room.state` и състоянието на track-а (`track.mediaStreamTrack.muted/readyState`), без втора връзка.
2. **Входящо обаждане:** OS поема аудио сесията. След разговора capture може да **не се възстанови сам** (track остава `muted` или `ended`). Показваме „Микрофонът е прекъснат — натисни, за да го включиш отново“ и не рестартираме сами без действие.
3. **Наблюдаваният проблем при първия тест** (звукът се оправи след mute/unmute): кандидати са iOS аудио сесия / AEC startup, Android Bluetooth route или encoder start. **Не приемам за решен.** Мерки:
   - клиентска диагностика (bytesSent и audioLevel на изходящия track за първите 10 s);
   - ръчна опция „Рестартирай микрофона“ в панела (`restartTrack`);
   - отделен regression сценарий (R).
4. **Autoplay:** „Само слушай“ изисква gesture (F4). При refresh няма автоматичен звук.
5. **Слушалки и Bluetooth:** маршрутизацията е на OS. `setSinkId` не е наличен навсякъде, затова **не предлагам** избор на изход в MVP. При `devicechange` → `restartTrack` за входа.
6. **Ехо:** браузърният AEC обикновено помага, но 4 отворени микрофона на високоговорител дават риск. Съвет „Препоръчваме слушалки“ в prompt-а. Няма push-to-talk в MVP. [НЕРЕШЕНО]
7. **Игрови звуци + WebRTC на iOS:** при активен capture iOS може да намали звука на `HTMLAudioElement` (игровите звуци са такива, `createGameAudioController.ts`) или да смени маршрута. Само тест на устройство ще покаже.
8. **Wi-Fi ↔ мобилни данни:** [LK] ICE restart и reconnect. Кратко прекъсване, показваме „Възстановяване…“.
9. **In-app браузъри и стари WebView:** `getUserMedia` може да липсва.

**Архитектурни:**
10. Production nginx `Permissions-Policy` / CSP (B11) може тихо да блокира микрофона.
11. PM2 топология (B8).
12. Backend restart: прекъсване 1–2 s за всички гласови маси заради ротацията при boot. Чакалните маси така или иначе се губят.
13. Caddy L4 + TURN на 443: [ПРОВЕРКА] корпоративни мрежи с TLS inspection. Не е тествано с външни потребители (както сам отбелязваш).
14. `empty_timeout: 120` [LK]: стая, създадена без влизане до 120 s, се затваря. Следващият токен я създава отново (H4). Безопасно е, но трябва тест.
15. Капацитетът е тестван синтетично на същия VPS с генератора (около 35% CPU извън LiveKit) и CPU steal до 18%. Лимит 10 е консервативен и разумен.
16. Speaking индикаторът при reconnect: изчиства се при `Disconnected`/`ParticipantDisconnected`, иначе остава „фантомен“ пръстен.
17. Дублирани audio елементи при ротация: sink-ът е keyed по `trackSid`, а при смяна на `Room` се чисти изцяло преди новото свързване.
18. Модалът по време на собствен ход (I4).
19. **Гост в частна маса:** [ФАКТ] `create_private_room` изисква профил. Join също трябва да се провери. Без профил няма VIP, значи и токен.
20. Самоизтриване на профил: профил с подадена заявка все още може да играе. Гласът го третира като обикновен профил, а банът е отделно (G3).

---

## P. Нерешени продуктови въпроси (за одобрение)

1. **„Само админ“:** препоръчвам посоката ти — само пълен админ може да **създаде** гласова маса. Останалите участници са VIP, иначе стандартният popup. Алтернатива: в този режим токен получават само админи (по-тесен тест, без реални участници). Препоръка: твоят вариант.
2. **Админ като играч без VIP:** Препоръка: **същото VIP правило** (прецедентът „Гледай“ е без role bypass). Админът може да си даде VIP с „admin_grant“ за тестовете.
3. **VIP изтича по време на мач:** правото се проверява при издаване на токен и при всяка граница на мача (повторна игра). По време на мача **не** се прекъсва (твоята идея). При повторна игра без VIP: ротация без него, като той продължава да играе без глас. Резервен вариант при reconnect по средата на мача с изтекъл VIP: [НЕРЕШЕНО] разрешаваме (вече е бил член в този мач) или отказваме. Препоръка: разрешаваме само ако е получил токен в същия мач (in-memory `issuedIdentities`).
4. **Бот замества временно:** гласът остава, правото не се отнема.
5. **Повторна игра със същите хора:** същата стая, без прекъсване.
6. **Смяна на участник:** ротация (само ако напусналият е имал токен).
7. **Кога се ротира:** по H2 и G3 — отнемане на право, бан, boot. Не при присъединяване.
8. **Капацитет за неактивна маса:** за целия живот на масата (E5), или освобождаване след N минути без участници.
9. **Може ли създателят да променя гласа след създаване:** препоръка **не за MVP**. Изборът е само при създаване, като „Време за реакция“, което също е неизменимо.
10. **Админът изключва функцията при активни разговори:** (а) незабавно прекратяване на всички (DeleteRoom), или (б) нови не се разрешават, текущите продължават до края на масата. Препоръка: „Изключен“ = (а), „Само админ“ = (б) за неадминските маси. Авариен стоп = (а).
11. **Отпадане на игровия WebSocket при жива LiveKit връзка:** граничен срок, след който клиентът сам напуска гласа (H5). Предложение: 120 s. Това е компромис между непрекъснатост и сигурност.
12. **Два таба / две устройства:** последният печели (displacement + DUPLICATE_IDENTITY), изместеният не прави rejoin.
13. **Chat mute санкции и глас:** препоръка — независими в MVP. Банът обаче винаги прекратява гласа. Може би е нужна отделна бъдеща санкция „гласов mute“.
14. **Информиране на потребителите:** кратък текст в prompt-а при първото включване („Разговорите се предават през гласовия сървър на Pika.bg и не се записват. Другите участници могат да ги запишат от своите устройства.“) + линк към условията. [НЕРЕШЕНО] Нужна ли е промяна в Общите условия и Политиката за поверителност (юридически въпрос извън кода)?
15. **Браузърни ограничения, които не можем да решим:** заключен телефон, фонов режим на iOS, обаждане, избор на изходно устройство, in-app браузъри, autoplay без tap.

**Допълнителни въпроси, открити при анализа:**

16. Глас в **чакалнята** или само в **играта**? Заданието предполага и чакалнята. Препоръка: да, от сядането.
17. „Изчакай в лоби“ при активен глас (I5).
18. Refresh: автоматично свързване или бутон „Възстанови“ (G3)?
19. Launch gift в гласовия VIP popup (I3)?
20. „Към лобито“ на финала = напускане на гласа (G3)?
21. Изглед на гласа в игра: тъмен игрови език (I0 — противоречие със заданието).
22. Prompt-ът по време на собствения ход (I4).
23. „Инкогнито режим“ — кой механизъм (B11)?
24. `stopMicTrackOnMute` (F5) и вариант А или Б за „Само слушай“ (E3).
25. Webhooks от LiveKit към Pika: изискват промяна в LiveKit конфигурацията. Препоръка: не за MVP (H5).

---

## Q. План за имплементация (уточнен спрямо реалния код)

Всеки етап изисква изрично одобрение. Следващият не започва автоматично.

| Етап | Съдържание | Критерии за приемане |
|---|---|---|
| **1** (сега) | Анализ, архитектура, визия, въпроси | Одобрени отговори на P |
| **2а** Backend основа | `server/src/voice/` (store, флаг, режим, лимит), миграция, `voiceEligibility` (чиста функция), админ API (режим и лимит), **без LiveKit** | Unit проверки на eligibility матрицата; атомарен лимит при конкурентни заявки; flag off → нулево поведение; `tsc` чисто |
| **2б** LiveKit интеграция (backend) | `livekitApi` (timeout, concurrency, breaker), токени, ротация, reconciliation, куки в index.ts | Тестове срещу **fake Twirp сървър**: timeout, 5xx, бавен отговор, breaker, ротация, стари генерации, boot; ръчен тест с реалния LiveKit от `curl` (от собственика) |
| **3** Voice controller (frontend, без UI полиране) | lazy SDK, state machine, audio sink, permissions, reconnect, cleanup, диагностика; минимален временен debug бутон зад админ флаг | Два desktop таба (различни профили): connect, listen, mute, rotation, leave; нула дублирани audio елементи и listeners (DevTools memory snapshot); chunk извън precache |
| **4** Мобилен UI | лоби, създаване, popup-и, чакалня, игрален бутон и панел, индикатори, всички състояния | Playwright screenshots (I11) на 5 viewport-а × всички фази и състояния; одобрение на всеки екран от теб; touch regression (B12) |
| **5** Desktop UI | същото, desktop език | Screenshots 1280×800, 1366×768, 1920×1080 |
| **6** Админ dashboard + failure handling | MVP показатели (L) | LiveKit изключен → сайтът и играта работят нормално; dashboard показва „недостъпна“ |
| **7** Интеграция и реални устройства | R | Чеклистът в R е подписан |
| **8** Внедряване | S | Постепенно активиране |

---

## R. Тестов план

**Backend (tsx check скриптове, по шаблона на проекта):**
- Eligibility матрица:
  - режим off / admin_only / public × VIP / non-VIP;
  - участник / зрител / бот / админ-зрител / чужда маса / напуснал (`permanentlyLeftAt`) / изгонен;
  - маса без глас; генерация retiring.
- Лимит:
  - 20 паралелни create при лимит 10 → точно 10 гласови;
  - намаляване на лимита при активни маси;
  - освобождаване на слота при изтичане, затваряне, старт → край и рестарт.
- LiveKit API (fake сървър):
  - timeout, 500, бавен отговор, connection refused;
  - breaker open → бърз 503, без мрежови заявки;
  - half-open; опашката е ограничена;
  - retry само за идемпотентните операции.
- Ротация:
  - стари генерации никога не се издават; конкурентни join и leave;
  - DeleteRoom fail → `delete_pending` → reconciler → retired;
  - boot reconciliation (сираци `pv_*`).
- Webhook (ако се одобри): валиден, невалиден подпис, дублиран, закъснял.
- Регресии:
  - частна маса **без** глас → идентичен snapshot (освен полето `voice: {enabled:false}`);
  - случайни маси и турнири → нито една voice функция не се вика (spy).

**Frontend:**
- Flag off → лобито, прозорецът за създаване и играта са визуално идентични (screenshot diff спрямо baseline).
- Създаване с и без глас; VIP popup (лоби с „Вземи VIP“, игра само с „ОК“); капацитет → „Създай без гласов чат“.
- Трите избора, показвани веднъж (re-render, раздаване, повторна игра не ги показват отново).
- Listen-only без permission prompt (spy на `getUserMedia`); mute/unmute; отказан permission; липсващо устройство.
- Join failure / 503 → правилно състояние, backoff, без retry storm.
- Ротация → без дублирано аудио (броят `<audio>` е ≤ броя отдалечени tracks).
- Speaking индикатори: 4 едновременно; изчистване при disconnect.
- Напускане на гласа ≠ напускане на масата; напускане на масата → пълен cleanup (listeners, timers, tracks: 0).

**Мобилни визуални тестове (Playwright, `hasTouch`):**
- 320×568, 360×800, 390×844, 430×932, 844×390.
- Фази: cutting, dealing, bidding (popup-ът за обявяване), playing, scoring, match-ended; с отворени settings, emoji и phrase picker-и; 4 активни speaking индикатора; всички 11 състояния на бутона.
- Проверка за застъпване с bounding box-ове: гласовият бутон и панел срещу картите, „Изход“, ⚙️, фразите, емоджитата, score HUD-а, иконата за зрители, bid popup-а.
- **Touch regression:** скриптът `b4f2271` („reliable card play and bid input on mobile“) да се пусне отново с активен глас.

**Реални устройства (задължително, unit тестовете не са доказателство):**
- Android Chrome, iPhone Safari, Desktop Chrome и Edge (+ Firefox по желание).
- Сценарии:
  - 4 говорят едновременно; 1 говори, 3 слушат; всички заглушени;
  - слушане без permission; отказ → разрешаване;
  - Wi-Fi ↔ 4G; обаждане; заключване и отключване; фон → преден план;
  - жични слушалки, Bluetooth (свързване по време на разговор), mute/unmute;
  - reconnect, refresh;
  - 3+ раздавания и повторна игра; смяна на участник;
  - LiveKit спрян от собственика по време на игра (играта продължава без забавяне).
- **Специален сценарий — първото включване на микрофона на iPhone и Android (10 повторения):** чист ли е звукът от първата секунда, или трябва mute/unmute? Записва се bytesSent и audioLevel от диагностиката.
- Ехо: два телефона на високоговорител в една стая.

**Performance:**
- Главният bundle не се променя (±1 KB); voice chunk извън precache.
- Long tasks при отворена игра с и без глас (Performance panel).
- Heap след 30 мин игра с глас.
- Батерия: 30 мин на Android с глас и без (грубо сравнение).

---

## S. Deployment и rollback (без изпълнение)
1. Backend deploy (`scripts/deploy-backend-production.sh`, със съществуващия migration backup flow). Миграцията е само добавяща. **Режимът по подразбиране е `off`** (без записи → off). Env:
   - `LIVEKIT_API_URL=https://voice.pika.bg`, `LIVEKIT_WS_URL=wss://voice.pika.bg`;
   - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (само в `server/.env` на сървъра, никога в Git или frontend);
   - `VOICE_CHAT_ENABLED` (липсващо = нормална работа по режима, `0` = авариен стоп).
2. Frontend deploy (`scripts/deployFrontendAtomic.sh`). При режим `off` UI-ят е идентичен.
3. Проверка: `nginx -T` за Permissions-Policy и CSP (B11) — само четене.
4. Режим „Само админ“ → тест с информирани участници (VIP).
5. „Активен“ с лимит 10 → наблюдение → евентуално увеличение.

**Rollback (по нива, от най-бързото):**
- (1) Режим „Изключен“ от админа, без deploy.
- (2) `VOICE_CHAT_ENABLED=0` + рестарт на процеса.
- (3) `deployFrontendAtomic.sh --rollback`.
- (4) Backend към предишен commit. Миграцията е добавяща, таблиците остават неизползвани и не пречат.

LiveKit инфраструктурата не се пипа при нито една стъпка.

---

## T. Гаранция, че недостъпен LiveKit не забавя играта
1. **Нито една игрова операция не зависи от LiveKit.** Създаването на маса, join, старт, ход, повторна игра и премахване на стая правят само синхронни in-memory и SQLite стъпки. Гласовите API заявки са `void`-нати promise-и в отделна bounded опашка.
2. Game worker-ите не знаят за гласа.
3. Timeout 3 s, най-много 4 паралелни заявки, опашка до 50, circuit breaker 30 s: при спрян VPS след 5 неуспеха системата **спира да опитва** и отговаря на `/api/voice/token` веднага с 503.
4. Клиентът: backoff 2 → 4 → 8 → 30 s (+ jitter), най-много N автоматични опита, после само ръчно „Опитай отново“. Без retry storm.
5. Клиентският SDK се зарежда само при изрично действие. Speaking и audio levels никога не минават през игровия WebSocket. Индикаторите пипат само атрибути (без render).
6. **Приемен тест в Етап 6:** гласовият VPS е недостъпен (iptables drop от собственика или грешен URL в staging), 4 маси се играят 15 мин. Не трябва да се вижда разлика в event loop lag (съществуващият `eventLoopHealth` мониторинг), във времената на ходовете и в `mainThreadTimingMetrics`.
