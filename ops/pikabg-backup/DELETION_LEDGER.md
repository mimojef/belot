# Регистър на окончателните изтривания — архивиране и restore (Етап 4C)

**Статус:** подготвено в Git, **не е инсталирано и не е проверено на production.** Самоизтриването (`PROFILE_SELF_DELETION_ENABLED`, `PROFILE_SELF_DELETION_WORKER_ENABLED`) остава изключено. Тази инсталация е **задължително условие преди** включване на worker-а.

## Защо

При окончателно изтриване worker-ът записва ред в `server/database/deletion-ledger/profile-deletions.jsonl`. Това е append-only регистър извън SQLite базата, със само псевдонимни ID-та: `request_id`, `profile_id`, `account_id`, `created_at` на профила и времена. Без имейл, име, IP или токени.

Restore на стара база би „възкресил“ профил, изтрит след backup-а. Регистърът позволява изтриването да се приложи отново. За целта той трябва да е **извън VPS** и **по-нов от всяка база**, която може да бъде възстановена.

## Гаранция (и нейните граници)

- **Worker-ът изтрива в базата само след като записът за заявката е потвърдено копиран извън VPS.** Потвърждението е `profile-deletions.offsite-ack.json` до регистъра. Пише го `pikabg-ledger-backup` само след като MD5 на отдалеченото копие съвпадне.
  - Без такова потвърждение заявката остава `blocked` с код `ledger_offsite_pending` и се опитва отново (5 мин, 10 мин, … до 6 ч).
  - Профилът остава скрит и непокътнат, докато чака.
- Следствие: **всяка база, в която профил вече е изтрит, е по-нова от поне едно външно копие на регистъра, което съдържа този профил.** Това не зависи от честотата на backup-а.
- **Какво НЕ е гарантирано:**
  - При трайно недостъпен Google Drive изтриванията чакат. Те не продължават без външно копие.
  - Гаранцията важи само при **една** външна дестинация (Google Drive, същият `pikabg-drive:` remote като базата и uploads). Загуба или компрометиране на Drive акаунта засяга и трите. Втора независима дестинация е бъдещо решение, което не е взето тук.
  - Ако някой ръчно редактира или изтрие регистъра на VPS, worker-ът спира (ack-ът не съвпада). Вече изтритото обаче зависи само от външните копия.

## Компоненти

| Файл | Роля |
|---|---|
| `server/src/db/profileDeletionLedger.ts` | Запис (идемпотентен, fsync), четене, проверка на ack |
| `server/src/ops/profileDeletionLedgerCli.ts` → `server/dist/ops/profileDeletionLedgerCli.js` | `snapshot`, `confirm`, `merge`, `migrate` (само възстановено копие), `reconcile`, `admin-backfill` (пуска се с `node`, без tsx) |
| `server/src/core/adminProfileDeletionCoordinator.ts` | Етап 4F1: административното изтриване през регистъра (т. 8) |
| `ops/pikabg-backup/scripts/pikabg-ledger-backup` | Качване на всеки 5 мин; ack само след MD5 проверка |
| `ops/pikabg-backup/scripts/pikabg-ledger-restore` | Изтегляне на **всички** snapshot-и и fail-closed обединение |
| `ops/pikabg-backup/systemd/pikabg-ledger-backup.{service,timer}` | Таймер на 5 минути (root, същият `RCLONE_CONFIG`) |

**Отдалечено разположение:** `pikabg-drive:PikaBG-Backups/deletion-ledger/<YYYY-MM-DD>/profile-deletions-<UTC>-<sha12>.jsonl`, плюс `.manifest.json` (байтове, sha256, md5, брой редове/записи).
- Нов snapshot се качва само при промяна. Всеки е надмножество на предишния.
- Snapshot-ите не се трият автоматично (малки са). Retention скриптът не ги пипа.

**Локално:** `/var/backups/pikabg-deletion-ledger/` (root, `0700`):
- `uploaded/` — потвърдени копия;
- `pending/` — неуспешни опити; изтриват се автоматично след 7 дни.

## 1. Инсталиране на VPS (ръчно, еднократно)

