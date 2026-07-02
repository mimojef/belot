# AI Training Recorder

Passive, fail-open recorder that captures every completed Belot deal to append-only JSONL files for later ML training. It observes game state transitions without modifying any gameplay, bot logic, timers, or WebSocket protocol.

## Purpose

The recorder captures supervised-learning examples: for each action (bid or card play) it stores what the actor could see at the moment of decision, plus the chosen action. This allows training a model to predict human (or bot) decisions from the visible game state.

## Enabling

The recorder is **disabled by default**. To enable, set these environment variables:

```env
TRAINING_RECORDER_ENABLED=true
TRAINING_RECORDER_HASH_SECRET=<random-secret-minimum-16-chars>
```

A missing or short secret causes the recorder to stay disabled (logged as a warning, no crash).

## All environment variables

| Variable | Default | Description |
|---|---|---|
| `TRAINING_RECORDER_ENABLED` | `false` | Set to `true` to activate |
| `TRAINING_RECORDER_HASH_SECRET` | — | Min 16-char secret for HMAC-SHA256 player/room pseudonymization |
| `TRAINING_RECORDER_PATH` | `./training-recordings` | Directory for JSONL files |
| `TRAINING_RECORDER_MAX_FILE_MB` | `100` | Rotate file after this many MB |
| `TRAINING_RECORDER_MAX_TOTAL_GB` | `10` | Delete oldest files when total exceeds this |
| `TRAINING_RECORDER_MAX_QUEUE` | `1000` | In-memory queue cap — overflow drops newest record |
| `TRAINING_RECORDER_RETENTION_DAYS` | `90` | Delete date-dirs older than this |

## File layout

```
{TRAINING_RECORDER_PATH}/
  2025-06-01/
    process-1234-worker-0-part-0000.jsonl
    process-1234-worker-0-part-0001.active.jsonl
  2025-06-02/
    process-5678-worker-1-part-0000.jsonl
```

Each line in a `.jsonl` file is one complete JSON record, newline-terminated. While a file is being written it carries an `.active.jsonl` suffix; it is renamed to plain `.jsonl` on rotation (file-size or date change) or graceful shutdown. This makes the in-progress file unambiguous across every PM2 process sharing the storage directory — cleanup, retention, and total-size enforcement never delete or rename a `*.active.jsonl` file, no matter which process owns it. Rename is fail-open: if it fails (e.g. a locked file), the file simply stays `.active.jsonl` until the next rotation/shutdown attempt and is never auto-deleted while active.

## Phase lifecycle

The recorder hooks into these server phase transitions. Correlation between hook calls is by **roomId only** — a room has at most one active deal in-process at a time (`activeDealStates: Map<roomId, ActiveDealState>`). Nothing is derived from match score: reading the score at bidding-start vs. at scoring-finalize would disagree (the score changes across the deal), so score can never be part of the correlation key.

| Transition | Event | Cards captured |
|---|---|---|
| `deal-next-2 → bidding` | Deal start — creates the active deal state for this roomId, generates a random `recordingId` | 5 per seat (20 total) → `handsAtBiddingStart` |
| `deal-last-3 → playing` | Playing start | 8 per seat (32 total) → `initialHands` |
| `bidding` (each bid) | Bid action recorded via `findAddedBidEntry` diff | — |
| `bidding → deal-last-3` | Last bid recorded via the same diff | — |
| `bidding → next-round` | All-pass: last bid + bidding_only record written | — |
| `playing` (each card) | Card action recorded via `findAddedPlayedCard` diff | — |
| `playing → scoring` | Last card (if any) + full record written; finalizes purely by roomId | — |

`dealIndex` in the record is a **recorder-owned, per-room sequence number** (metadata only, starts at 1 and increments each time a deal starts recording for that room) — it is never used as a correlation key and never derived from score.

### Diffing bids and cards

- `findAddedBidEntry(previousState, nextState)` compares `bidding.entries` before/after. It works identically for `bidding→bidding`, `bidding→deal-last-3`, and `bidding→next-round` because `ServerBiddingState.entries` is never reset across those transitions — there is no special-casing of "the last bid".
- `findAddedPlayedCard(previousState, nextState)` compares `flattenPlayedCards(state)` (completed tricks + the trick in progress, chronological) before/after. It works identically for `playing→playing` and `playing→scoring` because `playing` is preserved unchanged when scoring starts. A `playing→scoring` transition with no new card (the 32nd card already recorded on a prior `playing→playing` step) is a valid finalize-only case — no duplicate card is recorded.
- If a diff doesn't cleanly resolve to "exactly one added entry", nothing is recorded, a rate-limited warning is logged, and the `invalidTransition` metric is incremented. Gameplay is never affected.

Human actions (submitBid / submitPlay) are intercepted directly in `index.ts` and pass `actionOrigin: 'human_manual'`. Bot/timeout actions come through the worker `onApplied` callback and pass `actionOrigin: 'auto'`.

### Action-level deduplication

