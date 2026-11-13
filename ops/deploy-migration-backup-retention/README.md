# T2 — срок от 90 дни за автоматичните snapshot-и преди миграции

**Статус:** скриптът и тестът са готови. **На production не е пускан, нищо не е изтрито, нищо не е инсталирано.**

`scripts/deploy-backend-production.sh` прави консистентен snapshot (`VACUUM INTO`) на базата преди всяко прилагане на миграции:
```
/var/www/belot-v2/server/database/backups/backend-deploy-migration/<UTC YYYYMMDDHHMMSS>-<git short sha>/
  belot-v2.sqlite
  belot-v2.sqlite.sha256      ("<64 hex>  belot-v2.sqlite")
```
Досега тези snapshot-и **нямаха автоматично изтриване**. Затова текстът на Политиката за поверителност за резервните копия не отговаряше на реалността.

## Правила на скрипта (`prune-deploy-migration-backups.mjs`)

- **По подразбиране е DRY-RUN** и нищо не се изтрива. Изтриване има само с `--apply`.
- Обработват се **само** преки поддиректории на корена, които едновременно:
  - имат точно името на deploy скрипта;
  - съдържат **точно** двата очаквани файла;
  - имат валиден SHA256 ред.

  Всичко останало се **пропуска** и само се отчита: ръчни архиви, други имена, допълнителни файлове, symlink-ове, недовършени snapshot-и, бъдещи дати, файлове в корена.
- Възрастта се определя по **времето в името** (UTC), не по mtime.
- Срокът е **90 дни**. Под 30 скриптът не се стартира.
- **Най-новото успешно копие е защитено** независимо от възрастта.
- Изтриването е на двата известни файла поотделно, плюс `rmdir`, **не рекурсивно**. Ако междувременно в директорията се появи друг файл, нищо не се изтрива.
- **Ежечасните backup-и** (`ops/pikabg-backup`, локално и в Google Drive) са в други директории и **не се докосват**.

## Тест (само във временна директория)
```bash
node ops/deploy-migration-backup-retention/check-prune-deploy-migration-backups.mjs
```

## Production — стъпки (само след одобрение)

**1. Dry-run (само четене):**
```bash
cd /var/www/belot-v2
node ops/deploy-migration-backup-retention/prune-deploy-migration-backups.mjs
```
Изходът показва за всяка директория `KEEP` или `WOULD-DELETE` с възрастта и причината, както и коя е защитена. Изпрати резултата за преглед.

**2. Първо реално почистване (ръчно, след прегледа на dry-run-а):**
```bash
node ops/deploy-migration-backup-retention/prune-deploy-migration-backups.mjs --apply
```

**3. Автоматично ежедневно изпълнение (systemd).** Файловете са в `systemd/`. Копиране и активиране:
```bash
sudo cp ops/deploy-migration-backup-retention/systemd/pikabg-deploy-backup-retention.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pikabg-deploy-backup-retention.timer
systemctl list-timers pikabg-deploy-backup-retention.timer
journalctl -u pikabg-deploy-backup-retention.service --since today --no-pager
```

**Rollback:**
```bash
sudo systemctl disable --now pikabg-deploy-backup-retention.timer
```
Вече изтритите snapshot-и не се възстановяват. Затова dry-run-ът е задължителен преди `--apply`.

**Важно за правните текстове:** твърдението „автоматично изтриване след 90 дни“ за тези snapshot-и е вярно **едва след стъпка 3**. Таймерът трябва да е активен преди текстовете да влязат в сила.
