# Production frontend deploy план — atomic release fix

**Статус: план само за преглед. Не е изпълняван. Не прилагай без отделно одобрение.**

Обхват: **само frontend** (`/var/www/belot-v2`). Backend (PM2 процесът за `server/`) на `1139934` е здрав — **не се пипа, не се рестартира, не се rollback-ва**.

Production checkout-ът Е `/var/www/belot-v2` директно — backend/PM2 също разчита на тази структура. Този план **не** предполага несъществуващ `/var/www/belot-v2/repo` и **не мести** repo-то никъде. `scripts/deployFrontendAtomic.sh` вече извежда `PROJECT_ROOT` от собственото си местоположение (`../` спрямо `scripts/`), значи по подразбиране правилно съвпада с `/var/www/belot-v2` без нужда от explicit override.

---

## Предпоставки (еднократни, преди първата миграция)

1. `git pull` в `/var/www/belot-v2` до commit-а с тази поправка (`scripts/deployFrontendAtomic.sh`, `scripts/validatePrecacheClosure.mjs`, `deploy/`).
2. **Ръчно, изолирано** потвърди symlink атомарността на реалния Linux хост (виж бележката в `scripts/checkFrontendDeployAtomic.ts` — Windows dev машината не можа да го докаже end-to-end поради липса на elevated права за `ln -s`):
   ```bash
   mkdir -p /tmp/symlink-probe/target
   ln -sfn /tmp/symlink-probe/target /tmp/symlink-probe/link
   ls -la /tmp/symlink-probe/link   # трябва да покаже "link -> target" (l bit)
   rm -rf /tmp/symlink-probe
   ```
3. Review и **отделно одобрение** на nginx конфигурацията (стъпка 9 по-долу) — тази задача изрично забранява директно редактиране на production nginx без такова одобрение.
4. `npm ci` в `/var/www/belot-v2` (за да е наличен `node_modules/.bin/vite`, `tsc`, `playwright` и т.н., ползвани от deploy скрипта и regression тестовете).

---

## Първата миграция — без downtime, nginx превключва последен

**Критично:** старият план погрешно сменяше nginx `root` към `current` ПРЕДИ `current` изобщо да съществува. Правилният ред мигрира от текущия работещ `dist/` към новия release/pool модел **докато nginx още сочи към `dist/`** — живият трафик никога не спира и никога не сочи към полу-мигрирана структура.

### 1. Backup на текущия dist и nginx конфигурацията

```bash
sudo cp -a /var/www/belot-v2/dist /var/www/belot-v2/dist.backup-$(date -u +%Y%m%d%H%M%S)
sudo cp -a /etc/nginx/sites-available/pika.bg /etc/nginx/sites-available/pika.bg.backup-$(date -u +%Y%m%d%H%M%S)
```

### 2. Създай baseline release от ТЕКУЩИЯ работещ dist (без нов build)

`--adopt` копира (никога не мести/трие) съществуващия, вече обслужван `dist/` в изолирана temp директория, класифицира го със СЪЩАТА hashed/mutable логика и го публикува като нормален release — БЕЗ да build-ва нищо ново, БЕЗ да пипа оригинала:

```bash
cd /var/www/belot-v2
PROJECT_ROOT=/var/www/belot-v2 \
DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --adopt /var/www/belot-v2/dist
```

Очакван изход: `Release: <timestamp>-baseline-<sha>`, класификация (`N hashed`, `M mutable`), успешна precache closure проверка, `current -> <timestamp>-baseline-<sha>`.

### 3. Копиране на старите hashed assets в shared pool (автоматично от --adopt)

Стъпка 2 вече прави точно това (стъпки 3+4 от нормалния deploy pipeline, приложени към adopted-ия dist) — потвърди:

```bash
ls /var/www/belot-v2/assets/          # трябва да съдържа старите index-*.js/css hash-ове
```

### 4. Копиране на mutable assets в baseline release/assets (автоматично от --adopt)

