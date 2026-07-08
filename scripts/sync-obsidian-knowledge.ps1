param(
  [string]$LocalKnowledgeBase = "C:\Users\games\Documents\UNITV - AGENTE\UNITV-KNOWLEDGE-BASE",
  [string]$HostName = "76.13.231.244",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\unitv_hostinger_ed25519",
  [string]$RemoteKnowledgeBase = "/var/www/unitv/obsidian/UNITV-KNOWLEDGE-BASE",
  [switch]$Verify
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LocalKnowledgeBase -PathType Container)) {
  throw "Local Obsidian knowledge base not found: $LocalKnowledgeBase"
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
  throw "SSH key not found: $KeyPath"
}

$remote = "$User@$HostName"
$files = Get-ChildItem -LiteralPath $LocalKnowledgeBase -Filter "*.md" -File | Sort-Object Name

if (-not $files.Count) {
  throw "No .md files found in: $LocalKnowledgeBase"
}

ssh -i $KeyPath -o StrictHostKeyChecking=accept-new $remote "mkdir -p '$RemoteKnowledgeBase'"

foreach ($file in $files) {
  scp -i $KeyPath -o StrictHostKeyChecking=accept-new -- $file.FullName "${remote}:${RemoteKnowledgeBase}/$($file.Name)"
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Output "[$timestamp] Synced $($files.Count) Obsidian knowledge files to ${remote}:${RemoteKnowledgeBase}"

if ($Verify) {
  ssh -i $KeyPath $remote "ls -1 '$RemoteKnowledgeBase'/*.md | wc -l && stat -c '%n %s %y' '$RemoteKnowledgeBase'/*.md | sort"
}
