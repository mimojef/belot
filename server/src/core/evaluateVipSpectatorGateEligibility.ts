/**
 * Pure VIP authorization gate за Belot spectator watch ("Гледай", Phase 2C).
 * Изолиран в собствен файл, за да остане unit-testable без нужда от пълен
 * spectator eligibility fixture — само VIP статус влиза, нищо друго.
 *
 * Canonical VIP entitlement source of truth е ЕДИНСТВЕНО
 * server/src/db/vipStore.ts (vipStore.getStatus(profileId).isActive) —
 * caller-ът (index.ts) резолвва статуса и подава само { isActive }; gate-ът
 * не дублира expiration/timestamp логика. Няма role bypass: admin/
 * subadmin/marketing профили минават през СЪЩАТА проверка като normal
 * профил — caller-ът не подава и не проверява role тук.
 */
export type VipSpectatorGateInput = {
  vipStatus: { isActive: boolean }
}

export type VipSpectatorGateResult =
  | { ok: true }
  | { ok: false; code: 'vip_required' }

export function evaluateVipSpectatorGateEligibility(
  input: VipSpectatorGateInput,
): VipSpectatorGateResult {
  if (!input.vipStatus.isActive) {
    return { ok: false, code: 'vip_required' }
  }
  return { ok: true }
}
