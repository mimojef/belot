# Production Shadow Trace — Ръководство за безопасно активиране

Този документ описва как да се активира **production-safe shadow observation
trace mode** (`server/src/ai/localAiCardShadowTrace.ts`,
`LOCAL_AI_CARD_SHADOW_TRACE_ENABLED`) на production сървъра, за да се събират
реални shadow decisions от живи игри — **без каквато и да е промяна в
реалния gameplay**.

**Този документ е само ръководство/checklist.** Той не изпълнява deploy, SSH,
или каквато и да е remote операция сам по себе си — командите тук се пускат
ръчно от оператор, който вече има достъп до production машината.

---

## A) Какво прави shadow mode

- **Conventional bot-ът винаги играе реалната карта** — `pickServerBotPlayCard`
  (непроменен) решава final selected card, точно както преди тази функция да
  съществува.
- **Advisor v0** (`server/src/ai/cardAdvisorPolicy.ts`) се изчислява само като
  observation — "какво би избрал", никога не override-ва final картата.
- **Rule E2** (`server/src/ai/cardAdvisorSignalRuleE2.ts`) се изчислява само
  като observation — същото: никога не override-ва final картата.
- Резултатът се записва в отделен JSONL trace файл
  (`LOCAL_AI_CARD_SHADOW_TRACE_PATH`), напълно отделен от recorder writer-а и
  от client protocol-а.
- **Няма промяна в gameplay** при правилно зададени production flags — виж
  секция Б по-долу за точния списък.
- Trace записването е fail-safe: try/catch на всяко ниво (observation
  computation, JSON serialization, файлов I/O) — exception никъде не може да
  стигне до game loop-а или да промени избраната карта.

---

## Б) Production env flags

> ⚠️ **Do NOT enable these in production shadow mode:**
> - `LOCAL_AI_CARD_BETA_ENABLED=true`
> - `LOCAL_AI_CARD_BETA_TRACE_ENABLED=true`
> - `LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED=true`
>
> **Recommended production shadow env:**
> - `LOCAL_AI_CARD_SHADOW_TRACE_ENABLED=true`
> - `LOCAL_AI_CARD_SHADOW_TRACE_PATH=/var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl`

Забележка: горните три `LOCAL_AI_CARD_BETA_*` реда по-горе НЕ са
препоръчителни стойности за копиране — те са изрично изброени в "Do NOT
enable" списъка, за да е недвусмислено кои точно env vars трябва да останат
`false`/unset. Единствените стойности, които реално трябва да се сложат в
production `.env`, са двата реда под "Recommended production shadow env".

### Да се включат САМО тези (safe to copy-paste в production `.env`):

```
LOCAL_AI_CARD_SHADOW_TRACE_ENABLED=true
LOCAL_AI_CARD_SHADOW_TRACE_PATH=/var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
```

### Тези трябва да останат `false`/unset (НЕ копирай `=true` от тук — това е списък с флагове, които не трябва да се задават):

- `LOCAL_AI_CARD_BETA_ENABLED` → трябва да е `false`/unset
- `LOCAL_AI_CARD_BETA_TRACE_ENABLED` → трябва да е `false`/unset
- `LOCAL_AI_CARD_BETA_RULE_E2_TRACE_ENABLED` → трябва да е `false`/unset

Тези три флага управляват **beta advisor mode**, при който advisor v0 РЕАЛНО
може да смени картата на бота (доказано полезно офлайн, но все още не
достатъчно тествано за production — виж локалните beta trace анализи в
`training-output/local-ai-beta/`). Production shadow collection **не се
нуждае** от тях — shadow mode е архитектурно напълно независим (проверено в
`server/scripts/checkLocalAiShadowTrace.ts`, тест `[I2]`: shadow трасира
коректно дори когато `LOCAL_AI_CARD_BETA_ENABLED` изобщо не е зададен).

---

## В) Преди deploy

Изпълнява се ръчно от оператор с production достъп, **преди** да се пусне
новия код:

1. **SQLite backup** — направи пълен backup на production базата, преди
   каквато и да е промяна:
   ```bash
   npm run backup:db:prod
   ```
   (виж `server/scripts/backupDatabase.ts` — вече съществуващ, независим от
   тази задача mechanism.)

2. **Запиши текущия production HEAD**, за да имаш точна rollback точка:
   ```bash
   git rev-parse HEAD > /tmp/pre-deploy-head.txt
   cat /tmp/pre-deploy-head.txt
   ```

3. **Провери working tree clean на production** — не трябва да има локални
   несинхронизирани промени на production машината:
   ```bash
   git status --short
   ```
   Ако не е празно — спри, разследвай преди да продължиш.

4. **npm install / build checks** (в `server/`):
   ```bash
   npm ci
   npm run build
   ```

