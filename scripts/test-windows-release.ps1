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
function Smoke([switch]$Legacy, [string]$ExpectDb) {
  Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1'
  if ($Legacy) { node scripts/installed-smoke.mjs --legacy }
  elseif ($ExpectDb) { node scripts/installed-smoke.mjs --expect-db $ExpectDb }
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
  $rebuilt = (Get-FileHash node_modules/better-sqlite3/build/Release/better_sqlite3.node -Algorithm SHA256).Hash
  $vendored = (Get-FileHash prebuilt-win32-x64/better_sqlite3.node -Algorithm SHA256).Hash
  $installedBinding = Get-ChildItem "$installDir/resources" -Recurse -Filter 'better_sqlite3.node' | Select-Object -First 1
  if (-not $installedBinding -or ($rebuilt -ne $vendored) -or ((Get-FileHash $installedBinding.FullName -Algorithm SHA256).Hash -ne $rebuilt)) {
    throw 'Rebuilt, vendored and installed SQLite bindings must match'
  }
  Write-Host "PASS: rebuilt, vendored and installed SQLite binding SHA-256 $rebuilt"
  Smoke
  Write-Host 'PASS: certificate reconciliation, deduplication and edited Hyatt expiration displayed in the new year without a redemption'
  Write-Host 'PASS: logged two-night Omni reservation generated a separate unused award; one-night reservations did not combine; IHG summary shows the $250 single-purchase requirement'
  Write-Host 'PASS: 1.0.19 to current-version upgrade, native SQLite ABI, renderer, preload, preserved data and new controls'
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
  # v1.0.25 file management on the installed app: the file used last is reopened at launch,
  # and a file that has gone missing falls back to the default file without being forgotten.
  $settingsPath = Join-Path (Split-Path $dataPath) 'cc-benefit-tracker-settings.json'
  $movedDir = Join-Path $env:RUNNER_TEMP 'Moved Tracker Files'
  $moved = Join-Path $movedDir 'My Tracker.db'
  New-Item -ItemType Directory -Path $movedDir -Force | Out-Null
  Copy-Item $dataPath $moved -Force
  foreach ($suffix in '-wal','-shm') { if (Test-Path "$dataPath$suffix") { Copy-Item "$dataPath$suffix" "$moved$suffix" -Force } }
  [System.IO.File]::WriteAllText($settingsPath, (@{ last_db_path = $moved } | ConvertTo-Json))
  Smoke -ExpectDb $moved
  Stop-App
  Write-Host 'PASS: the file used last time is reopened at launch, with its data, and Save completes the .db file'
  Remove-Item "$moved*" -Force
  Smoke -ExpectDb $dataPath
  Stop-App
  $remembered = (Get-Content $settingsPath -Raw | ConvertFrom-Json).last_db_path
  if ($remembered -ne $moved) { throw 'A missing file was forgotten without the user being asked' }
  Remove-Item $settingsPath -Force
  Write-Host 'PASS: a missing remembered file falls back to the default file and is not forgotten'
  Get-FileHash $setup -Algorithm SHA256 | Format-List
} finally {
  Stop-App
  Stop-Transcript
}
