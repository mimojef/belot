[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$Tables,

    [Parameter(Mandatory = $true)]
    [int]$WorkerCount,

    [Parameter(Mandatory = $true)]
    [string]$HttpBaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$WsUrl,

    [Parameter(Mandatory = $true)]
    [string]$CredentialsPath,

    [string]$ResultsDirectory = (Join-Path $PSScriptRoot 'results'),
    [double]$LoginSpreadSeconds = 20,
    [double]$WsReadinessSeconds = 60,
    [double]$HoldSeconds = 5,
    [double]$HeartbeatTimeoutSeconds = 10,
    [double]$ControllerHardTimeoutSeconds = 120,
    [double]$HardTimeoutSeconds = 150,
    [string]$NodeExecutable = 'node',
    [string]$ControllerPath = (Join-Path $PSScriptRoot 'multi-process-ws-controller.mjs')
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

function Stop-OwnedProcessTree {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return }
    & taskkill.exe /PID $ProcessId /T /F *> $null
}

function Stop-ControllerProcess {
    param($Process)
    if ($null -eq $Process) { return }
    try { if ($Process.HasExited) { return } } catch { return }
    Stop-OwnedProcessTree -ProcessId $Process.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $fallbackDeadline = [DateTime]::UtcNow.AddSeconds(2)
        while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $fallbackDeadline) {
            Start-Sleep -Milliseconds 100
        }
    }
}

function Quote-ProcessArgument {
    param([string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Convert-ToMilliseconds {
    param([double]$Seconds)
    return [int64][Math]::Round($Seconds * 1000)
}

function Assert-NumberRange {
    param([string]$Name, [double]$Value, [double]$Minimum, [double]$Maximum)
    if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value) -or
        $Value -lt $Minimum -or $Value -gt $Maximum) {
        throw "$Name must be between $Minimum and $Maximum."
    }
}

function Get-SafeSummaryNumber {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return [int64]0 }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { return [int64]0 }
    try { return [int64]$property.Value } catch { return [int64]0 }
}

function Write-SafeProgress {
    param([string]$SummaryPath, [string]$LogPath)
    if (-not (Test-Path -LiteralPath $SummaryPath -PathType Leaf)) { return $false }
    try {
        $summary = Get-Content -Raw -LiteralPath $SummaryPath | ConvertFrom-Json
        $expectedProfiles = Get-SafeSummaryNumber $summary.expected 'profiles'
        $expectedTables = Get-SafeSummaryNumber $summary.expected 'tables'
        $loginSuccesses = Get-SafeSummaryNumber $summary.metrics 'loginSuccesses'
        $readyProfiles = Get-SafeSummaryNumber $summary.metrics 'peakReadyProfiles'
        $readyTables = Get-SafeSummaryNumber $summary.metrics 'peakReadyTables'
        $activeSockets = Get-SafeSummaryNumber $summary.metrics 'currentActiveSockets'
        $terminalFailures = Get-SafeSummaryNumber $summary.metrics 'terminalProfileFailures'
        $workerCrashes = Get-SafeSummaryNumber $summary.metrics 'workerCrashes'
        $heartbeatTimeouts = Get-SafeSummaryNumber $summary.metrics 'heartbeatTimeouts'
        $line = "PROGRESS login=$loginSuccesses/$expectedProfiles" +
            " readyProfiles=$readyProfiles/$expectedProfiles" +
            " readyTables=$readyTables/$expectedTables activeSockets=$activeSockets" +
            " terminalFailures=$terminalFailures workerCrashes=$workerCrashes" +
            " heartbeatTimeouts=$heartbeatTimeouts"
    } catch {
        return $false
    }
    Write-Host $line
    $line | Add-Content -LiteralPath $LogPath -Encoding UTF8
    return $true
}

