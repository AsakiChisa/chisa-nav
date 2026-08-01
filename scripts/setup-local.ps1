$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$devVarsPath = Join-Path $projectRoot ".dev.vars"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js first."
}

$sessionSecret = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$bootstrapToken = node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"

if ([string]::IsNullOrWhiteSpace($sessionSecret) -or [string]::IsNullOrWhiteSpace($bootstrapToken)) {
    throw "Failed to generate local secrets."
}

$content = "SESSION_SECRET=$sessionSecret`r`nBOOTSTRAP_TOKEN=$bootstrapToken`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($devVarsPath, $content, $utf8NoBom)

Write-Host ""
Write-Host "Created: $devVarsPath" -ForegroundColor Green
Write-Host "BOOTSTRAP_TOKEN (save this for the first admin setup):" -ForegroundColor Yellow
Write-Host $bootstrapToken -ForegroundColor Cyan
Write-Host ""
Write-Host "Next command: npm run dev"
