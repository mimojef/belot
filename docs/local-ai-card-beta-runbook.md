# Local AI Card Beta — Ръководство за ръчно локално тестване

Този документ описва как да пуснеш **локална** beta сесия с AI card-play candidate-а
(`server/src/ai/localAiCardBeta.ts`), да я тестваш ръчно с ботове, и после да прегледаш
какво е решил AI-ят спрямо conventional bot-а.

**Обхват: само local. Няма production промяна тук.**

- Не се пипа production `.env`, production база данни или production сървър.
- Не се прави deploy, SSH или каквато и да е remote операция.
- AI beta и trace-ът са изцяло **off по подразбиране** — този runbook описва как
  временно да ги включиш ЛОКАЛНО, за твоя собствена dev машина.
- Bidding винаги остава conventional bot — AI candidate-ът засяга **само**
  card-play решения на bot местата.

---

## A) Предпоставки

Local repo: `D:\Project\Belot-V2`

Нужен е model artifact (local-only, никога не се commit-ва):

```
training-output\models\card-model-v1\model.json
```

Провери дали съществува:

```powershell
Test-Path D:\Project\Belot-V2\training-output\models\card-model-v1\model.json
```

Ако върне `False`, генерирай/провери целия pipeline от `server\`:

```powershell
cd D:\Project\Belot-V2\server
npm run train:card-model
npm run test:card-model-inference
npm run simulate:ai-card-candidate
npm run check:local-ai-card-beta
npm run check:local-ai-card-beta-trace
```

Ако някоя от тези команди фейлне (non-zero exit), **не продължавай** към beta тест —
виж съответния `*-summary.md` в `training-output/models/card-model-v1/` за причината.

---

## B) Стартиране на backend с AI beta ON и trace ON

Всичко се задава като environment variables **само в текущата PowerShell сесия**
(не се пипа `server\.env`). Отваряш нов PowerShell прозорец за backend-а:

```powershell
cd D:\Project\Belot-V2\server

$env:LOCAL_AI_CARD_BETA_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_TRACE_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_MODEL_PATH = "D:\Project\Belot-V2\training-output\models\card-model-v1\model.json"
$env:LOCAL_AI_CARD_BETA_TRACE_PATH = "D:\Project\Belot-V2\training-output\local-ai-beta\card-decisions.jsonl"
```

По желание — изчисти стар trace log преди нов тест (само ако искаш чист summary за
тази конкретна сесия; иначе новите редове просто ще се append-нат към стария файл):

```powershell
Remove-Item -Path "D:\Project\Belot-V2\training-output\local-ai-beta\card-decisions.jsonl" -ErrorAction SilentlyContinue
```

Провери, че env vars са заредени в тази сесия:

```powershell
Get-ChildItem Env:LOCAL_AI_CARD_BETA_*
```

---

## B2) Тестване на `card-model-v2` вместо `card-model-v1` (по избор)

`card-model-v2` е по-богат feature set (виж `training-output/models/card-model-v2/metrics.md`
за пълни метрики) — offline измерено, значително по-добър при **lead** решения от v1
(non-forced test lead accuracy ≈51% срещу ≈37.5% за v1), при почти same follow accuracy.
**Default моделен път остава v1** — v2 се тества само ако изрично зададеш друг
`LOCAL_AI_CARD_BETA_MODEL_PATH`:

```powershell
cd D:\Project\Belot-V2\server

