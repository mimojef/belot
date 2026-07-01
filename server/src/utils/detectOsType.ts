export type OsType = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'unknown'

/**
 * Classifies a visitor's operating system from the User-Agent header.
 *
 * Priority order matters because some tokens are misleading:
 *  1. ChromeOS (CrOS)        — before Linux, since ChromeOS UAs also contain "Linux"
 *  2. Android                — before Linux, since Android UAs also contain "Linux"
 *  3. iPhone / iPad / iPod   → iOS
 *  4. Windows
 *  5. Macintosh / Mac OS X   → macOS
 *  6. Remaining Linux
 *  7. Missing/empty/unrecognised UA → unknown
 */
export function detectOsType(userAgent: string | null | undefined): OsType {
  const ua = userAgent ?? ''

  if (!ua) return 'unknown'

  if (/CrOS/i.test(ua)) return 'chromeos'
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'

  return 'unknown'
}
