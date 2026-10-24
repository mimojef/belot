# Аварийна nginx защита на личните качени файлове

**Статус: ВРЕМЕННА защитна мярка, активна на production.**
Правилата са в [`nginx-private-uploads-emergency-block.conf`](nginx-private-uploads-emergency-block.conf) — точно копие на приложеното на VPS. Пълната production nginx конфигурация умишлено НЕ е в Git (server-специфични настройки, сертификати, домейни).

## Какво се случи

nginx сервираше директно от диска, **без потребителско удостоверяване**, пет директории под `/uploads/`. Всяка от тях връщаше HTTP 206 при директна заявка:

| Директория | Съдържание |
|---|---|
| `/uploads/chat-attachments/` | снимки от личните разговори |
| `/uploads/support-attachments/` | снимки към поддръжката |
| `/uploads/topic-mute-evidence-attachments/` | evidence копия за модерация |
| `/uploads/profile-gallery/` | галериите на профилите |
| `/uploads/topic-attachments/` | снимки към публикации и отговори в Теми и Лафче |

В активната конфигурация (`/etc/nginx/sites-enabled/belot-v2` към момента на инцидента) ръчно са добавени `location ^~ ... { return 403; }` блокове:

1. **При инцидента — първите четири** (chat, support, evidence, gallery). Проверено след `nginx -t` и `systemctl reload nginx`: четирите директории → **403**, публичен аватар → 206, начална страница → 200.
2. **След одита на Теми — петото** (`topic-attachments`, с коментар `# Protect attachments from Topics and Lafche`). Проверено: `nginx -t` без предупреждения, reload успешен, nginx active; съществуващ файл → **403** и през `https://pika.bg`, и през `https://www.pika.bg`.

Причината за петото правило: Темите са само за регистрирани, а снимките им се отдават през удостоверения `/api/topics/...` маршрут (виж по-долу). Директният nginx alias заобикаляше тези проверки. Особено важно е за самоизтриването: през 45-дневния период публикациите на профила са скрити в приложението, но файловете им остават на диска и без блокировката биха били достъпни по URL за всеки, запазил името на файла.

## Какво блокира и легитимния достъп

- **`/uploads/profile-gallery/`** — до commit `fix(profile): restore secure gallery image access` клиентът зареждаше снимките от галерията директно по този URL и **докато блокировката е активна, галериите не се показваха на никого** (собственик или посетител ги виждаше само от браузърния кеш, защото по-рано файловете се отдаваха с `immutable` дълъг кеш). От този commit сървърът дава на клиента URL `/api/profiles/:profileId/gallery/:imageId`; Node чете файла по записания ред в базата, със същите правила за видимост като профила (скрит/изтрит профил → 404, блокиране → 403), `Cache-Control: private, no-cache` + `ETag`. Node вече не отдава `/uploads/profile-gallery/` и сам. **Правилото с 403 остава** — то е част от трайното решение (директният път не трябва да връща съдържание).
- **`chat-attachments`, `support-attachments`, `topic-mute-evidence-attachments`, `topic-attachments`** — приложението ги зарежда през удостоверени endpoint-и, които Node чете директно от диска (не през nginx alias-а):
  - чат и поддръжка — `/api/.../attachments/...`;
  - Теми и Лафче — `/api/topics/:topicId/attachments/:file` (`handleTopicAttachmentDownloadRequest` в `server/src/index.ts`: регистрирана сесия, файлът трябва да принадлежи на темата, авторът не е скрит заради заявка за самоизтриване). Клиентът (`src/`) и сървърът никога не генерират `/uploads/topic-attachments/` URL;
  - evidence копия — `/api/topics/mute-evidence/attachments/...` (само модератори). Старите evidence записи без копие сочат оригиналния файл в `topic-attachments` и също минават през `/api/topics/...`.

  Блокировката по `/uploads/...` не би трябвало да ги засяга, но **функционалната проверка на production е задължителна** (виж „Функционална проверка“ по-долу).
