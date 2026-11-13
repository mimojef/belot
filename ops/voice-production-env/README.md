# Production env на игровия VPS за гласовия чат

**Статус: подготвено, НЕ е изпълнено.** Това не е deploy.

- Новите стойности влизат в сила **едва при рестарт** на `belot-v2-server` (при deploy-а на Етап 7).
- Текущият production код не ползва тези имена, така че добавянето им предварително е безвредно.
- Гласът остава „Изключен“ (режимът по подразбиране е от базата).

| | |
|---|---|
| Игрови VPS | `185.203.117.14` |
| Файл | `/var/www/belot-v2/server/.env` (`import 'dotenv/config'` чете `.env` от cwd на PM2 процеса) |
| PM2 | `belot-v2-server`, един процес, `fork_mode` |

## Променливите

| Променлива | Стойност | Тайна |
|---|---|---|
| `LIVEKIT_API_URL` | `https://voice.pika.bg` | не |
| `LIVEKIT_WS_URL` | `wss://voice.pika.bg` | не |
| `LIVEKIT_API_KEY` | API key на LiveKit (password manager / гласовия VPS) | **да** |
| `LIVEKIT_API_SECRET` | API secret на LiveKit (≥32 знака) | **да** |
| `VOICE_ROOM_NAMESPACE` | `prod` (задължителен; без него гласът е „недостъпен“) | не |
| `VOICE_VPS_METRICS_URL` | `https://voice.pika.bg:8443` | не |
| `VOICE_VPS_METRICS_USERNAME` | `pika-metrics` | не |
| `VOICE_VPS_METRICS_PASSWORD` | паролата на Caddy маршрута (64 hex знака) | **да** |
| `VOICE_CHAT_ENABLED` | **не се задава** (препоръка) | не |

**`VOICE_CHAT_ENABLED`** е само авариен стоп (`0`). Отмяната му изисква рестарт. Без нея функционалността се управлява от админ панела, а по подразбиране е „Изключено“.

**Правила:**
- Тайните се въвеждат с `read -rs`: не се показват, не влизат в shell history и не минават като аргумент на процес.
- Не ги поставяй в чат, тикети или screenshots.
- Нищо не се рестартира.

Изпълни командите като **root** на игровия VPS, в **една SSH сесия**, стъпка по стъпка.

### 1. Проверки (само четене)
```bash
cd /var/www/belot-v2/server && pwd
pm2 jlist | jq -r '.[] | select(.name=="belot-v2-server") | "cwd=\(.pm2_env.pm_cwd) status=\(.pm2_env.status)"'
```
```bash
stat -c 'inode=%i mode=%a owner=%U:%G size=%s' .env
grep -oE '^(LIVEKIT_[A-Z_]+|VOICE_[A-Z_]+)=' .env || echo "няма гласови променливи в .env"
```
```bash
pm2 jlist | jq -r '.[] | select(.name=="belot-v2-server") | .pm2_env | keys[]' | grep -E '^(LIVEKIT_|VOICE_)' || echo "PM2 env: няма гласови имена"
git -C /var/www/belot-v2 check-ignore -q server/.env && echo ".env е игнориран от Git" || echo "ВНИМАНИЕ: .env не е в .gitignore"
```
Очаква се:
- `cwd=/var/www/belot-v2/server`;
- `.env` с права `600` (ако са по-широки — `chmod 600 .env`);
- няма гласови променливи в `.env` и в PM2 env;
- `.env` е игнориран от Git.

Ако в PM2 env вече има такива имена, **спри**: `dotenv` не ги презаписва.

### 2. Резервно копие
```bash
ENV_BAK=.env.bak-voice-$(date +%Y%m%d-%H%M%S)
cp -a .env "$ENV_BAK" && cmp .env "$ENV_BAK" && echo "backup OK: $ENV_BAK"
```

### 3. Помощни функции (отказват при вече съществуващо име; гарантират нов ред в края)
```bash
[ -z "$(tail -c1 .env)" ] || echo >> .env
addvar() { if grep -q "^$1=" .env; then echo "$1 вече съществува — пропускам"; else printf '%s=%s\n' "$1" "$2" >> .env; echo "$1 добавен"; fi; }
addsecret() { if grep -q "^$1=" .env; then echo "$1 вече съществува — пропускам"; return; fi; local v; read -rsp "$1 (не се показва): " v; echo; if [ -z "$v" ]; then echo "празно — пропускам"; return; fi; printf '%s=%s\n' "$1" "$v" >> .env; echo "$1 добавен (${#v} знака)"; v=; }
```

### 4. Нетайни стойности
```bash
addvar LIVEKIT_API_URL https://voice.pika.bg
addvar LIVEKIT_WS_URL wss://voice.pika.bg
addvar VOICE_ROOM_NAMESPACE prod
```
```bash
addvar VOICE_VPS_METRICS_URL https://voice.pika.bg:8443
addvar VOICE_VPS_METRICS_USERNAME pika-metrics
```

