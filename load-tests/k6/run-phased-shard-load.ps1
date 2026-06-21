param(
  # ─── Required: target ────────────────────────────────────────────────────────
  # Пример: -BaseUrl http://185.203.117.14:3101 -WsUrl ws://185.203.117.14:3101/ws
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$WsUrl,

  # ─── Required: mode ──────────────────────────────────────────────────────────
  [Parameter(Mandatory = $true)][string]$Mode,

  # ─── Required: scale — tables за ТОЗИ shard (напр. 200) ──────────────────────
  [Parameter(Mandatory = $true)][int]$Tables,

  # ─── Required: shard offset (0 за PC A, 200 за PC B при 400-table тест) ─────
  [Parameter(Mandatory = $true)][int]$TableOffset,

  # ─── Required: remote coordinator ────────────────────────────────────────────
  # URL към вече стартирания coordinator (напр. http://185.203.117.14:9876).
  [Parameter(Mandatory = $true)][string]$RemoteCoordinatorUrl,

  # ─── Required: shared runId и token ──────────────────────────────────────────
  # runId и token трябва да съвпадат с тези, с които е стартиран coordinator.
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$Token,

  # ─── Required: timing ────────────────────────────────────────────────────────
  [Parameter(Mandatory = $true)][int]$LoginSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$LoginBarrierTimeoutSeconds,
  [Parameter(Mandatory = $true)][int]$WsConnectSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$WsBarrierTimeoutSeconds,

  [int]$WsConnectDeadlineSeconds       = 120,
  [int]$WsConnectAttemptTimeoutSeconds = 15,
  [int]$WsMaxAttempts                  = 3,
  [int]$WsRetryBaseDelayMs             = 250,
  [int]$WsRetryMaxDelayMs              = 2000,

  [int]$MatchmakingSpreadSeconds     = 0,
  [int]$MatchRuntimeTimeoutSeconds   = 0,

  [string]$Stake                = '5000',
  [int]$ActionDeadlineSafetyMs = 500,
  [switch]$RejectedActionDiagnostics,

  # ─── Optional: shard identity ─────────────────────────────────────────────
  # По подразбиране: "shard-offset<TableOffset>"
  [string]$ShardId = '',

  # ─── Optional: heartbeat ──────────────────────────────────────────────────
  # Heartbeat се изпраща на всеки (HeartbeatIntervalPolls × SupervisorPollMilliseconds) ms.
  # При 250ms poll и 40 interval = 10s между heartbeat-ите (при 30s coordinator timeout).
  [int]$HeartbeatIntervalPolls   = 40,

  [int]$FailureCleanupGraceSeconds = 5,
  [int]$SupervisorPollMilliseconds = 250,

  [string]$ResultsDirectory = ''
)

$ErrorActionPreference = 'Stop'

$k6ScriptDir  = $PSScriptRoot
$credPath     = Join-Path $k6ScriptDir 'loadtest-users.json.local'
$k6ScriptPath = Join-Path $k6ScriptDir 'phased-multi-table-load.js'

function Fail([string]$message) {
  Write-Error -Message $message -ErrorAction Continue
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ShardId)) {
  $ShardId = "shard-offset${TableOffset}"
}

# ── 1. Validate Mode ─────────────────────────────────────────────────────────
if ($Mode -ne 'websocket-only' -and $Mode -ne 'full') {
  Fail "Mode must be 'websocket-only' or 'full', got '$Mode'."
}

# ── 2. Validate Tables and TableOffset ───────────────────────────────────────
if ($Tables -lt 1) {
  Fail "Tables must be >= 1, got $Tables."
}
if ($TableOffset -lt 0) {
  Fail "TableOffset must be >= 0, got $TableOffset."
}