$env:LOCAL_AI_CARD_BETA_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_TRACE_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_MODEL_PATH = "D:\Project\Belot-V2\training-output\models\card-model-v2\model.json"
$env:LOCAL_AI_CARD_BETA_TRACE_PATH = "D:\Project\Belot-V2\training-output\local-ai-beta\card-decisions.jsonl"
```

Ако `training-output/models/card-model-v2/model.json` липсва, генерирай го (от `server/`):

```powershell
npm run train:card-model-v2
npm run test:card-model-v2-inference
npm run simulate:ai-card-v2-candidate
```

Забележка: `LOCAL_AI_CARD_BETA_MODEL_PATH` е единственото нещо, което избира версията —
`server/src/ai/cardModelInference.ts` разпознава `modelVersion` от самия `model.json` файл
(`card-model-v1` или `card-model-v2`) и автоматично ползва правилния feature set. Няма
отделен env флаг за версия — не се включва в production по никакъв начин.

---

## C) Стартиране на backend + frontend

Реалните npm scripts от repo-то (не са измислени — виж `server\package.json` и
root `package.json`):

**Terminal 1 — backend** (в същия terminal, където зададе env vars от секция B):

```powershell
cd D:\Project\Belot-V2\server
npm run dev
```

Това стартира `tsx watch src/index.ts` — локалният WebSocket/HTTP сървър.

**Terminal 2 — frontend** (нов, отделен terminal — env vars от backend-а не са
нужни тук, клиентът не чете `LOCAL_AI_CARD_BETA_*`):

```powershell
cd D:\Project\Belot-V2
npm run dev
```

Това стартира Vite dev сървъра (по подразбиране `http://localhost:5173`, съвпада
с `CLIENT_ORIGIN` в `server/.env.example`).

Отвори `http://localhost:5173` в браузъра.

---

## D) Ръчно тестване

1. Влез локално в играта, както обичайно (locally, не production URL).
2. Започни/влез в маса, в която поне едно място се контролира от bot (напр.
   бързо търсене на маса, или стая с ботове на празните места — според текущия
   matchmaking UI на клиента; това не се променя от този runbook).
3. Изиграй 1–2 пълни ръце (bidding → раздаване → игра на карти).
4. Какво да очакваш:
   - **Bidding** — изцяло conventional bot, без промяна.
   - **Card-play на bot места** — AI candidate-ът участва само тук.
   - По-видимо AI влияние очаквай при **follow** ситуации (когато bot-ът следва
     чужда боя) — там AI моделът показа значително по-висока точност спрямо
     baseline-ите в офлайн оценките, при И v1, И v2. При **lead** (bot-ът води
     трик): с v1 очаквай по-слабо/по-неутрално влияние (офлайн ≈37.5% test
     accuracy); с `card-model-v2` (виж B2) lead поведението е измеримо
     по-силно (офлайн ≈51% test accuracy) — ако тестваш v2, очаквай по-видима
     разлика и при lead, не само при follow.
   - Forced ходове (само 1 legal карта) винаги изглеждат същите, независимо от
     AI флага — няма реален избор там.

