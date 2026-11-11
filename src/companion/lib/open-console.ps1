param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath $Url
  exit 0
} catch {
  exit 1
}
