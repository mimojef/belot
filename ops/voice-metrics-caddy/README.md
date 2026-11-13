# Метрики на гласовия VPS през съществуващия Caddy (Етап 6)

**Статус: внедрено на 2026-11-13.**

Защитен HTTPS маршрут, през който игровият backend на Pika.bg чете метриките на гласовия VPS за админ панела „Гласови разговори“.

**Ресурсите:**

| | |
|---|---|
| Гласов VPS | `185.203.119.211` (LiveKit/Caddy), SSH през `185.141.61.49` |
| Игрови VPS | `185.203.117.14` |
| Caddy | контейнер `lk-caddy`, образ `livekit/caddyl4:v2.11.3`, host network, RAM лимит 256 MB |
| Конфигурация | `/opt/livekit/caddy.yaml` → `/etc/caddy.yaml` (YAML, единичен файл, root:root 600); `/opt/livekit/caddy_data` → `/data` |
| Admin API | **изключено** (`admin: disabled: true`). Конфигурацията се прилага само с рестарт на `lk-caddy`. |
| Сертификати | `apps.tls.certificates.automate: [voice.pika.bg, turn.pika.bg]` (управлявани от tls app) |
| Kandido.bg | nginx на `185.141.61.49:443`. Не се засяга. |

**Защити на маршрута:**
- `pika_metrics` слуша **само на `185.203.119.211:8443`**, с HTTP/1.1 и HTTP/2 (без HTTP/3/UDP).
- Достъп има **само `185.203.117.14`**:
  - UFW пуска `8443/tcp` само от този IP;
  - Caddy проверява `remote_ip` и връща 403 за всеки друг IP;
  - **HTTP Basic** с потребител `pika-metrics` и bcrypt с `hash_cache`.
- Метриките **остават на loopback**: `127.0.0.1:6789` (LiveKit) и `127.0.0.1:9100` (Node Exporter).
- Паролата е **само** в password manager-а и в `server/.env` на игровия VPS. На гласовия VPS стои само bcrypt хешът. Никога в Git, чат, screenshots или логове.

Игровият backend чете маршрута само докато админ панелът е отворен: веднъж на 20 s, с timeout 4 s, никога от игровия hot path. При липса или недостъпност панелът показва „Недостъпно“.

| Път | Upstream |
|---|---|
| `GET https://voice.pika.bg:8443/pika-ops/livekit-metrics` | `127.0.0.1:6789/metrics` |
| `GET https://voice.pika.bg:8443/pika-ops/node-metrics` | `127.0.0.1:9100/metrics` |

Всичко друго връща 404 (от игровия VPS с парола), 401 (без парола) или 403 (от друг IP; иначе UFW вече го е спрял).

**Файлове тук:**
- [caddy-yaml-block.yaml](caddy-yaml-block.yaml) — **внедреният вариант**: един ред (JSON в YAML flow стил), добавен в края на `caddy.yaml` под `apps:`. Вместо реалния хеш съдържа `<BCRYPT_HASH>`.
- [caddy-http-server.json](caddy-http-server.json) — същият сървър за JSON конфигурация (за справка).
- [Caddyfile.snippet](Caddyfile.snippet) — алтернатива за Caddyfile. **Не се ползва** на гласовия VPS.

**Защо порт 8443, а не път под `:443`.** Портът `:443` се обслужва от layer4 маршрута (TLS → `127.0.0.1:7880`). HTTP разделяне по път там решава по първата заявка на TLS връзката. Игровият backend обаче преизползва keep-alive връзките за един и същ origin. Така Twirp заявки към LiveKit и заявки за метрики биха се смесили. Отделният порт е отделен origin, а LiveKit пътят остава непокътнат.

---

## Внедрена процедура (за повторение или за нов VPS)

**Правила:**
- Работи се в **една SSH сесия**, защото стъпките ползват shell променливи.
- Кандидатът се валидира във **временен контейнер** без мрежа и без достъп до сертификатите. Работещият `lk-caddy` не се пипа до стъпка 8.
- Монтираният файл се записва **на място** (същият inode). Затова не се ползват `mv` и `sed -i`, иначе контейнерът ще вижда стария файл.

