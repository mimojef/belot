// ─── Public types ─────────────────────────────────────────────────────────────

export type RoomRevisionRegistry = {
  ensure(roomId: string): number
  get(roomId: string): number | null
  bump(roomId: string): number
  remove(roomId: string): void
  has(roomId: string): boolean
  getTrackedRoomCount(): number
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRoomRevisionRegistry(): RoomRevisionRegistry {
  const revisions = new Map<string, number>()

  function validateRoomId(roomId: string): void {
    if (typeof roomId !== 'string' || roomId.trim() === '') {
      throw new Error(
        `[revision-registry] roomId must be a non-empty string, got ${JSON.stringify(roomId)}`,
      )
    }
  }

  return {
    ensure(roomId: string): number {
      validateRoomId(roomId)
      if (!revisions.has(roomId)) {
        revisions.set(roomId, 0)
      }
      return revisions.get(roomId)!
    },

    get(roomId: string): number | null {
      validateRoomId(roomId)
      const value = revisions.get(roomId)
      return value !== undefined ? value : null
    },

    bump(roomId: string): number {
      validateRoomId(roomId)
      const current = revisions.get(roomId)
      if (current === undefined) {
        throw new Error(
          `[revision-registry] bump() called for unregistered roomId=${roomId}. Call ensure() first.`,
        )
      }
      if (current >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          `[revision-registry] revision overflow for roomId=${roomId} (current=${current})`,
        )
      }
      const next = current + 1
      revisions.set(roomId, next)
      return next
    },

    remove(roomId: string): void {
      validateRoomId(roomId)
      revisions.delete(roomId)
    },

    has(roomId: string): boolean {
      validateRoomId(roomId)
      return revisions.has(roomId)
    },

    getTrackedRoomCount(): number {
      return revisions.size
    },
  }
}