Предпоставки:
- Backend е deploy-нат с този commit, т.е. съществува `/var/www/belot-v2/server/dist/ops/profileDeletionLedgerCli.js`.
- `node` е в `PATH` на root.
- `pikabg-drive:` remote-ът вече работи (`rclone lsd pikabg-drive:PikaBG-Backups`).

```bash
sudo install -m 0755 ops/pikabg-backup/scripts/pikabg-ledger-backup  /usr/local/sbin/pikabg-ledger-backup
sudo install -m 0755 ops/pikabg-backup/scripts/pikabg-ledger-restore /usr/local/sbin/pikabg-ledger-restore
sudo install -m 0644 ops/pikabg-backup/systemd/pikabg-ledger-backup.service /etc/systemd/system/
sudo install -m 0644 ops/pikabg-backup/systemd/pikabg-ledger-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Първо ръчно пускане (регистърът може още да липсва — качва се празен snapshot):
sudo systemctl start pikabg-ledger-backup.service
sudo journalctl -u pikabg-ledger-backup.service -n 30 --no-pager   # очаквано: "OK confirmed ..."
sudo ls -la /var/www/belot-v2/server/database/deletion-ledger/      # profile-deletions.offsite-ack.json
sudo rclone lsf -R pikabg-drive:PikaBG-Backups/deletion-ledger | tail

sudo systemctl enable --now pikabg-ledger-backup.timer
systemctl list-timers pikabg-ledger-backup.timer
```

Права:
- Директорията на регистъра се създава от Node процеса (`0700`, файлът `0600`).
- Ack-ът е `0644` и не съдържа лични данни.
- Ако Node процесът не работи като root, провери, че може да чете ack-а: `sudo -u <pm2 потребител> cat .../profile-deletions.offsite-ack.json`.

**Не задавай** `PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED=0` на production. Тази стойност е само за локална разработка. По подразбиране условието е включено (в лога: `ledgerOffsiteRequired=true`).

## 2. Проверка на архивирането (рутинно)

```bash
systemctl list-timers pikabg-ledger-backup.timer        # последно/следващо пускане
sudo journalctl -u pikabg-ledger-backup.service --since "1 hour ago" --no-pager | grep -E "OK|unchanged|ERROR"
sudo cat /var/www/belot-v2/server/database/deletion-ledger/profile-deletions.offsite-ack.json
# Чакащи заради липсващо външно копие (трябва да е 0 или временно):
sudo sqlite3 -readonly /var/www/belot-v2/server/database/data/belot-v2.sqlite \
  "SELECT COUNT(*) FROM profile_deletion_requests WHERE status='blocked' AND last_error_code='ledger_offsite_pending';"
```

`ERROR` в журнала означава, че изтриванията чакат. Те не продължават без копие. Отстрани причината (мрежа, Drive квота, rclone token) и пусни `sudo systemctl start pikabg-ledger-backup.service`.

## 3. Проверка на целостта (периодично и преди restore)

```bash
SCRATCH=$(mktemp -d /tmp/ledger-check.XXXX)
sudo /usr/local/sbin/pikabg-ledger-restore --target-dir "$SCRATCH/out" \
  --local-ledger /var/www/belot-v2/server/database/deletion-ledger/profile-deletions.jsonl
```

Изходът е JSON отчет:
- `validSnapshots` и `invalidSnapshots`;
- `newestSnapshot`;
- `localLedger: "used"`;
- `warnings`.

Изход 0 означава, че всички външни копия са консистентни помежду си и с живия регистър (append-only, без разклонения). Ненулев изход изисква разследване, преди каквото и да е изтриване или restore.

## 4. Restore след срив (същият VPS, регистърът е оцелял)

Платформата остава **спряна за потребители** през цялото време. **Не** стартирай PM2 (вкл. `pm2 restart`/`pm2 resurrect`/рестарт на машината с автоматичен старт на PM2), докато т. 7 не е изпълнена изцяло — сървърът при старт прилага миграциите и пуска worker-а върху живата база.

