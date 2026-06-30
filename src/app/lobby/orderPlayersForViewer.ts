import type { PlayerPublicProfileSnapshot } from '../network/createGameServerClient.js'

export function orderPlayersForViewer(
  players: PlayerPublicProfileSnapshot[],
  opts: { isAdmin: boolean; ownProfileId: string | null },
): PlayerPublicProfileSnapshot[] {
  if (!opts.isAdmin) return players

  const own: PlayerPublicProfileSnapshot[] = []
  const onlineHumans: PlayerPublicProfileSnapshot[] = []
  const offlineHumans: PlayerPublicProfileSnapshot[] = []
  const bots: PlayerPublicProfileSnapshot[] = []

  for (const p of players) {
    if (p.isBot === true) {
      bots.push(p)
    } else if (opts.ownProfileId !== null && p.profileId === opts.ownProfileId) {
      own.push(p)
    } else if (p.isOnline === true) {
      onlineHumans.push(p)
    } else {
      offlineHumans.push(p)
    }
  }

  return [...own, ...onlineHumans, ...offlineHumans, ...bots]
}
