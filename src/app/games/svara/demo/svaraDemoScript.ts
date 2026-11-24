// Свара — статичните пътища до ресурсите, наследени от анимационното демо.
//
// Самостоятелното демо е премахнато. Тук остават само пътищата, които
// истинската игра ползва (table/svaraTableAssets.ts): гърбът на картата,
// placeholder аватарите и пътищата на лицата на картите. Файлът запазва
// името си (без преименуване в тази задача).

export const SVARA_DEMO_CARD_BACK_SRC = '/images/cards/card-back.webp'
export const SVARA_DEMO_AVATAR_SRCS = [
  '/assets/avatars/male/male-avatar-01.webp',
  '/assets/avatars/female/female-avatar-02.webp',
  '/assets/avatars/male/male-avatar-03.webp',
  '/assets/avatars/female/female-avatar-04.webp',
] as const

export const svaraCardFaceSrc = (rank: string, suit: string) => `/images/cards/${suit}/${rank}_${suit}_300x420.webp`
