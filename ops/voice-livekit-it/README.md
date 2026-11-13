# Реални интеграционни тестове срещу LiveKit (гласов чат на Pika.bg)

Самостоятелен инструмент. **Не е част от приложението.** Не се deploy-ва с Pika и няма зависимости в основния проект.

- Ползва официалните SDK-та:
  - `livekit-server-sdk` **2.19.2** — RoomService API и токени, същата версия като backend-а;
  - `@livekit/rtc-node` **1.2.1** — истински WebRTC участници.
- Звукът и видеото са **синтетични**: тон 440/660 Hz и сив кадър. Без микрофон, камера или браузър.
- Правата в токените и в `UpdateParticipant` са **точно** тези на backend-а (`server/src/voice/voiceTokenIssuer.ts`, `voiceLiveKitApi.ts`).

## Безопасност

- **Креденшъли:** `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET` се четат само от env (`/opt/livekit/secrets.env` на гласовия VPS). Не се печатат и не се записват. JWT също не се печатат и не се записват. Грешките се маскират (`<jwt>`, `<secret>`, `<key>`).
- **Стаи:**
  - всички са `itest-<runId>-NN-<тест>`, извън production namespace `pv_<namespace>_…`;
  - инструментът **отказва** да пипне стая без собствения си префикс;
  - почиства само собствените си стаи — и при грешка, и при Ctrl+C;
  - изоставена стая LiveKit затваря сам след 120 s (`empty_timeout`).
- **Данни:** без игрови профили и без база. Identity-тата са синтетични (`itest-…`).
- **Натоварване:** най-много 4–6 едновременни участника, по 1 аудио поток на говорещ. Контейнерът е ограничен до 1 vCPU / 1 GB.

## Тестове

| # | Проверка | Резултат |
|---|---|---|
| 1 | Authenticated RoomService API (валиден / грешен / липсващ подпис) | PASS/FAIL |
| 2 | `auto_create:false` — токен за несъществуваща стая | PASS/FAIL |
| 3 | Non-VIP (`canPublish:false`) не публикува аудио | PASS/FAIL |
| 4 | VIP публикува микрофон; другият чува звук (RMS) | PASS/FAIL |
| 5 | VIP без видео, екран, звук от екран и data | PASS/FAIL |
| 6 | Максимум 4 участници | PASS/FAIL |
| 7 | `UpdateParticipant` слушател → говорещ без нова връзка | PASS/WARN/FAIL |
| 8 | `UpdateParticipant` отнемане от активно говорещ (звукът спира, слушането остава) | PASS/FAIL |
| 9 | Mute поток на Pika: отнемане + ротация; стар publish токен безполезен; нов токен само за слушане | PASS/FAIL |
| 10 | RemoveParticipant + повторно влизане със същия токен | INFO |
| 11 | Стар JWT след DeleteRoom (+ наблюдение: възкресено име) | PASS/FAIL |
| 12 | LiveKit refresh токен след DeleteRoom; валидност спрямо хоризонта от 20 min | PASS/WARN/FAIL (дълъг, ~5–7 min) |
| 13 | Ротация и изолация на генерациите | PASS/FAIL |
| 14 | DUPLICATE_IDENTITY; различни епохи съжителстват | PASS/FAIL |
| 15 | DeleteRoom на несъществуваща стая | INFO |
| 16 | `revokeTokenTs` при RemoveParticipant | INFO |

INFO е наблюдение. Пише и как резултатът се отнася до дизайна на Pika.

## Изпълнение на гласовия VPS (собственикът, през SSH)

Нужни са само Docker (вече е там) и интернет за `node` образа и npm пакетите. Нищо не се инсталира на хоста. LiveKit, Caddy, UFW и Kandido не се пипат.

### 1. Пакетиране локално (Git Bash, от корена на проекта)
```bash
tar --exclude=node_modules --exclude=results -czf voice-livekit-it.tgz -C ops voice-livekit-it
sha256sum ops/voice-livekit-it/run.mjs ops/voice-livekit-it/package-lock.json
scp voice-livekit-it.tgz <ssh-потребител>@185.141.61.49:/tmp/
```