Human actions are observed via the direct human hooks; the same transition could in principle also be observed later via the worker `onApplied` path. Each bid/card action is fingerprinted (`recordingId` + kind + entry/card count + seat + action/card id) before being appended. A repeat observation of the same transition is dropped (counted in the `duplicateActions` metric) and the first-seen `actorKind` (typically `human_manual`) is preserved — it is never overwritten by a later `auto` observation of the same action.

## Record schema (schemaVersion: 1)

### Full deal (`completed: true, recordKind: 'full'`)

```jsonc
{
  "schemaVersion": 1,
  "recordingId": "<random-uuid>",
  "recordedAt": "2025-06-01T12:00:00.000Z",
  "roomKey": "<hmac-sha256-of-room-id>",
  "dealIndex": 12345,
  "startedAt": "...", "completedAt": "...",
  "completed": true,
  "recordKind": "full",
  "dealerSeat": "bottom",
  "startingSeat": "right",
  "scoreBeforeDeal": { "team0": 40, "team1": 60 },
  "scoreAfterDeal":  { "team0": 40, "team1": 220 },
  "handsAtBiddingStart": {
    // 5 cards per seat at deal-next-2 → bidding
    "bottom": [{ "id": "hearts-J", "suit": "hearts", "rank": "J" }, ...],
    "right":  [...], "top": [...], "left": [...]
  },
  "initialHands": {
    // 8 cards per seat at deal-last-3 → playing (full hand)
    "bottom": [...], "right": [...], "top": [...], "left": [...]
  },
  "seats": {
    "bottom": { "playerKey": "abc123...", "isBot": false, "isTakeover": false },
    "right":  { "playerKey": null,        "isBot": true,  "isTakeover": false }
  },
  "biddingActions": [
    {
      "sequence": 1,
      "timestamp": "...",
      "seat": "right",
      "actorKind": "human_manual",
      "visibleBeforeAction": {
        "ownHand": [...],
        "dealerSeat": "bottom",
        "ownSeat": "right",
        "scoreBeforeDeal": { "team0": 40, "team1": 60 },
        "previousBids": [],
        "legalActions": [{ "type": "pass" }, { "type": "suit", "suit": "hearts" }, ...]
      },
      "chosenAction": { "type": "suit", "suit": "hearts" }
    }
  ],
  "finalContract": {
    "bidderSeat": "right",
    "contract": "suit",
    "trumpSuit": "hearts",
    "doubled": false, "redoubled": false
  },
  "cardActions": [
    {
      "sequence": 1,
      "timestamp": "...",
      "trickIndex": 0, "positionInTrick": 0,
      "seat": "bottom",
      "actorKind": "human_manual",
      "visibleBeforeAction": {
        "ownHand": [...],
        "legalCards": [...],
        "contract": { ... },
        "cardsPlayedBeforeAction": [...],
        "currentTrick": [...],
        "currentWinningSeat": null, "currentWinningCard": null,
        "dealerSeat": "bottom", "leaderSeat": "bottom",
        "scoreBeforeDeal": { ... }
      },
      "chosenCard": { "id": "clubs-J", "suit": "clubs", "rank": "J" }
    }
  ],
  "tricks": [
    {
      "trickIndex": 0, "leaderSeat": "bottom",
      "plays": [{ "sequence": 0, "seat": "bottom", "card": {...} }, ...],
      "winnerSeat": "bottom", "winningCard": {...}, "points": 34
    }
  ],
  "dealResult": {
    "bidderSeat": "right", "bidderTeam": "B", "contractTeam": "B",
    "contract": { ... },
    "contractMade": true, "isCapot": false, "isTie": false,
    "pointsTeam0Raw": 0, "pointsTeam1Raw": 162,
    "pointsTeam0Official": 0, "pointsTeam1Official": 162,
    "outcomeLabel": "Изкарана", "counterMultiplier": 1
  },
  "integrity": {
    "initialCardCount": 32, "playedCardCount": 32,
    "uniqueInitialCardCount": 32, "uniquePlayedCardCount": 32,
    "valid": true, "violations": []
  }
}
```

### All-pass deal (`completed: true, recordKind: 'bidding_only'`)

```jsonc
{
  "schemaVersion": 1,
  "recordingId": "<random-uuid>",
  "recordedAt": "...",
  "roomKey": "<hmac-sha256-of-room-id>",
  "dealIndex": 12345,
  "startedAt": "...", "completedAt": "...",
  "completed": true,
  "recordKind": "bidding_only",
  "dealerSeat": "bottom",
  "startingSeat": "right",
  "scoreBeforeDeal": { "team0": 40, "team1": 60 },
  "scoreAfterDeal":  { "team0": 40, "team1": 60 },
  "handsAtBiddingStart": { /* 5 cards × 4 seats */ },
  "initialHands": null,
  "seats": { ... },
  "biddingActions": [ /* all bids including the final pass */ ],
  "finalContract": null,
  "cardActions": [],
  "tricks": [],
  "dealResult": null,
  "integrity": { "valid": true, "violations": [], ... }
}
```

## Actor kinds

| Kind | Meaning |
|---|---|
| `human_manual` | Human player submitted voluntarily within time limit |
| `human_timeout` | First auto-action on a human seat: timer expired and the timeout handler acted |
| `bot_original` | Seat was always a bot (participant.kind === 'bot') |
| `bot_takeover` | Seat was a human but the bot took over after timeout (subsequent auto actions) |