- Остават публични по замисъл: `/uploads/avatars/`, `/uploads/gift-items/`, `/uploads/ad-campaigns/`, `/uploads/campaign-themes/`.

## Кога може да се премахне

**Нито едно от петте правила не се премахва**, преди трайното решение с удостоверен достъп (галерия и лични файлове само през Node с проверка на сесия/видимост, вкл. скриване при заявка за самоизтриване) да е:

1. внедрено на production и
2. проверено: директен `/uploads/...` към личните директории не връща съдържание, а легитимните изгледи работят.

Само тогава правилата се махат (или заменят), отделно и с нов backup.

## Не се прилага автоматично

`scripts/deploy-production.sh`, `deploy-backend-production.sh` и `deploy-frontend-production.sh` не пипат `/etc/nginx/` и не правят reload/restart на nginx. Така трябва и да остане: тази защита се прилага само ръчно, по процедурата по-долу.

## Ръчно прилагане (нов VPS или възстановяване от backup)

Всички команди са на VPS-а, като root или със `sudo`.

### 1. Намери реално активния конфигурационен файл

Не приемай, че `sites-enabled/` съдържа symlink към `sites-available/`. Там може да има обикновен файл (копие), а в `nginx.conf` може да има и други `include`.

```bash
# Всички файлове, които nginx реално зарежда (в реда на зареждане):
sudo nginx -T 2>/dev/null | grep '^# configuration file'

# Кои директории/шаблони се включват автоматично:
sudo nginx -T 2>/dev/null | grep -nE '^\s*include\s'

# Тип на записите в sites-enabled (symlink ли са и накъде сочат):
sudo ls -la /etc/nginx/sites-enabled/
for f in /etc/nginx/sites-enabled/*; do echo "$f -> $(readlink -f "$f")"; done

# Кой файл съдържа server блока на сайта и location-а за /uploads/:
sudo nginx -T 2>/dev/null | grep -nE '^# configuration file|server_name|location[^{]*/uploads'
```

Редактира се **файлът, към който реално сочи** записът в `sites-enabled/` (`readlink -f`). Ако е обикновен файл, редактира се самият той.

### 2. Backup — само извън директориите, които nginx зарежда

Backup в `sites-enabled/`, `conf.d/` или в която и да е директория от `include` реда по-горе се зарежда като **втора активна конфигурация**. Резултатът е дублирани `server_name` (вече се е случвало) или по-лошо. Пази backup-ите извън `/etc/nginx/`:

```bash
ACTIVE_CONF="$(readlink -f /etc/nginx/sites-enabled/belot-v2)"   # името според стъпка 1
sudo mkdir -p /root/nginx-config-backups
sudo chmod 700 /root/nginx-config-backups
sudo cp -a "$ACTIVE_CONF" "/root/nginx-config-backups/$(basename "$ACTIVE_CONF").$(date -u +%Y%m%dT%H%M%SZ)"
sudo ls -la /root/nginx-config-backups/

# Контролна проверка: в /etc/nginx не трябва да има забравени копия
sudo find /etc/nginx -maxdepth 2 \( -name '*.bak' -o -name '*backup*' -o -name '*.orig' -o -name '*~' \) -print
```

### 3. Добави правилата

Постави петте `location` блока от `nginx-private-uploads-emergency-block.conf` **вътре** в `server { ... }` блока, който обслужва сайта (HTTPS блокът с `server_name` на pika.bg и съществуващия `location /uploads/`). Ако сайтът се обслужва от повече от един такъв server блок (напр. отделни блокове за `www` и без `www`), правилата трябват във всеки от тях. Блок, който само пренасочва към HTTPS, не ги изисква.

Редът спрямо другите `location` блокове няма значение: за `^~` префикси nginx избира най-дългото съвпадение и не проверява regex location-ите. Не махай `^~`.