### 5. Тайни (поставяш стойността, когато бъдеш попитан; нищо не се показва)
```bash
addsecret LIVEKIT_API_KEY
```
```bash
addsecret LIVEKIT_API_SECRET
```
```bash
addsecret VOICE_VPS_METRICS_PASSWORD
```

### 6. Проверка без извеждане на стойности
```bash
awk '/^(LIVEKIT_|VOICE_)/{n=$0; sub(/=.*/,"",n); v=$0; sub(/^[^=]*=/,"",v); print n, "дължина=" length(v), (v ~ /^[A-Za-z0-9._~+\/=:-]+$/ ? "ok" : "НЕОБИЧАЙНИ ЗНАЦИ")}' .env
```
```bash
diff <(grep -vE '^(LIVEKIT_|VOICE_)' "$ENV_BAK") <(grep -vE '^(LIVEKIT_|VOICE_)' .env) && echo "останалите редове са непроменени"
stat -c 'mode=%a owner=%U:%G' .env
```
Очаква се:
- 8 реда, всички `ok`;
- `LIVEKIT_API_SECRET` с дължина ≥32, `VOICE_VPS_METRICS_PASSWORD` с дължина 64;
- „останалите редове са непроменени“;
- права `600`.

### 7. Проверка на паролата за метриките (стойността от `.env`, без да се показва)
```bash
( umask 077; awk '/^VOICE_VPS_METRICS_PASSWORD=/{sub(/^[^=]*=/,""); print "machine voice.pika.bg login pika-metrics password " $0}' .env > /root/.pika-m.netrc )
curl -s --netrc-file /root/.pika-m.netrc -o /dev/null -w 'метрики с паролата от .env: %{http_code}\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics; rm -f /root/.pika-m.netrc
```
Очаква се `200`.

### 8. Проверка на LiveKit ключовете (стойностите от `.env`, без да се показват)
Node подписва локално JWT само с право `roomList` и вика `ListRooms` за несъществуващо име. Това само чете, без стаи и без участници. Не се ползват външни пакети, а ключът и тайната не минават като аргументи.
```bash
node -e 'const fs=require("fs"),c=require("crypto");const e={};for(const l of fs.readFileSync(".env","utf8").split("\n")){const m=/^(LIVEKIT_API_(?:KEY|SECRET|URL))=(.*)$/.exec(l.trim());if(m)e[m[1]]=m[2]}const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const t=Math.floor(Date.now()/1000);const h=b({alg:"HS256",typ:"JWT"}),p=b({iss:e.LIVEKIT_API_KEY,sub:"pika-env-check",nbf:t-10,exp:t+60,video:{roomList:true}});const s=c.createHmac("sha256",e.LIVEKIT_API_SECRET||"").update(h+"."+p).digest("base64url");fetch(e.LIVEKIT_API_URL+"/twirp/livekit.RoomService/ListRooms",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+h+"."+p+"."+s},body:JSON.stringify({names:["pika_env_check_nonexistent"]}),signal:AbortSignal.timeout(5000)}).then(r=>console.log("LiveKit API с ключовете от .env: HTTP "+r.status)).catch(x=>console.log("грешка: "+x.name))'
```
Очаква се `HTTP 200`. При `401` key или secret е грешен: поправи реда (стъпка 9) и повтори.

### 9. Поправка или rollback (процесът не е рестартиран — играта не се засяга)
- **Поправка на една тайна:** `sed -i '/^LIVEKIT_API_SECRET=/d' .env`, после отново `addsecret LIVEKIT_API_SECRET`.
- **Пълен rollback:** `cp -a "$ENV_BAK" .env && echo "върнат backup"`.

## Откъде са LiveKit key/secret
- Пазят се на гласовия VPS. Тестовият инструмент `ops/voice-livekit-it` ги чете от `/opt/livekit/secrets.env`.
- Най-безопасно е да ги поставиш от password manager-а.
- Ако ги няма там, ги прочети на гласовия VPS **само на собствения си екран**, без копия в чат, файлове или screenshots. Запиши ги в password manager-а, после изчисти екрана (`clear`).
- Имената им (без стойностите) се проверяват с:
  ```bash
  sudo grep -oE '^[A-Z_]+=' /opt/livekit/secrets.env
  ```

## След това (Етап 7 — deploy с изключен глас, отделно одобрение)
- `npm ci` в `server/` и в root на production checkout-а. Deploy скриптът не инсталира зависимости, а `livekit-server-sdk` и `livekit-client` са нови.
- Backend deploy (`scripts/deploy-backend-production.sh`, с backup на миграциите) и frontend deploy (`scripts/deployFrontendAtomic.sh`).
- При старта backend-ът:
  - прилага добавящите миграции;
  - режимът е „Изключено“;
  - прави еднократен boot sweep: `ListRooms` за `pv_prod_*` (празно).
- В админ панела трябва да се вижда:
  - „LiveKit — Конфигурирано“;
  - „Метрики на гласовия VPS — Конфигурирано“;
  - табът „Гласов VPS“ работи.
