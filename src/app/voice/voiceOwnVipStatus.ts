// Гласов чат — собственият VIP статус за прозореца за включване и панела.
//
// Единственият източник е GET /api/vip/status (сървърният vipStore — същият,
// по който сървърът решава правото за говорене). profile.isVip от сесията НЕ
// е източник: сървърът не го попълва там (винаги null), затова всички VIP
// участници виждаха варианта „Вземи VIP“.
//
// Заявка: веднъж при нова гласова маса/профил и веднъж при всяко влизане в
// чакалнята (свеж статус след магазина) — без периодично презареждане.
// Докато отговорът не е дошъл, статусът е 'unknown' (НЕ „без VIP“); при
// грешка — 'error'. Това е само подсказка за интерфейса: правото за говорене
// се решава от сървъра при включване.

export type VoiceOwnVipStatus = 'unknown' | 'active' | 'inactive' | 'error'

export type VoiceOwnVipLoadResult = { ok: true; isActive: boolean } | { ok: false }

export type VoiceOwnVipTarget = {
  profileId: string
  voiceTableId: string
  screen: 'waiting' | 'game' | 'off_table'
}

export type VoiceOwnVipStatusSource = {
  get: () => VoiceOwnVipStatus
  /** Текущата гласова маса (null = няма). Евтино и идемпотентно — вика се при всяко рендериране. */
  sync: (target: VoiceOwnVipTarget | null) => void
  /** Свеж статус след известна промяна (подарък/покупка); до отговора остава последният известен. */
  refresh: () => void
}

export function createVoiceOwnVipStatusSource(deps: {
  load: () => Promise<VoiceOwnVipLoadResult>
  onChange: () => void
}): VoiceOwnVipStatusSource {
  let key: string | null = null
  let lastScreen: VoiceOwnVipTarget['screen'] | null = null
  let status: VoiceOwnVipStatus = 'unknown'
  /** Само последната заявка може да промени статуса (закъснял отговор се пренебрегва). */
  let seq = 0

  function set(next: VoiceOwnVipStatus): void {
    if (status === next) return
    status = next
    deps.onChange()
  }

  function load(): void {
    const mine = ++seq
    let pending: Promise<VoiceOwnVipLoadResult>
    try {
      pending = deps.load()
    } catch {
      pending = Promise.resolve({ ok: false })
    }
    void pending
      .then((result) => result, (): VoiceOwnVipLoadResult => ({ ok: false }))
      .then((result) => {
        if (mine !== seq) return
        set(result.ok ? (result.isActive ? 'active' : 'inactive') : 'error')
      })
  }

  return {
    get: () => status,
    sync(target) {
      if (target === null) {
        if (key === null) return
        key = null
        lastScreen = null
        seq += 1
        set('unknown')
        return
      }
      const nextKey = `${target.profileId}|${target.voiceTableId}`
      const changed = nextKey !== key
      const enteredWaiting = target.screen === 'waiting' && lastScreen !== 'waiting'
      key = nextKey
      lastScreen = target.screen
      if (!changed && !enteredWaiting) return
      set('unknown')
      load()
    },
    refresh() {
      if (key !== null) load()
    },
  }
}
