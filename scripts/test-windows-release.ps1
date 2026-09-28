$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force release-evidence | Out-Null
Start-Transcript -Path release-evidence/windows-validation.txt
$product = 'Credit Card Benefit Tracker'
$installDir = Join-Path $env:LOCALAPPDATA "Programs\$product"
$exe = Join-Path $installDir "$product.exe"
$setup = (Get-ChildItem dist-installer/*Setup*.exe | Select-Object -First 1).FullName

function Run-Setup([string]$path) {
  $p = Start-Process -FilePath $path -ArgumentList '/S','/currentuser' -PassThru
  if (-not $p.WaitForExit(180000)) { $p.Kill(); throw 'Installer timed out' }
  if ($p.ExitCode -ne 0) { throw "Installer failed: $($p.ExitCode)" }
  if (-not (Test-Path $exe)) { throw "Missing installed executable: $exe" }
}
function Stop-App {
  Get-Process -Name $product -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}
function Smoke([switch]$Legacy) {
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1'
  if ($Legacy) { node scripts/installed-smoke.mjs --legacy }
  else { node scripts/installed-smoke.mjs }
  if ($LASTEXITCODE -ne 0) { throw 'Installed app runtime smoke failed' }
}
try {
  $signature = Get-AuthenticodeSignature $setup
  if ($signature.Status -ne 'Valid') { throw "Invalid installer signature: $($signature.Status)" }
  Write-Host "PASS: installer SHA-256 Authenticode; signer $($signature.SignerCertificate.Subject); thumbprint $($signature.SignerCertificate.Thumbprint)"
  $old = Join-Path $env:RUNNER_TEMP 'previous-1.0.19.exe'
  Invoke-WebRequest 'https://github.com/anndunkin/cc-benefit-tracker/releases/download/v1.0.19/Credit.Card.Benefit.Tracker.Setup.1.0.19.exe' -OutFile $old
  Run-Setup $old
  Smoke -Legacy
  Stop-App
  Run-Setup $setup
  if ((Get-AuthenticodeSignature $exe).Status -ne 'Valid') { throw 'Installed application signature invalid' }
  if ((Get-AuthenticodeSignature (Join-Path $installDir "Uninstall $product.exe")).Status -ne 'Valid') { throw 'Uninstaller signature invalid' }
  Smoke
  Write-Host 'PASS: 1.0.19 to 1.0.20 upgrade, native SQLite ABI, renderer, preload, preserved data and new controls'
  # Reinstall while app is running exercises the custom running-process check.
  Run-Setup $setup
  Smoke
  Write-Host 'PASS: same-version reinstall while app was running'
  $dataPath = (Get-Content release-evidence/runtime.json | ConvertFrom-Json).dbPath
  Stop-App
  $uninstall = Join-Path $installDir "Uninstall $product.exe"
  Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait
  for ($i=0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Path $exe) { throw 'Uninstall did not remove application' }
  if (-not (Test-Path $dataPath)) { throw 'Uninstall removed user data' }
  Write-Host 'PASS: uninstall removed app and preserved data'
  # Simulate harmless leftovers only on the disposable runner.
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  function global:Read-Host { return '' }
  & ./scripts/repair-uninstall.ps1
  $ErrorActionPreference = 'Stop'
  if (Test-Path $installDir) { throw 'Repair left the stale application directory' }
  if (-not (Test-Path $dataPath)) { throw 'Repair removed user data' }
  Run-Setup $setup
  Smoke
  Stop-App
  Write-Host 'PASS: repair, fresh install after uninstall, and preserved usage on relaunch'
  Get-FileHash $setup -Algorithm SHA256 | Format-List
} finally {
  Stop-App
  Stop-Transcript
}
