-- Шести цвят за покупка: Розов #DC408E (одобрен от собственика 2026-11-08).
-- Добавъчна миграция — съществуващите цветове, покупки, инвентар и срокове
-- не се променят. Един и същ каталог за ника и за текста на съобщенията.
--
-- Групата е 'purple' (CHECK-ът на group_key няма 'pink' и не се разширява):
-- в магазина цветът излиза последен — Червен, Златист, Зелен, Син, Лилав, Розов.
-- Служебният #F72585 остава забранен (CHECK + isReservedOrNearReservedStaffColor);
-- #DC408E е изрично изключение от прага за близост (виж
-- PROFILE_CUSTOMIZATION_APPROVED_NEAR_RESERVED_COLORS).

INSERT OR IGNORE INTO profile_customization_colors (color_id, hex, label, group_key, sort_order, is_active)
VALUES ('pink-1', '#DC408E', 'Розов', 'purple', 15, 1);

-- Ако цветът вече съществува (напр. под друг id), само се пуска в продажба.
UPDATE profile_customization_colors
SET is_active = 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE hex = '#DC408E' AND is_active = 0;
