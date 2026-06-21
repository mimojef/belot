param(
  # ─── Required: target ────────────────────────────────────────────────────────
  # Default стойности НЕ са зададени за URL-ите, за да се избегне случайно
  # изпълнение срещу production.
  # Пример (SSH tunnel):  -BaseUrl http://127.0.0.1:3101 -WsUrl ws://127.0.0.1:3101/ws
  # Пример (директно):    -BaseUrl http://185.203.117.14:3101 -WsUrl ws://185.203.117.14:3101/ws
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$WsUrl,

  # ─── Required: mode ──────────────────────────────────────────────────────────
  # websocket-only : login → login barrier → WS connect → WS barrier → close
  # full           : same as websocket-only + matchmaking + gameplay to end
  [Parameter(Mandatory = $true)][string]$Mode,

  # ─── Required: scale ─────────────────────────────────────────────────────────
  [Parameter(Mandatory = $true)][int]$Tables,

  # ─── Required: timing ────────────────────────────────────────────────────────
  # Всички timing стойности са задължителни — runner-ът никога не разчита на
  # defaults от phased-multi-table-load.js, за да са тестовете точно сравними.
  [Parameter(Mandatory = $true)][int]$LoginSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$LoginBarrierTimeoutSeconds,
  [Parameter(Mandatory = $true)][int]$WsConnectSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$WsBarrierTimeoutSeconds,

  [int]$WsConnectDeadlineSeconds       = 120,
  [int]$WsConnectAttemptTimeoutSeconds = 15,
  [int]$WsMaxAttempts                  = 3,
  [int]$WsRetryBaseDelayMs             = 250,
  [int]$WsRetryMaxDelayMs              = 2000,

  # Задължителни само при Mode=full
  [int]$MatchmakingSpreadSeconds     = 0,
  [int]$MatchRuntimeTimeoutSeconds   = 0,

  # ─── Optional with stable defaults ───────────────────────────────────────────
  [string]$Stake                = '5000',
  [int]$ActionDeadlineSafetyMs = 500,
  [switch]$RejectedActionDiagnostics,

  [int]$FailureCleanupGraceSeconds = 5,
  [int]$SupervisorPollMilliseconds = 250,

  # ─── Optional: results directory (default: same directory as this script) ────
  [string]$ResultsDirectory = '',

  # ─── Optional: dual k6 mode ──────────────────────────────────────────────────
  # When set, Tables must be even. Two k6 processes are started:
  #   A: TABLE_OFFSET=0,          TABLES=Tables/2  (credentials 0 .. Tables*2-1)
  #   B: TABLE_OFFSET=Tables/2,   TABLES=Tables/2  (credentials Tables*2 .. Tables*4-1)
  # Coordinator uses expectedTables=Tables (full count). Both processes share one
  # coordinator, runId and login/WS barriers. One runner-result JSON (schemaVersion=2).
  [switch]$Dual
)

$ErrorActionPreference = 'Stop'

$k6ScriptDir   = $PSScriptRoot
$credPath      = Join-Path $k6ScriptDir 'loadtest-users.json.local'
$k6ScriptPath  = Join-Path $k6ScriptDir 'phased-multi-table-load.js'
$coordScript   = Join-Path $k6ScriptDir 'phased-load-coordinator.mjs'

function Fail([string]$message) {
  Write-Error -Message $message -ErrorAction Continue
  exit 1
}

# ── 1. Validate Mode ─────────────────────────────────────────────────────────
if ($Mode -ne 'websocket-only' -and $Mode -ne 'full') {
  Fail "Mode must be 'websocket-only' or 'full', got '$Mode'."
}

# ── 2. Validate Tables ────────────────────────────────────────────────────────
if ($Tables -lt 1) {
  Fail "Tables must be >= 1, got $Tables."
}
if ($Dual -and ($Tables % 2 -ne 0)) {
  Fail "Dual mode requires Tables to be even (two equal-size processes), got Tables=$Tables."
}
$TablesPerProcess = if ($Dual) { $Tables / 2 } else { $Tables }