## Privacy

- **No PII is stored.** Usernames, email addresses, IP addresses, access tokens, refresh tokens, passwords, and chat messages are never written.
- **Profile IDs are pseudonymized** using HMAC-SHA256 with `TRAINING_RECORDER_HASH_SECRET`. The same profile always produces the same `playerKey` within a deployment, but the original ID cannot be recovered without the secret.
- **Room IDs are pseudonymized** the same way. The `roomKey` field in every record is `HMAC-SHA256(secret, roomId)`, never the raw room ID.
- **Bot seats** always have `playerKey: null`.

## Fail-open design

Any error inside the recorder is caught and logged; the game always continues. Specifically:

- Errors in `onBiddingStart`, `onPlayingStart`, `onBidAction`, `onCardPlayed`, `onDealComplete`, `onAllPass`, `onDealAbandoned` are swallowed.
- Queue overflow silently drops the newest record (rate-limited warning log).
- Disk write errors mark the recorder as unhealthy and log the error, but do not throw.
- The recorder never rejects a game action, never blocks a game worker, and never modifies the authoritative game state.

## Deduplication

Each deal gets a random `recordingId` (UUID v4) created when bidding starts. Finalized recording IDs are kept in a per-process `Set` (capped at 10k). If the same deal is completed twice (e.g., due to retry), the second record is silently discarded and the `duplicateDeals` metric is incremented. See "Action-level deduplication" above for the separate per-action dedup guard (`duplicateActions`).

If `deal-next-2 → bidding` fires again for a room whose previous deal never finalized, the stale in-memory state is replaced (never accumulates) and `invalidTransition` is incremented — a room can only ever have one active deal.

## File rotation and retention

- Files rotate when they reach `TRAINING_RECORDER_MAX_FILE_MB`.
- Files also rotate when the local date changes (new day → new date subdirectory).
- The in-progress file is always named `*.active.jsonl` and is renamed to `*.jsonl` at the moment of rotation (before the next file is opened) or on graceful shutdown.
- Date subdirectories older than `TRAINING_RECORDER_RETENTION_DAYS` are deleted automatically (checked hourly) — `*.active.jsonl` files are never touched, even in an old-looking directory; the directory itself is only removed once fully empty.
- Total storage is capped at `TRAINING_RECORDER_MAX_TOTAL_GB` — oldest **closed** files are deleted first; `*.active.jsonl` files (this process's or any other's) are never candidates for deletion.

## Graceful shutdown

On server shutdown, the queue drains all queued records before closing. If shutdown times out, remaining records in queue are lost (acceptable: the game is shutting down).

## Validating recordings

```sh
# Validate a single file
npm run validate:training-recordings -- path/to/file.jsonl

# Validate an entire directory tree
npm run validate:training-recordings -- path/to/training-recordings/

# Verbose mode (prints every record)
npm run validate:training-recordings -- path/to/dir --verbose

# Read from stdin
cat path/to/file.jsonl | npm run validate:training-recordings
```

Exit code 0 = all valid. Exit code 1 = errors found. Exit code 2 = file system error.

## Running recorder tests

```sh
cd server
npm run check:training-recorder
```

## Health monitoring

When enabled, the recorder exposes metrics via the `/health` endpoint:

```json
{
  "trainingRecorder": {
    "enabled": true,
    "healthy": true,
    "queuedRecords": 0,
    "writtenRecords": 42,
    "droppedRecords": 0,
    "failedRecords": 0,
    "duplicateDeals": 0,
    "duplicateActions": 0,
    "noActiveDeal": 0,
    "invalidTransition": 0,
    "lastWriteAt": "2025-06-01T12:00:00.000Z",
    "lastErrorAt": null
  }
}
```

- `healthy: false` means a disk write error occurred. Records may be lost; check server logs.
- `duplicateDeals` — a completed/all-pass deal was finalized twice (retry).
- `duplicateActions` — the same bid/card action was observed more than once (see action-level dedup above).
- `noActiveDeal` — a bid/card/finalize hook fired for a room with no active deal state (e.g. after a stale-deal replacement).
- `invalidTransition` — a diff helper couldn't resolve a clean single added entry, or a `deal-next-2 → bidding` fired twice without the previous deal finalizing.

The `/health` payload never includes cards, player/room IDs, file paths, or secrets — only counters and timestamps.

## Canonical scoring reuse

Trick card-point values and the raw trick-points formula live in `server/src/game/serverScoring.ts` (`getServerCardPoints`, `getServerTrickCardPoints`) and are exported for reuse — the recorder calls these directly instead of keeping its own copy of the point tables, so gameplay scoring and recorded `tricks[].points` can never drift apart. Gameplay scoring output (`resolveServerScoring`) is unchanged.

`ServerScoringState` also carries a locale-independent `outcome: 'made' | 'inside' | 'tie'` field alongside the existing `outcomeLabel`/`outcomeShortLabel` (unchanged, still used by the UI). The recorder derives `dealResult.contractMade` / `isTie` from `outcome` rather than string-matching the Bulgarian labels.
