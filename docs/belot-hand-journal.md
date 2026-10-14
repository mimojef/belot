# Belot hand журнал — диагностика на всяко раздаване

Постоянен, структуриран сървърен журнал, от който може да се възстанови и провери всяко раздаване в Белот, включително „Долу картите“.

Кодът е в `server/src/diagnostics/belotHandJournal/`. Тестовете са в `server/scripts/checkBelotHandJournal.ts` (`npm run check:belot-hand-journal`).

## Къде се пази

| Какво | Път (спрямо `server/`) |
|---|---|
| База (SQLite, WAL) | `database/diagnostics/belot-hand-journal.sqlite` |
| Архиви (gzip JSONL, един файл на UTC ден) | `database/diagnostics/belot-hand-journal-archive/belot-hand-journal-YYYY-MM-DD-<ts>.jsonl.gz` |

- Базата е отделна от основната `database/data/belot-v2.sqlite`, затова не влиза в бекъпите и не се конкурира за lock с gameplay таблиците.
- Директорията е в `.gitignore`.
- Не е нужна миграция: схемата се създава автоматично при първия старт.
- Схемата има версия: колоната `schema_version` на всеки ред и `belot_hand_journal_meta.schema_version` (текущо `1`).

## Какво се записва

| Събитие | Кога | Съдържание |
|---|---|---|
| `hand_started` | при първото раздаване (deal-first-3) | мач, раздаване, 4-мата играчи (place, team, profile_id, име, човек/бот), раздавач/цепач/позиция на цепене, **всички 32 карти по места**, резултат и висящи точки преди |
| `bidding_completed` | край на наддаването | всички обяви по ред, договор, коз, изпълнител, контра/реконтра, ръцете при наддаването |
| `hand_redeal` | всички пас | причина, непроменен резултат |
| `trick_completed` | всяка взятка | водещ, 4-те карти по ред с източник (`human_manual`, `human_timeout_auto`, `bot_original`, `bot_takeover`), победител, точки, анонси в тази взятка, натрупано до момента |
| `sweep_offered` | предложение „Долу картите“ | кой, при коя взятка, **оставащите ръце на четиримата**, изиграните взятки, точки до момента, защо е допуснато (правило + условия) |
| `sweep_declined` | отказ | `player` / `timeout_auto_decline` / `bot_auto_decline`, колко ms преди изтичане |
| `sweep_accept_rejected` | отхвърлено решение | кой, причина, повторна проверка |
| `sweep_accepted` | прието | ръцете в момента на приемане, присъдените взятки и точки, автоматично зачетени белоти |
| `hand_scored` | точкуване | пълна разбивка (виж по-долу), приложения резултат и проверките |
| `hand_abandoned` | раздаване без точкуване (нова игра/нулиране) | фаза, изиграни взятки, оставащи ръце |
| `match_ended` | край на мача | победител, краен резултат |
| `anomaly` | при неуспешна проверка | тип, детайли, данни за разследване |

### Разбивка на точкуването (`hand_scored.payload.explanation`)

- По отбор: взятки, точки от карти, бонус за последна взятка, ×2 при „Без коз“, капо бонус, сурови точки.
- Анонси и белоти (сурови), отделно каре/последователности/белот (`declarationGroups`).
- Изход (`made` / `inside` / `tie`), точки на изпълнителя и защитата.
- Клон на правилата (`official.ruleBranch`), например:
  - `made_points_split_by_rounding`
  - `inside_all_points_to_defenders`
  - `tie_equal_split_bidder_points_held`
  - `made_with_counter_all_points_to_bidder_team`
- Закръгляне: праг (6 при коз, 5 при „Без коз“, 4 при „Всичко коз“), закръглени стойности и корекция.
- Множител при контра/реконтра: преди и след.
- Висящи точки:
  - стойност преди;
  - на кого отиват и защо (`owner_team_won_round` / `owner_team_did_not_win_round`);
  - стойност след и причина.
- Общ резултат преди и след.

Разбивката се изчислява от същия код като реалното точкуване (`explainServerScoring` в `serverScoring.ts`) и се сравнява с вече приложения резултат.

## Автоматични проверки

Проверките никога не променят резултата. Всяка неуспешна проверка се записва и като отделно `anomaly` събитие, а в PM2 лога се появява ред `[belot-hand-journal] anomaly type=...`.

| Тип аномалия | Проверка |
|---|---|
| `deal_integrity` | раздаването има точно 32 различни карти от пълното тесте, по 8 на място |
| `card_not_in_hand`, `illegal_card_play` | изиграната карта е била в ръката и е легална |
| `trick_winner_mismatch`, `trick_sequence_invalid` | победителят е преизчислен, редът на игра е правилен, водещият е предишният победител |
| `hand_cards_integrity` | при точкуване всички 32 карти са изиграни точно веднъж; „Долу картите“ присъжда точно оставащите карти |
| `raw_points_total_invalid` | сумата на суровите точки = 162 / 260 / 258 (+ капо) |
| `raw_vs_awarded_unexplained` | всяка начислена точка е обяснена от клона на правилата |
| `capot_misapplied` | капо бонусът е само за отбор с 8 взятки |
| `carry_over_misapplied` | висящите точки са използвани точно веднъж и новите следват правилото |
| `scoring_recompute_mismatch`, `match_total_mismatch` | независимо преизчисление = приложеното |
| `duplicate_hand_scoring` | раздаване точкувано повторно (напр. след рестарт); пази се таблица `belot_hand_journal_scored_hands` |
| `unexplained_match_score_change` | общият резултат или висящите точки се променят без точкуване |
| `client_snapshot_mismatch` | резултатът в snapshot-ите към 4-мата играчи и към зрител = сървърния |
| `sweep_recheck_failed` | структурните условия на предложението/приемането |