```bash
ls /var/www/belot-v2/current/assets/  # трябва да съдържа avatars/, lobby/, animated-emoji/ и т.н.
```

### 5. `current` symlink към baseline release (вече направено от --adopt в стъпка 2)

```bash
readlink -f /var/www/belot-v2/current
```

### 6. Проверка през ЛОКАЛНИ filesystem пътища — nginx ВСЕ ОЩЕ сочи към `dist/`

**Никакъв live трафик все още не минава през новата структура** — проверката е чисто локална:

```bash
test -f /var/www/belot-v2/current/index.html && echo "index.html OK"
test -f /var/www/belot-v2/current/sw.js && echo "sw.js OK"
diff /var/www/belot-v2/dist/index.html /var/www/belot-v2/current/index.html && echo "index.html идентичен с dist"

# Директно (без nginx) сравни съдържание на произволен hashed asset:
HASH_FILE=$(ls /var/www/belot-v2/assets/ | grep '^index-' | head -1)
diff "/var/www/belot-v2/dist/assets/$HASH_FILE" "/var/www/belot-v2/assets/$HASH_FILE" && echo "hashed asset идентичен"

# Пусни новия target тест срещу adopted baseline-а:
cd /var/www/belot-v2
DEPLOY_ROOT=/var/www/belot-v2 npx tsx scripts/checkFrontendDeployAtomic.ts
```

`https://pika.bg` продължава да обслужва стария `dist/` през целия този етап — нула риск за живите потребители.

### 7. Atomic publish на НОВ release (реален build, доказва пълния pipeline)

```bash
cd /var/www/belot-v2
git log -1 --oneline   # потвърди очаквания commit
PROJECT_ROOT=/var/www/belot-v2 \
DEPLOY_ROOT=/var/www/belot-v2 \
KEEP_RELEASES=3 \
  bash scripts/deployFrontendAtomic.sh
```

nginx **все още** сочи към `dist/` — този нов release само превключва `current` symlink-а локално, без ефект върху живия трафик.

### 8. Потвърди поне 2 release-а и валиден rollback target

```bash
PROJECT_ROOT=/var/www/belot-v2 DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --list
# Очаквано: baseline release + новия release, новият маркиран <- CURRENT

PROJECT_ROOT=/var/www/belot-v2 DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --rollback --dry-run
# Очаквано: посочва baseline release-а като target, без да прилага нищо (--dry-run)
```

### 9. Чак СЕГА — промяна на nginx root към `current` + reload

Приложи `deploy/nginx-frontend-cache-headers.conf.example` към реалния production `server {}` блок **само след ръчен review**:
- `root` → `/var/www/belot-v2/current`
- Regex location за hashed assets (`location ~ "^/assets/(.+-[0-9A-Za-z_-]{8,10}\.(?:js|mjs|css))$"`) — **БЕЗ `^~` преди него никъде**, иначе regex-ът никога не се проверява (виж location precedence бележката в конфиг файла, доказано емпирично).
- Plain prefix `location /assets/` (също БЕЗ `^~`) → `/var/www/belot-v2/current/assets/`.

```bash
sudo nginx -t                    # syntax check ПРЕДИ reload — задължително заради {n,m} quoting изискването
sudo systemctl reload nginx      # reload, не restart — нулев downtime
```

Тази стъпка се прави **веднъж** (при първата миграция) — следващите deploy-и никога повече не пипат nginx config, само `scripts/deployFrontendAtomic.sh`.

### 10. curl/cache/browser проверки (СЕГА за първи път през реалния live route)