```bash
pm2 stop belot-v2-server                         # спира и worker-а
# a) Възстанови базата + uploads в scratch (съществуващият скрипт):
sudo /usr/local/sbin/pikabg-restore --db-archive <...sqlite.zst> --uploads-archive <...-uploads.tar.zst> --target-dir /srv/restore-<дата>
# a2) ЗАДЪЛЖИТЕЛНО: миграциите на версията, която ще работи в production
#     (deploy-натия backend в /var/www/belot-v2/server), върху ВЪЗСТАНОВЕНОТО
#     копие. Backup отпреди нова миграция (напр. 20261027_001) иначе не може
#     да бъде съгласуван — reconcile отказва с restored_db_migrations_pending.
#     Командата отказва живата база и не създава нова.
cd /var/www/belot-v2/server
sudo node dist/ops/profileDeletionLedgerCli.js migrate --db=/srv/restore-<дата>/belot-v2.sqlite
#     Очаквано: {"ok":true,"status":"migrated","applied":[...],"pendingAfter":[]}
#     Проверка: следващите стъпки (b/c/d) отказват с exit 2, ако нещо липсва.
# b) Най-новото състояние на регистъра = ВСИЧКИ външни snapshot-и + живият регистър:
sudo /usr/local/sbin/pikabg-ledger-restore --target-dir /srv/ledger-<дата> \
  --local-ledger /var/www/belot-v2/server/database/deletion-ledger/profile-deletions.jsonl \
  --restored-db /srv/restore-<дата>/belot-v2.sqlite
# c) Повторно прилагане върху възстановените копия:
cd /var/www/belot-v2/server
sudo node dist/ops/profileDeletionLedgerCli.js reconcile --db=/srv/restore-<дата>/belot-v2.sqlite \
  --ledger=/srv/ledger-<дата>/merged-ledger.jsonl --apply --confirm=REAPPLY-PROFILE-DELETIONS \
  --uploads-root=/srv/restore-<дата>/uploads
# d) Финална проверка — трябва да е exit 0 и "verify OK":
sudo node dist/ops/profileDeletionLedgerCli.js reconcile --db=/srv/restore-<дата>/belot-v2.sqlite \
  --ledger=/srv/ledger-<дата>/merged-ledger.jsonl --verify-only
```

След това копирай проверените `belot-v2.sqlite` и `uploads/` на мястото на живите, по съществуващата процедура в `README.md` (Recovery).

**Не изтривай регистъра на VPS.** Той остава източник за следващи restore-и.

## 5. Restore върху нов VPS (регистърът на VPS е изгубен)

Стъпките са същите като в т. 4, но **без** `--local-ledger`. Източникът е само Google Drive.

1. Инсталирай rclone и конфигурирай `pikabg-drive:` (отделно, извън Git).
2. Deploy-ни backend-а (за `dist/ops/...`), но **не** стартирай PM2 за потребители.
3. Изпълни т. 4 a, **a2 (миграции върху възстановеното копие)**, b–d без `--local-ledger`.
4. Създай директорията `server/database/deletion-ledger/` и копирай `merged-ledger.jsonl` като `profile-deletions.jsonl` (`chmod 600`, собственост на потребителя на Node процеса). Така следващите изтривания продължават същата история.
5. Пусни веднъж `pikabg-ledger-backup` и провери изхода. Обърни внимание на `local_ledger_*` предупрежденията и на ack-а.
6. Едва тогава активирай таймерите и отвори платформата.

## 6. Липсващ, непълен или повреден архив

`pikabg-ledger-restore` **не продължава мълчаливо**:

| Изход | Причина | Действие |
|---|---|---|
| 3 | изтеглянето от Drive е неуспешно | Оправи мрежата/credentials. **Не** възстановявай без регистър. |
| 4 `no_ledger_available` | няма нито един snapshot | `--confirm-no-deletions-ever` **само** ако никога не е имало окончателни изтривания (напр. worker-ът никога не е включван — провери `profile_deletion_requests` в най-новия backup и журнала на worker-а) |
| 4 `newest_snapshot_invalid` | най-новото копие е повредено или непълно | Опитай пак. Ако копието е трайно повредено, `--accept-missing-newest` е допустимо **само** ако живият регистър липсва и няма друг източник. Обедини с всички по-стари и отбележи риска в инцидента. |
| 4 `ledger_history_diverged` / `local_ledger_diverged` / `ledger_conflict` | историята не е append-only (ръчна намеса или подмяна) | Спри. Нужна е ръчна експертиза на файловете. |
| 5 | отчетът след merge изисква внимание (напр. `ledger_stale`) | Виж т. 7. |
| 5 / reconcile exit 2 `restored_db_migrations_pending` | възстановената база е отпреди миграция на текущата версия | Изпълни т. 4 a2 (`migrate`) и повтори. Никога не пускай сървъра върху копието, за да „мигрира само“. |