# ── 3. Validate timing ────────────────────────────────────────────────────────
foreach ($kv in @{
  LoginSpreadSeconds = $LoginSpreadSeconds
  LoginBarrierTimeoutSeconds = $LoginBarrierTimeoutSeconds
  WsConnectSpreadSeconds = $WsConnectSpreadSeconds
  WsBarrierTimeoutSeconds = $WsBarrierTimeoutSeconds
}.GetEnumerator()) {
  if ($kv.Value -lt 1) { Fail "$($kv.Key) must be >= 1, got $($kv.Value)." }
}
foreach ($kv in @{
  WsConnectDeadlineSeconds = $WsConnectDeadlineSeconds
  WsConnectAttemptTimeoutSeconds = $WsConnectAttemptTimeoutSeconds
  WsMaxAttempts = $WsMaxAttempts
}.GetEnumerator()) {
  if ($kv.Value -lt 1) { Fail "$($kv.Key) must be >= 1, got $($kv.Value)." }
}
if ($WsRetryBaseDelayMs -lt 1 -or $WsRetryMaxDelayMs -lt 1 -or $WsRetryBaseDelayMs -gt $WsRetryMaxDelayMs) {
  Fail 'WsRetryBaseDelayMs and WsRetryMaxDelayMs must be positive integers with Base <= Max.'
}
if ($Mode -eq 'full') {
  if ($MatchmakingSpreadSeconds -lt 1) { Fail 'MatchmakingSpreadSeconds must be >= 1 for Mode=full.' }
  if ($MatchRuntimeTimeoutSeconds -lt 1) { Fail 'MatchRuntimeTimeoutSeconds must be >= 1 for Mode=full.' }
}

# ── 4. Validate Stake ─────────────────────────────────────────────────────────
$stakeInt = 0
if (-not [int]::TryParse($Stake, [ref]$stakeInt) -or $stakeInt -lt 1) {
  Fail "Stake must be a positive integer, got '$Stake'."
}
if ($ActionDeadlineSafetyMs -lt 0) {
  Fail "ActionDeadlineSafetyMs must be >= 0, got $ActionDeadlineSafetyMs."
}
if ($FailureCleanupGraceSeconds -lt 1 -or $SupervisorPollMilliseconds -lt 50) {
  Fail 'FailureCleanupGraceSeconds must be >= 1 and SupervisorPollMilliseconds must be >= 50.'
}
if ($HeartbeatIntervalPolls -lt 1) { Fail 'HeartbeatIntervalPolls must be >= 1.' }

# ── 5. Validate RunId and Token ───────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($RunId)) {
  Fail 'RunId must be a non-empty string matching the coordinator runId.'
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  Fail 'Token must be a non-empty string. Use a high-entropy value (e.g. openssl rand -hex 32).'
}
if ($Token.Length -lt 32) {
  Fail 'Token must be at least 32 characters. Use: openssl rand -hex 32'
}

# ── 6. Strip and validate URLs ────────────────────────────────────────────────
$BaseUrl              = $BaseUrl.TrimEnd('/')
$RemoteCoordinatorUrl = $RemoteCoordinatorUrl.TrimEnd('/')

if ($BaseUrl -notmatch '^http://') {
  Fail "BaseUrl must start with http://, got: $BaseUrl"
}
if ($WsUrl -notmatch '^ws://') {
  Fail "WsUrl must start with ws://, got: $WsUrl"
}
if ($RemoteCoordinatorUrl -notmatch '^http://') {
  Fail "RemoteCoordinatorUrl must start with http://, got: $RemoteCoordinatorUrl"
}

