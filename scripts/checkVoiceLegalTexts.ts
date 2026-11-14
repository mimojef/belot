/**
 * checkVoiceLegalTexts.ts
 *
 * Целеви проверки за редакцията на Общите условия и Политиката за
 * поверителност заради гласовия чат + връзката към Политиката в съществуващия
 * прозорец при първо включване (без нови прозорци).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceLegalTexts.ts
 */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { PUBLIC_LEGAL_PAGES, VOICE_CHAT_LEGAL_ANCHOR, VOICE_CHAT_LEGAL_EFFECTIVE_DATE, VOICE_CHAT_PRIVACY_PATH } from '../src/app/lobby/publicLegalPages'
import { VOICE_PRIVACY_NOTE, VOICE_PRIVACY_POLICY_PATH, renderVoiceJoinPrompt, renderVoicePrivacyNote } from '../src/app/voice/ui/renderVoicePanel'

let passed = 0
let failed = 0
const warnings: string[] = []
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const terms = PUBLIC_LEGAL_PAGES.terms.body
const privacy = PUBLIC_LEGAL_PAGES.privacy.body
const blocks = (body: string): string[] => body.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block.length > 0)

/** Тялото на раздел по заглавие (до следващото заглавие). */
function section(body: string, heading: string): string {
  const all = blocks(body)
  const start = all.indexOf(heading)
  if (start < 0) throw new Error(`липсва раздел ${heading}`)
  const rest = all.slice(start + 1)
  const end = rest.findIndex((block) => /^\d+[А-ЯA-Z]?\.\s/.test(block))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n\n')
}

console.log('\ncheckVoiceLegalTexts\n')

const lobbySource = await readFile('src/app/lobby/renderLobbyScreen.ts', 'utf8')
const regexSource = /const isSectionTitle = \/(.+)\/\.test\(block\)/.exec(lobbySource)?.[1]
const sectionTitle = regexSource === undefined ? null : new RegExp(regexSource)

await check('[L1] Заглавията на разделите (вкл. 6А/19А) се разпознават; броят на разделите е 32 / 16; котвите voice-chat са зададени', () => {
  assert(sectionTitle !== null, 'регулярният израз за заглавие е намерен')
  const termsTitles = blocks(terms).filter((block) => sectionTitle!.test(block))
  const privacyTitles = blocks(privacy).filter((block) => sectionTitle!.test(block))
  assert(termsTitles.length === 32, `Общи условия: ${termsTitles.length} раздела (31 + 19А)`)
  assert(privacyTitles.length === 16, `Политика: ${privacyTitles.length} раздела (15 + 6А)`)
  assert(termsTitles.includes('19А. Гласов чат в частните маси') && privacyTitles.includes('6А. Гласов чат в частните маси'), 'новите заглавия')
  assert(PUBLIC_LEGAL_PAGES.privacy.sectionAnchors?.['6А. Гласов чат в частните маси'] === VOICE_CHAT_LEGAL_ANCHOR, 'котва в Политиката')
  assert(PUBLIC_LEGAL_PAGES.terms.sectionAnchors?.['19А. Гласов чат в частните маси'] === VOICE_CHAT_LEGAL_ANCHOR, 'котва в Общите условия')
  assert(PUBLIC_LEGAL_PAGES.terms.sectionAnchors?.['28. Доброволно изтриване на профил'] === 'voluntary-profile-deletion', 'старата котва е запазена')
  assert(!sectionTitle!.test('Достъпност. Гласовият чат…') && !sectionTitle!.test('6АБ. не е заглавие'), 'обикновен текст не е заглавие')
  const oldRegex = /^\d+\.\s/
  assert(blocks(terms).filter((block) => oldRegex.test(block)).length === 31 && blocks(privacy).filter((block) => oldRegex.test(block)).length === 15, 'старите раздели се разпознават както преди')
})

await check('[L2] Политика 6А: ЕИП само за гласовия сървър; без доставчик, местоположение, IP или технически подробности', () => {
  const voice = section(privacy, '6А. Гласов чат в частните маси')
  assert(voice.includes('гласов сървър на Pika.bg, разположен в рамките на Европейското икономическо пространство (ЕИП)'), 'ЕИП за гласовия сървър')
  assert(privacy.includes('Аудиото и връзките на гласовия чат се обработват от гласов сървър, разположен в рамките на ЕИП.'), 'раздел 10')
  assert(!/данните от гласовия чат не се предават извън/i.test(privacy), 'няма общо твърдение за всички данни')
  for (const forbidden of [/evps/i, /redcluster/i, /кипър/i, /дейта цент/i, /livekit/i, /\bturn\b/i, /dtls|srtp/i, /185\.\d+/, /voice\.pika\.bg/i, /p_</]) {
    assert(!forbidden.test(privacy) && !forbidden.test(terms), `няма ${forbidden}`)
  }
  assert(voice.includes('не е криптирана от край до край'), 'без твърдение за end-to-end')
  assert(voice.includes('не използва бисквитки или локално съхранение'), 'бисквитки')
})

