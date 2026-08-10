# Credit Card Benefit Tracker - Uninstall Repair Utility (PowerShell)
#
# Run this when a previous uninstall left the machine in a broken state
# ("cannot find the .exe", "the app is open", installer refuses to run).
#
# Usage:
#   1. Right-click this file and choose "Run with PowerShell".
#   2. If Windows blocks it, open PowerShell manually and run:
#      Set-ExecutionPolicy -Scope Process Bypass; .\repair-uninstall.ps1
#
# No admin required. Your logged benefit usage data in
# %APPDATA%\Credit Card Benefit Tracker is preserved.

$ErrorActionPreference = 'Continue'
$AppGuid = '0cad1474-5477-5366-bb89-f2f01e551ded'
$AppExe = 'Credit Card Benefit Tracker.exe'
$UninstExe = 'Uninstall Credit Card Benefit Tracker.exe'

Write-Host ''
Write-Host '=== Credit Card Benefit Tracker - Uninstall Repair ===' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Cleaning leftover state from a botched uninstall. Your logged'
Write-Host 'benefit usage data in %APPDATA%\Credit Card Benefit Tracker'
Write-Host 'WILL be preserved.'
Write-Host ''
Read-Host 'Press Enter to continue'

# 1. Kill lingering processes -----------------------------------------
Write-Host ''
Write-Host '[1/5] Killing any lingering app / uninstaller processes...'
$killed = $false
foreach ($name in @('Credit Card Benefit Tracker', 'Uninstall Credit Card Benefit Tracker')) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "      Terminated: $name" -ForegroundColor Yellow
        $killed = $true
    }
}
if (-not $killed) { Write-Host '      No matching processes were running.' }

# 2. Registry cleanup -------------------------------------------------
Write-Host ''
Write-Host '[2/5] Removing leftover registry entries...'
$keys = @(
    "HKCU:\Software\$AppGuid",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"
)
foreach ($k in $keys) {
    if (Test-Path $k) {
        Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $k)) {
            Write-Host "      Deleted $k" -ForegroundColor Yellow
        } else {
            Write-Host "      WARNING: could not delete $k" -ForegroundColor Red
        }
    } else {
        Write-Host "      $k not present."
    }
}

# 3. Leftover install folders -----------------------------------------
Write-Host ''
Write-Host '[3/5] Removing leftover install folders...'
$targets = @(
    "$env:LOCALAPPDATA\Programs\Credit Card Benefit Tracker",
    "$env:LOCALAPPDATA\Programs\credit-card-benefit-tracker",
    "$env:LOCALAPPDATA\Programs\cc-benefit-tracker",
    "$env:USERPROFILE\Downloads\Credit Card Benefit Tracker",
    "$env:USERPROFILE\Desktop\Credit Card Benefit Tracker"
)
foreach ($t in $targets) {
    if (Test-Path $t) {
        Remove-Item -Path $t -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $t)) {
            Write-Host "      Removed $t" -ForegroundColor Yellow
        } else {
            Write-Host "      WARNING: could not fully remove $t (files may be in use)" -ForegroundColor Red
        }
    }
}

# 4. Leftover shortcuts -----------------------------------------------
Write-Host ''
Write-Host '[4/5] Removing leftover shortcuts...'
$shortcuts = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker\Credit Card Benefit Tracker.lnk",
    "$env:USERPROFILE\Desktop\Credit Card Benefit Tracker.lnk",
    "$env:PUBLIC\Desktop\Credit Card Benefit Tracker.lnk"
)
foreach ($s in $shortcuts) {
    if (Test-Path $s) {
        Remove-Item -Path $s -Force -ErrorAction SilentlyContinue
        Write-Host "      Removed $s" -ForegroundColor Yellow
    }
}
$smFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker"
if (Test-Path $smFolder) {
    Remove-Item -Path $smFolder -Force -ErrorAction SilentlyContinue
}

# 5. Preserve user data ------------------------------------------------
Write-Host ''
Write-Host '[5/5] Verifying user data is intact...'
$dataDir = "$env:APPDATA\Credit Card Benefit Tracker"
if (Test-Path $dataDir) {
    Write-Host "      Preserved: $dataDir" -ForegroundColor Green
    Write-Host '      Your benefit usage history is safe.'
} else {
    Write-Host '      No user data folder present (this is fine on a fresh setup).'
}

Write-Host ''
Write-Host '=== Repair complete ===' -ForegroundColor Cyan
Write-Host ''
Write-Host 'You can now run "Credit Card Benefit Tracker Setup 1.0.12.exe" (or'
Write-Host 'later) and it will install cleanly. If you still see the previous'
Write-Host '"app is open" error, sign out of Windows and sign back in, then'
Write-Host 're-run the installer.'
Write-Host ''
Read-Host 'Press Enter to close'
