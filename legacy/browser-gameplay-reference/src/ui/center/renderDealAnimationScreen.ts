import type { Seat } from '../../data/constants/seatOrder'

type DealAnimationPhase = 'deal-first-3' | 'deal-next-2' | 'deal-last-3'

export function renderDealAnimationScreen(
  _phase: DealAnimationPhase,
  _dealerSeat: Seat | null
): string {
  return `
    <div
      style="
        width:100%;
        height:390px;
        margin:0;
        padding:0;
        background:transparent;
        pointer-events:none;
        user-select:none;
      "
    ></div>
  `
}