## 7. Проверки преди повторно пускане на сайта

0. `migrate` върху възстановеното копие е върнал `"pendingAfter":[]` (същата версия на сървъра, която ще бъде пусната), а `reconcile` не съобщава `restored_db_migrations_pending`.
1. `reconcile --verify-only` връща **exit 0** и `verify OK`.
2. Няма `ledger_stale` (базата не знае за изтриване, което регистърът не съдържа). Ако има такова, регистърът е по-стар от базата. Намери по-ново външно копие и **не** използвай `--accept-stale-ledger` без анализ.
3. Няма `identity_mismatch`. Ако има, профил със същия `profile_id` има друга идентичност — нужна е ръчна проверка; той не се трие автоматично.
3a. Няма `replay ... result=blocked` (напр. `code=active_ban`). Записът в регистъра се прави **преди** изтриването, затова блокирана заявка също има запис. `blocked` означава, че във възстановеното копие изтриването не е допустимо (напр. активен бан). Провери в журнала на worker-а дали заявката е била `completed` на живо. Профилът **не** се изтрива автоматично и проверката остава неуспешна, докато не бъде взето ръчно решение.
4. `PRAGMA integrity_check` е `ok` (reconcile го проверява).
5. Файловете: `journalPending=0` и `fileFailures=0` в изхода на `--apply`.
6. Таймерът `pikabg-ledger-backup.timer` е активен и първото пускане е `OK`/`unchanged`.

## 8. Административни окончателни изтривания (Етап 4F1)

Административното изтриване („Изтрий профила“, вкл. „по тази заявка“ от поддръжката) използва **същия регистър и същото offsite потвърждение**.

**Зависимост за deploy:** след deploy на 4F1 административното изтриване **се изпълнява само при работещ `pikabg-ledger-backup.timer`** (т. 1). Без потвърждение операцията остава „насрочена“ и **не** се изпълнява (fail-closed). Админът вижда съобщение, че изтриването е насрочено. `PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED=0` е само за локална разработка.

### Поток

1. Админът потвърждава изтриването → висящ ред в `pending_profile_moderation` (`ledger_operation_id`) и запис `admin_delete_intent` в регистъра.
   - Ако записът в регистъра е невъзможен → HTTP 503, без висящ ред, нищо не е изтрито.
2. До 5 мин `pikabg-ledger-backup` потвърждава записа. Сървърът (на всяка минута) изпълнява изтриването, ако профилът не е в активна игра; иначе — в края на мача.
3. След COMMIT → `admin_delete_completed`. Одитният ред в `admin_profile_deletions` е със същия `log_id` = `operationId`.
   - Срив между COMMIT и записа се довършва автоматично по одитния ред.
   - **Етап 4F2:** `admin_delete_completed` означава, че **данните в базата** са изтрити (същото ядро като самоизтриването). Физическите файлове са в същата надеждна опашка (`profile_deletion_file_queue.admin_operation_id`) и се обработват веднага, а при грешка — с повторни опити от runner-а на всяка минута. Състоянието на файловата фаза е в `admin_profile_deletions.file_cleanup_status`: `pending` (не е приключила), `done` (всички файлове са изтрити, липсващи или споделени), `NULL` (изтриване отпреди 4F2, стар best-effort механизъм).
4. Отказ (напр. незавършил турнир) → `admin_delete_aborted`. Приключване чрез самоизтриване (Етап 4E6C) → `admin_delete_resolved_by_self`.

Диагностика на недовършени файлови фази (само четене):

```sql
SELECT a.log_id, a.deleted_at, q.status, q.attempt_count, q.last_error_code, q.next_attempt_at
FROM admin_profile_deletions a
JOIN profile_deletion_file_queue q ON q.admin_operation_id = a.log_id
WHERE a.file_cleanup_status = 'pending' AND q.status NOT IN ('done', 'skipped_shared');
```