Ако видиш каквото и да е нередно (invalid карта изиграна, замръзнала стая,
crash на сървъра) — спри теста веднага и виж [Safety бележки](#h-safety-бележки)
по-долу.

---

## E) Обобщаване на trace-а

След тестовата сесия (можеш да спреш backend-а или да го оставиш пуснат — trace
файлът вече е записан на диска):

```powershell
cd D:\Project\Belot-V2\server
npm run summarize:local-ai-card-beta-trace
```

Отвори резултата:

```
training-output\local-ai-beta\summary.md
```

(Машинно-четимата версия е `training-output\local-ai-beta\summary.json`.)

---

## F) Как да се интерпретира summary-то

| `decisionSource` | Значение |
|---|---|
| `ai_accepted` | AI е избрал различна от conventional, валидна карта — тя е изиграна. |
| `ai_same_as_conventional` | AI е избрал същата карта като conventional bot-а. |
| `conventional_fallback` | AI не е използван успешно (липсващ/повреден model, exception, invalid AI избор) — изиграна е conventional картата. |
| `forced_card` | Само 1 legal карта — няма реален избор, AI флагът е без значение тук. |
| `ai_disabled` | AI флагът е бил OFF по време на това решение. |

Важни проверки в summary-то:

- **Invalid final cards трябва винаги да е `0`.** Ако не е — виж
  [Safety бележки](#h-safety-бележки), спри и докладвай.
- **Fallback count може легитимно да е `0`** (означава AI моделът е зареден и
  работил безпроблемно през цялата сесия). Ако има fallback-и — виж
  `fallbackReasonCounts` в summary-то за конкретната причина (напр. изтрит
  model файл по средата на сесията).
- `aiAcceptedRateExcludingForced` показва колко често AI-ят реално е повлиял на
  избора (изключвайки тривиалните forced ходове).

---

## G) Как да изключиш AI beta (връщане към conventional)

**Вариант 1 — нов terminal без env vars** (най-безопасно и най-просто):

Просто отвори чисто нов PowerShell прозорец (env vars от секция B са
session-scoped, не съществуват там) и пусни backend-а нормално:

```powershell
cd D:\Project\Belot-V2\server
npm run dev
```

**Вариант 2 — explicit unset в текущата сесия:**

```powershell
Remove-Item Env:LOCAL_AI_CARD_BETA_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:LOCAL_AI_CARD_BETA_TRACE_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:LOCAL_AI_CARD_BETA_MODEL_PATH -ErrorAction SilentlyContinue
Remove-Item Env:LOCAL_AI_CARD_BETA_TRACE_PATH -ErrorAction SilentlyContinue
```

Потвърди, че default поведението е conventional:

```powershell
Get-ChildItem Env:LOCAL_AI_CARD_BETA_*
```

(трябва да не върне нищо) — рестартирай backend-а (`npm run dev`) след това, за
да е сигурно, че новата (изчистена) среда се използва.

---

## H) Safety бележки

- **Production не се пипа тук по никакъв начин** — всичко в този runbook е
  локални команди, локални файлове, локален browser session.
- **Production `.env` не се пипа** — env vars се задават само в PowerShell
  сесията (`$env:...`), не в `server/.env`.
- **Generated файлове не се commit-ват:** `training-output/` (включително
  `training-output/models/` и `training-output/local-ai-beta/`) е в
  `.gitignore`. Никога не прави `git add` върху тях.
- **Ако видиш invalid final card, crash или "заседнала" стая по време на beta
  теста:**
  1. Спри теста веднага (Ctrl+C на backend terminal-а е достатъчно локално).
  2. НЕ продължавай да тестваш върху същата session/room.
  3. Пусни `npm run summarize:local-ai-card-beta-trace` и провери
     `invalidFinalCards`/`invalidAiPredictions` в `summary.json`.
  4. Докладвай находката (кой decisionSource, кой fallbackReason, кога/при
     каква ръка) — не се опитвай сам да променяш `localAiCardBeta.ts`
     поведението без review.

---

## Бърза справка (командна лента)

```powershell
# 1) Provери model artifact
Test-Path D:\Project\Belot-V2\training-output\models\card-model-v1\model.json

# 2) Включи AI beta + trace (в terminal-а за backend)
cd D:\Project\Belot-V2\server
$env:LOCAL_AI_CARD_BETA_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_TRACE_ENABLED = "true"
$env:LOCAL_AI_CARD_BETA_MODEL_PATH = "D:\Project\Belot-V2\training-output\models\card-model-v1\model.json"
$env:LOCAL_AI_CARD_BETA_TRACE_PATH = "D:\Project\Belot-V2\training-output\local-ai-beta\card-decisions.jsonl"
npm run dev

# 3) Frontend (отделен terminal)
cd D:\Project\Belot-V2
npm run dev

# 4) След теста — обобщи trace-а
cd D:\Project\Belot-V2\server
npm run summarize:local-ai-card-beta-trace

# 5) Изключи AI beta — просто нов terminal без env vars, или:
Remove-Item Env:LOCAL_AI_CARD_BETA_ENABLED,Env:LOCAL_AI_CARD_BETA_TRACE_ENABLED,Env:LOCAL_AI_CARD_BETA_MODEL_PATH,Env:LOCAL_AI_CARD_BETA_TRACE_PATH -ErrorAction SilentlyContinue
```

Опционален PowerShell helper, който автоматизира стъпки 1-2 (проверка на model
artifact + създаване на trace директория + задаване на env vars):
`scripts/local-ai/start-local-ai-card-beta.ps1` (виж коментарите в началото на
файла за наличните параметри).
