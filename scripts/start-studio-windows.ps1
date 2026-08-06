$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$env:OLLAMA_MODELS = "H:\ollama-models"
node server.mjs
