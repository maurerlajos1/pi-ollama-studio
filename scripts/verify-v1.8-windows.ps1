$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Run-Step($name, $command) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  Invoke-Expression $command
  if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE" }
}

Write-Host "Pi Ollama Studio v1.8 Windows Release Gate" -ForegroundColor Green
Write-Host "Node: $(node --version)"
Write-Host "Git: $(git --version)"
try { Write-Host "Pi: $(pi --version)" } catch { Write-Host "Pi: not found" -ForegroundColor Yellow }
try { Write-Host "Ollama: $(ollama --version)" } catch { Write-Host "Ollama: not found" -ForegroundColor Yellow }

Run-Step 'Syntax / static checks' 'npm run check'
Run-Step 'Deterministic unit + integration suite' 'npm test'
Run-Step 'Live LSP suite' 'npm run test:lsp-live'
Run-Step 'Real Pi RPC suite' 'npm run test:pi-live'
Run-Step 'Rendered Chrome/Edge Playwright UI suite' 'npm run test:ui'
Run-Step 'Real Ollama + Pi hardware E2E' 'npm run test:ollama-e2e:windows'

Write-Host "`nALL v1.8 WINDOWS RELEASE GATES PASSED" -ForegroundColor Green
