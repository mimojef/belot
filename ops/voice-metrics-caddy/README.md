# Метрики на гласовия VPS през съществуващия Caddy (Етап 6)

Защитен HTTPS маршрут, през който игровият backend на Pika.bg чете метриките на гласовия VPS за админ панела „Гласови разговори“.

- **Без** Prometheus, Grafana, SSH тунел или нови услуги. Ползва се само съществуващият контейнер `lk-caddy`.
- Метриките **остават на loopback**: `127.0.0.1:6789` (LiveKit) и `127.0.0.1:9100` (Node Exporter). Caddy само ги проксира.
- Достъпът има три защити:
  - UFW пуска `8443/tcp` само от игровия VPS `185.203.117.14`;
  - Caddy приема само `remote_ip` `185.203.117.14` (иначе връща 403);
  - отделна HTTP Basic автентикация; на гласовия VPS се пази само bcrypt хеш.
- Паролата живее **само** в `server/.env` на игровия VPS. Никога в Git, чат, screenshots, логове или frontend.
- Игровият backend чете метриките само докато админ панелът е отворен: веднъж на 20 s, с timeout 4 s, никога от игровия hot path. Когато маршрутът липсва или е недостъпен, панелът показва „Недостъпно“.

| Път | Upstream |
|---|---|
| `GET https://voice.pika.bg:8443/pika-ops/livekit-metrics` | `127.0.0.1:6789/metrics` |
| `GET https://voice.pika.bg:8443/pika-ops/node-metrics` | `127.0.0.1:9100/metrics` |

Всичко друго връща 404 (от игровия VPS) или 403 (от друг IP).

**Защо порт 8443, а не път под `:443`.** Портът `:443` се обслужва от layer4 маршрута, който подава декриптирания поток към LiveKit. HTTP разделяне по път там решава по първата заявка на всяка TLS връзка. Игровият backend обаче преизползва keep-alive връзките за един и същ origin. Така връзка, отворена за метрики, може да получи по-късна Twirp заявка към LiveKit API-то (и обратно). Отделният порт е отделен origin с отделни връзки, а LiveKit пътят на `:443` не се пипа.

> Този документ е подготвен **без достъп** до реалната конфигурация на `lk-caddy`. Двата фрагмента ([Caddyfile.snippet](Caddyfile.snippet) и [caddy-http-server.json](caddy-http-server.json)) трябва да се слеят с нея. Препоръката е първо да изпълниш read-only проверките (стъпка 0) и да изпратиш изхода им без тайни. Тогава мога да подготвя точния diff спрямо твоята конфигурация.

---

## 0. Read-only проверки (нищо не се променя)

```bash
# Формат на конфигурацията (Caddyfile или JSON) и как е стартиран контейнерът
sudo docker inspect lk-caddy --format '{{json .Config.Cmd}} {{json .Config.Entrypoint}} {{json .Mounts}}'

# Нужните модули (layer4 + стандартните http модули)
sudo docker exec lk-caddy caddy list-modules | grep -E '^(layer4|http\.handlers\.(reverse_proxy|authentication|rewrite)|http\.authentication\.providers\.http_basic|http\.matchers\.remote_ip)$'

# Портът 8443 е свободен
sudo ss -lntp | grep ':8443 ' || echo "8443 е свободен"

# Как се управлява сертификатът за voice.pika.bg (същият ще се ползва и на 8443)
sudo docker exec lk-caddy caddy adapt --config <път до конфигурацията> 2>/dev/null | grep -o '"automation"[^]]*]' | head -1

# UFW (текущи правила)
sudo ufw status numbered
```

Какво търсим в изхода:
- **Конфигурацията** е или Caddyfile (с глобален блок `layer4 { … }`), или JSON. От това зависи кой фрагмент се ползва.
- **Модулите** `http.handlers.reverse_proxy`, `http.handlers.authentication` и `http.matchers.remote_ip` присъстват. Те са стандартни за всеки Caddy build.
- **Сертификатът** за `voice.pika.bg` вече се управлява от Caddy (tls app). Новият HTTPS сървър на `:8443` ползва **същия** сертификат от storage-а, без ново издаване.
  - Ако сертификатът е външен файл (`load_files` / `tls cert key`), фрагментът се допълва с `tls <cert> <key>` (Caddyfile) или с `tls_connection_policies` към същия сертификат (JSON).

---

## 1. Парола и bcrypt хеш

На **гласовия VPS**:

```bash
# Силна случайна парола (32 байта). Запиши я само в password manager-а.
openssl rand -base64 32

# bcrypt хеш — командата пита интерактивно, паролата не остава в history
sudo docker exec -it lk-caddy caddy hash-password
```