`failed` без `next_attempt_at` (или с изчерпани опити) е постоянен отказ — напр. опасен път или символна връзка — и изисква ръчна проверка. Restore на backup, направен между COMMIT и файловете, довършва файловата фаза автоматично (runner-ът и `reconcile`).

В регистъра има само UUID-та, времена и кодове. **Без имена, имейли, IP или причината.** Причината остава само в одита в базата.

### Еднократно след deploy: старите административни изтривания

Изтриванията отпреди 4F1 са само в `admin_profile_deletions`. Докато не бъдат добавени, `reconcile` отказва restore с `admin_ledger_stale` (fail-closed).

```bash
cd /var/www/belot-v2/server
# Преглед (базата само се чете, регистърът не се променя):
sudo -u <потребителят на Node> node dist/ops/profileDeletionLedgerCli.js admin-backfill \
  --db=database/data/belot-v2.sqlite --ledger=database/deletion-ledger/profile-deletions.jsonl
# Запис в регистъра (идемпотентно):
sudo -u <потребителят на Node> node dist/ops/profileDeletionLedgerCli.js admin-backfill \
  --db=database/data/belot-v2.sqlite --ledger=database/deletion-ledger/profile-deletions.jsonl \
  --apply --confirm=BACKFILL-ADMIN-DELETIONS
```

- Добавят се само редове, чийто профил **наистина липсва** в базата. Идентификацията е по UUID, никога по име.
- `insufficient` (невалиден идентификатор/дата) и `profile_present` **не** се добавят (exit 1). Те изискват ръчна проверка.
- След това следващото пускане на `pikabg-ledger-backup` ги качва извън VPS.

### Restore — нови резултати на `reconcile`

| Резултат | Значение | `--apply` |
|---|---|---|
| `admin_missing` | Доказано завършено административно изтриване, профилът е „възкресен“ | Изтрива се отново със същия административен път (оригиналният момент, същият `log_id`). Активен бан в стария backup не пречи |
| `admin_unresolved` | Само намерение, без доказано изпълнение, а профилът е в базата | **Не** се трие. Verify остава неуспешен — провери в живата база/логовете дали изтриването е станало |
| `admin_identity_mismatch` | Същият UUID, друга идентичност (акаунт/дата на създаване) | **Не** се трие — ръчна проверка |
| `admin_ledger_stale` | Одитен ред в базата, чиято операция липсва в регистъра | `--apply` се отказва (както `ledger_stale`) — по-ново копие на регистъра или `admin-backfill` |

Висящ ред от стар backup за операция, която в регистъра вече е приключена, **не** се изпълнява повторно. Сървърът го премахва.

**Връщане към версия отпреди 4F1:** по-старият код не разпознава административните записи и приема регистъра за повреден. Тогава самоизтриването и архивирането спират (fail-closed). Не връщай сървъра към такава версия, след като в регистъра има административни записи.


## 9. Трайни отмени на доброволни заявки (Етап 4J1)

Отмяната на заявка за самоизтриване вече е запис в **същия** регистър, за да оцелее при restore на стар backup. Причината, имейлът и името **не** се записват извън базата.

### Нови записи

| Запис | Съдържание | Значение |
|---|---|---|
| `request_cancelled` | `requestId`, `profileId`, `cancellationId`, `source` (`user` / `admin` / `system`), `recordedAt` | Отмяна. Валидна е, ако е **след** намерението за заявката или намерение няма |
| `request_db_deleted` | `requestId`, `profileId`, `dbDeletedAt`, `recordedAt` | Необратимото изтриване е започнало. Записва се (fsync) вътре в транзакцията на изтриването, непосредствено преди COMMIT (Етап 4J1A). Срив между записа и COMMIT → worker-ът довършва изтриването при следващия опит. Има предимство пред всяка отмяна |

### Поток (без чакане в отворена транзакция)

