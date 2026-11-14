# Версия на LiveKit за админ панела (гласовия VPS)

**Статус:** скриптът, systemd unit-ите и тестът са готови. **На гласовия VPS не е инсталирано.**

## Защо

LiveKit (v1.13.11) не публикува версията си в своите Prometheus метрики. Затова раздел „Гласов VPS“ в админ панела показваше „Недостъпно“. Реалната версия се взима от **самия работещ контейнер**:

```
docker exec lk-server /livekit-server --version   ->   livekit-server version 1.13.11
```

Скриптът я записва като метрика за **съществуващия** Node Exporter textfile collector (Node Exporter 1.7.0, `127.0.0.1:9100`, директория `/var/lib/prometheus/node-exporter`). Backend-ът я чете от **същия** Node Exporter отговор, който вече взима през Caddy маршрута `/pika-ops/node-metrics`.

- Без нови HTTP заявки, без нови портове, без клиентска телеметрия, без hardcoded версия.
- Без рестарт на LiveKit, Caddy или Node Exporter. Textfile collector-ът чете `*.prom` файловете при всяко четене.

## Какво се записва

`/var/lib/prometheus/node-exporter/pika_livekit_version.prom` — атомично (temp файл в същата директория + `mv`), права `0644`:

```
pika_livekit_build_info{version="1.13.11"} 1
pika_livekit_version_check_success 1
pika_livekit_version_check_timestamp_seconds <unix time на проверката>
```

- **При грешка** файлът се презаписва **без** `pika_livekit_build_info` и със `success 0`: контейнерът не работи, docker липсва или изтича timeout от 20 s, неочакван изход. Скриптът излиза с код 1 и причината отива в journal-а. **Старата версия никога не остава като актуална.**
- **Проверка за актуалност (backend):** версията се показва само при `success 1` и timestamp, не по-стар от **15 минути** спрямо `node_time_seconds` на VPS-а. Ако таймерът спре, версията сама изчезва до „Недостъпно“.
- Версията се приема само във формат `X.Y.Z` (по желание с `-rc.1` и т.н.), до 64 знака. Произволен текст не може да влезе в етикета.

## Файлове

| В repo | На гласовия VPS |
|---|---|
| `pika-livekit-version-textfile` | `/usr/local/sbin/pika-livekit-version-textfile` (0755, root) |
| `systemd/pika-livekit-version.service` | `/etc/systemd/system/` (0644) |
| `systemd/pika-livekit-version.timer` | `/etc/systemd/system/` (0644) — `OnCalendar=*:0/5` |
| `check-pika-livekit-version-textfile.mjs` | — (тест на dev машината, с stub за docker) |

Услугата е `oneshot`, като root (нужен за `docker exec`), с `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome=read-only`.

## Тест (dev машина)

```bash
node ops/voice-livekit-version/check-pika-livekit-version-textfile.mjs
cd server && node node_modules/tsx/dist/cli.mjs scripts/checkVoiceLiveKitVersion.ts
```

## Инсталация (гласовия VPS, като root)

**0. Проверки (само четене):**
```bash
docker inspect --format '{{.State.Running}}' lk-server
docker exec lk-server /livekit-server --version
ls -ld /var/lib/prometheus/node-exporter
ls -l /var/lib/prometheus/node-exporter/
curl -s 127.0.0.1:9100/metrics | grep -E '^node_textfile_scrape_error'
ls -l /usr/local/sbin/pika-livekit-version-textfile /etc/systemd/system/pika-livekit-version.* 2>&1
```

**1. Копиране** (от dev машината, в корена на repo-то):
```bash
ssh root@<voice-vps> 'mkdir -p /root/pika-lkv'
scp ops/voice-livekit-version/pika-livekit-version-textfile \
    ops/voice-livekit-version/systemd/pika-livekit-version.service \
    ops/voice-livekit-version/systemd/pika-livekit-version.timer \
    root@<voice-vps>:/root/pika-lkv/
```
На VPS-а: `sha256sum /root/pika-lkv/*` трябва да съвпадне с хешовете от прегледа, а `grep -c $'\r' /root/pika-lkv/*` — да е `0` за всички файлове (без CRLF).

**2. Инсталиране и една ръчна проверка:**
```bash
install -m 0755 -o root -g root /root/pika-lkv/pika-livekit-version-textfile /usr/local/sbin/
install -m 0644 -o root -g root /root/pika-lkv/pika-livekit-version.service /etc/systemd/system/
install -m 0644 -o root -g root /root/pika-lkv/pika-livekit-version.timer   /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/pika-livekit-version.service /etc/systemd/system/pika-livekit-version.timer
systemctl daemon-reload
systemctl start pika-livekit-version.service
systemctl status --no-pager pika-livekit-version.service | head -5
cat /var/lib/prometheus/node-exporter/pika_livekit_version.prom
curl -s 127.0.0.1:9100/metrics | grep -E '^(pika_livekit_|node_textfile_scrape_error)'
```
Очаквано: `pika_livekit_build_info{version="1.13.11"} 1`, `pika_livekit_version_check_success 1` и `node_textfile_scrape_error 0`.

**3. Таймер:**
```bash
systemctl enable --now pika-livekit-version.timer
systemctl list-timers pika-livekit-version.timer --no-pager
```

Админ панелът показва версията след deploy на backend-а с новия парсер.

## Rollback

```bash
systemctl disable --now pika-livekit-version.timer
rm -f /etc/systemd/system/pika-livekit-version.service /etc/systemd/system/pika-livekit-version.timer
systemctl daemon-reload
rm -f /usr/local/sbin/pika-livekit-version-textfile
rm -f /var/lib/prometheus/node-exporter/pika_livekit_version.prom
rm -rf /root/pika-lkv
```
След rollback панелът отново показва „Недостъпно“. Нищо друго не се засяга: LiveKit, Caddy, Node Exporter и останалите метрики остават непроменени.
