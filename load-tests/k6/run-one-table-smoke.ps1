$ErrorActionPreference = 'Stop'

$credentialsPath = Join-Path $PSScriptRoot 'loadtest-users.json.local'
$passwordEnvNames = 1..4 | ForEach-Object { "USER_${_}_PASSWORD" }

function Fail($message) {
  Write-Error -Message $message -ErrorAction Continue
  exit 1
}

try {
  if (-not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
    Fail "Missing credentials file: $credentialsPath"
  }

  if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
    Fail "k6 was not found in PATH. Install k6 or add it to PATH before running this script."
  }

  try {
    $credentials = Get-Content -LiteralPath $credentialsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Fail "Invalid JSON in credentials file: $credentialsPath"
  }

  if ($null -eq $credentials.users -or -not ($credentials.users -is [array])) {
    Fail 'Credentials file must have the structure: { "users": [...] }'
  }

  if ($credentials.users.Count -ne 4) {
    Fail "Expected exactly 4 load-test users, found $($credentials.users.Count)."
  }

  $env:BASE_URL = 'https://www.pika.bg'
  $env:WS_URL = 'wss://www.pika.bg/ws'
  $env:STAKE = '5000'

  Write-Host 'Using load-test users:'

  for ($i = 0; $i -lt 4; $i += 1) {
    $user = $credentials.users[$i]
    $index = $i + 1
    $email = ''
    $password = ''
    $displayName = ''

    if ($null -ne $user.email) {
      $email = [string]$user.email
    }

    if ($null -ne $user.password) {
      $password = [string]$user.password
    }

    if ($null -ne $user.displayName) {
      $displayName = [string]$user.displayName
    }

    if ([string]::IsNullOrWhiteSpace($email)) {
      Fail "User $index is missing email."
    }

    if ([string]::IsNullOrWhiteSpace($password)) {
      Fail "User $index is missing password."
    }

    Set-Item -Path "Env:USER_${index}_EMAIL" -Value $email
    Set-Item -Path "Env:USER_${index}_PASSWORD" -Value $password

    Write-Host ("{0}: {1} <{2}>" -f $index, $displayName, $email)
  }

  Push-Location -LiteralPath $PSScriptRoot
  try {
    & k6 run 'one-table-smoke.js'
    $k6ExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  } finally {
    Pop-Location
  }

  exit $k6ExitCode
} finally {
  foreach ($name in $passwordEnvNames) {
    Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
  }
}