$controller = $null
$controllerStarted = $false
$runnerExitCode = 2
try {
    Assert-NumberRange 'Tables' $Tables 1 400
    Assert-NumberRange 'WorkerCount' $WorkerCount 1 32
    Assert-NumberRange 'LoginSpreadSeconds' $LoginSpreadSeconds 0 3600
    Assert-NumberRange 'WsReadinessSeconds' $WsReadinessSeconds 0.1 3600
    Assert-NumberRange 'HoldSeconds' $HoldSeconds 0.1 3600
    Assert-NumberRange 'HeartbeatTimeoutSeconds' $HeartbeatTimeoutSeconds 0.1 3600
    Assert-NumberRange 'ControllerHardTimeoutSeconds' $ControllerHardTimeoutSeconds 1 86400
    Assert-NumberRange 'HardTimeoutSeconds' $HardTimeoutSeconds 1 86400
    if ($WorkerCount -gt $Tables) { throw 'WorkerCount must not exceed Tables.' }
    if ($HardTimeoutSeconds -lt ($ControllerHardTimeoutSeconds + 10)) {
        throw 'HardTimeoutSeconds must be at least ControllerHardTimeoutSeconds + 10.'
    }
    $requiredProfiles = $Tables * 4
    if ($requiredProfiles -gt 1600) { throw 'Requested profile count exceeds 1600.' }

    $allowedPair = (
        ($HttpBaseUrl -ceq 'http://185.203.117.14:3101' -and
            $WsUrl -ceq 'ws://185.203.117.14:3101/ws') -or
        ($HttpBaseUrl -ceq 'http://127.0.0.1:3101' -and
            $WsUrl -ceq 'ws://127.0.0.1:3101/ws') -or
        ($HttpBaseUrl -ceq 'http://localhost:3101' -and
            $WsUrl -ceq 'ws://localhost:3101/ws')
    )
    if (-not $allowedPair) { throw 'SAFETY: disallowed HTTP/WebSocket target pair.' }
    $nodeCommand = Get-Command -Name $NodeExecutable -CommandType Application -ErrorAction Stop
    $nodePath = $nodeCommand.Source
    $wsPackagePath = Join-Path $scriptRoot 'node_modules\ws\package.json'
    if (-not (Test-Path -LiteralPath $wsPackagePath -PathType Leaf)) {
        throw 'Missing local node_modules/ws dependency.'
    }
    $resolvedController = (Resolve-Path -LiteralPath $ControllerPath -ErrorAction Stop).Path
    $resolvedCredentials = (Resolve-Path -LiteralPath $CredentialsPath -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedCredentials -PathType Leaf)) {
        throw 'Credentials path must be a file.'
    }

    try {
        $credentialsDocument = Get-Content -Raw -LiteralPath $resolvedCredentials | ConvertFrom-Json
    } catch {
        throw 'Credentials file is not valid JSON.'
    }
    if ($null -eq $credentialsDocument.users -or $credentialsDocument.users -isnot [System.Array]) {
        throw 'Credentials file must contain a users array.'
    }
    if ($credentialsDocument.users.Count -lt $requiredProfiles) {
        throw "Credentials file contains fewer than the required $requiredProfiles profiles."
    }
    $credentialsDocument = $null

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $resolvedResultsRoot = [System.IO.Path]::GetFullPath($ResultsDirectory)
    $runDirectory = Join-Path $resolvedResultsRoot "multi-process-ws-$timestamp"
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    $logPath = Join-Path $runDirectory "multi-process-ws-$timestamp.log"

    @(
        "[$(Get-Date -Format o)] Starting Node multi-process WebSocket controller"
        "tables=$Tables workers=$WorkerCount profiles=$requiredProfiles"
        "httpTarget=$HttpBaseUrl wsTarget=$WsUrl"
        "controller=$resolvedController"
    ) | Set-Content -LiteralPath $logPath -Encoding UTF8

    $arguments = @(
        (Quote-ProcessArgument $resolvedController),
        '--tables', "$Tables",
        '--workers', "$WorkerCount",
        '--base-url', (Quote-ProcessArgument $HttpBaseUrl),
        '--ws-url', (Quote-ProcessArgument $WsUrl),
        '--credentials', (Quote-ProcessArgument $resolvedCredentials),
        '--output-directory', (Quote-ProcessArgument $runDirectory),
        '--login-spread-ms', "$(Convert-ToMilliseconds $LoginSpreadSeconds)",
        '--readiness-duration-ms', "$(Convert-ToMilliseconds $WsReadinessSeconds)",
        '--hold-duration-ms', "$(Convert-ToMilliseconds $HoldSeconds)",
        '--heartbeat-timeout-ms', "$(Convert-ToMilliseconds $HeartbeatTimeoutSeconds)",
        '--hard-timeout-ms', "$(Convert-ToMilliseconds $ControllerHardTimeoutSeconds)"
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = $arguments -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $controller = New-Object System.Diagnostics.Process
    $controller.StartInfo = $startInfo
    if (-not $controller.Start()) { throw 'Unable to start Node controller process.' }
    $controllerStarted = $true
    $stdoutTask = $controller.StandardOutput.ReadToEndAsync()
    $stderrTask = $controller.StandardError.ReadToEndAsync()
    $finalSummaryPath = Join-Path $runDirectory 'multi-process-ws-final.json'
    $partialSummaryPath = Join-Path $runDirectory 'multi-process-ws-partial.json'
    $startLine = "RUN controllerPid=$($controller.Id) runDirectory=$runDirectory"
    Write-Host $startLine
    $startLine | Add-Content -LiteralPath $logPath -Encoding UTF8
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false
    $nextProgressAtSeconds = 1.0
    while (-not $controller.HasExited) {
        if ($stopwatch.Elapsed.TotalSeconds -ge $HardTimeoutSeconds) {
            $timedOut = $true
            Stop-ControllerProcess -Process $controller
            break
        }
        if ($stopwatch.Elapsed.TotalSeconds -ge $nextProgressAtSeconds) {
            if (Write-SafeProgress -SummaryPath $partialSummaryPath -LogPath $logPath) {
                $nextProgressAtSeconds = $stopwatch.Elapsed.TotalSeconds + 5
            } else {
                $nextProgressAtSeconds = $stopwatch.Elapsed.TotalSeconds + 0.5
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if ($controller.HasExited) {
        $controller.WaitForExit()
    }
    $stopwatch.Stop()

    if ($stdoutTask.IsCompleted) {
        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        if ($stdoutText) { $stdoutText | Add-Content -LiteralPath $logPath -Encoding UTF8 }
    }
    if ($stderrTask.IsCompleted) {
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        if ($stderrText) { $stderrText | Add-Content -LiteralPath $logPath -Encoding UTF8 }
    }

    if ($timedOut) {
        "[$(Get-Date -Format o)] HARD TIMEOUT controllerPid=$($controller.Id)" |
            Add-Content -LiteralPath $logPath -Encoding UTF8
        $completionLine = "DONE exitCode=124 logPath=$logPath finalSummaryPath=$finalSummaryPath"
        Write-Host $completionLine
        $completionLine | Add-Content -LiteralPath $logPath -Encoding UTF8
        $runnerExitCode = 124
    } else {
        $controllerExitCode = [int]$controller.ExitCode
        if (-not (Test-Path -LiteralPath $finalSummaryPath -PathType Leaf)) {
            throw 'Controller final summary is missing.'
        }
        try {
            $finalSummary = Get-Content -Raw -LiteralPath $finalSummaryPath | ConvertFrom-Json
        } catch {
            throw 'Controller final summary is not valid JSON.'
        }
        if ($finalSummary.status -cne 'final') {
            throw 'Controller final summary status is not final.'
        }
        $summaryExitProperty = $finalSummary.PSObject.Properties['exitCode']
        if ($null -eq $summaryExitProperty -or $null -eq $summaryExitProperty.Value) {
            throw 'Controller final summary is missing exitCode.'
        }
        try { $summaryExitCode = [int]$summaryExitProperty.Value } catch {
            throw 'Controller final summary exitCode is invalid.'
        }
        if ($summaryExitCode -ne $controllerExitCode) {
            throw 'Controller final summary exitCode does not match the process exit code.'
        }
        "[$(Get-Date -Format o)] Controller exit code=$controllerExitCode" |
            Add-Content -LiteralPath $logPath -Encoding UTF8
        $completionLine = "DONE exitCode=$controllerExitCode logPath=$logPath finalSummaryPath=$finalSummaryPath"
        Write-Host $completionLine
        $completionLine | Add-Content -LiteralPath $logPath -Encoding UTF8
        $runnerExitCode = $controllerExitCode
    }
} catch {
    if ($controllerStarted) {
        $runnerExitCode = 3
        [Console]::Error.WriteLine('Runner failed after controller start.')
        if ($null -ne $logPath -and $null -ne $finalSummaryPath) {
            Write-Host "DONE exitCode=3 logPath=$logPath finalSummaryPath=$finalSummaryPath"
        }
    } else {
        $runnerExitCode = 2
        [Console]::Error.WriteLine('Runner preflight failed.')
    }
} finally {
    if ($controllerStarted -and $null -ne $controller) {
        try {
            if (-not $controller.HasExited) { Stop-ControllerProcess -Process $controller }
        } catch {
            Stop-Process -Id $controller.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
exit $runnerExitCode