await check('[L3] Срокове без абсолютни обещания; активна база ≠ backup-и; Google Drive; логове без срок в дни', () => {
  const voice = section(privacy, '6А. Гласов чат в частните маси')
  const retention = section(privacy, '11. Срокове за съхранение')
  assert(voice.includes('от активната база данни 30 дни след приключването'), '30 дни от активната база')
  assert(voice.includes('при технически прекъсвания изтриването се извършва при първата възможност'), 'уговорка за прекъсвания')
  assert(voice.includes('ротация, при която по-старите записи се заменят от по-новите'), 'логове — ротация')
  assert(!/\b14 дни\b/.test(privacy), 'няма 14 дни')
  assert(retention.includes('сроковете за изтриване в тази политика се отнасят до активната база данни'), 'разграничение активна база / копия')
  assert(retention.includes('Google Drive') && retention.includes('90 дни'), 'Google Drive и 90 дни')
  assert(retention.includes('Преди обновяване на структурата на базата данни се създава и допълнително копие, което по правило се изтрива автоматично 7 дни след създаването си'), 'копията преди миграции (T2) — 7 дни')
  assert(retention.includes('Изключение правят последните две успешни такива копия: те се пазят независимо от възрастта си'), 'изключение за последните две успешни копия (T2)')
  assert(!/такова копие се пази, докато|изтрива автоматично 90 дни/.test(retention), 'старият T2 текст (90 дни / едно копие) е премахнат')
  assert(retention.includes('може да се забави и се извършва при първата възможност'), 'уговорка за копията')
  assert(!/заменени по графика за подмяна/.test(retention), 'старото неточно твърдение е премахнато')
  assert(!/гарантира(ме)? (изтриване|срок)/i.test(privacy), 'без гаранция за срок')
})

await check('[L4] Общи условия: поправен mute (Теми + чат на частните маси + говорене; слушането остава); 19А без абсолютни освобождавания; честна игра по 15/16', () => {
  const moderation = section(terms, '19. Използване и модерация на секция „Теми“, включително „Лафче“')
  assert(moderation.includes('за текстовия чат на частните маси и за говоренето в гласовия чат на частните маси'), 'обхват на mute')
  assert(moderation.includes('да слуша в гласовия чат') && moderation.includes('да говори в гласовия чат'), 'слуша, но не говори')
  assert(moderation.includes('Микрофонът не се включва автоматично'), 'без автоматичен микрофон след mute')
  assert(!moderation.includes('ограничението се прилага за цялата секция „Теми“.'), 'старото тясно твърдение е заменено')
  const voice = section(terms, '19А. Гласов чат в частните маси')
  assert(voice.includes('Правилата за честна игра по раздели 15 и 16 важат и за гласовия чат'), 'честна игра')
  assert(voice.includes('освен в случаите, когато приложимото законодателство предвижда друго'), 'уговорка към отговорността')
  assert(voice.includes('освен когато приложимото законодателство изисква друго или е налице доказан технически проблем'), 'уговорка към възстановяването')
  assert(!/не носи никаква отговорност|при никакви обстоятелства|изцяло освободена/i.test(voice), 'без абсолютни формулировки')
  assert(voice.includes('раздел 6А от Политиката за поверителност'), 'препратка към Политиката')
})

await check('[L5] Класиранията и останалите раздели не са променени (раздел 21 и 26 са идентични с HEAD)', () => {
  const head = execFileSync('git', ['show', 'HEAD:src/app/lobby/publicLegalPages.ts'], { encoding: 'utf8' })
  const headTerms = /const TERMS_BODY = `([\s\S]*?)`\n\nconst PRIVACY_BODY/.exec(head.replace(/\r\n/g, '\n'))?.[1]
  assert(headTerms !== undefined, 'HEAD текстът е прочетен')
  for (const heading of ['21. Рангове, статистики и класирания', '26. Ограничаване на отговорността', '15. Забранено поведение', '16. Забрана за реални залози между потребители', '28. Доброволно изтриване на профил']) {
    assert(section(headTerms!, heading) === section(terms, heading), `раздел „${heading}“ е непроменен`)
  }
})

await check('[L6] Съществуващият прозорец при първо включване има връзка към /privacy#voice-chat (нов таб, без нов прозорец)', () => {
  assert(VOICE_PRIVACY_POLICY_PATH === VOICE_CHAT_PRIVACY_PATH, 'пътят съвпада с котвата на Политиката')
  const note = renderVoicePrivacyNote()
  assert(note.includes(VOICE_PRIVACY_NOTE), 'одобреният текст е запазен')
  assert(note.includes(`href="${VOICE_CHAT_PRIVACY_PATH}"`) && note.includes('target="_blank"') && note.includes('rel="noopener noreferrer"'), 'връзка в нов таб')
  for (const isOwnVip of [true, false]) {
    for (const theme of ['light', 'dark'] as const) {
      const prompt = renderVoiceJoinPrompt({ isOwnVip, canOpenShop: true, theme })
      assert(prompt.includes('data-voice-privacy-link="1"'), `прозорецът (${isOwnVip ? 'VIP' : 'non-VIP'}, ${theme}) съдържа връзката`)
      assert((prompt.match(/role="dialog"/g) ?? []).length === 1, 'един диалог — без нов прозорец')
    }
  }
})

await check('[L7] Дата на влизане в сила — една константа за двата документа', () => {
  assert(terms.includes(`Дата на влизане в сила: ${VOICE_CHAT_LEGAL_EFFECTIVE_DATE}`), 'Общи условия')
  assert(privacy.includes(`Дата на влизане в сила: ${VOICE_CHAT_LEGAL_EFFECTIVE_DATE}`), 'Политика')
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(VOICE_CHAT_LEGAL_EFFECTIVE_DATE)) {
    warnings.push(`VOICE_CHAT_LEGAL_EFFECTIVE_DATE = „${VOICE_CHAT_LEGAL_EFFECTIVE_DATE}“ — ЗАМЕСТИТЕЛ: задай датата на frontend deploy-а преди затворената бета.`)
  }
})

for (const warning of warnings) console.log(`  WARN  ${warning}`)
console.log(`\n${passed} passed, ${failed} failed${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}`)
if (failed > 0) process.exit(1)
