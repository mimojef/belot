# Distributed Shard Load Test — Command Reference

> **Read-only reference.** Copy-paste into your terminal after filling in
> `<PLACEHOLDER>` values. Do NOT run these from within this repo session.

---

## Architecture overview

```
VPS (185.203.117.14) — Ubuntu/Linux
  └── phased-load-coordinator.mjs
        binds 127.0.0.1:PORT (loopback only)

PC A ──SSH tunnel──► VPS:PORT ──► coordinator
PC B ──SSH tunnel──► VPS:PORT ──► coordinator
```

The coordinator is never exposed to the public internet.
Each PC reaches it through its own private SSH tunnel.

---

## 1 — VPS: start coordinator (Bash / Ubuntu)

```bash
# SSH into VPS, then:
cd /var/www/belot-v2-loadtest

# Generate a run ID and a 48-byte (96 hex char) high-entropy token.
# The token is sent in the X-Belot-Load-Token header — never in a URL.
RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")
echo "RUN_ID : $RUN_ID"
echo "TOKEN  : $TOKEN"   # share with PC A and PC B (out-of-band, e.g. encrypted message)

# Save to a file so you don't need to type it again:
echo "$TOKEN" > /tmp/coord-token-${RUN_ID}.txt

# Start coordinator in background (loopback only, heartbeat timeout 30 s):
# Args: <runId> <expectedTables> <port> <token> [host] [heartbeatTimeoutSec]
# expectedTables = sum of all shards' -Tables params (e.g. 200+200 = 400)
nohup node load-tests/k6/phased-load-coordinator.mjs \
  "$RUN_ID" \
  400 \
  9876 \
  "$TOKEN" \
  127.0.0.1 \
  30 \
  > /tmp/coord-${RUN_ID}.log 2>&1 &

# Save PID for clean shutdown later:
echo $! > /tmp/coord-${RUN_ID}.pid
echo "Coordinator started. PID=$(cat /tmp/coord-${RUN_ID}.pid)"

# Health check (no token required):
curl -s http://127.0.0.1:9876/health
```

`expectedTables` must equal the **sum** of all shards' `-Tables` parameters.
Example: shard A handles 200 tables, shard B handles 200 tables → `expectedTables=400`.

---

## 2 — PC A: SSH tunnel + shard runner (Windows)

### Step 1 — Open SSH tunnel (CMD — keep window open)

```cmd
ssh -N -L 9876:127.0.0.1:9876 <VPS_SSH_USER>@185.203.117.14
```

Keep this window open for the full duration of the test.

### Step 2 — Run shard A (PowerShell)

```powershell
Set-Location D:\Project\Belot-V2-LoadTest\load-tests\k6

.\run-phased-shard-load.ps1 `
  -BaseUrl                      http://185.203.117.14:3101 `
  -WsUrl                        ws://185.203.117.14:3101/ws `
  -Mode                         websocket-only `
  -Tables                       200 `
  -TableOffset                  0 `
  -RemoteCoordinatorUrl         http://127.0.0.1:9876 `
  -RunId                        <RUN_ID_FROM_VPS> `
  -Token                        <TOKEN_FROM_VPS> `
  -LoginSpreadSeconds           30 `
  -LoginBarrierTimeoutSeconds   120 `
  -WsConnectSpreadSeconds       30 `
  -WsBarrierTimeoutSeconds      120 `
  -ShardId                      shard-A
```

---

## 3 — PC B: SSH tunnel + shard runner (Windows)

### Step 1 — Open SSH tunnel (CMD — keep window open)

```cmd
ssh -N -L 9876:127.0.0.1:9876 <VPS_SSH_USER>@185.203.117.14
```

### Step 2 — Run shard B (PowerShell)

```powershell
Set-Location D:\Project\Belot-V2-LoadTest\load-tests\k6

.\run-phased-shard-load.ps1 `
  -BaseUrl                      http://185.203.117.14:3101 `
  -WsUrl                        ws://185.203.117.14:3101/ws `
  -Mode                         websocket-only `
  -Tables                       200 `
  -TableOffset                  200 `
  -RemoteCoordinatorUrl         http://127.0.0.1:9876 `
  -RunId                        <RUN_ID_FROM_VPS> `
  -Token                        <TOKEN_FROM_VPS> `
  -LoginSpreadSeconds           30 `
  -LoginBarrierTimeoutSeconds   120 `
  -WsConnectSpreadSeconds       30 `
  -WsBarrierTimeoutSeconds      120 `
  -ShardId                      shard-B
