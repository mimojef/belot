export type PhraseReaction = {
  id: string
  text: string
}

export const PHRASE_REACTIONS: PhraseReaction[] = [
  { id: 'phrase_01', text: 'Браво, майсторе!' },
  { id: 'phrase_02', text: 'Евала, играч!' },
  { id: 'phrase_03', text: 'Колега не ги разбираш!' },
  { id: 'phrase_04', text: 'Голям артист си!' },
  { id: 'phrase_05', text: 'Айде, шампионе!' },
  { id: 'phrase_06', text: 'Опааа, какво стана?' },
  { id: 'phrase_07', text: 'Оле, Мале!' },
  { id: 'phrase_08', text: 'Мозъкът ти пуши!' },
  { id: 'phrase_09', text: 'Картите те обичат!' },
  { id: 'phrase_10', text: 'Тук мирише на драма!' },
  { id: 'phrase_11', text: 'Отивай да гледаш реклами!' },
  { id: 'phrase_12', text: 'Напускай Брат!' },
  { id: 'phrase_13', text: 'Картите паднаха от смях!' },
  { id: 'phrase_14', text: 'Голямо мислене!' },
  { id: 'phrase_15', text: 'Тоя бот има чувства!' },
  { id: 'phrase_16', text: 'Айде, без паника!' },
  { id: 'phrase_17', text: 'Само спокойно!' },
  { id: 'phrase_18', text: 'Тук няма случайни хора!' },
  { id: 'phrase_19', text: 'Майсторска работа!' },
  { id: 'phrase_20', text: 'Тук вече е сериозно!' },
  { id: 'phrase_21', text: 'Смях на масата!' },
  { id: 'phrase_22', text: 'Да живее белотът!' },
]

export function getPhraseReactionText(phraseId: string): string | null {
  return PHRASE_REACTIONS.find((phrase) => phrase.id === phraseId)?.text ?? null
}
