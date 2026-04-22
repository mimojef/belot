import type { Seat } from '../../data/constants/seatOrder'

export function renderCuttingScreen(
  _cutterSeat: Seat | null,
  _selectedCutIndex: number | null | undefined
): string {
  return `
    <div
      style="
        width:100%;
        height:260px;
        margin:0;
        padding:0;
        background:transparent;
        pointer-events:none;
        user-select:none;
      "
    ></div>
  `
}