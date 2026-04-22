# План за следващ чат

## Цел
Да не се кръпят повече едновременно browser-driven и server-driven gameplay flow-ове.

## Правилен ред
1. Запазваме lobby / matchmaking / profiles / assets.
2. Не местим повече логика на парче в текущия browser runtime.
3. Проектираме чист server-authoritative gameplay runtime.
4. Строим нов runtime слой на сървъра файл по файл.
5. После връзваме клиента към gameplay snapshots.

## Важно
Старите client gameplay файлове и текущият `server/src/game/` трябва да се ползват само като reference, докато новият runtime не е готов.