# ── 7. Target safety guard — exact pair allowlist ─────────────────────────────
# Разрешени са само двете точни комбинации. pika.bg и порт 3001 никога не са цел.
$allowedPairs = @(
  [pscustomobject]@{ BaseUrl = 'http://185.203.117.14:3101'; WsUrl = 'ws://185.203.117.14:3101/ws' }
  [pscustomobject]@{ BaseUrl = 'http://127.0.0.1:3101';      WsUrl = 'ws://127.0.0.1:3101/ws' }
)
if (-not ($allowedPairs | Where-Object { $_.BaseUrl -eq $BaseUrl -and $_.WsUrl -eq $WsUrl })) {
  Fail (
    "SAFETY: Непозволена комбинация BaseUrl='$BaseUrl' + WsUrl='$WsUrl'.`n" +
    "Разрешени са само:`n" +
    "  http://185.203.117.14:3101  +  ws://185.203.117.14:3101/ws`n" +
    "  http://127.0.0.1:3101       +  ws://127.0.0.1:3101/ws"
  )
}

# ── 8. Validate tools in PATH ─────────────────────────────────────────────────
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  Fail 'k6 not found in PATH.'
}
$k6Executable = (Get-Command k6 -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $k6ScriptPath -PathType Leaf)) {
  Fail "k6 script not found: $k6ScriptPath"
}

# ── 9. Validate credentials (TableOffset-aware) ───────────────────────────────
if (-not (Test-Path -LiteralPath $credPath -PathType Leaf)) {
  Fail "Credentials file not found: $credPath"
}
$credentials = $null
try {
  $credentials = Get-Content -LiteralPath $credPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail "Invalid JSON in credentials file: $credPath"
}
if ($null -eq $credentials.users -or -not ($credentials.users -is [array])) {
  Fail 'Credentials file must have the structure: { "users": [...] }'
}
$credentialStart = $TableOffset * 4
$requiredUsers   = $credentialStart + $Tables * 4
if ($credentials.users.Count -lt $requiredUsers) {
  Fail ("Credentials file has $($credentials.users.Count) users; " +
    "TableOffset=$TableOffset Tables=$Tables requires users " +
    "$credentialStart..$($requiredUsers - 1) (total >= $requiredUsers).")
}
for ($i = $credentialStart; $i -lt $requiredUsers; $i++) {
  $u         = $credentials.users[$i]
  $email     = if ($null -ne $u.email)    { [string]$u.email }    else { '' }
  $password  = if ($null -ne $u.password) { [string]$u.password } else { '' }
  $tableNum  = [int][Math]::Floor(($i - $credentialStart) / 4) + 1 + $TableOffset
  $playerNum = ($i % 4) + 1
  if ([string]::IsNullOrWhiteSpace($email)) {
    Fail "User index $i (table $tableNum, player $playerNum) is missing email."
  }
  if ([string]::IsNullOrWhiteSpace($password)) {
    Fail "User index $i (table $tableNum, player $playerNum) is missing password."
  }
}

# ── 10. Resolve results directory ─────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) { $ResultsDirectory = $k6ScriptDir }
if (-not (Test-Path -LiteralPath $ResultsDirectory -PathType Container)) {
  Fail "ResultsDirectory does not exist: $ResultsDirectory"
}

# ── 11. Output paths ──────────────────────────────────────────────────────────
$timestamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
$modeSlug         = if ($Mode -eq 'websocket-only') { 'ws-only' } else { 'full' }
$fileBase         = "phased-shard-${Tables}t-off${TableOffset}-${modeSlug}-${timestamp}"
$summaryPath      = Join-Path $ResultsDirectory "${fileBase}.json"
$logPath          = Join-Path $ResultsDirectory "${fileBase}.log"
$metricsPath      = Join-Path $ResultsDirectory "${fileBase}.metrics.ndjson"
$runnerResultPath = Join-Path $ResultsDirectory "${fileBase}.runner-result.json"

foreach ($path in @($summaryPath, $logPath, $metricsPath, $runnerResultPath)) {
  if (Test-Path -LiteralPath $path) { Fail "Output file already exists (timestamp collision?): $path" }
}

# ── Helper functions (inlined — no dependency on run-phased-multi-table-load.ps1) ──