5. **Server build проверка** — увери се, че `dist/index.js` е актуален след
   build-а (виж стъпка 4).

6. **`PRAGMA integrity_check`** на SQLite базата (read-only проверка, не
   променя данни):
   ```bash
   sqlite3 /var/www/belot-v2/server/data/production.db "PRAGMA integrity_check;"
   ```
   (адаптирай пътя до реалния production `.db` файл.)

7. **PM2 status** — провери текущото състояние на процеса преди рестарт:
   ```bash
   pm2 status
   pm2 logs belot-v2-server --lines 50 --nostream
   ```

8. **`/health` before** — увери се, че сървърът вече отговаря нормално преди
   каквато и да е промяна:
   ```bash
   curl -s https://<production-host>/health
   ```

---

## Г) Rollback идея

Ако нещо тръгне зле след активиране на shadow trace:

1. **Rollback към предишния production HEAD**:
   ```bash
   git checkout "$(cat /tmp/pre-deploy-head.txt)"
   npm ci
   npm run build
   ```

2. **`pm2 restart`**:
   ```bash
   pm2 restart belot-v2-server
   ```

3. **`/health` check** — потвърди, че сървърът отново отговаря нормално:
   ```bash
   curl -s https://<production-host>/health
   ```

4. **DB restore само ако има реален DB проблем** — shadow trace **никога не
   прави DB writes** (изцяло отделен JSONL файлов механизъм, никаква връзка
   със SQLite), затова DB restore не би трябвало изобщо да е необходим заради
   тази промяна. Направи DB restore единствено ако независимо от shadow
   trace-а установиш реална database повреда (напр. `PRAGMA integrity_check`
   връща грешка) — в такъв случай възстанови от backup-а от стъпка В.1.

---

## Д) След deploy

1. **Провери, че сървърът е online**:
   ```bash
   pm2 status
   curl -s https://<production-host>/health
   ```

2. **Провери, че trace файлът се създава** след реални bot card decisions
   (изисква поне една игра с bot места да е играна след deploy-а):
   ```bash
   ls -la /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
   ```

3. **Провери размер и брой редове** (виж [Disk safety бележки](#е-disk-safety-бележки)
   по-долу за пълните команди):
   ```bash
   du -h /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
   wc -l /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
   ```

4. **Провери за errors в PM2 logs**:
   ```bash
   pm2 logs belot-v2-server --lines 200 --nostream | grep -i "local-ai-card-shadow-trace"
   ```
   Очаквано: единствено информативния startup лог
   (`LOCAL_AI_CARD_SHADOW_TRACE_ENABLED=true — production-safe shadow
   observation active, logging to ...`) — никакви повтарящи се warning
   redове за trace write failures (ако виждаш такива непрекъснато, виж
   [Disk safety бележки](#е-disk-safety-бележки), директорията/permissions
   вероятно имат проблем).

5. **Потвърждение, че gameplay няма промяна** — изиграй/наблюдавай няколко
   реални ръце: bidding, deal, играене на карти — всичко трябва да изглежда
   абсолютно същото, както преди тази промяна. Ако видиш каквото и да е
   нередно (invalid карта, различно поведение на бот) — това е **критичен**
   сигнал, направи rollback незабавно (секция Г) и докладвай.

---

## Е) Disk safety бележки

**Не е имплементирана автоматична ротация на trace файла в тази задача** —
съзнателно решение, за да не се раздува обхватът. Това означава:

⚠️ **`card-decisions.jsonl` ще расте неограничено**, докато shadow trace
остане включен — всяко bot card решение добавя един JSON ред. При активна
production трафик, файлът може да стане голям за дни/седмици. Оператор трябва
периодично ръчно да проверява размера и, ако е нужно, да архивира/изтрие
старите данни (или да спре временно trace-а), докато не се добави истинска
ротация в бъдеща задача.

Примерни команди за проверка на размер (Linux, адаптирай пътя):

```bash
du -h /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
wc -l /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
```

Преглед на последните няколко записа (без да отваряш целия файл):

```bash
tail -n 3 /var/www/belot-v2/training-output/local-ai-shadow/card-decisions.jsonl
```

---

## Ж) Safety бележки (обобщение)

- Production `.env` файлът се редактира ръчно от оператора, само с горните 2
  флага — тази задача/документ не пипа `.env` автоматично.
- Shadow trace е read-only observation + append-only локален файлов запис —
  никакви DB writes, никакви client protocol промени, никакви промени в
  recorder writer-а.
- `pickServerBotPlayCard.ts` (conventional bot логиката) остава напълно
  непроменен от цялата shadow trace архитектура.
- Ако видиш каквото и да е неочаквано поведение след активиране — незабавен
  rollback (секция Г), после разследване, преди повторен опит.
