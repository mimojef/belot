param(
  # ─── Required: target ────────────────────────────────────────────────────────
  # Default стойности НЕ са зададени за URL-ите, за да се избегне случайно
  # изпълнение срещу production.
  # Пример (SSH tunnel):  -BaseUrl http://127.0.0.1:3101 -WsUrl ws://127.0.0.1:3101/ws
  # Пример (директно):    -BaseUrl http://185.203.117.14:3101 -WsUrl ws://185.203.117.14:3101/ws
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$WsUrl,

  # ─── Required: scale ─────────────────────────────────────────────────────────
  [Parameter(Mandatory = $true)][int]$Tables,

  # ─── Required: timing ────────────────────────────────────────────────────────
  # Всички timing стойности са задължителни — runner-ът никога не разчита на
  # defaults от multi-table-load.js, за да са тестовете точно сравними.
  [Parameter(Mandatory = $true)][int]$LoginSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$MatchmakingBarrierSeconds,
  [Parameter(Mandatory = $true)][int]$WsConnectSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$WsReadyBufferSeconds,
  [Parameter(Mandatory = $true)][int]$MatchmakingSpreadSeconds,
  [Parameter(Mandatory = $true)][int]$HealthBarrierTimeoutSeconds,
  [Parameter(Mandatory = $true)][int]$MatchRuntimeTimeoutSeconds,

  # ─── Optional with stable defaults ───────────────────────────────────────────
  [string]$Stake                = '5000',
  [int]$ActionDeadlineSafetyMs = 500,
  [switch]$RejectedActionDiagnostics,

  # ─── Optional: results directory (default: same directory as this script) ────
  [string]$ResultsDirectory = ''
)

$ErrorActionPreference = 'Stop'

$k6ScriptDir  = $PSScriptRoot
$credPath     = Join-Path $k6ScriptDir 'loadtest-users.json.local'
$k6ScriptPath = Join-Path $k6ScriptDir 'multi-table-load.js'

function Fail([string]$message) {
  Write-Error -Message $message -ErrorAction Continue
  exit 1
}

# ── 1. Validate Tables ────────────────────────────────────────────────────────
if ($Tables -lt 1) {
  Fail "Tables must be >= 1, got $Tables."
}

# ── 2. Validate timing (all must be >= 1) ────────────────────────────────────
$timingCheck = [ordered]@{
  LoginSpreadSeconds          = $LoginSpreadSeconds
  MatchmakingBarrierSeconds   = $MatchmakingBarrierSeconds
  WsConnectSpreadSeconds      = $WsConnectSpreadSeconds
  WsReadyBufferSeconds        = $WsReadyBufferSeconds
  MatchmakingSpreadSeconds    = $MatchmakingSpreadSeconds
  HealthBarrierTimeoutSeconds = $HealthBarrierTimeoutSeconds
  MatchRuntimeTimeoutSeconds  = $MatchRuntimeTimeoutSeconds
}
foreach ($entry in $timingCheck.GetEnumerator()) {
  if ($entry.Value -lt 1) {
    Fail "$($entry.Key) must be a positive integer (>= 1), got $($entry.Value)."
  }
}

# ── 3. Validate Stake ─────────────────────────────────────────────────────────
$stakeInt = 0
if (-not [int]::TryParse($Stake, [ref]$stakeInt) -or $stakeInt -lt 1) {
  Fail "Stake must be a positive integer, got '$Stake'."
}

# ── 4. Validate ActionDeadlineSafetyMs ───────────────────────────────────────
if ($ActionDeadlineSafetyMs -lt 0) {
  Fail "ActionDeadlineSafetyMs must be >= 0, got $ActionDeadlineSafetyMs."
}

# ── 5. Strip trailing slashes from BaseUrl ───────────────────────────────────
$BaseUrl = $BaseUrl.TrimEnd('/')

# ── 6. Basic URL scheme check ─────────────────────────────────────────────────
if ($BaseUrl -notmatch '^http://') {
  Fail "BaseUrl must start with http://, got: $BaseUrl"
}
if ($WsUrl -notmatch '^ws://') {
  Fail "WsUrl must start with ws://, got: $WsUrl"
}

# ── 7. Target safety guard — exact pair allowlist ─────────────────────────────
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

# ── 8. Validate credentials file ─────────────────────────────────────────────
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

# ── 9. Validate k6 in PATH ───────────────────────────────────────────────────
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  Fail 'k6 not found in PATH. Install k6 or add it to PATH before running.'
}

# ── 10. Validate k6 script exists ────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $k6ScriptPath -PathType Leaf)) {
  Fail "k6 script not found: $k6ScriptPath"
}

# ── 11. Resolve results directory ────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) {
  $ResultsDirectory = $k6ScriptDir
}
if (-not (Test-Path -LiteralPath $ResultsDirectory -PathType Container)) {
  Fail "ResultsDirectory does not exist: $ResultsDirectory"
}

# ── 12. Generate timestamped output paths ────────────────────────────────────
$timestamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$fileBase    = "multi-table-load-${Tables}t-${timestamp}"
$summaryPath = Join-Path $ResultsDirectory "${fileBase}.json"
$logPath     = Join-Path $ResultsDirectory "${fileBase}.log"

