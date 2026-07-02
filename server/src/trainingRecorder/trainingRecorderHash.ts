import { createHmac } from 'node:crypto'

// Creates a pseudonymous player key from a profileId using HMAC-SHA256.
// Returns null for bot seats so they are clearly distinguishable from humans.
export function computePlayerKey(
  secret: string,
  profileId: string | null | undefined,
): string | null {
  if (!profileId) return null

  return createHmac('sha256', secret).update(String(profileId)).digest('hex')
}