### 2. Разопаковане на VPS-а
```bash
sudo install -d -m 700 /opt/livekit/tests
sudo tar -xzf /tmp/voice-livekit-it.tgz -C /opt/livekit/tests && rm /tmp/voice-livekit-it.tgz
sudo sha256sum /opt/livekit/tests/voice-livekit-it/run.mjs /opt/livekit/tests/voice-livekit-it/package-lock.json
# сумите трябва да съвпадат с локалните
sudo sed 's/=.*/=<скрито>/' /opt/livekit/secrets.env
# трябва да има LIVEKIT_API_KEY и LIVEKIT_API_SECRET; стойностите не се показват
```
Ако имената в `secrets.env` са други — кажи ми само **имената**.

### 3. Проверка на Kandido преди теста
Функцията `kcheck` е от плана за инсталация. Пусни я веднъж и запиши времената.

### 4. Образ и зависимости (еднократно)
```bash
# Път към инструмента — този, в който е разопакован (при първото изпълнение файловете бяха директно в /opt/livekit/tests)
IT_DIR=/opt/livekit/tests/voice-livekit-it

sudo docker pull node:24-bookworm-slim
sudo docker image inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
# в следващите команди може да се ползва точният digest вместо тага

sudo docker run --rm --network host --cpus 1 --memory 1g --pids-limit 256 -e NODE_ENV=production \
  -v "$IT_DIR":/it -w /it node:24-bookworm-slim npm ci --omit=dev --no-audit --no-fund
sudo docker run --rm -e NODE_ENV=production -v "$IT_DIR":/it -w /it node:24-bookworm-slim node run.mjs --self-check
# очаквано: "self-check OK" (без мрежа и без креденшъли)
```

### 5. Тестове (без дългия, ~3–4 min)

> **CA bundle е задължителен.** `node:24-bookworm-slim` няма системни root CA сертификати. Нативният WebRTC слой на `@livekit/rtc-node` (Rust) чете само системното хранилище, затова без тях `wss://voice.pika.bg` пада с `no native root CA certificates found`. Решението е да монтираш CA bundle-а на хоста **само за четене** и да зададеш `SSL_CERT_FILE`. **TLS проверката НЕ се изключва.** Алтернатива е образ с инсталиран пакет `ca-certificates`.

```bash
IT_DIR=/opt/livekit/tests/voice-livekit-it
sudo docker run --rm --network host \
  --cpus 1 --memory 1g --pids-limit 256 \
  --env-file /opt/livekit/secrets.env \
  -e NODE_ENV=production \
  -e IT_WS_URL=wss://voice.pika.bg \
  -e IT_API_URL=http://127.0.0.1:7880 \
  -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  --mount type=bind,source=/etc/ssl/certs/ca-certificates.crt,target=/etc/ssl/certs/ca-certificates.crt,readonly \
  -v "$IT_DIR":/it -w /it \
  node:24-bookworm-slim node run.mjs --skip-long
```
- WebSocket минава по реалния път (`wss://voice.pika.bg` → Caddy).
- API-то е локално (`127.0.0.1:7880` — достъпно само от VPS-а, заради `--network host`).
- Ако `--env-file` не приеме файла (например стойности в кавички), зареди файла в shell-а и подай `-e LIVEKIT_API_KEY -e LIVEKIT_API_SECRET` **без стойности**. Docker ги взема от средата, така че не се появяват в командния ред; останалите параметри са същите.
- Тест 2 (и проверките „стар токен е отказан“ в тестове 9, 11, 12 и 13) дава PASS **само** при потвърден отказ от сървъра (`404` / `not found`). Мрежова или TLS грешка е FAIL с `rejectionKind: network`.

### 6. Дългият тест 12 (refresh токен, ~5–7 min)
Същата команда, но накрая `node run.mjs --only=12 --long-wait-sec=420`.

### 7. След тестовете
```bash
# същата команда като в т. 5, но накрая:  node run.mjs --leftovers
# очаквано: "itest-* стаи: 0"
#   (--purge-leftovers трие САМО itest-* стаи, ако има останали от прекъснато пускане)
kcheck
sudo docker stats --no-stream lk-server lk-caddy
```
Изпрати ми конзолния изход и файла `$IT_DIR/results/itest-<runId>.json`. В тях няма токени и ключове.

### Премахване
```bash
sudo rm -rf "$IT_DIR"
sudo docker image rm node:24-bookworm-slim
```
