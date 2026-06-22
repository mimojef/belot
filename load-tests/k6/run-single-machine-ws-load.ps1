param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$WsUrl,
  [Parameter(Mandatory = $true)][ValidateRange(1, 600)][int]$Tables,
  [int]$LoginSpreadSeconds = 20,
  [int]$WsStartDelaySeconds = 30,
  [int]$WsAttemptTimeoutSeconds = 10,
  [int]$WsDeadlineSeconds = 60,
  [int]$WsHoldSeconds = 5,
  [ValidateRange(1, 20)][int]$WsMaxAttempts = 3,
  [int]$WsRetryBaseDelayMs = 250,
  [int]$WsRetryMaxDelayMs = 2000,
  [int]$CleanupTimeoutMs = 5000,
  [ValidateRange(1, 300)][int]$HardTimeoutGraceSeconds = 15,
  [string]$ResultsDirectory = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$scriptDir = $PSScriptRoot
$credentialsPath = Join-Path $scriptDir 'loadtest-users.json.local'
$loadScriptPath = Join-Path $scriptDir 'single-machine-ws-load.js'

function Fail([string]$Message) {
  Write-Error -Message $Message -ErrorAction Continue
  exit 1
}

function ConvertTo-NativeArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
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

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
  if ($null -eq $Process -or $Process.HasExited) { return }
  & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1 | Out-Null
}

function New-MetricsState {
  $counts = [ordered]@{}
  foreach ($name in @(
    'login_attempts', 'login_failures', 'login_ready_players', 'login_ready_tables',
    'ws_attempts', 'ws_retries', 'ws_retry_exhausted', 'ws_ready_players',
    'ws_ready_tables', 'ws_deadlines_exceeded', 'ws_terminal_failures',
    'ws_cleanup_completed', 'ws_cleanup_failures'
  )) { $counts[$name] = 0.0 }
  return [pscustomobject]@{
    Offset = [int64]0
    PendingBytes = [byte[]]@()
    Counts = $counts
    FileFound = $false
    ReadSucceeded = $false
    ReadErrors = 0
    InvalidJsonLines = 0
    PartialJsonLines = 0
  }
}

function Add-MetricJsonLine($State, [string]$Line, [bool]$Partial) {
  if ([string]::IsNullOrWhiteSpace($Line)) { return }
  try {
    $record = $Line | ConvertFrom-Json -ErrorAction Stop
    if ($record.type -eq 'Point' -and $State.Counts.Contains([string]$record.metric)) {
      $value = 0.0
      if ([double]::TryParse(
          [string]$record.data.value,
          [System.Globalization.NumberStyles]::Float,
          [System.Globalization.CultureInfo]::InvariantCulture,
          [ref]$value
        )) {
        $State.Counts[[string]$record.metric] += $value
      }
    }
  } catch {
    if ($Partial) { $State.PartialJsonLines += 1 } else { $State.InvalidJsonLines += 1 }
  }
}

function Read-IncrementalMetrics($State, [string]$Path, [switch]$Final) {
  $stream = $null
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $State.FileFound = $true
      $stream = [System.IO.FileStream]::new(
        $Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
      if ($stream.Length -lt $State.Offset) {
        $State.Offset = 0
        $State.PendingBytes = [byte[]]@()
      }
      [void]$stream.Seek($State.Offset, [System.IO.SeekOrigin]::Begin)
      $available = [int]($stream.Length - $State.Offset)
      if ($available -gt 0) {
        $newBytes = [byte[]]::new($available)
        $totalRead = 0
        while ($totalRead -lt $available) {
          $read = $stream.Read($newBytes, $totalRead, $available - $totalRead)
          if ($read -le 0) { break }
          $totalRead += $read
        }
        if ($totalRead -gt 0) {
          $buffer = [byte[]]::new($State.PendingBytes.Length + $totalRead)
          if ($State.PendingBytes.Length -gt 0) {
            [System.Array]::Copy($State.PendingBytes, 0, $buffer, 0, $State.PendingBytes.Length)
          }
          [System.Array]::Copy($newBytes, 0, $buffer, $State.PendingBytes.Length, $totalRead)
          $lineStart = 0
          for ($index = 0; $index -lt $buffer.Length; $index += 1) {
            if ($buffer[$index] -ne 10) { continue }
            $length = $index - $lineStart
            if ($length -gt 0 -and $buffer[$index - 1] -eq 13) { $length -= 1 }
            $line = [System.Text.Encoding]::UTF8.GetString($buffer, $lineStart, $length)
            Add-MetricJsonLine $State $line $false
            $lineStart = $index + 1
          }
          $pendingLength = $buffer.Length - $lineStart
          $State.PendingBytes = [byte[]]::new($pendingLength)
          if ($pendingLength -gt 0) {
            [System.Array]::Copy($buffer, $lineStart, $State.PendingBytes, 0, $pendingLength)
          }
          $State.Offset += $totalRead
        }
      }
      $State.ReadSucceeded = $true
    }
  } catch {
    $State.ReadErrors += 1
  } finally {
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
  }

  if ($Final -and $State.PendingBytes.Length -gt 0) {
    try {
      $line = [System.Text.UTF8Encoding]::new($false, $true).GetString($State.PendingBytes)
      Add-MetricJsonLine $State $line $true
    } catch {
      $State.PartialJsonLines += 1
    }
    $State.PendingBytes = [byte[]]@()
  }
}