if (Test-Path -LiteralPath $summaryPath) {
  Fail "Summary file already exists (timestamp collision?): $summaryPath"
}
if (Test-Path -LiteralPath $logPath) {
  Fail "Log file already exists (timestamp collision?): $logPath"
}

# ── 13. Assemble k6 arguments ────────────────────────────────────────────────
$diagFlag = if ($RejectedActionDiagnostics) { '1' } else { '0' }

$k6Args = @(
  'run',
  '-e', "TABLES=$Tables",
  '-e', "LOGIN_SPREAD_SECONDS=$LoginSpreadSeconds",
  '-e', "MATCHMAKING_BARRIER_SECONDS=$MatchmakingBarrierSeconds",
  '-e', "WS_CONNECT_SPREAD_SECONDS=$WsConnectSpreadSeconds",
  '-e', "WS_READY_BUFFER_SECONDS=$WsReadyBufferSeconds",
  '-e', "MATCHMAKING_SPREAD_SECONDS=$MatchmakingSpreadSeconds",
  '-e', "HEALTH_BARRIER_TIMEOUT_SECONDS=$HealthBarrierTimeoutSeconds",
  '-e', "REQUIRED_ACTIVE_ROOMS=$Tables",
  '-e', "MATCH_RUNTIME_TIMEOUT_SECONDS=$MatchRuntimeTimeoutSeconds",
  '-e', "ACTION_DEADLINE_SAFETY_MS=$ActionDeadlineSafetyMs",
  '-e', "BASE_URL=$BaseUrl",
  '-e', "WS_URL=$WsUrl",
  '-e', "STAKE=$Stake",
  '-e', "REJECTED_ACTION_DIAGNOSTICS=$diagFlag",
  '-e', "SUMMARY_JSON_PATH=$summaryPath",
  $k6ScriptPath
)

# ── 14. Open log, print summary, run k6 ──────────────────────────────────────
# stdout and stderr of k6 are both shown on the console in real-time and
# captured to $logPath via StreamWriter + 2>&1 | ForEach-Object pipeline.
# $LASTEXITCODE after the pipeline reflects k6's own exit code.
$script:logWriter = $null
$k6ExitCode = 1

function Log([string]$line) {
  Write-Host $line
  if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($line) }
}

try {
  $script:logWriter = [System.IO.StreamWriter]::new(
    $logPath, $false, [System.Text.UTF8Encoding]::new($false))
  $script:logWriter.AutoFlush = $true
  $script:logWriter.WriteLine("Log started : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
  $script:logWriter.WriteLine('')

  Log ''
  Log '═══════════════════════════════════════════════════'
  Log '  multi-table-load k6 runner'
  Log '═══════════════════════════════════════════════════'
  Log "  Target BASE_URL  : $BaseUrl"
  Log "  Target WS_URL    : $WsUrl"
  Log "  Tables           : $Tables"
  Log "  Players          : $($Tables * 4)  ($Tables x 4)"
  Log "  Stake            : $Stake"
  Log ''
  Log '  Timing:'
  Log "    LoginSpreadSeconds          : $LoginSpreadSeconds"
  Log "    MatchmakingBarrierSeconds   : $MatchmakingBarrierSeconds"
  Log "    WsConnectSpreadSeconds      : $WsConnectSpreadSeconds"
  Log "    WsReadyBufferSeconds        : $WsReadyBufferSeconds"
  Log "    MatchmakingSpreadSeconds    : $MatchmakingSpreadSeconds"
  Log "    HealthBarrierTimeoutSeconds : $HealthBarrierTimeoutSeconds"
  Log "    MatchRuntimeTimeoutSeconds  : $MatchRuntimeTimeoutSeconds"
  Log "    ActionDeadlineSafetyMs      : $ActionDeadlineSafetyMs"
  Log ''
  Log "  RejectedActionDiagnostics : $diagFlag"
  Log "  Credentials validated     : $requiredUsers users (indices 0..$($requiredUsers - 1))"
  Log "  Summary JSON : $summaryPath"
  Log "  Console log  : $logPath"
  Log '═══════════════════════════════════════════════════'
  Log ''

  # NativeCommandError от k6 stderr не трябва да хвърля изключение.
  # $LASTEXITCODE след pipeline-а е реалният exit code на k6.
  $ErrorActionPreference = 'Continue'
  & k6 @k6Args 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      $line = $_.Exception.Message
      Write-Host $line -ForegroundColor Red
    } else {
      $line = [string]$_
      Write-Host $line
    }
    $script:logWriter.WriteLine($line)
  }
  $k6ExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  $ErrorActionPreference = 'Stop'
} finally {
  if ($null -ne $script:logWriter) {
    try {
      $script:logWriter.WriteLine('')
      $script:logWriter.WriteLine("k6 exit code : $k6ExitCode")
      $script:logWriter.WriteLine("Summary JSON : $summaryPath")
      $script:logWriter.WriteLine("Log ended    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
      $script:logWriter.Flush()
      $script:logWriter.Close()
    } catch { }
  }
}

Write-Host ''
Write-Host "k6 exited with code $k6ExitCode."
Write-Host "Summary JSON : $summaryPath"
Write-Host "Console log  : $logPath"

exit $k6ExitCode
