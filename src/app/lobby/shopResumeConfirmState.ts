import type { CoinPackageSnapshot, CoinPurchaseSnapshot } from '../network/createGameServerClient'

export type ShopResumeConfirmInput = {
  purchases: CoinPurchaseSnapshot[]
  shopPackages: CoinPackageSnapshot[]
  lobbyPackages: CoinPackageSnapshot[]
}

export type ShopResumeConfirmOpenResult =
  | { ok: true; resumeId: string; packageId: string }
  | { ok: false; reason: 'not-found' | 'not-pending' | 'no-package-id' | 'package-unavailable' }

/**
 * Pure state computation: determines whether a "Плати" resume confirm popup
 * can be opened for a given purchaseId, and returns the resolved state.
 *
 * No DOM, no side effects — safe to call from both the controller and tests.
 */
export function computeShopResumeConfirmOpen(
  purchaseId: string,
  input: ShopResumeConfirmInput,
): ShopResumeConfirmOpenResult {
  const purchase = input.purchases.find((p) => p.purchaseId === purchaseId)

  if (!purchase) return { ok: false, reason: 'not-found' }
  if (purchase.status !== 'pending') return { ok: false, reason: 'not-pending' }

  const packageId = purchase.packageId
  if (!packageId) return { ok: false, reason: 'no-package-id' }

  const coinPackage =
    input.shopPackages.find((p) => p.packageId === packageId) ??
    input.lobbyPackages.find((p) => p.packageId === packageId)

  if (!coinPackage) return { ok: false, reason: 'package-unavailable' }

  return { ok: true, resumeId: purchaseId, packageId }
}

/**
 * Pure dispatch: given the current resume ID and confirm package ID,
 * determines whether the confirm action should call resume or new-purchase.
 *
 * Returns 'resume' with the purchaseId, or 'new-purchase' with the packageId.
 */
export type ShopConfirmDispatch =
  | { action: 'resume'; purchaseId: string }
  | { action: 'new-purchase'; packageId: string }
  | { action: 'noop' }

export function computeShopPurchaseConfirmDispatch(
  resumeId: string | null,
  confirmPackageId: string | null,
): ShopConfirmDispatch {
  if (resumeId !== null) return { action: 'resume', purchaseId: resumeId }
  if (confirmPackageId !== null) return { action: 'new-purchase', packageId: confirmPackageId }
  return { action: 'noop' }
}