function Format-ProgressLine($State, [double]$ElapsedSeconds) {
  $counts = $State.Counts
  return ('PROGRESS elapsed={0:F1}s login={1}/{2} loginFail={3} wsReady={4}/{5} ' +
    'wsAttempts={6} retries={7} exhausted={8} deadlines={9} terminal={10} cleanup={11} cleanupFail={12}') -f @(
      $ElapsedSeconds, $counts.login_ready_players, $counts.login_attempts,
      $counts.login_failures, $counts.ws_ready_players, $counts.ws_ready_tables,
      $counts.ws_attempts, $counts.ws_retries, $counts.ws_retry_exhausted,
      $counts.ws_deadlines_exceeded, $counts.ws_terminal_failures,
      $counts.ws_cleanup_completed, $counts.ws_cleanup_failures
    )
}

function Write-RunnerSummary([string]$Path, $Summary) {
  $json = $Summary | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

$BaseUrl = $BaseUrl.TrimEnd('/')
$allowedPairs = @(
  [pscustomobject]@{ BaseUrl = 'http://185.203.117.14:3101'; WsUrl = 'ws://185.203.117.14:3101/ws' }
  [pscustomobject]@{ BaseUrl = 'http://127.0.0.1:3101'; WsUrl = 'ws://127.0.0.1:3101/ws' }
)
if ($null -eq ($allowedPairs | Where-Object { $_.BaseUrl -eq $BaseUrl -and $_.WsUrl -eq $WsUrl })) {
  Fail "SAFETY: Непозволена BASE_URL/WS_URL комбинация: '$BaseUrl' + '$WsUrl'. Разрешен е само load-test backend на порт 3101."
}

$positiveValues = [ordered]@{
  WsStartDelaySeconds = $WsStartDelaySeconds
  WsAttemptTimeoutSeconds = $WsAttemptTimeoutSeconds
  WsDeadlineSeconds = $WsDeadlineSeconds
  WsHoldSeconds = $WsHoldSeconds
  WsRetryBaseDelayMs = $WsRetryBaseDelayMs
  WsRetryMaxDelayMs = $WsRetryMaxDelayMs
  CleanupTimeoutMs = $CleanupTimeoutMs
}
foreach ($entry in $positiveValues.GetEnumerator()) {
  if ($entry.Value -lt 1) { Fail "$($entry.Key) must be a positive integer." }
}
if ($LoginSpreadSeconds -lt 0) { Fail 'LoginSpreadSeconds must be >= 0.' }
if ($LoginSpreadSeconds -ge $WsStartDelaySeconds) {
  Fail 'LoginSpreadSeconds must be less than WsStartDelaySeconds.'
}
if ($WsAttemptTimeoutSeconds -ge $WsDeadlineSeconds) {
  Fail 'WsAttemptTimeoutSeconds must be less than WsDeadlineSeconds.'
}
if ($WsRetryBaseDelayMs -gt $WsRetryMaxDelayMs) {
  Fail 'WsRetryBaseDelayMs must be <= WsRetryMaxDelayMs.'
}
if (-not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
  Fail "Credentials file not found: $credentialsPath"
}
try {
  $credentials = Get-Content -Raw -Encoding UTF8 -LiteralPath $credentialsPath | ConvertFrom-Json
} catch {
  Fail "Invalid JSON in credentials file: $credentialsPath"
}
$requiredUsers = $Tables * 4
if ($null -eq $credentials.users -or -not ($credentials.users -is [array])) {
  Fail 'Credentials file must have the structure: { "users": [...] }'
}
if ($credentials.users.Count -lt $requiredUsers) {
  Fail "Tables=$Tables requires at least $requiredUsers credentials; found $($credentials.users.Count)."
}
for ($index = 0; $index -lt $requiredUsers; $index++) {
  if ([string]::IsNullOrWhiteSpace([string]$credentials.users[$index].email)) {
    Fail "Credential index $index is missing email."
  }
  if ([string]::IsNullOrEmpty([string]$credentials.users[$index].password)) {
    Fail "Credential index $index is missing password."
  }
}
$k6Command = Get-Command k6 -ErrorAction SilentlyContinue
if ($null -eq $k6Command) { Fail 'k6 not found in PATH.' }
if (-not (Test-Path -LiteralPath $loadScriptPath -PathType Leaf)) { Fail "Load script not found: $loadScriptPath" }
if ([string]::IsNullOrWhiteSpace($ResultsDirectory)) { $ResultsDirectory = $scriptDir }
if (-not (Test-Path -LiteralPath $ResultsDirectory -PathType Container)) {
  Fail "ResultsDirectory does not exist: $ResultsDirectory"
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$fileBase = "single-machine-ws-${Tables}t-${timestamp}"
$summaryPath = Join-Path $ResultsDirectory "$fileBase-summary.json"
$metricsPath = Join-Path $ResultsDirectory "$fileBase-metrics.jsonl"
$logPath = Join-Path $ResultsDirectory "$fileBase.log"
$runnerSummaryPath = Join-Path $ResultsDirectory "$fileBase-runner-summary.json"
$partialSummaryPath = Join-Path $ResultsDirectory "$fileBase-partial-summary.json"
if (@($summaryPath, $metricsPath, $logPath, $runnerSummaryPath, $partialSummaryPath) |
    Where-Object { Test-Path -LiteralPath $_ }) {
  Fail 'Output path collision. Wait one second and run again.'
}
$k6Arguments = @(
  'run',
  '--no-color',
  '--out', "json=$metricsPath",
  '-e', "TABLES=$Tables",
  '-e', "BASE_URL=$BaseUrl",
  '-e', "WS_URL=$WsUrl",
  '-e', "LOGIN_SPREAD_SECONDS=$LoginSpreadSeconds",
  '-e', "WS_START_DELAY_SECONDS=$WsStartDelaySeconds",
  '-e', "WS_ATTEMPT_TIMEOUT_SECONDS=$WsAttemptTimeoutSeconds",
  '-e', "WS_DEADLINE_SECONDS=$WsDeadlineSeconds",
  '-e', "WS_HOLD_SECONDS=$WsHoldSeconds",
  '-e', "WS_MAX_ATTEMPTS=$WsMaxAttempts",
  '-e', "WS_RETRY_BASE_DELAY_MS=$WsRetryBaseDelayMs",
  '-e', "WS_RETRY_MAX_DELAY_MS=$WsRetryMaxDelayMs",
  '-e', "CLEANUP_TIMEOUT_MS=$CleanupTimeoutMs",
  '-e', "SUMMARY_JSON_PATH=$summaryPath",
  $loadScriptPath
)
$hardTimeoutSeconds = $WsStartDelaySeconds + $WsDeadlineSeconds + $WsHoldSeconds `
  + [int][Math]::Ceiling($CleanupTimeoutMs / 1000.0) + $HardTimeoutGraceSeconds
$watchdogExitCode = 124

$script:logWriter = $null
$k6ExitCode = 1
$process = $null
$watchdogTriggered = $false
$runnerStatus = 'runner-failure'
$runnerError = $null
$clock = $null
$metricsState = New-MetricsState
$nextProgressAtSeconds = 5.0
$writtenSummaryPath = $partialSummaryPath
function Log([string]$Line) {
  Write-Host $Line
  if ($null -ne $script:logWriter) { $script:logWriter.WriteLine($Line) }
}

try {
  $script:logWriter = [System.IO.StreamWriter]::new(
    $logPath, $false, [System.Text.UTF8Encoding]::new($false))
  $script:logWriter.AutoFlush = $true
  Log 'single-machine WebSocket load runner'
  Log "BASE_URL: $BaseUrl"
  Log "WS_URL:   $WsUrl"
  Log "Tables:   $Tables"
  Log "Players:  $requiredUsers"
  Log "Login spread: $LoginSpreadSeconds seconds"
  Log "WS hold:      $WsHoldSeconds seconds"
  Log "Hard timeout: $hardTimeoutSeconds seconds"
  Log "Metrics JSONL: $metricsPath"
  Log "k6 summary:    $summaryPath"
  Log "Log:           $logPath"
  Log ''

  $nativeArguments = (($k6Arguments | ForEach-Object {
    ConvertTo-NativeArgument ([string]$_)
  }) -join ' ')
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  if ($k6Command.Source -match '\.(cmd|bat)$') {
    $psi.FileName = $env:ComSpec
    $quotedCommand = ConvertTo-NativeArgument $k6Command.Source
    $psi.Arguments = "/d /s /c `"$quotedCommand $nativeArguments`""
  } else {
    $psi.FileName = $k6Command.Source
    $psi.Arguments = $nativeArguments
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $psi.EnvironmentVariables['NO_COLOR'] = '1'

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  if (-not $process.Start()) { throw 'Failed to start k6 process.' }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $stdoutDone = $false
  $stderrDone = $false
  $stdoutTask = $process.StandardOutput.ReadLineAsync()
  $stderrTask = $process.StandardError.ReadLineAsync()

  while (-not ($process.HasExited -and $stdoutDone -and $stderrDone)) {
    while (-not $stdoutDone -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.GetAwaiter().GetResult()
      if ($null -eq $line) { $stdoutDone = $true } else {
        Write-Host $line
        $script:logWriter.WriteLine($line)
        $stdoutTask = $process.StandardOutput.ReadLineAsync()
      }
    }
    while (-not $stderrDone -and $stderrTask.IsCompleted) {
      $line = $stderrTask.GetAwaiter().GetResult()
      if ($null -eq $line) { $stderrDone = $true } else {
        Write-Host $line -ForegroundColor Red
        $script:logWriter.WriteLine($line)
        $stderrTask = $process.StandardError.ReadLineAsync()
      }
    }
    if (-not $watchdogTriggered -and -not $process.HasExited `
        -and $clock.Elapsed.TotalSeconds -ge $hardTimeoutSeconds) {
      $watchdogTriggered = $true
      $runnerStatus = 'watchdog'
      $reason = "HARD WATCHDOG: k6 exceeded $hardTimeoutSeconds seconds; terminating process tree."
      Log $reason
      Stop-ProcessTree $process
    } elseif ($watchdogTriggered -and -not $process.HasExited `
        -and $clock.Elapsed.TotalSeconds -ge ($hardTimeoutSeconds + 5)) {
      $process.Kill()
    }
    if ($clock.Elapsed.TotalSeconds -ge $nextProgressAtSeconds) {
      Read-IncrementalMetrics $metricsState $metricsPath
      Log (Format-ProgressLine $metricsState $clock.Elapsed.TotalSeconds)
      while ($nextProgressAtSeconds -le $clock.Elapsed.TotalSeconds) {
        $nextProgressAtSeconds += 5.0
      }
    }
    if (-not ($process.HasExited -and $stdoutDone -and $stderrDone)) {
      Start-Sleep -Milliseconds 10
    }
  }
  $process.WaitForExit()
  $k6ExitCode = if ($watchdogTriggered) { $watchdogExitCode } else { $process.ExitCode }
  if (-not $watchdogTriggered) { $runnerStatus = 'normal' }
} catch {
  $runnerError = $_.Exception.Message
  if ($null -ne $script:logWriter) { Log "Runner failure: $runnerError" }
  $k6ExitCode = if ($watchdogTriggered) { $watchdogExitCode } else { 1 }
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    try { Stop-ProcessTree $process } catch { }
  }
  $elapsedSeconds = if ($null -ne $clock) { $clock.Elapsed.TotalSeconds } else { 0.0 }
  try { Read-IncrementalMetrics $metricsState $metricsPath -Final } catch { }
  $writtenSummaryPath = if ($runnerStatus -eq 'normal') {
    $runnerSummaryPath
  } else {
    $partialSummaryPath
  }
  $runnerSummary = [ordered]@{
    status = $runnerStatus
    exitCode = $k6ExitCode
    elapsedSeconds = [Math]::Round($elapsedSeconds, 3)
    paths = [ordered]@{
      log = $logPath
      metrics = $metricsPath
      k6Summary = $summaryPath
    }
    metrics = $metricsState.Counts
    metricsFileFound = $metricsState.FileFound
    metricsReadSucceeded = $metricsState.ReadSucceeded
    metricsReadErrors = $metricsState.ReadErrors
    invalidJsonLines = $metricsState.InvalidJsonLines
    partialJsonLines = $metricsState.PartialJsonLines
    runnerError = $runnerError
  }
  try {
    Write-RunnerSummary $writtenSummaryPath $runnerSummary
    if ($null -ne $script:logWriter) {
      Log (Format-ProgressLine $metricsState $elapsedSeconds)
      Log "Runner summary: $writtenSummaryPath"
    }
  } catch {
    if ($null -ne $script:logWriter) {
      try { Log "Runner summary write failed: $($_.Exception.Message)" } catch { }
    }
  }
  if ($null -ne $process) { try { $process.Dispose() } catch { } }
  if ($null -ne $script:logWriter) {
    try {
      $script:logWriter.WriteLine('')
      $script:logWriter.WriteLine("k6 exit code: $k6ExitCode")
      $script:logWriter.WriteLine("Metrics JSONL: $metricsPath")
      $script:logWriter.WriteLine("Runner summary: $writtenSummaryPath")
      $script:logWriter.Flush()
      $script:logWriter.Close()
    } catch { }
  }
}

Write-Host "k6 exited with code $k6ExitCode."
Write-Host "Metrics JSONL: $metricsPath"
Write-Host "k6 summary:    $summaryPath"
Write-Host "Runner summary: $writtenSummaryPath"
Write-Host "Console log:   $logPath"
exit $k6ExitCode
