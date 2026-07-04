param(
  [string]$HostName = "76.13.231.244",
  [string]$User = "root",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\unitv_hostinger_ed25519",
  [string]$AppDir = "/var/www/unitv",
  [string]$Domain = "_"
)

$ErrorActionPreference = "Stop"
$remote = "$User@$HostName"
$repo = "https://github.com/theandrezn/UNITV.git"

ssh -i $KeyPath -o StrictHostKeyChecking=accept-new $remote "APP_DIR='$AppDir' REPO_URL='$repo' DOMAIN='$Domain' bash -s" < scripts/vps-bootstrap.sh
scp -i $KeyPath .env.local "${remote}:${AppDir}/.env.local"
ssh -i $KeyPath $remote "chmod 600 '$AppDir/.env.local' && cd '$AppDir' && bash scripts/vps-deploy.sh"

Write-Output "Deployment finished. Test: http://$HostName/api/health"