```bash
for path in / /index.html /sw.js /manifest.webmanifest; do
  echo "=== $path ==="
  curl -sI "https://pika.bg$path" | grep -i "cache-control\|^HTTP"
done

SCRIPT=$(curl -s https://pika.bg/index.html | grep -o '/assets/index-[A-Za-z0-9]*\.js' | head -1)
echo "=== hashed: $SCRIPT ==="
curl -sI "https://pika.bg$SCRIPT" | grep -i "cache-control\|^HTTP"   # очаква immutable

echo "=== mutable: /assets/lobby/... ==="
MUTABLE=$(curl -s https://pika.bg/index.html | grep -o '/lobby' | head -1)
curl -sI "https://pika.bg/assets/avatars/" -o /dev/null -w "%{http_code}\n"  # sanity, реален файл варира

curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/                      # 200
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/lobby                 # 200 (SPA fallback)
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/strategy              # 200 (SPA fallback, НЕ /lobby redirect)
curl -s -o /dev/null -w "%{http_code}\n" "https://pika.bg$SCRIPT"              # 200
```

Browser/PWA smoke test (ръчно):
- Твърд refresh на `https://pika.bg/` → зарежда без recovery overlay.
- DevTools → Application → Service Workers → нов `sw.js` е `activated`, без `waiting` state.
- Влез, стартирай реален мач, потвърди PWA auto-update coordinator НЕ прекъсва активна игра.
- Отвори `/strategy`, презареди — директно зарежда `/strategy`.

### 11. Наблюдение на nginx и PM2 логове (само наблюдение, backend непроменен)

```bash
sudo tail -f /var/log/nginx/access.log | grep -E "assets/index-|sw\.js|GET / "
sudo tail -f /var/log/nginx/error.log
pm2 logs belot-v2-server --lines 100   # само наблюдение — backend процесът не се рестартира
```

Следи за 404 към `/assets/...` (би означавало asset пропуснат при publish) и необичайни WS disconnect спайкове около момента на nginx reload (стъпка 9, еднократно).

---

## Следващи (обикновени) deploy-и — след първата миграция

nginx вече сочи към `current`, значи всеки следващ deploy е просто:

```bash
cd /var/www/belot-v2
git pull
PROJECT_ROOT=/var/www/belot-v2 DEPLOY_ROOT=/var/www/belot-v2 KEEP_RELEASES=3 \
  bash scripts/deployFrontendAtomic.sh
```

Без nginx reload, без downtime, без ръчна намеса.

---

## Rollback команди

**Само frontend.** Backend PM2 процесът не се засяга от нищо по-долу.

```bash
# Rollback към предишния frontend release:
PROJECT_ROOT=/var/www/belot-v2 DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --rollback

# Проверка кой release е "current" в момента:
PROJECT_ROOT=/var/www/belot-v2 DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --list

# Extreme fallback — връщане към СТАРИЯ nginx config + СТАРИЯ dist/ (само
# ако нещо е дълбоко счупено в самия release/pool модел, не за обикновен
# "предпочитам предишната версия" случай — за това ползвай --rollback):
sudo cp -a /etc/nginx/sites-available/pika.bg.backup-<timestamp> /etc/nginx/sites-available/pika.bg
sudo nginx -t && sudo systemctl reload nginx
# nginx отново сочи към dist/ (root директивата от backup-натия config) —
# /var/www/belot-v2/dist.backup-<timestamp> е непокътнат резерв, ако и
# самият dist/ по някаква причина е бил променен междувременно:
sudo rm -rf /var/www/belot-v2/dist
sudo cp -a /var/www/belot-v2/dist.backup-<timestamp> /var/www/belot-v2/dist
```

Нормалният `--rollback` превключва само `current` symlink-а — атомарен, секунди, не изисква nginx reload (nginx вече следва symlink-а on-the-fly). Mutable assets (avatars/images/audio) се връщат автоматично, защото живеят вътре в release директорията. Hashed assets pool-ът е споделен и не се пипа при rollback.

---

## Явно изключено от този план

- Backend/PM2 конфигурация или рестарт.
- `npm audit fix` (не се изпълнява).
- Промяна в game алгоритъма.
- Автоматично прилагане на nginx конфигурацията без отделно одобрение (стъпка 9).
- Действия срещу production данни или бази.
- Преместване на repo checkout-а извън `/var/www/belot-v2`.
