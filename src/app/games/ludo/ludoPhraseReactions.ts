// Готови фрази за „Не се сърди човече“ — същата система като Белот
// (src/app/activeRoom/phraseReactions.ts), само каталогът е собствен.
// Сървърът приема единствено тези id-та (виж parseClientMessage.ts,
// send_ludo_phrase_reaction) — текстът живее само тук, по мрежата минава id.
import type { PhraseReactionOption } from '../../phraseReactions/phraseReactionPickerUi'

export const LUDO_PHRASE_REACTIONS: readonly PhraseReactionOption[] = [
  { id: 'ludo_phrase_01', text: 'ХАХА... Чукнах те!' },
  { id: 'ludo_phrase_02', text: 'Ще те скъсам!' },
  { id: 'ludo_phrase_03', text: 'Само да те докопам!' },
  { id: 'ludo_phrase_04', text: 'Бягай, идвам!' },
  { id: 'ludo_phrase_05', text: 'Това вече е наглост!' },
  { id: 'ludo_phrase_06', text: 'Нищо лично!' },
  { id: 'ludo_phrase_07', text: 'Опа, без да искам!' },
  { id: 'ludo_phrase_08', text: 'Това боли!' },
  { id: 'ludo_phrase_09', text: 'Записвам си го в черния тефтер!' },
  { id: 'ludo_phrase_10', text: 'Играеш си с огъня!' },
  { id: 'ludo_phrase_11', text: 'Нервичките как са?' },
  { id: 'ludo_phrase_12', text: 'Тук не си добре!' },
  { id: 'ludo_phrase_13', text: 'Благодаря за играта!' },
  { id: 'ludo_phrase_14', text: 'Успех!' },
]

export function getLudoPhraseReactionText(phraseId: string): string | null {
  return LUDO_PHRASE_REACTIONS.find((phrase) => phrase.id === phraseId)?.text ?? null
}