# ── 3. Validate common timing (all must be >= 1) ─────────────────────────────
$timingCheck = [ordered]@{
  LoginSpreadSeconds          = $LoginSpreadSeconds
  LoginBarrierTimeoutSeconds  = $LoginBarrierTimeoutSeconds
  WsConnectSpreadSeconds      = $WsConnectSpreadSeconds
  WsBarrierTimeoutSeconds     = $WsBarrierTimeoutSeconds
}
foreach ($entry in $timingCheck.GetEnumerator()) {
  if ($entry.Value -lt 1) {
    Fail "$($entry.Key) must be a positive integer (>= 1), got $($entry.Value)."
  }
}

$wsRetryCheck = [ordered]@{
  WsConnectDeadlineSeconds       = $WsConnectDeadlineSeconds
  WsConnectAttemptTimeoutSeconds = $WsConnectAttemptTimeoutSeconds
  WsMaxAttempts                  = $WsMaxAttempts
}
foreach ($entry in $wsRetryCheck.GetEnumerator()) {
  if ($entry.Value -lt 1) {
    Fail "$($entry.Key) must be a positive integer (>= 1), got $($entry.Value)."
  }
}
if ($WsRetryBaseDelayMs -lt 1 -or $WsRetryMaxDelayMs -lt 1) {
  Fail 'WsRetryBaseDelayMs and WsRetryMaxDelayMs must be positive integers.'
}
if ($WsRetryBaseDelayMs -gt $WsRetryMaxDelayMs) {
  Fail "WsRetryBaseDelayMs must be <= WsRetryMaxDelayMs."
}

# ── 4. Validate Mode=full timing ─────────────────────────────────────────────
if ($Mode -eq 'full') {
  if ($MatchmakingSpreadSeconds -lt 1) {
    Fail "MatchmakingSpreadSeconds must be >= 1 for Mode=full, got $MatchmakingSpreadSeconds."
  }
  if ($MatchRuntimeTimeoutSeconds -lt 1) {
    Fail "MatchRuntimeTimeoutSeconds must be >= 1 for Mode=full, got $MatchRuntimeTimeoutSeconds."
  }
}

# ── 5. Validate Stake ─────────────────────────────────────────────────────────
$stakeInt = 0
if (-not [int]::TryParse($Stake, [ref]$stakeInt) -or $stakeInt -lt 1) {
  Fail "Stake must be a positive integer, got '$Stake'."
}

# ── 6. Validate ActionDeadlineSafetyMs ───────────────────────────────────────
if ($ActionDeadlineSafetyMs -lt 0) {
  Fail "ActionDeadlineSafetyMs must be >= 0, got $ActionDeadlineSafetyMs."
}
if ($FailureCleanupGraceSeconds -lt 1 -or $SupervisorPollMilliseconds -lt 50) {
  Fail 'FailureCleanupGraceSeconds must be >= 1 and SupervisorPollMilliseconds must be >= 50.'
}

# ── 7. Strip trailing slashes from BaseUrl ───────────────────────────────────
$BaseUrl = $BaseUrl.TrimEnd('/')

# ── 8. Basic URL scheme check ─────────────────────────────────────────────────
if ($BaseUrl -notmatch '^http://') {
  Fail "BaseUrl must start with http://, got: $BaseUrl"
}
if ($WsUrl -notmatch '^ws://') {
  Fail "WsUrl must start with ws://, got: $WsUrl"
}

# ── 9. Target safety guard — exact pair allowlist ─────────────────────────────
# Идентичен guard с run-multi-table-load.ps1.
# Разрешени са само двете точни комбинации. Всичко останало е блокирано:
# https/wss, port 3001, pika.bg, друг host, друг path, query string, fragment.
#   VPS директно : http://185.203.117.14:3101  +  ws://185.203.117.14:3101/ws
#   SSH tunnel   : http://127.0.0.1:3101        +  ws://127.0.0.1:3101/ws
$allowedPairs = @(
  [pscustomobject]@{
    BaseUrl = 'http://185.203.117.14:3101'
    WsUrl   = 'ws://185.203.117.14:3101/ws'
  }
  [pscustomobject]@{
    BaseUrl = 'http://127.0.0.1:3101'
    WsUrl   = 'ws://127.0.0.1:3101/ws'
  }
)

$matchedPair = $allowedPairs | Where-Object {
  $_.BaseUrl -eq $BaseUrl -and $_.WsUrl -eq $WsUrl
}