function ConvertTo-NativeArgument([string]$Argument) {
  if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') { return $Argument }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') { $backslashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Start-K6Async([string]$Executable, [string[]]$Arguments) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Executable
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) { throw 'Failed to start k6 process.' }
  return [pscustomobject]@{
    Process = $process
    Pid = $process.Id
    StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    StdoutTask = $process.StandardOutput.ReadToEndAsync()
    StderrTask = $process.StandardError.ReadToEndAsync()
    OutputDrained = $false
  }
}

function Drain-K6Output($State, [scriptblock]$LogAction, [switch]$Wait) {
  if ($State.OutputDrained) { return }
  if (-not $Wait -and (-not $State.StdoutTask.IsCompleted -or -not $State.StderrTask.IsCompleted)) { return }
  $stdout = $State.StdoutTask.GetAwaiter().GetResult()
  $stderr = $State.StderrTask.GetAwaiter().GetResult()
  foreach ($line in ($stdout -split '\r?\n')) { if ($line.Length -gt 0) { & $LogAction $line $false } }
  foreach ($line in ($stderr -split '\r?\n')) { if ($line.Length -gt 0) { & $LogAction $line $true } }
  $State.OutputDrained = $true
}

function Stop-VerifiedProcessTree($State) {
  if ($State.Process.HasExited) { return [pscustomobject]@{ Forced = $false; TaskkillExitCode = $null } }
  $current = [System.Diagnostics.Process]::GetProcessById($State.Pid)
  if ($current.StartTime.ToUniversalTime().Ticks -ne $State.StartTimeUtcTicks) {
    throw "Refusing to terminate PID $($State.Pid): process StartTime identity changed."
  }
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkill /PID $State.Pid /T /F | Out-Null
  $taskkillExitCode = $LASTEXITCODE
  if (-not $State.Process.WaitForExit(5000)) {
    $current = [System.Diagnostics.Process]::GetProcessById($State.Pid)
    if ($current.StartTime.ToUniversalTime().Ticks -ne $State.StartTimeUtcTicks) {
      throw "Refusing fallback termination for PID $($State.Pid): process StartTime identity changed."
    }
    $State.Process.Kill()
    if (-not $State.Process.WaitForExit(5000)) {
      throw "PID $($State.Pid) did not exit after verified fallback termination."
    }
  }
  return [pscustomobject]@{ Forced = $true; TaskkillExitCode = $taskkillExitCode }
}

function Get-MetricsNdjsonStats([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [pscustomobject]@{ Exists = $false; FileSizeBytes = 0; SampledLines = 0; SampleErrors = 0 }
  }
  $fi = [System.IO.FileInfo]::new($Path)
  $sizeBytes = $fi.Length; $sampledLines = 0; $sampleErrors = 0
  $reader = [System.IO.StreamReader]::new($Path, [System.Text.Encoding]::UTF8, $true)
  try {
    $checked = 0
    while (-not $reader.EndOfStream -and $checked -lt 10) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $checked += 1
      try { $null = $line | ConvertFrom-Json -ErrorAction Stop; $sampledLines += 1 }
      catch { $sampleErrors += 1 }
    }
  } finally { $reader.Dispose() }
  return [pscustomobject]@{ Exists = $true; FileSizeBytes = $sizeBytes; SampledLines = $sampledLines; SampleErrors = $sampleErrors }
}

function Write-AtomicJson([string]$Path, $Value) {
  $temporaryPath = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::Move($temporaryPath, $Path)
}