### 1. Предварителни проверки (само четене)
```bash
F=/opt/livekit/caddy.yaml
IMG=$(sudo docker inspect lk-caddy --format '{{.Config.Image}}'); echo "image=$IMG"
sudo awk '/^[^ #]/{k=$0} END{print "последен top-level ключ: " k}' $F
sudo grep -c '^  http:' $F
sudo tail -c1 $F | od -An -c
sudo stat -c 'inode=%i mode=%a owner=%U:%G size=%s' $F
```
Очаква се:
- последен top-level ключ `apps:`;
- `0` (няма `http` app);
- `\n` (файлът завършва с нов ред).

### 2. Резервно копие
```bash
BAK=/opt/livekit/caddy.yaml.bak-$(date +%Y%m%d-%H%M%S)
sudo cp -a $F "$BAK" && sudo cmp $F "$BAK" && echo "backup OK: $BAK"
```

### 3. Парола (показва се веднъж → password manager → `clear`)
```bash
PASS=$(openssl rand -hex 32); echo "$PASS"
```

### 4. bcrypt хеш (временен контейнер; хешът не се показва)
```bash
HASH=$(printf '%s\n' "$PASS" | sudo docker run --rm -i --network none --entrypoint caddy "$IMG" hash-password)
case "$HASH" in '$2a$'*|'$2b$'*) echo "хеш OK (${#HASH} знака)";; *) echo "ГРЕШКА";; esac
unset PASS
```

### 5. Кандидат
```bash
NEW=/opt/livekit/caddy.yaml.new
sudo cp -a $F $NEW && sudo cmp $F $NEW && echo "копие OK"
```

### 6. Добавяне на блока (последният ред от [caddy-yaml-block.yaml](caddy-yaml-block.yaml))
`<BCRYPT_HASH>` се замества в shell-а. Хешът не минава през `sh -c`, затова `$` в него не се интерпретира. При внедряването редът беше добавен на четири части с `printf ... | sudo tee -a $NEW` (за безопасно поставяне в терминал), със същото съдържание. Ако копие на [caddy-yaml-block.yaml](caddy-yaml-block.yaml) е на VPS-а, еквивалентът е:
```bash
LINE=$(tail -n 1 caddy-yaml-block.yaml)        # от копие на този файл на VPS-а
printf '%s\n' "${LINE/<BCRYPT_HASH>/$HASH}" | sudo tee -a $NEW >/dev/null; unset HASH LINE
```

### 7. Проверки на кандидата
```bash
SIZE=$(sudo stat -c %s $F); sudo cmp -n "$SIZE" $F $NEW && echo "първите $SIZE байта са идентични"
sudo wc -l $F $NEW
sudo docker run --rm --network none --tmpfs /data --tmpfs /config -v $F:/etc/caddy.yaml:ro --entrypoint caddy "$IMG" validate --config /etc/caddy.yaml --adapter yaml
sudo docker run --rm --network none --tmpfs /data --tmpfs /config -v $NEW:/etc/caddy.yaml:ro --entrypoint caddy "$IMG" validate --config /etc/caddy.yaml --adapter yaml
sudo docker run --rm --network none -v $NEW:/etc/caddy.yaml:ro --entrypoint caddy "$IMG" adapt --config /etc/caddy.yaml --adapter yaml 2>/dev/null | grep -oE '"listen":\[[^]]*\]|"protocols":\[[^]]*\]|"hash_cache":\{\}|"dial":"127\.0\.0\.1:(6789|9100)"|"ranges":\["185\.203\.117\.14/32"\]' | sort | uniq -c
```
- И двете валидирания трябва да дадат `Valid configuration`.
- Структурата трябва да показва двата listen-а (`:443` и `:8443`), `h1`/`h2`, `hash_cache`, двата `dial`-а и `ranges`.
- Ако нещо не мине, **спри**. Нищо не е променено.

