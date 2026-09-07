# Pull new confirmed sales from 130point and push prizewall.json to GitHub.
#   powershell -ExecutionPolicy Bypass -File publish.ps1          # sync, then commit+push if the data changed
#   powershell -ExecutionPolicy Bypass -File publish.ps1 -NoSync  # commit+push only (the app already synced)
param([switch]$NoSync)
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

if (-not $NoSync) {
  python scrape130.py --sync prizewall.json
}

git add prizewall.json
if (git diff --cached --quiet) { Write-Host "publish: nothing new"; exit 0 }

$sales = python -c "import json;d=json.load(open('prizewall.json',encoding='utf-8'));print(sum(len(c['sales']) for c in d['cards']))"
git commit -q -m "Sync 130point: $sales confirmed sales on file"
git pull -q --rebase --autostash origin main
git push -q origin main
Write-Host "publish: pushed ($sales sales)"
