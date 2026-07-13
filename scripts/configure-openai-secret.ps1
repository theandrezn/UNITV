param(
  [string]$HostName = "76.13.231.244",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\unitv_hostinger_ed25519",
  [string]$AppDir = "/var/www/unitv"
)

$ErrorActionPreference = "Stop"
$secret = (Get-Clipboard -Raw -ErrorAction Stop).Trim()
if (-not $secret.StartsWith("sk-proj-") -or $secret.Length -lt 40) {
  throw "O clipboard nao contem uma chave de projeto OpenAI valida. Copie a chave e execute novamente."
}

$remote = "$User@$HostName"
$remoteSecretFile = "/root/.unitv-openai-key.tmp"
$localSecretFile = [System.IO.Path]::GetTempFileName()

try {
  [System.IO.File]::WriteAllText($localSecretFile, $secret, [System.Text.UTF8Encoding]::new($false))
  scp -q -i $KeyPath $localSecretFile "${remote}:${remoteSecretFile}"
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao transferir o segredo para o servidor."
  }

  $remoteScript = @'
set -euo pipefail
umask 077
python3 - <<'PY'
from pathlib import Path

secret_file = Path("/root/.unitv-openai-key.tmp")
env_file = Path("/var/www/unitv/.env.local")
secret = secret_file.read_text(encoding="utf-8").strip()
if not secret.startswith("sk-proj-") or len(secret) < 40:
    raise SystemExit("invalid secret")

updates = {
    "OPENAI_API_KEY": secret,
    "OPENAI_MODEL": "gpt-5.4-mini",
    "OPENAI_MODEL_SALES_AGENT": "gpt-5.4-mini",
    "OPENAI_MODEL_SALES_AGENT_STRONG": "gpt-5.4-mini",
    "OPENAI_MODEL_INTENT": "gpt-5.4-mini",
    "OPENAI_MODEL_AUDIT_SUMMARY": "gpt-5.4-mini",
    "UNITV_DAILY_LEARNING_STRONG_MODEL_ENABLED": "false",
    "UNITV_DAILY_LEARNING_ENABLED": "false",
    "UNITV_SPECIALIST_AI_ANALYSIS_ENABLED": "false",
    "UNITV_AUDIT_USE_AI_SUMMARY": "false",
}

lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
result = []
seen = set()
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        result.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        result.append(line)
for key, value in updates.items():
    if key not in seen:
        result.append(f"{key}={value}")

env_file.write_text("\n".join(result) + "\n", encoding="utf-8")
env_file.chmod(0o600)
secret_file.unlink(missing_ok=True)
PY
'@

  $remoteScript.Replace("/var/www/unitv", $AppDir).Replace("`r", "") |
    ssh -i $KeyPath $remote "bash -s"
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao atualizar a configuracao segura no servidor."
  }

  Write-Output "Chave OpenAI e politica economica configuradas no servidor; valor oculto e arquivo protegido com modo 600."
}
finally {
  $secret = $null
  if (Test-Path -LiteralPath $localSecretFile) {
    Remove-Item -LiteralPath $localSecretFile -Force
  }
  ssh -q -i $KeyPath $remote "rm -f '$remoteSecretFile'" 2>$null | Out-Null
}
