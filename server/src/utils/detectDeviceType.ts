export type DeviceType = 'mobile' | 'desktop' | 'tablet' | 'unknown'

export type DeviceTypeHeaders = {
  userAgent: string | null
  secChUaMobile: string | null
  secChUaPlatform: string | null
}

/**
 * Classifies a visitor's device from server-side HTTP headers.
 *
 * Priority order (UA, then client hints as fallback):
 *  1. iPhone / iPod                          → mobile
 *  2. Android + "Mobile" token               → mobile
 *  3. iPad (explicit)                        → tablet
 *  4. iPadOS desktop-like UA                 → tablet
 *     (Safari on iPad in desktop mode sends "Macintosh … Mobile/…")
 *  5. Android without "Mobile"               → tablet
 *  6. Windows / macOS / Linux / ChromeOS     → desktop
 *  7. Unrecognised UA → client-hints assist  → unknown
 *  8. No UA           → client-hints assist  → unknown
 *
 * Client-hint rules (tiebreaker only):
 *  - sec-ch-ua-mobile=?1                     → mobile
 *  - platform android/ios                    → mobile
 *  - platform android/ios + ?0               → tablet (not mobile, not desktop)
 *  - platform windows/macos/linux/chromeos   → desktop
 *  - ?0 alone (no reliable platform)         → unknown  ← tablets also send ?0
 *  - no data                                 → unknown
 */
export function detectDeviceType(headers: DeviceTypeHeaders): DeviceType {
  const ua = headers.userAgent ?? ''

  if (!ua) {
    return classifyByClientHints(headers)
  }

  // --- Mobile ---
  if (/iPhone|iPod/i.test(ua)) return 'mobile'
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return 'mobile'

  // --- Tablet ---
  if (/iPad/i.test(ua)) return 'tablet'
  // iPadOS 13+ desktop mode: UA looks like macOS Safari but includes "Mobile"
  if (/Macintosh/i.test(ua) && /Mobile/i.test(ua)) return 'tablet'
  // Android without Mobile token
  if (/Android/i.test(ua)) return 'tablet'

  // --- Desktop ---
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop'

  // UA present but none of the above matched — try client hints as a hint
  const fromHints = classifyByClientHints(headers)
  return fromHints !== 'unknown' ? fromHints : 'unknown'
}

function classifyByClientHints(headers: DeviceTypeHeaders): DeviceType {
  const mobile = headers.secChUaMobile?.trim()
  const platform = headers.secChUaPlatform?.replace(/"/g, '').trim().toLowerCase() ?? ''

  // ?1 is an unambiguous mobile signal
  if (mobile === '?1') return 'mobile'

  // Known desktop platforms are reliable
  if (platform === 'windows') return 'desktop'
  if (platform === 'macos') return 'desktop'
  if (platform === 'linux') return 'desktop'
  if (platform === 'chromeos') return 'desktop'

  // Android/iOS platform without ?1: could be tablet, not safe to call mobile or desktop
  if (platform === 'android' || platform === 'ios') return 'unknown'

  // ?0 alone (no platform info) is NOT sufficient to confirm desktop — tablets also send ?0
  return 'unknown'
}
