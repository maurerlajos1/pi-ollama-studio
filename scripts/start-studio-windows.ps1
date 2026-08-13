param(
  [string]$ModelsPath = $env:OLLAMA_MODELS,
  [switch]$SkipPtySetup
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if ($ModelsPath) { $env:OLLAMA_MODELS = $ModelsPath }
if (-not $SkipPtySetup) {
  node scripts/setup-node-pty.mjs
  if ($LASTEXITCODE -ne 0) { Write-Warning 'node-pty setup failed; Studio will use the pipe terminal fallback.' }
}
node server.mjs
