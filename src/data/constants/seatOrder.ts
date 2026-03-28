export const SEAT_ORDER = ['bottom', 'right', 'top', 'left'] as const

export type Seat = (typeof SEAT_ORDER)[number]