# Агресивно почистване — browser gameplay преместен в legacy

Този вариант е по-агресивен от safe cleanup.

## Какво е направено
- Преместени са browser-driven gameplay файловете в:
  `legacy/browser-gameplay-reference/`
- Оставени са активни:
  - lobby
  - matchmaking
  - network client
  - audio assets
  - profile popup
  - server, matchmaking, protocol, DB и bot profile основата

## Преместени в legacy
- `src/main.ts`
- `src/app/bootstrap.ts`
- `src/app/renderApp.ts`
- `src/app/runPlayingBotsUntilHumanTurn.ts`
- `src/app/playPrompts/**`
- `src/app/animations/**`
- `src/core/**`
- `src/ui/center/**`
- `src/ui/layout/**`

## Важно
Този zip вече НЕ е запазен като работещ browser gameplay build.
Той е подготвен за clean server-authoritative посока, като старият gameplay е запазен за reference.

## Следваща стъпка
В новата архитектура:
- server runtime става source of truth
- client рендерира snapshot-и
- старите gameplay файлове се ползват само за справка