if ($null -eq $matchedPair) {
  Fail (
    "SAFETY: Непозволена комбинация BaseUrl='$BaseUrl' + WsUrl='$WsUrl'.`n" +
    "Разрешени са само:`n" +
    "  http://185.203.117.14:3101  +  ws://185.203.117.14:3101/ws`n" +
    "  http://127.0.0.1:3101       +  ws://127.0.0.1:3101/ws"
  )
}

# ── 10. Validate credentials file ─────────────────────────────────────────────
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

$requiredUsers = $Tables * 4
if ($credentials.users.Count -lt $requiredUsers) {
  Fail ("Credentials file has $($credentials.users.Count) users; " +
    "Tables=$Tables requires $requiredUsers (Tables x 4).")
}

for ($i = 0; $i -lt $requiredUsers; $i++) {
  $u         = $credentials.users[$i]
  $email     = if ($null -ne $u.email)    { [string]$u.email }    else { '' }
  $password  = if ($null -ne $u.password) { [string]$u.password } else { '' }
  $tableNum  = [int][Math]::Floor($i / 4) + 1
  $playerNum = ($i % 4) + 1

  if ([string]::IsNullOrWhiteSpace($email)) {
    Fail "User index $i (table $tableNum, player $playerNum) is missing email."
  }
  if ([string]::IsNullOrWhiteSpace($password)) {
    Fail "User index $i (table $tableNum, player $playerNum) is missing password."
  }
}

# ── 11. Validate tools in PATH ────────────────────────────────────────────────
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  Fail 'k6 not found in PATH. Install k6 or add it to PATH before running.'
}
$k6Executable = (Get-Command k6 -ErrorAction Stop).Source
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'node not found in PATH. Install Node.js or add it to PATH before running.'
}

# ── 12. Validate script files ────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $k6ScriptPath -PathType Leaf)) {
  Fail "k6 script not found: $k6ScriptPath"
}
if (-not (Test-Path -LiteralPath $coordScript -PathType Leaf)) {
  Fail "Coordinator script not found: $coordScript"
}

# ── 13. Resolve results directory ────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) {
  $ResultsDirectory = $k6ScriptDir
}
if (-not (Test-Path -LiteralPath $ResultsDirectory -PathType Container)) {
  Fail "ResultsDirectory does not exist: $ResultsDirectory"
}

# ── 14. Generate timestamped output paths ────────────────────────────────────
$timestamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$modeSlug    = if ($Mode -eq 'websocket-only') { 'ws-only' } else { 'full' }
$dualSlug    = if ($Dual) { '-dual' } else { '' }
$fileBase    = "phased-multi-table-load-${Tables}t${dualSlug}-${modeSlug}-${timestamp}"
$summaryPath = Join-Path $ResultsDirectory "${fileBase}.json"
$logPath     = Join-Path $ResultsDirectory "${fileBase}.log"
$metricsPath = Join-Path $ResultsDirectory "${fileBase}.metrics.ndjson"
$runnerResultPath = Join-Path $ResultsDirectory "${fileBase}.runner-result.json"

# Dual-mode: per-process summary and metrics paths (log is combined)
$summaryPathA = Join-Path $ResultsDirectory "${fileBase}.a.json"
$summaryPathB = Join-Path $ResultsDirectory "${fileBase}.b.json"
$metricsPathA = Join-Path $ResultsDirectory "${fileBase}.a.metrics.ndjson"
$metricsPathB = Join-Path $ResultsDirectory "${fileBase}.b.metrics.ndjson"

if (-not $Dual -and (Test-Path -LiteralPath $summaryPath)) {
  Fail "Summary file already exists (timestamp collision?): $summaryPath"
}
if (-not $Dual -and (Test-Path -LiteralPath $metricsPath)) {
  Fail "Metrics file already exists (timestamp collision?): $metricsPath"
}
if ($Dual -and (Test-Path -LiteralPath $summaryPathA)) {
  Fail "Summary A file already exists (timestamp collision?): $summaryPathA"
}
if ($Dual -and (Test-Path -LiteralPath $summaryPathB)) {
  Fail "Summary B file already exists (timestamp collision?): $summaryPathB"
}
if ($Dual -and (Test-Path -LiteralPath $metricsPathA)) {
  Fail "Metrics A file already exists (timestamp collision?): $metricsPathA"
}
if ($Dual -and (Test-Path -LiteralPath $metricsPathB)) {
  Fail "Metrics B file already exists (timestamp collision?): $metricsPathB"
}
if (Test-Path -LiteralPath $logPath) {
  Fail "Log file already exists (timestamp collision?): $logPath"
}
if (Test-Path -LiteralPath $runnerResultPath) {
  Fail "Runner result already exists (timestamp collision?): $runnerResultPath"
}

