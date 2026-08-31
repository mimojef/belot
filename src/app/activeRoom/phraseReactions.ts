export type PhraseReaction = {
  id: string
  text: string
}

export const PHRASE_REACTIONS: PhraseReaction[] = [
  { id: 'phrase_01', text: 'Браво, майсторе!' },
  { id: 'phrase_02', text: 'Извинявай' },
  { id: 'phrase_03', text: 'Колега не ги разбираш!' },
  { id: 'phrase_04', text: 'Голям артист си!' },
  { id: 'phrase_05', text: 'Айде, шампионе!' },
  { id: 'phrase_06', text: 'Опааа, какво стана?' },
  { id: 'phrase_07', text: 'Оле, Мале!' },
  { id: 'phrase_08', text: 'Благодаря' },
  { id: 'phrase_09', text: 'Моля' },
  { id: 'phrase_10', text: 'Картите те обичат!' },
  { id: 'phrase_11', text: 'Тук мирише на драма!' },
  { id: 'phrase_12', text: 'Колега стегни се' },
  { id: 'phrase_13', text: 'Напускай Брат!' },
  { id: 'phrase_14', text: 'Много ги разбирам' },
  { id: 'phrase_15', text: 'Голямо мислене!' },
  { id: 'phrase_16', text: 'Много им върви' },
  { id: 'phrase_17', text: 'Чист късмет' },
  { id: 'phrase_18', text: 'Само спокойно!' },
  { id: 'phrase_19', text: 'Майсторска работа!' },
  { id: 'phrase_20', text: 'Нямаме шанс' },
  { id: 'phrase_21', text: 'Смях на масата!' },
  { id: 'phrase_22', text: 'Да живее белотът!' },
  { id: 'phrase_23', text: 'Заспивам!' },
  { id: 'phrase_24', text: 'Да играем пак!' },
]

export function getPhraseReactionText(phraseId: string): string | null {
  return PHRASE_REACTIONS.find((phrase) => phrase.id === phraseId)?.text ?? null
}
