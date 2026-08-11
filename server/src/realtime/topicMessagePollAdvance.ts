// Чист (без DB/socket достъп) core на cross-instance poll cursor invariant-а
// за Topics realtime (Етап 2) — извлечен в отделен малък файл единствено за
// да е unit-тестваем в изолация от целия server/src/index.ts bootstrap. Виж
// extensive коментара при `topicMessagePollCursor` в index.ts за пълния
// rationale на самия invariant; тук е само чистата механика.
//
// Инвариант: cursor напредва СТРИКТНО според редовете, подадени в `rows` (в
// реда, в който са подадени — очаква се ASC по seq, какъвто е
// topicMessageStore.pollNewMessages), независимо дали редът е
// locally-announced. Редове, чийто seq вече е в `locallyAnnouncedSeqs`, се
// изключват от `rowsToBroadcast` (вече доставени instant-но от local send
// пътя в index.ts), но пак напредват cursor-а — точно това предпазва от
// race-а, при който local send директно мести cursor-а и прескача по-малък
// seq, insert-нат от друга инстанция, но все още непрочетен от тази.
export function computeTopicMessagePollAdvance<T extends { seq: number }>(
  currentCursor: number,
  locallyAnnouncedSeqs: ReadonlySet<number>,
  rows: readonly T[],
): { nextCursor: number; rowsToBroadcast: T[] } {
  let cursor = currentCursor
  const rowsToBroadcast: T[] = []

  for (const row of rows) {
    cursor = row.seq
    if (!locallyAnnouncedSeqs.has(row.seq)) {
      rowsToBroadcast.push(row)
    }
  }

  return { nextCursor: cursor, rowsToBroadcast }
}
