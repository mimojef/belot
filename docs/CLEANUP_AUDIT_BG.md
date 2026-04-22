# Belot-V2 — почистен проект и архитектурен одит

Този архив е почистен за по-лесна подмяна и за старт на нов, чист server-authoritative gameplay runtime.

## Какво е изтрито
- `.git/`
- `node_modules/`
- `server/node_modules/`
- `server/dist/`

Тези папки са генерирани или локални и не са нужни за прехвърляне на проекта.

## Какво остава активно
- `public/` — изображения, икони, аудио
- `src/app/lobby/` — lobby / waiting room flow
- `src/app/network/` — websocket client комуникация
- `src/app/audio/` — audio controller
- `src/ui/overlays/` — profile popup и overlays
- `server/src/matchmaking/` — matchmaking логика
- `server/src/core/` — rooms / connections / reconnect основа
- `server/src/bots/` — bot profiles
- `server/database/` — DB файлове

## Какво да се третира като reference / legacy при следващата стъпка
Тези части още са вътре, но не трябва да бъдат дългосрочният source of truth за gameplay:
- `src/main.ts`
- `src/app/renderApp.ts`
- `src/app/playPrompts/`
- `src/app/animations/`
- `src/core/`
- `src/ui/center/`
- `src/ui/layout/`
- `server/src/game/`

## Целта оттук нататък
Следващата архитектурна стъпка е:
1. нов чист server-authoritative gameplay runtime
2. клиентът да праща actions и да рендерира snapshot-и
3. старият browser-driven gameplay flow да остане само за reference

## Как да пуснеш проекта след подмяна
### Клиент
```bash
npm install
npm run dev
```

### Сървър
```bash
cd server
npm install
npm run dev
```
