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
| `server/src/ops/profileDeletionLedgerCli.ts` → `server/dist/ops/profileDeletionLedgerCli.js` | `snapshot`, `confirm`, `merge`, `migrate` (само възстановено копие), `reconcile` (пуска се с `node`, без tsx) |
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
3a. Няма `replay ... result=blocked` (напр. `code=active_ban` или `code=support_evidence_hold`). Записът в регистъра се прави **преди** изтриването, затова блокирана заявка също има запис. `blocked` означава, че във възстановеното копие изтриването не е допустимо (напр. активен бан). Провери в журнала на worker-а дали заявката е била `completed` на живо. Профилът **не** се изтрива автоматично и проверката остава неуспешна, докато не бъде взето ръчно решение.
4. `PRAGMA integrity_check` е `ok` (reconcile го проверява).
5. Файловете: `journalPending=0` и `fileFailures=0` в изхода на `--apply`.
6. Таймерът `pikabg-ledger-backup.timer` е активен и първото пускане е `OK`/`unchanged`.

## Какво не може да се провери без production

- Реалното качване в Google Drive: дали MD5 се поддържа от remote-а, квотата и токените. Тестовете ползват stub rclone.
- Истинските `flock`, `systemd` таймер, права и собственост на файловете между root и потребителя на PM2.
- Наличието на `node` в `PATH` на root и на `dist/ops/` след реален deploy.
- Пълен restore върху реален VPS (време, дисково пространство, PM2).
- Поведение на реален Linux `fsync` при прекъсване на захранването. Тестовете симулират прекъснат запис, но не и загуба на захранване.