Пълната гаранция за „Долу картите“ се изчислява от engine-а при офертата и отново при приемането. Журналът не я повтаря в реално време, защото търсенето отнема до десетки ms. Независимо офлайн преизчисляване от записаните ръце се пуска с `--verify-sweeps`.

## Извличане от VPS

Пътят по-долу е пример (`DEPLOY_ROOT` по подразбиране). Използвай реалния път на сървъра.

```bash
cd /var/www/belot-v2/server

# Всички раздавания в една стая (четим отчет)
npm run -s diagnostics:belot-hands:prod -- --room=<roomId>

# Конкретен мач / раздаване
npm run -s diagnostics:belot-hands:prod -- --match='<roomId>@<startedAt>'
npm run -s diagnostics:belot-hands:prod -- --hand=h_<id>

# Всички раздавания на профил за период
npm run -s diagnostics:belot-hands:prod -- --profile=<profileId> --since=2026-10-01 --until=2026-10-15

# Само аномалиите за последните дни
npm run -s diagnostics:belot-hands:prod -- --anomalies --since=2026-10-10

# Пълни данни (JSON) за прикачване/анализ + офлайн проверка на „Долу картите“
npm run -s diagnostics:belot-hands:prod -- --room=<roomId> --format=json --verify-sweeps > room.json

# Включи и архивите (по-стари от 30 дни)
npm run -s diagnostics:belot-hands:prod -- --profile=<profileId> --archives --since=2026-06-01
```

- `roomId` и `profileId` се виждат в админ панела и в PM2 логовете (`[gameplay-audit]` редовете съдържат `roomId`).
- CLI-то отваря базата само за четене и може да се пуска, докато сървърът работи.
- Директно с SQLite: `sqlite3 database/diagnostics/belot-hand-journal.sqlite "SELECT occurred_at_ms, event_type, payload_json FROM belot_hand_journal_events WHERE room_id='<roomId>' ORDER BY id"`.
- Архив: `zcat database/diagnostics/belot-hand-journal-archive/belot-hand-journal-2026-09-10-*.jsonl.gz | grep '<roomId>'`.

## Задържане, размер, архивиране

Поддръжката тръгва 2 минути след старта и след това на всеки 6 часа, извън gameplay пътя. Настройва се с env променливи:

| Env | По подразбиране | Значение |
|---|---|---|
| `BELOT_HAND_JOURNAL_ENABLED` | вкл. (`0` изключва) | включване на журнала |
| `BELOT_HAND_JOURNAL_RETENTION_DAYS` | 30 | след толкова дни редовете се архивират и трият от базата |
| `BELOT_HAND_JOURNAL_MAX_DB_MB` | 2048 | при надвишаване най-старите дни (без днешния) се архивират по-рано |
| `BELOT_HAND_JOURNAL_ARCHIVE_RETENTION_DAYS` | 180 | архивите се трият след толкова дни |
| `BELOT_HAND_JOURNAL_MAX_ARCHIVE_MB` | 1024 | общ лимит за архивите (най-старите се трият първи) |
| `BELOT_HAND_JOURNAL_DIR` | `server/database/diagnostics` | алтернативна директория |

Ориентировъчен обем: около 14 KB на изиграно раздаване в базата (около 1.5–2 KB компресирано в архив). Например 3 600 раздавания на ден са около 50 MB на ден и около 1.5 GB за 30 дни.

## Надеждност и производителност

- Изпълнява се в главната нишка при всеки commit на authoritative state: директни действия на играчите (`commitServerRoomReplacement`) и worker tick-ове (`applyAcceptedGameWorkerCandidate.onApplied`).
- Само чете state-а (diff prev → next) и слага събитията в опашка.
- Записът е една SQLite транзакция на event-loop оборот (`setImmediate`). WAL + `synchronous=NORMAL`.
- При PM2 restart/stop опашката се записва синхронно преди затваряне. При crash на процеса се губят най-много събитията от последния оборот. Активното раздаване така или иначе е в `active_room_snapshots`, а след рестарт журналът продължава. Ако раздаване няма `hand_started`, то се реконструира (`reconstructedMidHand: true`).
- Ако минат няколко стъпки в един commit (catch-up след дълъг престой), точкуването се реконструира от последното видяно пълно състояние (`observedVia: 'catch_up'`) и се проверява спрямо приложения резултат.
- Измерено: средно около 30–45 µs на преход, точкуване около 0.2 ms, без пикове над около 2 ms.
- Грешка в журнала никога не стига до gameplay: всичко е в try/catch и се логва `[belot-hand-journal] ... (gameplay unaffected)`.

## Поверителност

- Пълните ръце са само в тази сървърна база и архивите.
- Няма HTTP/WS endpoint и нищо не се изпраща към клиенти, противници или зрители.
- Не се записват connectionId, IP, user-agent, session/reconnect токени, accountId или пароли. За играчите се пазят само място, отбор, profile_id, показвано име и вид (човек/бот).
