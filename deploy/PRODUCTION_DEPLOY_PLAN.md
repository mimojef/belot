# Production frontend deploy план — atomic release fix

**Статус: план само за преглед. Не е изпълняван. Не прилагай без отделно одобрение.**

Обхват: **само frontend** (`/var/www/belot-v2`). Backend (PM2 процесът за `server/`) на `c73ac7a` е здрав — **не се пипа, не се рестартира, не се rollback-ва**.

---

## Предпоставки (еднократни, преди първи atomic deploy)

1. Копирай `scripts/deployFrontendAtomic.sh` и `deploy/nginx-frontend-cache-headers.conf.example` на production хоста (напр. в repo checkout-а под `/var/www/belot-v2/repo`).
2. **Ръчно, изолирано** потвърди symlink атомарността на реалния Linux хост (виж бележката в `scripts/checkFrontendDeployAtomic.ts` — Windows dev машината не можа да го докаже end-to-end поради липса на elevated права за `ln -s`):
   ```bash
   mkdir -p /tmp/symlink-probe/target
   ln -sfn /tmp/symlink-probe/target /tmp/symlink-probe/link
   ls -la /tmp/symlink-probe/link   # трябва да покаже "link -> target" (l bit)
   rm -rf /tmp/symlink-probe
   ```
3. Review и **отделно одобрение** на nginx конфигурацията (стъпка 4 по-долу) — тази задача изрично забранява директно редактиране на production nginx без такова одобрение.

---

## 1. Backup на текущия dist

```bash
sudo cp -a /var/www/belot-v2/dist /var/www/belot-v2/dist.backup-$(date -u +%Y%m%d%H%M%S)
```

Пази поне последния backup, докато новият flow не бъде потвърден стабилен за няколко реални deploy-а.

## 2. Build в temp release directory

```bash
cd /var/www/belot-v2/repo
git fetch origin
git log -1 --oneline   # потвърди очаквания commit ПРЕДИ build
PROJECT_ROOT=/var/www/belot-v2/repo \
DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --dry-run
```

`--dry-run` build-ва и валидира (стъпка 3), но НЕ публикува — първа безопасна проверка, че текущият commit build-ва чисто на production хоста, преди какъвто и да е live ефект.

## 3. Проверка на файловете

`--dry-run` вече прави автоматично:
- `index.html` съществува и съдържа `<script type="module">` + `assets/index-` референция;
- `sw.js` съществува и съдържа workbox precache код;
- `manifest.webmanifest` съществува;
- `assets/` не е празна.

Допълнителна ръчна проверка преди реален publish:
```bash
grep -c "assets/index-" /tmp/belot-frontend-build-*/index.html   # =1 (точно един entry chunk reference)
```

## 4. Nginx конфигурация (отделно одобрение, извън тази задача)

Приложи `deploy/nginx-frontend-cache-headers.conf.example` към реалния production `server {}` блок **само след ръчен review** — смени `root` към `/var/www/belot-v2/current` и добави `location ^~ /assets/ { alias /var/www/belot-v2/assets/; ... }`.

```bash
sudo nginx -t                    # syntax check ПРЕДИ reload
sudo systemctl reload nginx      # reload, не restart — нулев downtime
```

Тази стъпка се прави **веднъж**, преди първия atomic deploy (не на всеки deploy).

## 5. Atomic publish (реалният deploy)

```bash
cd /var/www/belot-v2/repo
PROJECT_ROOT=/var/www/belot-v2/repo \
DEPLOY_ROOT=/var/www/belot-v2 \
KEEP_RELEASES=3 \
  bash scripts/deployFrontendAtomic.sh
```

Скриптът: build извън live dist → validate → публикува hashed assets в споделения pool → подготвя release directory → атомарен `current` symlink swap → retention cleanup на release метаданните (НЕ на assets pool-а).

## 6. Cache-header проверка

```bash
for path in / /index.html /sw.js /manifest.webmanifest; do
  echo "=== $path ==="
  curl -sI "https://pika.bg$path" | grep -i "cache-control\|^HTTP"
done

SCRIPT=$(curl -s https://pika.bg/index.html | grep -o '/assets/index-[A-Za-z0-9]*\.js' | head -1)
echo "=== $SCRIPT ==="
curl -sI "https://pika.bg$SCRIPT" | grep -i "cache-control\|^HTTP"
```

Очаквано (след стъпка 4): `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` → `Cache-Control: no-cache, must-revalidate`; `/assets/index-*.js` → `Cache-Control: public, max-age=31536000, immutable`.

## 7. curl проверки на всички entry/assets

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/                      # 200
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/lobby                 # 200 (SPA fallback)
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/sw.js                 # 200
curl -s -o /dev/null -w "%{http_code}\n" https://pika.bg/manifest.webmanifest  # 200
curl -s -o /dev/null -w "%{http_code}\n" "https://pika.bg$SCRIPT"              # 200

# Потвърди, че ПРЕДИШНИЯТ release hash (ако има такъв в assets pool-а) все още е достъпен:
ls /var/www/belot-v2/assets/ | grep "^index-"
```

## 8. Browser/PWA smoke test

Ръчно, в реален браузър (или Playwright срещу prod, ако вече е одобрено за read-only smoke):
- Твърд refresh на `https://pika.bg/` → зарежда без recovery overlay.
- DevTools → Application → Service Workers → потвърди нов `sw.js` е `activated`, без `waiting` state, задържащ стар клиент.
- Влез, стартирай реален мач, потвърди PWA auto-update coordinator НЕ прекъсва активна игра (вече покрито от `check:pwa-auto-update`).
- Отвори `/strategy`, презареди — потвърди директно зарежда `/strategy`, не пренасочва към `/lobby`.

## 9. Наблюдение на nginx и PM2 логове (само наблюдение, backend непроменен)

```bash
sudo tail -f /var/log/nginx/access.log | grep -E "assets/index-|sw\.js|GET / "
sudo tail -f /var/log/nginx/error.log
pm2 logs belot-v2-server --lines 100   # само наблюдение — backend процесът не се рестартира
```

Следи за 404 към `/assets/index-*` (би означавало asset пропуснат при publish) и необичайни WS disconnect спайкове точно около момента на nginx reload (стъпка 4, еднократно).

---

## Rollback команди

**Само frontend.** Backend PM2 процесът на `c73ac7a` не се засяга от нищо по-долу.

```bash
# Rollback към предишния frontend release:
PROJECT_ROOT=/var/www/belot-v2/repo \
DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --rollback

# Проверка кой release е "current" в момента:
PROJECT_ROOT=/var/www/belot-v2/repo \
DEPLOY_ROOT=/var/www/belot-v2 \
  bash scripts/deployFrontendAtomic.sh --list

# При нужда от пълен backup restore (extreme fallback, извън нормалния release/current flow):
sudo rm -rf /var/www/belot-v2/dist
sudo cp -a /var/www/belot-v2/dist.backup-<timestamp> /var/www/belot-v2/dist
# (само ако nginx все още сочи към dist/, не към current/ — legacy fallback)
```

Rollback-ът превключва `current` symlink-а към предишния release — атомарен, секунди, не изисква nginx reload (nginx вече следва symlink-а on-the-fly).

---

## Явно изключено от този план

- Backend/PM2 конфигурация или рестарт.
- `npm audit fix` (не се изпълнява).
- Промяна в game алгоритъма.
- Автоматично прилагане на nginx конфигурацията без отделно одобрение (стъпка 4).
- Действия срещу production данни или бази.