function New-RunnerResult($Context, $SupervisorResult, $MetricsStats, [string]$RunnerError) {
  $outcome = if (-not [string]::IsNullOrEmpty($RunnerError)) {
    'runner-error'
  } elseif ($null -ne $SupervisorResult -and $null -ne $SupervisorResult.CoordinatorFailure) {
    'coordinator-failure'
  } elseif ($null -ne $SupervisorResult -and $SupervisorResult.ExitCode -eq 0) {
    'success'
  } else {
    'k6-error'
  }
  return [ordered]@{
    schemaVersion = 1
    outcome = $outcome
    runId = $Context.RunId
    mode = $Context.Mode
    tables = $Context.Tables
    tableOffset = $Context.TableOffset
    shardId = $Context.ShardId
    startedAt = $Context.StartedAt.ToString('o')
    finishedAt = [DateTime]::UtcNow.ToString('o')
    coordinatorFailure = if ($null -ne $SupervisorResult) { $SupervisorResult.CoordinatorFailure } else { $null }
    runnerError = $RunnerError
    k6 = [ordered]@{
      processId = if ($null -ne $SupervisorResult) { $SupervisorResult.ProcessId } else { $null }
      processStartTimeUtcTicks = if ($null -ne $SupervisorResult) { $SupervisorResult.ProcessStartTimeUtcTicks } else { $null }
      exitCode = if ($null -ne $SupervisorResult) { $SupervisorResult.ExitCode } else { $null }
      forcedTermination = if ($null -ne $SupervisorResult) { $SupervisorResult.ForcedTermination } else { $false }
      taskkillExitCode = if ($null -ne $SupervisorResult) { $SupervisorResult.TaskkillExitCode } else { $null }
      failureDetectedAt = if ($null -ne $SupervisorResult -and $null -ne $SupervisorResult.FailureDetectedAt) { $SupervisorResult.FailureDetectedAt.ToString('o') } else { $null }
    }
    artifacts = [ordered]@{
      logPath = $Context.LogPath
      metricsPath = $Context.MetricsPath
      k6SummaryPath = $Context.SummaryPath
      k6SummaryExists = Test-Path -LiteralPath $Context.SummaryPath -PathType Leaf
      metricsExists = $MetricsStats.Exists
      metricsFileSizeBytes = $MetricsStats.FileSizeBytes
      metricsSampledLines = $MetricsStats.SampledLines
      metricsSampleErrors = $MetricsStats.SampleErrors
    }
  }
}

# Invoke-K6Supervisor — shard variant with heartbeat support.
# $HeartbeatAction is called every $HeartbeatIntervalPolls polls; pass $null to disable.
function Invoke-K6Supervisor(
  [string]$Executable,
  [string[]]$Arguments,
  [scriptblock]$StatusProvider,
  [scriptblock]$LogAction,
  [scriptblock]$HeartbeatAction,
  [int]$HeartbeatIntervalPolls,
  [int]$CleanupGraceSeconds,
  [int]$PollMilliseconds
) {
  $state = Start-K6Async $Executable $Arguments
  $failure = $null; $failureDetectedAt = $null; $graceDeadline = $null
  $forced = $false; $taskkillExitCode = $null
  $hbCounter = 0
  try {
    while (-not $state.Process.HasExited) {
      Drain-K6Output $state $LogAction
      # Periodic heartbeat to coordinator
      $hbCounter += 1
      if ($null -ne $HeartbeatAction -and $HeartbeatIntervalPolls -gt 0 -and $hbCounter -ge $HeartbeatIntervalPolls) {
        $hbCounter = 0
        try { & $HeartbeatAction }
        catch { try { & $LogAction "Heartbeat failed: $($_.Exception.Message)" $true } catch { } }
      }
      if ($null -eq $failure) {
        try {
          $status = & $StatusProvider
          if ($null -ne $status -and ($status.loginBarrierFailed -eq $true -or $status.wsBarrierFailed -eq $true)) {
            $failure = $status
            $failureDetectedAt = [DateTime]::UtcNow
            $graceDeadline = $failureDetectedAt.AddSeconds($CleanupGraceSeconds)
          }
        } catch { & $LogAction "Coordinator status poll failed: $($_.Exception.Message)" $true }
      }
      if ($null -ne $failure -and [DateTime]::UtcNow -ge $graceDeadline) {
        $stop = Stop-VerifiedProcessTree $state
        $forced = $stop.Forced; $taskkillExitCode = $stop.TaskkillExitCode
        break
      }
      Start-Sleep -Milliseconds $PollMilliseconds
    }
    [void]$state.Process.WaitForExit()
    Drain-K6Output $state $LogAction -Wait
    return [pscustomobject]@{
      ProcessId = $state.Pid
      ProcessStartTimeUtcTicks = $state.StartTimeUtcTicks
      ExitCode = $state.Process.ExitCode
      CoordinatorFailure = $failure
      FailureDetectedAt = $failureDetectedAt
      ForcedTermination = $forced
      TaskkillExitCode = $taskkillExitCode
    }
  } catch {
    if (-not $state.Process.HasExited) { $null = Stop-VerifiedProcessTree $state }
    throw
  } finally {
    $state.Process.Dispose()
  }
}

