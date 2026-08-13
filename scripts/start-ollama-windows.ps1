param(
  [string]$ModelsPath = $env:OLLAMA_MODELS,
  [string]$HostAddress = $(if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST } else { '127.0.0.1:11434' })
)

$ErrorActionPreference = 'Stop'
if ($ModelsPath) { $env:OLLAMA_MODELS = $ModelsPath }
$env:OLLAMA_HOST = $HostAddress
$env:OLLAMA_FLASH_ATTENTION = if ($env:OLLAMA_FLASH_ATTENTION) { $env:OLLAMA_FLASH_ATTENTION } else { '1' }
$env:OLLAMA_KV_CACHE_TYPE = if ($env:OLLAMA_KV_CACHE_TYPE) { $env:OLLAMA_KV_CACHE_TYPE } else { 'q8_0' }
$env:OLLAMA_CONTEXT_LENGTH = if ($env:OLLAMA_CONTEXT_LENGTH) { $env:OLLAMA_CONTEXT_LENGTH } else { '65536' }
$env:OLLAMA_NUM_PARALLEL = if ($env:OLLAMA_NUM_PARALLEL) { $env:OLLAMA_NUM_PARALLEL } else { '1' }
$env:OLLAMA_MAX_LOADED_MODELS = if ($env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS } else { '1' }
$env:OLLAMA_MAX_QUEUE = if ($env:OLLAMA_MAX_QUEUE) { $env:OLLAMA_MAX_QUEUE } else { '64' }
$env:OLLAMA_KEEP_ALIVE = if ($env:OLLAMA_KEEP_ALIVE) { $env:OLLAMA_KEEP_ALIVE } else { '30m' }
$env:OLLAMA_NO_CLOUD = if ($env:OLLAMA_NO_CLOUD) { $env:OLLAMA_NO_CLOUD } else { '1' }
Write-Host "Starting Ollama on $HostAddress" -ForegroundColor Cyan
if ($ModelsPath) { Write-Host "Models: $ModelsPath" }
ollama serve