Алтернатива без копиране на текст: файлът се слага в `/etc/nginx/snippets/` (обикновено не се зарежда автоматично, провери със стъпка 1) и в server блока се добавя `include snippets/nginx-private-uploads-emergency-block.conf;`. **Никога** в `conf.d/` или `sites-enabled/`: там би се заредил на ниво `http`.

### 4. Провери синтаксиса и презареди (без restart)

```bash
sudo nginx -t && sudo systemctl reload nginx
systemctl is-active nginx
```

При грешка от `nginx -t` не прави reload. Върни backup-а (стъпка 6).

### 5. Проверка след прилагане

Вземи реални имена на файлове от диска. Пътят до `uploads/` се вижда от `root`/`alias` на `location /uploads/` в стъпка 1, например `/var/www/belot-v2/server/uploads`:

```bash
UPLOADS=/var/www/belot-v2/server/uploads   # според стъпка 1
code() { curl -s -o /dev/null -w '%{http_code}' -r 0-0 "$1"; }

for dir in chat-attachments support-attachments topic-mute-evidence-attachments topic-attachments; do
  f="$(sudo ls "$UPLOADS/$dir" 2>/dev/null | head -1)"
  [ -n "$f" ] && echo "$dir: $(code "https://pika.bg/uploads/$dir/$f")   # очаквано 403"
done
g="$(sudo find "$UPLOADS/profile-gallery" -type f | head -1)"
[ -n "$g" ] && echo "profile-gallery: $(code "https://pika.bg/uploads/profile-gallery/${g#"$UPLOADS/profile-gallery/"}")   # очаквано 403"
a="$(sudo ls "$UPLOADS/avatars" | head -1)"
echo "avatar: $(code "https://pika.bg/uploads/avatars/$a")   # очаквано 200/206"
echo "home: $(code https://pika.bg/)   # очаквано 200"
```

Повтори проверката и за `https://www.pika.bg/`, ако домейнът се обслужва.

### Функционална проверка (задължителна след прилагане)

Блокировките трябва да спират само директния `/uploads/...` достъп, не и приложението. С влязъл потребител в браузъра:

1. **Лафче** — снимка към публикация се показва, отваря се на цял екран и се сваля.
2. **Обикновена тема в „Общи“** — снимка към root публикация и към отговор се показва, отваря и сваля.
3. **Нова публикация със снимка** в Лафче и в тема — качва се и се вижда веднага, вкл. от друг потребител.
4. **Личен разговор (Чат)** и **поддръжка** — снимките се показват.
5. **Модератор** — evidence изгледът към заглушаване показва снимката (и при копие, и при стар запис без копие).
6. **Галерия на профил** (след commit `fix(profile): restore secure gallery image access`) — снимките се показват на собственика и на друг влязъл потребител (вкл. в инкогнито прозорец, без стар кеш); заявките са към `/api/profiles/<id>/gallery/<imageId>` и връщат 200; директен `/uploads/profile-gallery/...` връща 403.
7. В DevTools → Network: заявките за снимки са към `/api/...` и връщат 200. Нито една не е към `/uploads/topic-attachments/`, `/uploads/chat-attachments/`, `/uploads/profile-gallery/` и т.н.

Преди тази версия на приложението галериите на профилите не се показваха (виж по-горе). Всяко счупено изображение след нея означава, че блокировката засяга легитимна функция: докладвай, преди да променяш правилата.

Кеш: файловете под `/uploads/` се отдаваха с дълъг кеш (`immutable`). Вече изтеглени копия могат да останат в браузърите и в евентуален CDN/proxy кеш. Ако има CDN, изчисти кеша за петте префикса.

### 6. Връщане назад (само при счупена конфигурация)

```bash
sudo cp -a /root/nginx-config-backups/<файл>.<timestamp> "$ACTIVE_CONF"
sudo nginx -t && sudo systemctl reload nginx
```

Връщането **маха и защитата**. Използвай го само ако nginx не стартира/презарежда, след което приложи правилата наново.