```

> **Note on `TableOffset`:** PC A uses `0`, PC B uses `200`.
> Their credential slices are `[0..799]` and `[800..1599]` respectively
> (4 users × 200 tables each). Ensure `loadtest-users.json.local` on each PC
> contains at least 1600 user entries.

---

## 4 — Monitor: show both shards + total status (Windows PowerShell)

```powershell
$coordUrl = 'http://127.0.0.1:9876'
$runId    = '<RUN_ID_FROM_VPS>'
$token    = '<TOKEN_FROM_VPS>'

while ($true) {
  try {
    $s = Invoke-RestMethod `
      -Uri "$coordUrl/status?runId=$runId" `
      -Method Get `
      -Headers @{'X-Belot-Load-Token' = $token} `
      -TimeoutSec 3
    Clear-Host
    Write-Host "=== $(Get-Date -Format 'HH:mm:ss') runId=$runId ==="
    Write-Host ("Login tables ready : {0}/{1}  barrier={2}  failed={3}" -f `
      $s.loginTablesReady, $s.expectedTables, $s.loginBarrierReleased, $s.loginBarrierFailed)
    Write-Host ("WS    tables ready : {0}/{1}  barrier={2}  failed={3}" -f `
      $s.wsTablesReady,    $s.expectedTables, $s.wsBarrierReleased,    $s.wsBarrierFailed)
    if ($s.globalFailure) {
      Write-Host "GLOBAL FAILURE: $($s.globalFailure | ConvertTo-Json -Compress)" -ForegroundColor Red
    }
    Write-Host ''
    foreach ($sh in $s.shards) {
      Write-Host ("  [{0}]  status={1}  offset={2}  tables={3}  login={4}  ws={5}  last={6}" -f `
        $sh.shardId, $sh.status, $sh.tableOffset, $sh.tables,
        $sh.loginTablesReady, $sh.wsTablesReady, $sh.lastSeenAt)
    }
  } catch {
    Write-Host "Poll failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  Start-Sleep -Seconds 3
}
```

---

## 5 — Stop / cleanup

### Stop coordinator on VPS (Bash — stop by PID file, not pkill)

```bash
# Graceful stop using the saved PID:
kill $(cat /tmp/coord-${RUN_ID}.pid)

# Verify it stopped (should show "no process" after ~2s):
sleep 2 && ps -p $(cat /tmp/coord-${RUN_ID}.pid) 2>/dev/null || echo "Coordinator stopped."

# Check the log for any errors:
tail -20 /tmp/coord-${RUN_ID}.log

# Remove PID and token files when done:
rm -f /tmp/coord-${RUN_ID}.pid /tmp/coord-token-${RUN_ID}.txt
```

### Stop shard runner on PC (PowerShell)

```
# The runner exits automatically when:
#   - k6 finishes cleanly (exit 0) → calls /shard-complete, exits 0
#   - k6 fails (non-zero exit)    → calls /global-failure, exits 1
#   - coordinator signals failure  → supervisor kills k6, exits 99
#
# To stop manually: press Ctrl+C once.
# The finally block will POST /global-failure to notify the other shard.
```

### Close SSH tunnel

Close the SSH window or press `Ctrl+C` in the `ssh -N` session.

### Delete result files (optional)

```powershell
Remove-Item "D:\Project\Belot-V2-LoadTest\load-tests\k6\phased-shard-*" -ErrorAction SilentlyContinue
```

---

## Key parameters reference

| Parameter | Description |
|---|---|
| `Tables` | Number of tables **this shard** manages |
| `TableOffset` | First table index for this shard (PC A=0, PC B=200) |
| `ShardId` | Human-readable name shown in `/status` (default: `shard-offset<N>`) |
| `HeartbeatIntervalPolls` | Heartbeat every N×PollMs; default 40×250ms=10s |
| `FailureCleanupGraceSeconds` | Grace period before forced k6 kill on global failure |
| `RemoteCoordinatorUrl` | Always the **tunneled** loopback URL, never the VPS public IP |

> **Security reminder:** The token is never passed in a URL query string.
> It is always sent in the `X-Belot-Load-Token` HTTP header.
> Do not log or echo the token value.
