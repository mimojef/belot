param(
  # Target URLs — задължително подай при smoke тест към load-test инстанцията.
  # Default стойности НЕ са зададени, за да се избегне случайно изпълнение към production.
  # Пример (SSH tunnel):  -BaseUrl http://127.0.0.1:3101  -WsUrl ws://127.0.0.1:3101/ws
  # Пример (директно):    -BaseUrl http://185.203.117.14:3101  -WsUrl ws://185.203.117.14:3101/ws
  [string]$BaseUrl = '',
  [string]$WsUrl = '',
  [string]$Stake = '5000'
)

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

  # Smoke тестът ползва само 4 потребителя; файлът може да съдържа 2400 за big load test.
  if ($credentials.users.Count -lt 4) {
    Fail "Credentials file must contain at least 4 users, found $($credentials.users.Count)."
  }

  # ─── Resolve BASE_URL и WS_URL ──────────────────────────────────────────────
  # Приоритет: параметър → env var → грешка (няма production default)
  $resolvedBaseUrl = if ($BaseUrl -ne '') { $BaseUrl } elseif ($env:BASE_URL -ne '') { $env:BASE_URL } else { '' }
  $resolvedWsUrl   = if ($WsUrl -ne '')   { $WsUrl }   elseif ($env:WS_URL -ne '')   { $env:WS_URL }   else { '' }

  if ([string]::IsNullOrWhiteSpace($resolvedBaseUrl)) {
    Fail "BASE_URL не е зададен. Подай -BaseUrl http://185.203.117.14:3101 или задай `$env:BASE_URL."
  }
  if ([string]::IsNullOrWhiteSpace($resolvedWsUrl)) {
    Fail "WS_URL не е зададен. Подай -WsUrl ws://185.203.117.14:3101/ws или задай `$env:WS_URL."
  }

  # ─── SAFETY GUARD: откажи production URL без нарочен override ───────────────
  $blockedPatterns = @('pika.bg', 'www.pika.bg')
  foreach ($pattern in $blockedPatterns) {
    if ($resolvedBaseUrl -match [regex]::Escape($pattern)) {
      Fail "SAFETY: Отказваме smoke тест към production ($pattern) в BASE_URL. Използвай load-test URL (порт 3101)."
    }
    if ($resolvedWsUrl -match [regex]::Escape($pattern)) {
      Fail "SAFETY: Отказваме smoke тест към production ($pattern) в WS_URL. Използвай load-test URL (порт 3101)."
    }
  }

  $env:BASE_URL = $resolvedBaseUrl
  $env:WS_URL   = $resolvedWsUrl
  $env:STAKE    = $Stake

  Write-Host "Target: BASE_URL=$($env:BASE_URL)"
  Write-Host "Target: WS_URL=$($env:WS_URL)"
  Write-Host "Stake : $($env:STAKE)"

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