# ── Coordinator helpers — token always in X-Belot-Load-Token header, never in URL ──

function Invoke-CoordPost([string]$Url, [string]$BodyJson) {
  $headers = @{
    'X-Belot-Load-Token' = $Token
    'Content-Type'       = 'application/json'
  }
  # SilentlyContinue: best-effort fire-and-forget (crash reporting must not itself crash).
  Invoke-RestMethod -Uri $Url -Method Post -Headers $headers `
    -Body $BodyJson -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
}

function Invoke-CoordGet([string]$Url) {
  $headers = @{'X-Belot-Load-Token' = $Token}
  return Invoke-RestMethod -Uri $Url -Method Get -Headers $headers -TimeoutSec 3 -ErrorAction Stop
}

function Invoke-CoordPostStrict([string]$Url, [string]$BodyJson) {
  $headers = @{
    'X-Belot-Load-Token' = $Token
    'Content-Type'       = 'application/json'
  }
  # Throws on network error, timeout, or HTTP 4xx/5xx — caller must handle as fatal.
  return Invoke-RestMethod -Uri $Url -Method Post -Headers $headers `
    -Body $BodyJson -TimeoutSec 10 -ErrorAction Stop
}

# ── 12. Init runtime state ────────────────────────────────────────────────────
$script:logWriter = $null
$k6ExitCode       = 1
$supervisorResult = $null
$runnerError      = $null
$runStartedAt     = [DateTime]::UtcNow
$coordUrl         = $RemoteCoordinatorUrl

function Log([string]$line) {
  Write-Host $line
  if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($line) }
}

# ── 13. Verify remote coordinator is healthy ──────────────────────────────────
$healthUrl   = "$coordUrl/health"
$coordReady  = $false
$healthCheck = (Get-Date).AddSeconds(30)

Write-Host "Waiting for coordinator at $healthUrl ..."
while ((Get-Date) -lt $healthCheck) {
  Start-Sleep -Milliseconds 300
  try {
    $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $coordReady = $true; break }
  } catch { }
}
if (-not $coordReady) {
  Fail "Remote coordinator did not respond at $healthUrl within 30 seconds."
}
Write-Host "Coordinator is healthy."

# ── 14. Register shard (strict — aborts before k6 if coordinator rejects) ─────
try {
  $regBody = ConvertTo-Json @{ shardId = $ShardId; tableOffset = $TableOffset; tables = $Tables } -Compress
  $regResp = Invoke-CoordPostStrict "$coordUrl/shard-register?runId=$RunId" $regBody
  if ($null -ne $regResp -and $regResp.idempotent) {
    Write-Host "Shard '$ShardId' re-registered (same params, idempotent)."
  } else {
    Write-Host "Shard '$ShardId' registered (tableOffset=$TableOffset, tables=$Tables)."
  }
} catch {
  Fail "Shard registration failed (aborting before k6 start): $($_.Exception.Message)"
}

# ── 14b. First heartbeat (strict — abort before k6 if coordinator rejects) ────
try {
  $hbBody = ConvertTo-Json @{ shardId = $ShardId } -Compress
  Invoke-CoordPostStrict "$coordUrl/shard-heartbeat?runId=$RunId" $hbBody | Out-Null
} catch {
  Fail "Initial heartbeat failed (aborting before k6 start): $($_.Exception.Message)"
}

