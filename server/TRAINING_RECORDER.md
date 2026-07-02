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
| `TRAINING_RECORDER_HASH_SECRET` | — | Min 16-char secret for HMAC-SHA256 player pseudonymization |
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
    process-1234-worker-0-part-0001.jsonl
  2025-06-02/
    process-5678-worker-1-part-0000.jsonl
```

Each line in a `.jsonl` file is one complete JSON record, newline-terminated. Files rotate when they reach `MAX_FILE_MB` or when the UTC date changes.

## Record schema (schemaVersion: 1)

### Complete deal (`completed: true`)

```jsonc
{
  "schemaVersion": 1,
  "recordingId": "roomId::deal-12345::dealer-bottom",
  "recordedAt": "2025-06-01T12:00:00.000Z",
  "roomKey": "room-uuid",
  "dealIndex": 12345,
  "startedAt": "...", "completedAt": "...",
  "completed": true,
  "dealerSeat": "bottom",
  "startingSeat": "right",
  "scoreBeforeDeal": { "team0": 40, "team1": 60 },
  "scoreAfterDeal":  { "team0": 40, "team1": 220 },
  "initialHands": {
    "bottom": [{ "id": "hearts-J", "suit": "hearts", "rank": "J" }, ...],
    "right":  [...], "top": [...], "left": [...]
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

### Incomplete deal (`completed: false`)

```jsonc
{
  "schemaVersion": 1,
  "recordingId": "...",
  "recordedAt": "...",
  "roomKey": "...",
  "dealIndex": 12345,
  "startedAt": "...", "completedAt": "...",
  "completed": false,
  "terminationReason": "all-pass"
}
```

## Actor kinds

| Kind | Meaning |
|---|---|
| `human_manual` | Human player acted within time limit |
| `human_timeout` | Human player's seat timed out; the human action was submitted by the timeout handler |
| `bot_original` | Seat was always a bot |
| `bot_takeover` | Seat was a human but the bot took over after timeout |

## Privacy

- **No PII is stored.** Usernames, email addresses, IP addresses, access tokens, refresh tokens, passwords, and chat messages are never written.
- **Profile IDs are pseudonymized** using HMAC-SHA256 with `TRAINING_RECORDER_HASH_SECRET`. The same profile always produces the same `playerKey` within a deployment, but the original ID cannot be recovered without the secret.
- **Bot seats** always have `playerKey: null`.

## Fail-open design

Any error inside the recorder is caught and logged; the game always continues. Specifically:

- Errors in `onDealStart`, `onBidAction`, `onCardPlayed`, `onDealComplete`, `onDealAbandoned` are swallowed.
- Queue overflow silently drops the newest record (rate-limited warning log).
- Disk write errors mark the recorder as unhealthy and log the error, but do not throw.
- The recorder never rejects a game action, never blocks a game worker, and never modifies the authoritative game state.

## Deduplication

Each deal gets a stable `recordingId` (`${roomId}::deal-${dealIndex}::dealer-${seat}`). Finalized recording IDs are kept in a per-process `Set` (capped at 10k). If the same deal is completed twice (e.g., due to retry), the second record is silently discarded.

## File rotation and retention

- Files rotate when they reach `TRAINING_RECORDER_MAX_FILE_MB`.
- Files also rotate when the UTC date changes (new day → new date subdirectory).
- Date subdirectories older than `TRAINING_RECORDER_RETENTION_DAYS` are deleted automatically (checked hourly).
- Total storage is capped at `TRAINING_RECORDER_MAX_TOTAL_GB` — oldest closed files are deleted first.

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

## Copying recordings safely

The files are append-only JSONL. To safely copy them without risking a partial line at the end of the active file, use:

```sh
# Copy all CLOSED (non-active) files — safe to copy anytime
rsync -av --exclude='*-part-active.jsonl' training-recordings/ backup/

# Or wait for graceful shutdown (which flushes the queue) before copying the active file
```

The active file name ends with the current date part; it is safe to read at any time (each line is atomic) but may be incomplete.

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
    "duplicateRecords": 0,
    "lastWriteAt": "2025-06-01T12:00:00.000Z",
    "lastErrorAt": null
  }
}
```

`healthy: false` means a disk write error occurred. Records may be lost; check server logs.