Хешът (`$2a$14$…`) се слага в конфигурацията на Caddy на мястото на `<BCRYPT_HASH>`. Самата парола отива само в `server/.env` на игровия VPS (стъпка 5) по защитен канал. **Никога** в чат, Git или screenshots.

---

## 2. Резервно копие на текущата конфигурация

```bash
sudo cp -a <път до Caddyfile или caddy.json> <същия път>.bak-$(date +%Y%m%d-%H%M%S)
```

---

## 3. Добавяне на маршрута

**Caddyfile.** Добави съдържанието на [Caddyfile.snippet](Caddyfile.snippet) като **нов** site блок в края на файла. Глобалният `layer4` блок и останалите блокове не се пипат.

**JSON.** Добави обекта `pika_metrics` от [caddy-http-server.json](caddy-http-server.json) в `apps.http.servers`. Ключът `_comment` е само пояснение и не се копира. Ако `apps.http` липсва, създай го с `{"servers": {"pika_metrics": …}}`.

Валидиране **преди** reload:

```bash
sudo docker exec lk-caddy caddy validate --config <път> --adapter caddyfile   # за Caddyfile
sudo docker exec lk-caddy caddy validate --config <път>                       # за JSON
```

Ако validate отчете грешка, **не продължавай**. Върни резервното копие (стъпка 7).

Reload без прекъсване на текущите връзки:

```bash
sudo docker exec lk-caddy caddy reload --config <път> [--adapter caddyfile]
```

---

## 4. UFW — само от игровия VPS

```bash
sudo ufw allow proto tcp from 185.203.117.14 to any port 8443 comment 'pika voice metrics'
sudo ufw status numbered
```

С Docker host networking UFW филтрира порта нормално (няма Docker NAT, който да го заобиколи).

---

## 5. Конфигурация на игровия backend

Добави в `server/.env` на **игровия VPS**:

```
VOICE_VPS_METRICS_URL=https://voice.pika.bg:8443
VOICE_VPS_METRICS_USERNAME=pika-metrics
VOICE_VPS_METRICS_PASSWORD=<паролата от стъпка 1>
```

- Приема се само `https://` (`http://` е разрешено единствено за loopback тестове).
- URL-ът е без потребител, парола, query и hash.
- Без тези три променливи панелът показва „Метриките на гласовия VPS не са конфигурирани“, а всички показатели са „Недостъпно“.

Променливите се прочитат при старт на процеса, затова е нужен рестарт на `belot-v2-server` (при deploy).

---

## 6. Проверка (от игровия VPS)

```bash
# Без автентикация -> 401
curl -s -o /dev/null -w '%{http_code}\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics

# С автентикация -> 200. Паролата е в netrc файл с права 600, не в командата
#   /root/.pika-voice-metrics.netrc:
#   machine voice.pika.bg login pika-metrics password <паролата>
curl -s --netrc-file /root/.pika-voice-metrics.netrc https://voice.pika.bg:8443/pika-ops/livekit-metrics | grep -c '^livekit_'
curl -s --netrc-file /root/.pika-voice-metrics.netrc https://voice.pika.bg:8443/pika-ops/node-metrics | grep -E '^node_(cpu_seconds_total|memory_MemTotal_bytes|boot_time_seconds) ' | head -3

# Непознат път -> 404
curl -s -o /dev/null -w '%{http_code}\n' --netrc-file /root/.pika-voice-metrics.netrc https://voice.pika.bg:8443/metrics

# LiveKit на :443 е непроменен -> 401 (Twirp без подпис)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://voice.pika.bg/twirp/livekit.RoomService/ListRooms

rm -f /root/.pika-voice-metrics.netrc   # след проверката
```

От **друг** IP (например домашния компютър):

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' https://voice.pika.bg:8443/pika-ops/livekit-metrics
```

Очаква се timeout или connection refused заради UFW. Ако UFW временно не филтрира, отговорът е 403 от Caddy.

В админ панела „Гласови разговори“ → „Гласов VPS“ статусът трябва да е „Работи“. CPU и трафикът се изчисляват от второто четене (~20 s след отварянето).

---

## 7. Rollback

```bash
sudo cp -a <резервното копие> <път до конфигурацията>
sudo docker exec lk-caddy caddy reload --config <път> [--adapter caddyfile]
sudo ufw status numbered          # намери правилото 'pika voice metrics'
sudo ufw delete <номер>
```

На игровия VPS премахни трите `VOICE_VPS_METRICS_*` променливи. Панелът ще показва „Недостъпно“, а гласът и играта не се засягат.

---

## Какво НЕ прави маршрутът

- Не отваря Prometheus endpoint публично и не променя LiveKit, TURN, Node Exporter или Kandido.bg.
- Не дава достъп до аудио, стаи или участници. Метриките са агрегирани броячи на сървъра.
- Не е зависимост на играта. Ако е недостъпен, само панелът показва „Недостъпно“.