# ── 15. Find a free local TCP port for the coordinator ───────────────────────
$coordPort = $null
try {
  $listener = New-Object System.Net.Sockets.TcpListener(
    [System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $coordPort = $listener.LocalEndpoint.Port
  $listener.Stop()
} catch {
  Fail "Failed to find a free local port for the coordinator: $_"
}

$runId    = [System.Guid]::NewGuid().ToString('N').Substring(0, 16)
$coordUrl = "http://127.0.0.1:$coordPort"

# ── 16. Assemble k6 arguments ────────────────────────────────────────────────
$diagFlag = if ($RejectedActionDiagnostics) { '1' } else { '0' }

# Shared environment args — identical for both processes in dual mode
$k6EnvArgs = @(
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
  '-e', "RUN_ID=$runId"
)

if ($Dual) {
  # Process A: TABLE_OFFSET=0,              TABLES=TablesPerProcess, credentials 0..(TablesPerProcess*4-1)
  # Process B: TABLE_OFFSET=TablesPerProcess, TABLES=TablesPerProcess, credentials TablesPerProcess*4..Tables*4-1
  $k6ArgsA = @('run', '--out', "json=$metricsPathA",
    '-e', "TABLES=$TablesPerProcess", '-e', 'TABLE_OFFSET=0',
    '-e', "SUMMARY_JSON_PATH=$summaryPathA") + $k6EnvArgs + @($k6ScriptPath)
  $k6ArgsB = @('run', '--out', "json=$metricsPathB",
    '-e', "TABLES=$TablesPerProcess", '-e', "TABLE_OFFSET=$TablesPerProcess",
    '-e', "SUMMARY_JSON_PATH=$summaryPathB") + $k6EnvArgs + @($k6ScriptPath)
} else {
  $k6Args = @('run', '--out', "json=$metricsPath",
    '-e', "TABLES=$Tables", '-e', 'TABLE_OFFSET=0',
    '-e', "SUMMARY_JSON_PATH=$summaryPath") + $k6EnvArgs + @($k6ScriptPath)
}

# ── 17. Start coordinator + run k6 + cleanup ─────────────────────────────────
# Coordinator е Node.js HTTP процес, стартиран преди k6 и спрян в finally.
# k6 stdout+stderr са показани на конзолата и записани в log файл чрез
# StreamWriter + 2>&1 | ForEach-Object (Start-Transcript не покрива stderr).

$coordProcess     = $null
$script:logWriter = $null
$k6ExitCode       = 1
$supervisorResult = $null
$dualResult       = $null
$runnerError      = $null
$runStartedAt     = [DateTime]::UtcNow

function Log([string]$line) {
  Write-Host $line
  if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($line) }
}

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
  if (-not $Wait -and (-not $State.StdoutTask.IsCompleted -or -not $State.StderrTask.IsCompleted)) {
    return
  }
  $stdout = $State.StdoutTask.GetAwaiter().GetResult()
  $stderr = $State.StderrTask.GetAwaiter().GetResult()
  foreach ($line in ($stdout -split '\r?\n')) { if ($line.Length -gt 0) { & $LogAction $line $false } }
  foreach ($line in ($stderr -split '\r?\n')) { if ($line.Length -gt 0) { & $LogAction $line $true } }
  $State.OutputDrained = $true
}

