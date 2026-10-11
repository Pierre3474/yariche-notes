# Installation de Yariche sous Windows (Docker Desktop requis).
#   powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error 'Docker Desktop est introuvable : https://docs.docker.com/desktop/setup/install/windows-install/'
}
function New-Secret($bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}
if (-not (Test-Path .env)) {
  $port = if ($env:YARICHE_PORT) { $env:YARICHE_PORT } else { '5174' }
  $code = (New-Secret 8)
  @"
# Généré par install.ps1. Voir .env.example pour toutes les options.
YARICHE_PORT=$port
AUTH_MODE=local
SESSION_SECRET=$(New-Secret 32)
SETUP_CODE=$code
ALLOW_SIGNUP=false
"@ | Set-Content -Encoding utf8 .env
  Write-Host 'Fichier .env créé.'
}
$env_ = Get-Content .env
$code = ($env_ | Where-Object { $_ -like 'SETUP_CODE=*' } | Select-Object -First 1) -replace '^SETUP_CODE=', ''
$port = ($env_ | Where-Object { $_ -like 'YARICHE_PORT=*' } | Select-Object -First 1) -replace '^YARICHE_PORT=', ''
if (-not $port) { $port = '5174' }
docker compose up -d --build
Write-Host ""
Write-Host "Yariche est prêt : http://localhost:$port"
if ($code -and -not (Test-Path data/accounts.json)) {
  Write-Host "Première visite : crée le compte administrateur avec le code d'installation $code"
}
