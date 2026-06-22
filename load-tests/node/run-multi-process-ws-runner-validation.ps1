[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$runnerPath = Join-Path $PSScriptRoot 'run-multi-process-ws-load.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("belot-node-runner-validation-" + [Guid]::NewGuid())
$passed = 0
$failed = 0
$ownedPids = New-Object System.Collections.Generic.List[int]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        $script:passed += 1
        Write-Host "ok $script:passed - $Name"
    } else {
        $script:failed += 1
        Write-Host "not ok - $Name $Detail"
    }
}

function Write-FakeCredentials {
    param([string]$Path, [int]$Count)
    $users = for ($index = 0; $index -lt $Count; $index += 1) {
        [PSCustomObject]@{ email = "fake-$index@example.test"; password = 'DO_NOT_LEAK_PASSWORD' }
    }
    @{ users = @($users) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Quote-Arg {
    param([string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-Runner {
    param(
        [string]$Credentials,
        [string]$Results,
        [int]$Tables = 1,
        [int]$Workers = 1,
        [string]$Http = 'http://127.0.0.1:3101',
        [string]$WebSocket = 'ws://127.0.0.1:3101/ws',
        [string]$Node = 'node',
        [double]$TimeoutSeconds = 20,
        [double]$ControllerTimeoutSeconds = 5,
        [string]$WorkingDirectory = $tempRoot,
        [string]$Controller = $script:fakeControllerPath
    )
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runnerPath,
        '-Tables', "$Tables", '-WorkerCount', "$Workers",
        '-HttpBaseUrl', $Http, '-WsUrl', $WebSocket,
        '-CredentialsPath', $Credentials, '-ResultsDirectory', $Results,
        '-NodeExecutable', $Node, '-ControllerPath', $Controller,
        '-LoginSpreadSeconds', '0',
        '-WsReadinessSeconds', '1', '-HoldSeconds', '1',
        '-HeartbeatTimeoutSeconds', '2', '-ControllerHardTimeoutSeconds', "$ControllerTimeoutSeconds",
        '-HardTimeoutSeconds', "$TimeoutSeconds"
    )
    $captureId = [Guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path $tempRoot "$captureId.stdout.txt"
    $stderrPath = Join-Path $tempRoot "$captureId.stderr.txt"
    $quotedArguments = @($arguments | ForEach-Object { Quote-Arg ([string]$_) })
    Push-Location $WorkingDirectory
    try {
        $invocation = Start-Process -FilePath 'powershell.exe' -ArgumentList $quotedArguments `
            -Wait -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $exitCode = $invocation.ExitCode
        $output = ''
        if (Test-Path -LiteralPath $stdoutPath) { $output += Get-Content -Raw -LiteralPath $stdoutPath }
        if (Test-Path -LiteralPath $stderrPath) { $output += Get-Content -Raw -LiteralPath $stderrPath }
    } finally {
        Pop-Location
        Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
    }
    return [PSCustomObject]@{ ExitCode = $exitCode; Output = $output; Results = $Results }
}

function Get-RunLogs {
    param([string]$Results)
    if (-not (Test-Path -LiteralPath $Results)) { return @() }
    return @(Get-ChildItem -LiteralPath $Results -Recurse -File -Filter '*.log')
}

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $otherDirectory = Join-Path $tempRoot 'other-current-directory'
    New-Item -ItemType Directory -Path $otherDirectory -Force | Out-Null
    $credentials4 = Join-Path $tempRoot 'credentials-4.json'
    $credentials3 = Join-Path $tempRoot 'credentials-3.json'
    $credentials1600 = Join-Path $tempRoot 'credentials-1600.json'
    Write-FakeCredentials -Path $credentials4 -Count 4
    Write-FakeCredentials -Path $credentials3 -Count 3
    Write-FakeCredentials -Path $credentials1600 -Count 1600

    $script:fakeControllerPath = Join-Path $tempRoot 'fake-controller.mjs'
    @'
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const outputDirectory = value('--output-directory');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'controller.pid'), String(process.pid));
const writeFinal = (exitCode) => fs.writeFileSync(
  path.join(outputDirectory, 'multi-process-ws-final.json'),
  JSON.stringify({ status: 'final', exitCode }),
);
console.log('FAKE_CONTROLLER_STDOUT');
console.error('FAKE_CONTROLLER_STDERR');
if (outputDirectory.includes('timeout-case')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  fs.writeFileSync(path.join(outputDirectory, 'child.pid'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (outputDirectory.includes('runner-error-case')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  fs.writeFileSync(path.join(outputDirectory, 'child.pid'), String(child.pid));
  fs.writeFileSync(path.join(outputDirectory, 'multi-process-ws-partial.json'), JSON.stringify({
    expected: { profiles: 4, tables: 1 }, metrics: { loginSuccesses: 1 },
  }));
  const logPath = fs.readdirSync(outputDirectory).find((name) => name.endsWith('.log'));
  fs.rmSync(path.join(outputDirectory, logPath));
  fs.mkdirSync(path.join(outputDirectory, logPath));
  setInterval(() => {}, 1000);
} else if (outputDirectory.includes('progress-case')) {
  fs.writeFileSync(path.join(outputDirectory, 'multi-process-ws-partial.json'), JSON.stringify({
    expected: { profiles: 4, tables: 1 },
    metrics: { loginSuccesses: 3, peakReadyProfiles: 2, peakReadyTables: 0,
      currentActiveSockets: 2, terminalProfileFailures: 1, workerCrashes: 0,
      heartbeatTimeouts: 0 },
    password: 'PROGRESS_SECRET_PASSWORD', cookie: 'PROGRESS_SECRET_COOKIE',
    session: 'PROGRESS_SECRET_SESSION',
  }));
  setTimeout(() => { writeFinal(0); process.exit(0); }, 6500);
} else if (outputDirectory.includes('missing-summary-case')) {
  setTimeout(() => process.exit(0), 30);
} else if (outputDirectory.includes('corrupt-summary-case')) {
  fs.writeFileSync(path.join(outputDirectory, 'multi-process-ws-final.json'), '{broken');
  setTimeout(() => process.exit(0), 30);
} else if (outputDirectory.includes('mismatch-summary-case')) {
  writeFinal(1);
  setTimeout(() => process.exit(0), 30);
} else {
  const match = /exit-(\d)/.exec(outputDirectory + ' ' + value('--credentials'));
  const exitCode = match ? Number(match[1]) : 0;
  setTimeout(() => { writeFinal(exitCode); process.exit(exitCode); }, 30);
}
'@ | Set-Content -LiteralPath $script:fakeControllerPath -Encoding UTF8

    $differentCwd = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'different-cwd') -WorkingDirectory $otherDirectory
    Assert-True 'runner works from a different current directory' ($differentCwd.ExitCode -eq 0)

    $missingNode = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'missing-node') -Node 'definitely-missing-node.exe'
    Assert-True 'missing Node is rejected' ($missingNode.ExitCode -eq 2)

    $missingCredentials = Invoke-Runner -Credentials (Join-Path $tempRoot 'missing.json') `
        -Results (Join-Path $tempRoot 'missing-credentials')
    Assert-True 'missing credentials file is rejected' ($missingCredentials.ExitCode -eq 2)

    $tooFew = Invoke-Runner -Credentials $credentials3 -Results (Join-Path $tempRoot 'too-few')
    Assert-True 'insufficient credentials count is rejected' ($tooFew.ExitCode -eq 2)

    $production = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'pika-rejected') `
        -Http 'https://www.pika.bg' -WebSocket 'wss://www.pika.bg/ws'
    Assert-True 'pika.bg production target is rejected' ($production.ExitCode -eq 2)

    $port3001 = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'port-3001-rejected') `
        -Http 'http://127.0.0.1:3001' -WebSocket 'ws://127.0.0.1:3001/ws'
    Assert-True 'port 3001 is rejected' ($port3001.ExitCode -eq 2)

    $tables400 = Invoke-Runner -Credentials $credentials1600 `
        -Results (Join-Path $tempRoot 'tables-400') -Tables 400 -Workers 8
    Assert-True '400 tables and 1600 profiles are accepted with fake controller' ($tables400.ExitCode -eq 0)

    $tables401 = Invoke-Runner -Credentials $credentials1600 `
        -Results (Join-Path $tempRoot 'tables-401') -Tables 401 -Workers 8
    Assert-True '401 tables return exit code 2' ($tables401.ExitCode -eq 2)

    $workers33 = Invoke-Runner -Credentials $credentials1600 `
        -Results (Join-Path $tempRoot 'workers-33') -Tables 400 -Workers 33
    Assert-True '33 workers return exit code 2' ($workers33.ExitCode -eq 2)

    $shortExternalTimeout = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'short-external-timeout') `
        -ControllerTimeoutSeconds 5 -TimeoutSeconds 14
    Assert-True 'external timeout shorter than controller timeout plus 10 returns 2' `
        ($shortExternalTimeout.ExitCode -eq 2)

    $codesPreserved = $true
    $observedCodes = New-Object System.Collections.Generic.List[string]
    foreach ($code in 0..3) {
        $exitController = Join-Path $tempRoot "fake-controller-exit-$code.mjs"
        @"
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const outputDirectory = args[args.indexOf('--output-directory') + 1];
fs.writeFileSync(path.join(outputDirectory, 'multi-process-ws-final.json'),
  JSON.stringify({ status: 'final', exitCode: $code }));
setTimeout(() => process.exit($code), 30);
"@ | Set-Content -LiteralPath $exitController -Encoding UTF8
        $result = Invoke-Runner -Credentials $credentials4 `
            -Results (Join-Path $tempRoot "exit-$code") -Controller $exitController
        if ($result.ExitCode -ne $code) { $codesPreserved = $false }
        $observedCodes.Add("$code=$($result.ExitCode)")
    }
    Assert-True 'valid final summaries preserve controller exit codes 0, 1, 2 and 3' $codesPreserved `
        ($observedCodes -join ',')

    $missingSummary = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'missing-summary-case')
    Assert-True 'missing final summary returns exit code 3' ($missingSummary.ExitCode -eq 3)

    $corruptSummary = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'corrupt-summary-case')
    Assert-True 'corrupt final summary returns exit code 3' ($corruptSummary.ExitCode -eq 3)

    $mismatchSummary = Invoke-Runner -Credentials $credentials4 `
        -Results (Join-Path $tempRoot 'mismatch-summary-case')
    Assert-True 'mismatched final summary exit code returns 3' ($mismatchSummary.ExitCode -eq 3)

    $runnerErrorResults = Join-Path $tempRoot 'runner-error-case'
    $runnerError = Invoke-Runner -Credentials $credentials4 -Results $runnerErrorResults
    $runnerErrorControllerFile = Get-ChildItem -LiteralPath $runnerErrorResults -Recurse -File `
        -Filter 'controller.pid' | Select-Object -First 1
    $runnerErrorChildFile = Get-ChildItem -LiteralPath $runnerErrorResults -Recurse -File `
        -Filter 'child.pid' | Select-Object -First 1
    $runnerErrorControllerPid = [int](Get-Content -Raw $runnerErrorControllerFile.FullName)
    $runnerErrorChildPid = [int](Get-Content -Raw $runnerErrorChildFile.FullName)
    Start-Sleep -Milliseconds 150
    $runnerErrorControllerGone = -not (Get-Process -Id $runnerErrorControllerPid -ErrorAction SilentlyContinue)
    $runnerErrorChildGone = -not (Get-Process -Id $runnerErrorChildPid -ErrorAction SilentlyContinue)
    Assert-True 'post-start runner failure returns 3 and cleans its process tree' `
        ($runnerError.ExitCode -eq 3 -and $runnerErrorControllerGone -and $runnerErrorChildGone)

    $nodeCommand = Get-Command node -CommandType Application
    $sentinel = Start-Process -FilePath $nodeCommand.Source `
        -ArgumentList @('-e', '"setInterval(() => {}, 1000)"') -PassThru -WindowStyle Hidden
    $ownedPids.Add($sentinel.Id)
    $timeoutResults = Join-Path $tempRoot 'timeout-case'
    $timeout = Invoke-Runner -Credentials $credentials4 -Results $timeoutResults `
        -ControllerTimeoutSeconds 1 -TimeoutSeconds 11
    Assert-True 'independent hard timeout returns 124' ($timeout.ExitCode -eq 124)

    $controllerPidFile = Get-ChildItem -LiteralPath $timeoutResults -Recurse -File `
        -Filter 'controller.pid' | Select-Object -First 1
    $childPidFile = Get-ChildItem -LiteralPath $timeoutResults -Recurse -File `
        -Filter 'child.pid' | Select-Object -First 1
    $controllerPid = if ($controllerPidFile) { [int](Get-Content -Raw $controllerPidFile.FullName) } else { 0 }
    $childPid = if ($childPidFile) { [int](Get-Content -Raw $childPidFile.FullName) } else { 0 }
    Start-Sleep -Milliseconds 150
    $controllerGone = $controllerPid -gt 0 -and -not (Get-Process -Id $controllerPid -ErrorAction SilentlyContinue)
    $childGone = $childPid -gt 0 -and -not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    $sentinelAlive = $null -ne (Get-Process -Id $sentinel.Id -ErrorAction SilentlyContinue)
    Assert-True 'timeout kills only the concrete controller process tree' `
        ($controllerGone -and $childGone -and $sentinelAlive)

    $logs = Get-RunLogs -Results $differentCwd.Results
    Assert-True 'timestamped log file is created' ($logs.Count -ge 1)

    $progressResults = Join-Path $tempRoot 'progress-case'
    $progress = Invoke-Runner -Credentials $credentials4 -Results $progressResults
    $progressLogs = Get-RunLogs -Results $progressResults
    $progressLogText = @($progressLogs | ForEach-Object {
        Get-Content -Raw -LiteralPath $_.FullName
    }) -join "`n"
    Assert-True 'safe partial summary progress appears in output and log' `
        ($progress.Output -match 'PROGRESS login=3/4 readyProfiles=2/4' -and
            $progressLogText -match 'PROGRESS login=3/4 readyProfiles=2/4')
    Assert-True 'progress output does not contain secrets' `
        (($progress.Output + $progressLogText) -notmatch
            'PROGRESS_SECRET_PASSWORD|PROGRESS_SECRET_COOKIE|PROGRESS_SECRET_SESSION')

    $allText = @($differentCwd.Output, $missingNode.Output, $tooFew.Output,
        $progress.Output, $progressLogText) -join "`n"
    foreach ($log in $logs) { $allText += "`n" + (Get-Content -Raw -LiteralPath $log.FullName) }
    Assert-True 'output and logs contain no passwords, cookies, or sessions' `
        ($allText -notmatch 'DO_NOT_LEAK_PASSWORD|belot_session|cookie|session')

    $normalPids = Get-ChildItem -LiteralPath (Join-Path $tempRoot 'exit-0') -Recurse -File `
        -Filter 'controller.pid' | ForEach-Object { [int](Get-Content -Raw $_.FullName) }
    $noNormalOrphans = $true
    foreach ($pidValue in $normalPids) {
        if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { $noNormalOrphans = $false }
    }
    Assert-True 'normal runs leave no orphan process' $noNormalOrphans

    Write-Host "`nPassed: $passed; Failed: $failed"
    if ($failed -gt 0) { exit 1 }
    exit 0
} finally {
    foreach ($processId in $ownedPids) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
