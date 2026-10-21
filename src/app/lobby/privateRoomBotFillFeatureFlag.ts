// Feature flag за бутона "Запълни с бот" в чакалнята на частна маса (Белот).
//
// Временно изключен — бутонът не се рендира изобщо (без празно място).
// Само UI visibility: сървърната логика за добавяне/махане на бот
// (add_bot_to_private_room_team / remove_bot_from_private_room_team) остава
// непокътната. За възстановяване: смени стойността на true.
//
// "Махни бот" остава видим, ако в отбора вече има бот (напр. маса, създадена
// преди изключването), за да не остане бот, който собственикът не може да махне.
export const BELOT_PRIVATE_BOT_FILL_ENABLED = false

let flagOverrideForTests: boolean | undefined

export function isBelotPrivateBotFillEnabled(): boolean {
  return flagOverrideForTests ?? BELOT_PRIVATE_BOT_FILL_ENABLED
}

export function __setBelotPrivateBotFillOverrideForTests(value: boolean | undefined): void {
  flagOverrideForTests = value
}
