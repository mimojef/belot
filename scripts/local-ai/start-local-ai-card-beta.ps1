<#
.SYNOPSIS
  Local-only helper to prepare a "Local AI Card Beta" test session.
  See docs/local-ai-card-beta-runbook.md for the full manual process.

.DESCRIPTION
  This script does NOT touch production. No SSH, no deploy, no changes to
  server/.env. It only:
    1. Checks that training-output/models/card-model-v1/model.json exists.
    2. Creates training-output/local-ai-beta/ (if missing).
    3. Optionally (-ClearTrace) deletes the old trace log.
    4. Sets the LOCAL_AI_CARD_BETA_* env vars IN THE CURRENT PowerShell session.
    5. Optionally (-StartServer) starts the backend (npm run dev) in a NEW window.
    6. Optionally (-TurnOff) only unsets the env vars (revert to conventional).

.PARAMETER ClearTrace
  Deletes the old training-output/local-ai-beta/card-decisions.jsonl before
  start, so the next summary reflects only the new session.

.PARAMETER StartServer
  Starts `npm run dev` in server/ in a new PowerShell window (with the env
  vars already set). If not passed, the script only prepares the environment
  and prints the next manual steps — nothing is started automatically.

.PARAMETER TurnOff
  Only unsets the LOCAL_AI_CARD_BETA_* env vars in the current session and
  exits — skips all checks/directory setup. Use this for a quick revert to
  conventional bot behaviour without opening a new terminal.

.EXAMPLE
  .\start-local-ai-card-beta.ps1
  Prepares the environment, prints the env vars and the next manual steps.

.EXAMPLE
  .\start-local-ai-card-beta.ps1 -ClearTrace -StartServer
  Clears the old trace log and automatically starts the backend in a new window.

.EXAMPLE
  .\start-local-ai-card-beta.ps1 -TurnOff
  Reverts the current session to conventional (AI/trace env vars unset).
#>

param(
    [switch]$ClearTrace,
    [switch]$StartServer,
    [switch]$TurnOff
)

$ErrorActionPreference = 'Stop'

if ($TurnOff) {
    Remove-Item Env:LOCAL_AI_CARD_BETA_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:LOCAL_AI_CARD_BETA_TRACE_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:LOCAL_AI_CARD_BETA_MODEL_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:LOCAL_AI_CARD_BETA_TRACE_PATH -ErrorAction SilentlyContinue
    Write-Host 'LOCAL_AI_CARD_BETA_* env vars cleared in this session -- conventional bot behaviour.' -ForegroundColor Green
    Write-Host 'Restart the backend (npm run dev) in server/, if it was already running, to pick up the change.' -ForegroundColor Yellow
    return
}

$repoRoot = Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')
$serverDir = Join-Path $repoRoot 'server'
$modelPath = Join-Path $repoRoot 'training-output\models\card-model-v1\model.json'
$traceDir = Join-Path $repoRoot 'training-output\local-ai-beta'
$tracePath = Join-Path $traceDir 'card-decisions.jsonl'

Write-Host '=== Local AI Card Beta - Start Helper (local-only, NOT production) ===' -ForegroundColor Cyan
Write-Host "Repo root: $repoRoot"
Write-Host ''

if (-not (Test-Path $modelPath)) {
    Write-Host "Model artifact NOT found: $modelPath" -ForegroundColor Red
    Write-Host ''
    Write-Host 'Run these first (from server/):' -ForegroundColor Yellow
    Write-Host '  npm run train:card-model'
    Write-Host '  npm run test:card-model-inference'
    Write-Host '  npm run simulate:ai-card-candidate'
    Write-Host '  npm run check:local-ai-card-beta'
    Write-Host '  npm run check:local-ai-card-beta-trace'
    exit 1
}

Write-Host "Model artifact found: $modelPath" -ForegroundColor Green

if (-not (Test-Path $traceDir)) {
    New-Item -ItemType Directory -Path $traceDir -Force | Out-Null
    Write-Host "Created trace directory: $traceDir" -ForegroundColor Green
} else {
    Write-Host "Trace directory already exists: $traceDir" -ForegroundColor Green
}

if ($ClearTrace) {
    if (Test-Path $tracePath) {
        Remove-Item -Path $tracePath -Confirm:$false
        Write-Host "Deleted old trace log: $tracePath" -ForegroundColor Yellow
    } else {
        Write-Host 'No old trace log to delete.' -ForegroundColor Yellow
    }
}

$env:LOCAL_AI_CARD_BETA_ENABLED = 'true'
$env:LOCAL_AI_CARD_BETA_TRACE_ENABLED = 'true'
$env:LOCAL_AI_CARD_BETA_MODEL_PATH = $modelPath
$env:LOCAL_AI_CARD_BETA_TRACE_PATH = $tracePath

Write-Host ''
Write-Host 'Env vars set in this PowerShell session:' -ForegroundColor Cyan
Write-Host "  LOCAL_AI_CARD_BETA_ENABLED       = $env:LOCAL_AI_CARD_BETA_ENABLED"
Write-Host "  LOCAL_AI_CARD_BETA_TRACE_ENABLED = $env:LOCAL_AI_CARD_BETA_TRACE_ENABLED"
Write-Host "  LOCAL_AI_CARD_BETA_MODEL_PATH    = $env:LOCAL_AI_CARD_BETA_MODEL_PATH"
Write-Host "  LOCAL_AI_CARD_BETA_TRACE_PATH    = $env:LOCAL_AI_CARD_BETA_TRACE_PATH"

if ($StartServer) {
    Write-Host ''
    Write-Host 'Starting local backend (npm run dev) in a new window...' -ForegroundColor Cyan
    $backendCommand = "cd '$serverDir'; " +
        "`$env:LOCAL_AI_CARD_BETA_ENABLED='true'; " +
        "`$env:LOCAL_AI_CARD_BETA_TRACE_ENABLED='true'; " +
        "`$env:LOCAL_AI_CARD_BETA_MODEL_PATH='$modelPath'; " +
        "`$env:LOCAL_AI_CARD_BETA_TRACE_PATH='$tracePath'; " +
        'npm run dev'
    Start-Process powershell -ArgumentList @('-NoExit', '-Command', $backendCommand)
    Write-Host ''
    Write-Host "Don't forget to start the frontend separately: cd $repoRoot; npm run dev" -ForegroundColor Yellow
} else {
    Write-Host ''
    Write-Host 'Next step -- backend (in THIS terminal, so it inherits the env vars):' -ForegroundColor Cyan
    Write-Host "  cd $serverDir"
    Write-Host '  npm run dev'
    Write-Host ''
    Write-Host 'Frontend (in a SEPARATE terminal):' -ForegroundColor Cyan
    Write-Host "  cd $repoRoot"
    Write-Host '  npm run dev'
}

Write-Host ''
Write-Host 'After the test session, to summarize the trace:' -ForegroundColor Cyan
Write-Host "  cd $serverDir"
Write-Host '  npm run summarize:local-ai-card-beta-trace'
Write-Host "  # see: $traceDir\summary.md"
Write-Host ''
Write-Host 'To turn AI beta off: .\start-local-ai-card-beta.ps1 -TurnOff  (or a new terminal without the env vars)' -ForegroundColor Cyan
Write-Host ''
Write-Host 'This is a LOCAL beta helper -- no production, no deploy, no SSH.' -ForegroundColor Green
