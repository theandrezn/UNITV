param(
  [string]$LocalKnowledgeBase = "C:\Users\games\Documents\UNITV - AGENTE\UNITV-KNOWLEDGE-BASE",
  [string]$HostName = "76.13.231.244",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\unitv_hostinger_ed25519",
  [string]$RemoteKnowledgeBase = "/var/www/unitv/obsidian/UNITV-KNOWLEDGE-BASE",
  [int]$DebounceSeconds = 5,
  [switch]$SkipInitialSync
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LocalKnowledgeBase -PathType Container)) {
  throw "Local Obsidian knowledge base not found: $LocalKnowledgeBase"
}

$syncScript = Join-Path $PSScriptRoot "sync-obsidian-knowledge.ps1"

function Invoke-KnowledgeSync {
  & $syncScript `
    -LocalKnowledgeBase $LocalKnowledgeBase `
    -HostName $HostName `
    -User $User `
    -KeyPath $KeyPath `
    -RemoteKnowledgeBase $RemoteKnowledgeBase
}

if (-not $SkipInitialSync) {
  Invoke-KnowledgeSync
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $LocalKnowledgeBase
$watcher.Filter = "*.md"
$watcher.IncludeSubdirectories = $false
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite, Size'
$watcher.EnableRaisingEvents = $true

$eventNames = @("Changed", "Created", "Deleted", "Renamed")
$subscriptions = foreach ($eventName in $eventNames) {
  Register-ObjectEvent -InputObject $watcher -EventName $eventName -SourceIdentifier "unitv.obsidian.$eventName"
}

Write-Output "Watching Obsidian knowledge base: $LocalKnowledgeBase"
Write-Output "Remote target: ${User}@${HostName}:${RemoteKnowledgeBase}"
Write-Output "Debounce: $DebounceSeconds seconds. Press Ctrl+C to stop."

$pending = $false
$lastChangeAt = Get-Date

try {
  while ($true) {
    $event = Wait-Event -Timeout 1
    if ($event) {
      $pending = $true
      $lastChangeAt = Get-Date
      Remove-Event -EventIdentifier $event.EventIdentifier

      while ($extra = Get-Event) {
        $pending = $true
        $lastChangeAt = Get-Date
        Remove-Event -EventIdentifier $extra.EventIdentifier
      }
    }

    if ($pending -and ((Get-Date) - $lastChangeAt).TotalSeconds -ge $DebounceSeconds) {
      try {
        Invoke-KnowledgeSync
      } catch {
        Write-Warning "Obsidian sync failed: $($_.Exception.Message)"
      }
      $pending = $false
    }
  }
} finally {
  foreach ($subscription in $subscriptions) {
    Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
  }
  $watcher.Dispose()
}
