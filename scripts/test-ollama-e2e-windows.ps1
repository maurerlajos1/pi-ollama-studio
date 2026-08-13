param(
  [string]$OllamaUrl = $(if ($env:PI_STUDIO_E2E_OLLAMA_URL) { $env:PI_STUDIO_E2E_OLLAMA_URL } else { 'http://127.0.0.1:11434' }),
  [string]$Model = $(if ($env:PI_STUDIO_E2E_MODEL) { $env:PI_STUDIO_E2E_MODEL } else { '15koutput' }),
  [string]$FallbackModel = $(if ($env:PI_STUDIO_E2E_FALLBACK_MODEL) { $env:PI_STUDIO_E2E_FALLBACK_MODEL } else { '' }),
  [string]$ApiKeyEnv = $(if ($env:PI_STUDIO_OLLAMA_API_KEY_ENV) { $env:PI_STUDIO_OLLAMA_API_KEY_ENV } else { 'OLLAMA_API_KEY' }),
  [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:PI_STUDIO_E2E_OLLAMA_URL = $OllamaUrl
$env:PI_STUDIO_E2E_MODEL = $Model
if ($FallbackModel) {
  $env:PI_STUDIO_E2E_FALLBACK_MODEL = $FallbackModel
} else {
  Remove-Item Env:PI_STUDIO_E2E_FALLBACK_MODEL -ErrorAction SilentlyContinue
}
$env:PI_STUDIO_OLLAMA_API_KEY_ENV = $ApiKeyEnv
if ($KeepArtifacts) { $env:PI_STUDIO_E2E_KEEP_ARTIFACTS = '1' }

Write-Host "Pi Ollama Studio real hardware E2E" -ForegroundColor Cyan
Write-Host "  Ollama:   $OllamaUrl"
Write-Host "  Model:    $Model"
Write-Host "  Fallback: $(if ($FallbackModel) { $FallbackModel } else { 'disabled' })"
if ([Environment]::GetEnvironmentVariable($ApiKeyEnv)) {
  Write-Host "  Auth:     $ApiKeyEnv is available" -ForegroundColor Green
} elseif ($OllamaUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?)[:/]') {
  Write-Warning "$ApiKeyEnv is not set. A protected remote endpoint may reject the test."
} else {
  Write-Host "  Auth:     not required for local endpoint"
}

npm run test:ollama-e2e
exit $LASTEXITCODE