# ── 15. Assemble k6 arguments ─────────────────────────────────────────────────
$diagFlag = if ($RejectedActionDiagnostics) { '1' } else { '0' }

$k6Args = @(
  'run',
  '--out', "json=$metricsPath",
  '-e', "TABLES=$Tables",
  '-e', "TABLE_OFFSET=$TableOffset",
  '-e', "MODE=$Mode",
  '-e', "LOGIN_SPREAD_SECONDS=$LoginSpreadSeconds",
  '-e', "LOGIN_BARRIER_TIMEOUT_SECONDS=$LoginBarrierTimeoutSeconds",
  '-e', "WS_CONNECT_SPREAD_SECONDS=$WsConnectSpreadSeconds",
  '-e', "WS_BARRIER_TIMEOUT_SECONDS=$WsBarrierTimeoutSeconds",
  '-e', "WS_CONNECT_DEADLINE_SECONDS=$WsConnectDeadlineSeconds",
  '-e', "WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS=$WsConnectAttemptTimeoutSeconds",
  '-e', "WS_MAX_ATTEMPTS=$WsMaxAttempts",
  '-e', "WS_RETRY_BASE_DELAY_MS=$WsRetryBaseDelayMs",
  '-e', "WS_RETRY_MAX_DELAY_MS=$WsRetryMaxDelayMs",
  '-e', "MATCHMAKING_SPREAD_SECONDS=$MatchmakingSpreadSeconds",
  '-e', "MATCH_RUNTIME_TIMEOUT_SECONDS=$MatchRuntimeTimeoutSeconds",
  '-e', "ACTION_DEADLINE_SAFETY_MS=$ActionDeadlineSafetyMs",
  '-e', "BASE_URL=$BaseUrl",
  '-e', "WS_URL=$WsUrl",
  '-e', "STAKE=$Stake",
  '-e', "REJECTED_ACTION_DIAGNOSTICS=$diagFlag",
  '-e', "COORDINATOR_URL=$coordUrl",
  '-e', "RUN_ID=$RunId",
  '-e', "COORDINATOR_TOKEN=$Token",
  '-e', "SUMMARY_JSON_PATH=$summaryPath",
  $k6ScriptPath
)