### 8. Прилагане (запис на място + рестарт на Caddy; LiveKit не се рестартира)
```bash
sudo stat -c 'inode=%i' $F
sudo sh -c 'cat /opt/livekit/caddy.yaml.new > /opt/livekit/caddy.yaml'
sudo stat -c 'inode=%i' $F              # същият inode
sudo docker restart lk-caddy
```
Рестартът прекъсва за няколко секунди WSS и TURN/TLS на `185.203.119.211:443`. Kandido не се засяга.

### 9. Проверка на гласовия VPS (преди UFW)
```bash
sudo docker ps --format '{{.Names}}\t{{.Status}}' | grep lk-
sudo ss -lntup | grep ':8443'          # само tcp на 185.203.119.211:8443
curl -s -o /dev/null -w 'voice 443: %{http_code}\n' https://voice.pika.bg/                     # 200
curl -s -o /dev/null -w 'twirp: %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://voice.pika.bg/twirp/livekit.RoomService/ListRooms   # 401
echo | timeout 5 openssl s_client -connect turn.pika.bg:443 -servername turn.pika.bg 2>/dev/null | openssl x509 -noout -enddate
curl -s -o /dev/null -w '8443 от гласовия VPS: %{http_code}\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics   # 403
```

### 10. UFW
```bash
sudo ufw allow proto tcp from 185.203.117.14 to 185.203.119.211 port 8443 comment 'pika voice metrics'
sudo ufw status numbered | grep -E '8443|pika'
```

### 11. Проверка от игровия VPS (паролата е в netrc файл, не в командата)
```bash
curl -s -o /dev/null -w 'без парола: %{http_code}\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics      # 401
umask 077; read -rsp 'Парола: ' p; echo; printf 'machine voice.pika.bg login pika-metrics password %s\n' "$p" > /root/.pika-voice-metrics.netrc; unset p
curl -s --netrc-file /root/.pika-voice-metrics.netrc -o /dev/null -w 'livekit: %{http_code} %{size_download}B\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics   # 200
curl -s --netrc-file /root/.pika-voice-metrics.netrc -o /dev/null -w 'node: %{http_code} %{size_download}B\n' https://voice.pika.bg:8443/pika-ops/node-metrics       # 200
curl -s --netrc-file /root/.pika-voice-metrics.netrc -o /dev/null -w 'друг път: %{http_code}\n' https://voice.pika.bg:8443/metrics                                   # 404
rm -f /root/.pika-voice-metrics.netrc
```

### Rollback
```bash
sudo sh -c 'cat /opt/livekit/caddy.yaml.bak-<TS> > /opt/livekit/caddy.yaml'
sudo docker restart lk-caddy
sudo ufw status numbered       # правилото 'pika voice metrics'
sudo ufw delete <номер>
sudo ss -lntup | grep ':8443' || echo "8443 е затворен"
```
На игровия VPS: премахни `VOICE_VPS_METRICS_*` от `server/.env` и рестартирай при следващия deploy. Панелът ще показва „Недостъпно“, а гласът и играта не се засягат.

---

## Резултат от внедряването (2026-11-13)

- Backup: `/opt/livekit/caddy.yaml.bak-20261113-191226`.
- Оригиналната конфигурация е запазена (същите байтове + един добавен ред). Inode-ът е запазен.
- Оригиналът и кандидатът са валидирани.
- Caddy е рестартиран успешно. LiveKit **не е** рестартиран.
- На гласовия VPS:
  - LiveKit HTTPS 200;
  - LiveKit API без подпис 401;
  - TURN сертификатът е валиден до 10.02.2027;
  - неоторизиран IP получава 403;
  - UFW пуска `8443/tcp` само от `185.203.117.14`.
- От игровия VPS: без парола 401; LiveKit metrics 200 (96 041 B); Node metrics 200 (147 525 B); друг път 404.

## Какво НЕ прави маршрутът

- Не отваря Prometheus endpoint публично и не променя LiveKit, TURN, Node Exporter или Kandido.bg.
- Не дава достъп до аудио, стаи или участници. Метриките са агрегирани броячи на сървъра.
- Не е зависимост на играта. Ако е недостъпен, само панелът показва „Недостъпно“.