function Stop-VerifiedProcessTree($State) {
  if ($State.Process.HasExited) {
    return [pscustomobject]@{ Forced = $false; TaskkillExitCode = $null }
  }
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
  $sizeBytes = $fi.Length
  $sampledLines = 0
  $sampleErrors = 0
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

function Invoke-K6Supervisor(
  [string]$Executable,
  [string[]]$Arguments,
  [scriptblock]$StatusProvider,
  [scriptblock]$LogAction,
  [int]$CleanupGraceSeconds,
  [int]$PollMilliseconds
) {
  $state = Start-K6Async $Executable $Arguments
  $failure = $null
  $failureDetectedAt = $null
  $graceDeadline = $null
  $forced = $false
  $taskkillExitCode = $null
  try {
    while (-not $state.Process.HasExited) {
      Drain-K6Output $state $LogAction
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
        $forced = $stop.Forced
        $taskkillExitCode = $stop.TaskkillExitCode
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

function Invoke-DualK6Supervisor(
  [string]$ExecutableA,
  [string[]]$ArgumentsA,
  [string]$ExecutableB,
  [string[]]$ArgumentsB,
  [scriptblock]$StatusProvider,
  [scriptblock]$LogAction,
  [int]$CleanupGraceSeconds,
  [int]$PollMilliseconds
) {
  $stateA = Start-K6Async $ExecutableA $ArgumentsA
  $stateB = $null
  try {
    $stateB = Start-K6Async $ExecutableB $ArgumentsB
  } catch {
    if (-not $stateA.Process.HasExited) { $null = Stop-VerifiedProcessTree $stateA }
    $stateA.Process.Dispose()
    throw
  }

  $failure        = $null   # set only by coordinator report
  $crashDetected  = $false  # set only by process exit-code detection
  $failureDetAt   = $null
  $graceDeadline  = $null
  $forcedA        = $false
  $forcedB        = $false
  $taskkillA      = $null
  $taskkillB      = $null

  try {
    while (-not ($stateA.Process.HasExited -and $stateB.Process.HasExited)) {
      Drain-K6Output $stateA $LogAction
      Drain-K6Output $stateB $LogAction

      if ($null -eq $failure -and -not $crashDetected) {
        # Detect process crash (non-zero exit without coordinator failure reported)
        if ($stateA.Process.HasExited -and $stateA.Process.ExitCode -ne 0) {
          $crashDetected = $true
          $failureDetAt  = [DateTime]::UtcNow
          $graceDeadline = $failureDetAt.AddSeconds($CleanupGraceSeconds)
          & $LogAction "k6-A (PID=$($stateA.Pid)) exited with code $($stateA.Process.ExitCode); scheduling kill of k6-B" $true
        } elseif ($stateB.Process.HasExited -and $stateB.Process.ExitCode -ne 0) {
          $crashDetected = $true
          $failureDetAt  = [DateTime]::UtcNow
          $graceDeadline = $failureDetAt.AddSeconds($CleanupGraceSeconds)
          & $LogAction "k6-B (PID=$($stateB.Pid)) exited with code $($stateB.Process.ExitCode); scheduling kill of k6-A" $true
        } else {
          try {
            $status = & $StatusProvider
            if ($null -ne $status -and ($status.loginBarrierFailed -eq $true -or $status.wsBarrierFailed -eq $true)) {
              $failure       = $status
              $failureDetAt  = [DateTime]::UtcNow
              $graceDeadline = $failureDetAt.AddSeconds($CleanupGraceSeconds)
            }
          } catch { & $LogAction "Coordinator status poll failed: $($_.Exception.Message)" $true }
        }
      }

      if (($null -ne $failure -or $crashDetected) -and $null -ne $graceDeadline -and [DateTime]::UtcNow -ge $graceDeadline) {
        if (-not $stateA.Process.HasExited) {
          $sA = Stop-VerifiedProcessTree $stateA
          $forcedA   = $sA.Forced
          $taskkillA = $sA.TaskkillExitCode
        }
        if (-not $stateB.Process.HasExited) {
          $sB = Stop-VerifiedProcessTree $stateB
          $forcedB   = $sB.Forced
          $taskkillB = $sB.TaskkillExitCode
        }
        break
      }

      Start-Sleep -Milliseconds $PollMilliseconds
    }

    [void]$stateA.Process.WaitForExit()
    [void]$stateB.Process.WaitForExit()
    Drain-K6Output $stateA $LogAction -Wait
    Drain-K6Output $stateB $LogAction -Wait

    return [pscustomobject]@{
      ProcessIdA                = $stateA.Pid
      ProcessStartTimeUtcTicksA = $stateA.StartTimeUtcTicks
      ExitCodeA                 = $stateA.Process.ExitCode
      ForcedTerminationA        = $forcedA
      TaskkillExitCodeA         = $taskkillA
      ProcessIdB                = $stateB.Pid
      ProcessStartTimeUtcTicksB = $stateB.StartTimeUtcTicks
      ExitCodeB                 = $stateB.Process.ExitCode
      ForcedTerminationB        = $forcedB
      TaskkillExitCodeB         = $taskkillB
      CoordinatorFailure        = $failure
      CrashDetected             = $crashDetected
      FailureDetectedAt         = $failureDetAt
    }
  } catch {
    foreach ($st in @($stateA, $stateB)) {
      if ($null -ne $st -and -not $st.Process.HasExited) { $null = Stop-VerifiedProcessTree $st }
    }
    throw
  } finally {
    foreach ($st in @($stateA, $stateB)) {
      if ($null -ne $st) { $st.Process.Dispose() }
    }
  }
}

function New-DualRunnerResult($Context, $DualResult, $MetricsStatsA, $MetricsStatsB, [string]$RunnerError) {
  $outcome = if (-not [string]::IsNullOrEmpty($RunnerError)) {
    'runner-error'
  } elseif ($null -ne $DualResult -and $null -ne $DualResult.CoordinatorFailure) {
    'coordinator-failure'
  } elseif ($null -ne $DualResult -and $DualResult.ExitCodeA -eq 0 -and $DualResult.ExitCodeB -eq 0) {
    'success'
  } else {
    'k6-error'  # covers crash-kills-other: at least one non-zero exit
  }
  return [ordered]@{
    schemaVersion = 2
    outcome = $outcome
    runId = $Context.RunId
    mode = $Context.Mode
    tables = $Context.Tables
    startedAt = $Context.StartedAt.ToString('o')
    finishedAt = [DateTime]::UtcNow.ToString('o')
    coordinatorFailure = if ($null -ne $DualResult) { $DualResult.CoordinatorFailure } else { $null }
    runnerError = $RunnerError
    k6 = [ordered]@{
      a = [ordered]@{
        processId = if ($null -ne $DualResult) { $DualResult.ProcessIdA } else { $null }
        processStartTimeUtcTicks = if ($null -ne $DualResult) { $DualResult.ProcessStartTimeUtcTicksA } else { $null }
        exitCode = if ($null -ne $DualResult) { $DualResult.ExitCodeA } else { $null }
        forcedTermination = if ($null -ne $DualResult) { $DualResult.ForcedTerminationA } else { $false }
        taskkillExitCode = if ($null -ne $DualResult) { $DualResult.TaskkillExitCodeA } else { $null }
      }
      b = [ordered]@{
        processId = if ($null -ne $DualResult) { $DualResult.ProcessIdB } else { $null }
        processStartTimeUtcTicks = if ($null -ne $DualResult) { $DualResult.ProcessStartTimeUtcTicksB } else { $null }
        exitCode = if ($null -ne $DualResult) { $DualResult.ExitCodeB } else { $null }
        forcedTermination = if ($null -ne $DualResult) { $DualResult.ForcedTerminationB } else { $false }
        taskkillExitCode = if ($null -ne $DualResult) { $DualResult.TaskkillExitCodeB } else { $null }
      }
      failureDetectedAt = if ($null -ne $DualResult -and $null -ne $DualResult.FailureDetectedAt) { $DualResult.FailureDetectedAt.ToString('o') } else { $null }
    }
    artifacts = [ordered]@{
      a = [ordered]@{
        logPath = $Context.LogPathA
        metricsPath = $Context.MetricsPathA
        k6SummaryPath = $Context.SummaryPathA
        k6SummaryExists = Test-Path -LiteralPath $Context.SummaryPathA -PathType Leaf
        metricsExists = $MetricsStatsA.Exists
        metricsFileSizeBytes = $MetricsStatsA.FileSizeBytes
        metricsSampledLines = $MetricsStatsA.SampledLines
        metricsSampleErrors = $MetricsStatsA.SampleErrors
      }
      b = [ordered]@{
        logPath = $Context.LogPathB
        metricsPath = $Context.MetricsPathB
        k6SummaryPath = $Context.SummaryPathB
        k6SummaryExists = Test-Path -LiteralPath $Context.SummaryPathB -PathType Leaf
        metricsExists = $MetricsStatsB.Exists
        metricsFileSizeBytes = $MetricsStatsB.FileSizeBytes
        metricsSampledLines = $MetricsStatsB.SampledLines
        metricsSampleErrors = $MetricsStatsB.SampleErrors
      }
    }
  }
}

try {
  # ── 17a. Start coordinator process ─────────────────────────────────────────
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName        = 'node'
  $psi.Arguments       = "`"$coordScript`" $runId $Tables $coordPort"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow  = $true
  $coordProcess = [System.Diagnostics.Process]::Start($psi)

  if ($null -eq $coordProcess) {
    Fail "Failed to start coordinator process."
  }

  # ── 17b. Wait for coordinator /health ──────────────────────────────────────
  $healthUrl      = "$coordUrl/health"
  $coordReady     = $false
  $healthDeadline = (Get-Date).AddSeconds(30)

  while ((Get-Date) -lt $healthDeadline) {
    Start-Sleep -Milliseconds 300
    try {
      $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing `
        -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) {
        $coordReady = $true
        break
      }
    } catch { }
  }

  if (-not $coordReady) {
    Fail "Coordinator did not become ready within 30 seconds on port $coordPort."
  }

  # ── 17c. Open log writer ────────────────────────────────────────────────────
  $script:logWriter = [System.IO.StreamWriter]::new(
    $logPath, $false, [System.Text.UTF8Encoding]::new($false))
  $script:logWriter.AutoFlush = $true
  $script:logWriter.WriteLine("Log started    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
  $script:logWriter.WriteLine('')

  Log ''
  Log '═══════════════════════════════════════════════════════════════'
  Log '  phased-multi-table-load k6 runner'
  Log '═══════════════════════════════════════════════════════════════'
  Log "  Mode             : $Mode"
  Log "  Target BASE_URL  : $BaseUrl"
  Log "  Target WS_URL    : $WsUrl"
  Log "  Tables           : $Tables"
  Log "  Players          : $($Tables * 4)  ($Tables x 4)"
  Log "  Stake            : $Stake"
  Log ''
  Log '  Timing:'
  Log "    LoginSpreadSeconds         : $LoginSpreadSeconds"
  Log "    LoginBarrierTimeoutSeconds : $LoginBarrierTimeoutSeconds"
  Log "    WsConnectSpreadSeconds     : $WsConnectSpreadSeconds"
  Log "    WsBarrierTimeoutSeconds    : $WsBarrierTimeoutSeconds"
  Log "    WsConnectDeadlineSeconds       : $WsConnectDeadlineSeconds"
  Log "    WsConnectAttemptTimeoutSeconds : $WsConnectAttemptTimeoutSeconds"
  Log "    WsMaxAttempts                  : $WsMaxAttempts"
  Log "    WsRetryBaseDelayMs             : $WsRetryBaseDelayMs"
  Log "    WsRetryMaxDelayMs              : $WsRetryMaxDelayMs"
  if ($Mode -eq 'full') {
    Log "    MatchmakingSpreadSeconds   : $MatchmakingSpreadSeconds"
    Log "    MatchRuntimeTimeoutSeconds : $MatchRuntimeTimeoutSeconds"
  }
  Log "    ActionDeadlineSafetyMs     : $ActionDeadlineSafetyMs"
  Log ''
  Log "  RejectedActionDiagnostics : $diagFlag"
  Log "  Credentials validated     : $requiredUsers users (indices 0..$($requiredUsers - 1))"
  Log "  Coordinator port          : $coordPort"
  Log "  Run ID                    : $runId"
  if ($Dual) {
    Log "  k6 processes  : 2 (A: TABLE_OFFSET=0 TABLES=$TablesPerProcess | B: TABLE_OFFSET=$TablesPerProcess TABLES=$TablesPerProcess)"
    Log "  Summary A    : $summaryPathA"
    Log "  Summary B    : $summaryPathB"
    Log "  Metrics A    : $metricsPathA"
    Log "  Metrics B    : $metricsPathB"
  } else {
    Log "  Summary JSON : $summaryPath"
    Log "  Metrics NDJSON: $metricsPath"
  }
  Log "  Runner result: $runnerResultPath"
  Log "  Console log  : $logPath"
  Log '═══════════════════════════════════════════════════════════════'
  Log ''

  # ── 17d. Run k6 asynchronously under the external failure supervisor ─────────
  $statusUrl = "$coordUrl/status?runId=$runId"
  $statusProvider = {
    Invoke-RestMethod -Uri $statusUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
  }
  $logAction = {
    param([string]$line, [bool]$isError)
    if ($isError) { Write-Host $line -ForegroundColor Red } else { Write-Host $line }
    if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($line) }
  }
  if ($Dual) {
    $dualResult = Invoke-DualK6Supervisor `
      $k6Executable $k6ArgsA $k6Executable $k6ArgsB $statusProvider $logAction `
      $FailureCleanupGraceSeconds $SupervisorPollMilliseconds
    $k6ExitCode = if ($dualResult.ExitCodeA -eq 0 -and $dualResult.ExitCodeB -eq 0) { 0 } else { 1 }
  } else {
    $supervisorResult = Invoke-K6Supervisor `
      $k6Executable $k6Args $statusProvider $logAction `
      $FailureCleanupGraceSeconds $SupervisorPollMilliseconds
    $k6ExitCode = $supervisorResult.ExitCode
  }

} catch {
  $runnerError = $_.Exception.ToString()
  $k6ExitCode = 1
  if ($null -ne $script:logWriter) { Log "Runner error: $runnerError" }
} finally {
  # ── Спри coordinator ─────────────────────────────────────────────────────────
  if ($null -ne $coordProcess) {
    if (-not $coordProcess.HasExited) {
      try { $coordProcess.Kill() } catch { }
      try { $coordProcess.WaitForExit(5000) } catch { }
    }
    $coordProcess.Dispose()
    $coordProcess = $null
  }

  # ── Always write a separate runner-owned result JSON ─────────────────────────
  try {
    if ($Dual) {
      $metricsStatsA = Get-MetricsNdjsonStats $metricsPathA
      $metricsStatsB = Get-MetricsNdjsonStats $metricsPathB
      $context = [pscustomobject]@{
        RunId = $runId; Mode = $Mode; Tables = $Tables; StartedAt = $runStartedAt
        LogPathA = $logPath; MetricsPathA = $metricsPathA; SummaryPathA = $summaryPathA
        LogPathB = $logPath; MetricsPathB = $metricsPathB; SummaryPathB = $summaryPathB
      }
      $runnerResult = New-DualRunnerResult $context $dualResult $metricsStatsA $metricsStatsB $runnerError
    } else {
      $metricsStats = Get-MetricsNdjsonStats $metricsPath
      $context = [pscustomobject]@{
        RunId = $runId; Mode = $Mode; Tables = $Tables; StartedAt = $runStartedAt
        LogPath = $logPath; MetricsPath = $metricsPath; SummaryPath = $summaryPath
      }
      $runnerResult = New-RunnerResult $context $supervisorResult $metricsStats $runnerError
    }
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

  # ── Затвори log ──────────────────────────────────────────────────────────────
  if ($null -ne $script:logWriter) {
    try {
      $script:logWriter.WriteLine('')
      $script:logWriter.WriteLine("k6 exit code : $k6ExitCode")
      $script:logWriter.WriteLine("Summary JSON : $summaryPath")
      $script:logWriter.WriteLine("Runner result: $runnerResultPath")
      $script:logWriter.WriteLine("Log ended    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
      $script:logWriter.Flush()
      $script:logWriter.Close()
    } catch { }
  }
}

Write-Host ''
Write-Host "k6 exited with code $k6ExitCode."
if ($Dual) {
  Write-Host "Summary A    : $summaryPathA"
  Write-Host "Summary B    : $summaryPathB"
  Write-Host "Metrics A    : $metricsPathA"
  Write-Host "Metrics B    : $metricsPathB"
} else {
  Write-Host "Summary JSON : $summaryPath"
  Write-Host "Metrics NDJSON: $metricsPath"
}
Write-Host "Runner result: $runnerResultPath"
Write-Host "Console log  : $logPath"

exit $k6ExitCode