# ── 16. Open log and run supervisor ──────────────────────────────────────────
try {
  $script:logWriter = [System.IO.StreamWriter]::new(
    $logPath, $false, [System.Text.UTF8Encoding]::new($false))
  $script:logWriter.AutoFlush = $true

  Log ''
  Log '═══════════════════════════════════════════════════════════════'
  Log '  phased-shard-load k6 runner (distributed shard mode)'
  Log '═══════════════════════════════════════════════════════════════'
  Log "  ShardId          : $ShardId"
  Log "  Mode             : $Mode"
  Log "  Target BASE_URL  : $BaseUrl"
  Log "  Target WS_URL    : $WsUrl"
  Log "  Tables (shard)   : $Tables"
  Log "  TableOffset      : $TableOffset"
  Log "  Credentials      : indices $credentialStart..$($requiredUsers - 1)"
  Log "  Coordinator URL  : $coordUrl"
  Log "  Run ID           : $RunId"
  Log "  Summary JSON     : $summaryPath"
  Log "  Metrics NDJSON   : $metricsPath"
  Log "  Runner result    : $runnerResultPath"
  Log "  Console log      : $logPath"
  Log '═══════════════════════════════════════════════════════════════'
  Log ''

  $statusUrl = "$coordUrl/status?runId=$RunId"
  $statusProvider = {
    Invoke-CoordGet $statusUrl
  }

  $heartbeatAction = {
    try {
      $hbBody = ConvertTo-Json @{ shardId = $ShardId } -Compress
      Invoke-CoordPost "$coordUrl/shard-heartbeat?runId=$RunId" $hbBody
    } catch { }
  }

  $logAction = {
    param([string]$line, [bool]$isError)
    if ($isError) { Write-Host $line -ForegroundColor Red } else { Write-Host $line }
    if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($line) }
  }

  $supervisorResult = Invoke-K6Supervisor `
    $k6Executable $k6Args `
    $statusProvider $logAction `
    $heartbeatAction $HeartbeatIntervalPolls `
    $FailureCleanupGraceSeconds $SupervisorPollMilliseconds

  $k6ExitCode = $supervisorResult.ExitCode

} catch {
  $runnerError = $_.Exception.ToString()
  $k6ExitCode  = 1
  if ($null -ne $script:logWriter) { Log "Runner error: $runnerError" }
} finally {
  # ── Notify coordinator of crash or successful completion ──────────────────
  try {
    if (-not [string]::IsNullOrEmpty($runnerError)) {
      # Runner threw before/during k6 — report as global failure
      $fb = ConvertTo-Json @{ shardId = $ShardId; reason = 'runner-exception' } -Compress
      Invoke-CoordPost "$coordUrl/global-failure?runId=$RunId" $fb
    } elseif ($null -ne $supervisorResult -and $supervisorResult.ExitCode -ne 0 -and $null -eq $supervisorResult.CoordinatorFailure) {
      # k6 exited non-zero and a coordinator failure was NOT what caused it — report crash
      $reason = "k6 exited with code $($supervisorResult.ExitCode)"
      $fb = ConvertTo-Json @{ shardId = $ShardId; reason = $reason } -Compress
      Invoke-CoordPost "$coordUrl/global-failure?runId=$RunId" $fb
    } elseif ($null -ne $supervisorResult -and $supervisorResult.ExitCode -eq 0) {
      # Clean completion
      $cb = ConvertTo-Json @{ shardId = $ShardId } -Compress
      Invoke-CoordPost "$coordUrl/shard-complete?runId=$RunId" $cb
    }
    # If killed by coordinator failure ($supervisorResult.CoordinatorFailure != null),
    # no report needed — the coordinator already knows it triggered the shutdown.
  } catch { }

  # ── Write runner result ───────────────────────────────────────────────────
  try {
    $metricsStats = Get-MetricsNdjsonStats $metricsPath
    $context = [pscustomobject]@{
      RunId = $RunId; Mode = $Mode; Tables = $Tables; TableOffset = $TableOffset
      ShardId = $ShardId; StartedAt = $runStartedAt
      LogPath = $logPath; MetricsPath = $metricsPath; SummaryPath = $summaryPath
    }
    $runnerResult = New-RunnerResult $context $supervisorResult $metricsStats $runnerError
    $outcome = $runnerResult.outcome
    Write-AtomicJson $runnerResultPath $runnerResult
    if ($outcome -eq 'coordinator-failure') { $k6ExitCode = 99 }
    elseif ($outcome -eq 'runner-error') { $k6ExitCode = 1 }
  } catch {
    $k6ExitCode = 1
    if ($null -ne $script:logWriter) {
      $script:logWriter.WriteLine("Failed to write runner result: $($_.Exception.Message)")
    }
  }

  if ($null -ne $script:logWriter) {
    try {
      $script:logWriter.WriteLine('')
      $script:logWriter.WriteLine("k6 exit code : $k6ExitCode")
      $script:logWriter.WriteLine("Runner result: $runnerResultPath")
      $script:logWriter.WriteLine("Log ended    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
      $script:logWriter.Flush()
      $script:logWriter.Close()
    } catch { }
  }
}

Write-Host ''
Write-Host "Shard '$ShardId' finished with exit code $k6ExitCode."
Write-Host "Summary JSON     : $summaryPath"
Write-Host "Metrics NDJSON   : $metricsPath"
Write-Host "Runner result    : $runnerResultPath"
Write-Host "Console log      : $logPath"

exit $k6ExitCode