1. **Приета** — ред в `profile_deletion_cancellations` в същата транзакция като проверките (срок за потребителя, роля и причина за администратора). От този момент worker-ът не може да вземе заявката и не може да маркира изтриване (claim + тригери), дори offsite backup-ът да не работи дни наред.
2. **Записана** — `request_cancelled` в регистъра. Записът се прави под writer lock-а на SQLite (кратък локален append), затова няма дублирани редове между процесите.
3. **Окончателна** — едва когато ack-ът на `pikabg-ledger-backup` покрива записа (същата проверка като за изтриванията: точен префикс + SHA-256). Заявката става `cancelled` и профилът се показва отново.

Всеки процес довършва приетите отмени на всеки 30 s. Срив между стъпките се довършва идемпотентно. Докато отмяната не е окончателна, профилът остава скрит, входът показва „Отмяната е приета…“, а в админ панела статусът е „Отмяната е приета — потвърждава се“. Отмяна, приета преди срока, остава валидна, ако потвърждението дойде след него.

Ако преди записа worker-ът открие в регистъра отмяна за заявката (база, възстановена без reconcile), той **не** изтрива профила, а възстановява трайната защита в базата.

### Restore — нови резултати на `reconcile`

| Резултат | Значение | `--apply` |
|---|---|---|
| `cancel_restore_needed` | В регистъра има валидна отмяна, а във възстановената база заявката е активна | Възстановява трайната защита (`recovered_from_ledger = 1`). Профилът **не** се трие. Финализира я обичайният механизъм след offsite потвърждение |
| `cancelled` | Отмяната вече е спазена (или заявката липсва в backup-а) | Нищо |
| `cancel_conflict` | Отмяна **преди** намерението — невалидна последователност | Нищо не се трие и нищо не се отменя. Verify остава неуспешен — ръчна проверка |
| `cancel_ignored` | Има `request_db_deleted` — изтриването има предимство | Изтриването се прилага повторно. Профилът не се възстановява |
| `ledger_stale` (и за отмени) | Финализирана отмяна в базата, която липсва в регистъра | `--apply` се отказва (по-ново копие на регистъра) |

### Заключване на регистъра (Етап 4J1A)

- Всеки запис в края на регистъра (вкл. отрязването на недовършен ред след срив) се прави под изключително заключване на `profile-deletions.jsonl.lock` в същата директория (SQLite заключване на файла).
- Операционната система освобождава заключването, ако процесът умре — „заседнал“ lock няма; файлът **не** трябва да се трие ръчно.
- Snapshot, confirm и offsite проверките само четат (завършени редове) и не заключват. `merge --out=<живия регистър>` също заключва.
- Заключване, заето повече от 15 s, прави записа неуспешен (fail-closed: изтриването чака, отмяната остава приета).
- Ако ops команда, която пише в регистъра, се пусне като root, файлът `.lock` получава собственика на регистъра.

### Наблюдение

- `grep profile-deletion-cancellation` в PM2 логовете: `finalized`, `ledger_failed` (повреден/недостъпен регистър — отмяната остава приета и защитена), `CONFLICT deletion_proven` (база, възстановена без reconcile — изпълни т. 4).
- Дълго чакащи отмени означават, че `pikabg-ledger-backup` не потвърждава. Провери т. 2.

### Връщане към версия отпреди 4J1

- След първия запис `request_cancelled` / `request_db_deleted` по-старият код приема регистъра за повреден: самоизтриването, административните изтривания и архивирането на регистъра спират (fail-closed).
- Освен това миграция `20261103_001` остава в базата: по-старият код не може да отмени заявка (тригерът изисква финализирана трайна отмяна), а worker-ът му би продължил, докато регистърът е без нови записи.
- Затова **не** връщай backend-а към версия отпреди 4J1, докато самоизтриването е включено. Ако връщането е неизбежно, първо изключи `PROFILE_SELF_DELETION_WORKER_ENABLED` и подаването.

## Какво не може да се провери без production

- Реалното качване в Google Drive: дали MD5 се поддържа от remote-а, квотата и токените. Тестовете ползват stub rclone.
- Истинските `flock`, `systemd` таймер, права и собственост на файловете между root и потребителя на PM2.
- Наличието на `node` в `PATH` на root и на `dist/ops/` след реален deploy.
- Пълен restore върху реален VPS (време, дисково пространство, PM2).
- Поведение на реален Linux `fsync` при прекъсване на захранването. Тестовете симулират прекъснат запис, но не и загуба на захранване.
