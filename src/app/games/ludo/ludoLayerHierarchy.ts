// Global Ludo layers. Modal UI is portalled to document.body so these values
// are compared in the same root stacking context as gameplay effects.
export const LUDO_GAME_SCREEN_Z_INDEX = 500
// Виж task-а "emoji cleanup убива pawn move animation" — moving/trail
// pieces-ите на playLudoMoveRouteOverlay.ts преди живееха ВЪТРЕ в board-овия
// `[data-ludo-effects-overlay="1"]` div (част от options.root markup-а),
// значи всеки generic render() (включ. emoji reaction cleanup, viewer
// popover toggle, gift/spectator updates) ги detach-ваше по средата на
// анимацията чрез innerHTML replace. Fix-нато да mirror-ват established
// document.body-hosted pattern-а на playLudoCaptureFlightOverlay.ts/dice
// overlay-я — под CAPTURE_FLIGHT (move-route анимацията винаги приключва
// ПРЕДИ евентуален capture flight/impact за същия ход), над game screen-а.
export const LUDO_MOVE_ROUTE_Z_INDEX = 7_500
// Trail-ът стои леко под движещата се пионка (mirror на старата relative
// разлика moving z-index:80 vs trail z-index:60).
export const LUDO_MOVE_ROUTE_TRAIL_Z_INDEX = 7_480
export const LUDO_CAPTURE_FLIGHT_Z_INDEX = 8_000
export const LUDO_CAPTURE_IMPACT_Z_INDEX = 8_500
export const LUDO_EMOJI_REACTION_Z_INDEX = 8_800
export const LUDO_DICE_OVERLAY_Z_INDEX = 9_000
// Виж task-а "Ludo подаръци" — gift flight-ът е под modal layer-а (mirror
// на Belot's table gift z-index scheme: flight=60 < modal=65), за да не
// прекрачи евентуален вече отворен popup, но над dice overlay-я (полетът
// трябва да се вижда над board-а/dice-а).
export const LUDO_GIFT_FLIGHT_Z_INDEX = 9_100
export const LUDO_MODAL_LAYER_Z_INDEX = 10_000
// Самостоятелен document.body child (НЕ nested в modalLayerRoot, mirror на
// Belot's table gift modal, който също живее directно в document.body) —
// малко над MODAL_LAYER_Z_INDEX, за да е винаги достъпен gift picker-ът,
// дори докато друг in-layer popup (bot takeover и т.н.) е отворен.
export const LUDO_GIFT_MODAL_Z_INDEX = 10_050
export const LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX = 1
