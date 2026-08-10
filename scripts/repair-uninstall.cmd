@echo off
setlocal EnableDelayedExpansion

REM =====================================================================
REM  Credit Card Benefit Tracker - Uninstall Repair Utility
REM
REM  Run this when a previous uninstall left the machine in a broken state
REM  ("cannot find the .exe", "the app is open", installer refuses to run).
REM
REM  What it does:
REM    1. Force-terminates any lingering app / uninstaller processes.
REM    2. Removes the two registry keys electron-builder writes:
REM         HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded
REM         HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\
REM             0cad1474-5477-5366-bb89-f2f01e551ded
REM    3. Removes leftover install folders from the three common locations.
REM    4. Removes leftover Start Menu and Desktop shortcuts.
REM    5. Preserves user data in %APPDATA%\Credit Card Benefit Tracker
REM       (the SQLite database). Nothing you have logged will be lost.
REM
REM  All operations are per-user - no admin required.
REM =====================================================================

echo.
echo === Credit Card Benefit Tracker - Uninstall Repair ===
echo.
echo This will clean up leftover state from a botched uninstall so the
echo v1.0.11 installer can run cleanly. Your logged benefit usage data in
echo %%APPDATA%%\Credit Card Benefit Tracker WILL be preserved.
echo.
pause

echo.
echo [1/6] Diagnosing what tasklist reports about the app...
echo       (This is the same probe the installer runs. If it prints any
       row here, the installer will think the app is running.)
echo       ---
tasklist /FI "IMAGENAME eq Credit Card Benefit Tracker.exe" /FO TABLE
echo       ---
tasklist /FI "IMAGENAME eq Uninstall Credit Card Benefit Tracker.exe" /FO TABLE
echo       ---

echo.
echo [2/6] Killing any lingering app / uninstaller processes...
taskkill /F /IM "Credit Card Benefit Tracker.exe" /T >nul 2>&1
taskkill /F /IM "Uninstall Credit Card Benefit Tracker.exe" /T >nul 2>&1
if !errorlevel! equ 0 (
  echo       Terminated running processes.
) else (
  echo       No matching processes were running.
)

echo.
echo [3/6] Removing leftover registry entries...
REM App install-metadata key
reg query "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded" >nul 2>&1
if !errorlevel! equ 0 (
  reg delete "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded" /f >nul 2>&1
  echo       Deleted HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded
) else (
  echo       HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded not present.
)

REM Uninstall key that Programs and Features reads (both hives)
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" >nul 2>&1
if !errorlevel! equ 0 (
  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" /f >nul 2>&1
  echo       Deleted Programs and Features uninstall entry (HKCU).
) else (
  echo       Uninstall registry entry not present (HKCU).
)
reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" >nul 2>&1
if !errorlevel! equ 0 (
  reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" /f >nul 2>&1
  echo       Deleted Programs and Features uninstall entry (HKLM).
) else (
  echo       Uninstall registry entry not present (HKLM).
)

REM Any lingering MUI / language / install-mode residue that CHECK_APP_RUNNING
REM could be reading. These are the reg-name patterns electron-builder writes.
for %%V in ("InstallLocation" "KeepShortcuts") do (
  reg delete "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded" /v %%V /f >nul 2>&1
)

echo.
echo [4/6] Removing leftover install folders...
REM Historical location: next to the setup .exe. We can't know that path,
REM but we can check the two well-known electron-builder defaults.
set "TARGETS=%LOCALAPPDATA%\Programs\Credit Card Benefit Tracker" "%LOCALAPPDATA%\Programs\credit-card-benefit-tracker" "%LOCALAPPDATA%\Programs\cc-benefit-tracker" "%USERPROFILE%\Downloads\Credit Card Benefit Tracker" "%USERPROFILE%\Desktop\Credit Card Benefit Tracker"
for %%T in (%TARGETS%) do (
  if exist %%T (
    rmdir /S /Q %%T 2>nul
    if not exist %%T (
      echo       Removed %%T
    ) else (
      echo       WARNING: could not fully remove %%T ^(files may be in use^)
    )
  )
)

echo.
echo [5/6] Removing leftover shortcuts...
set "SHORTCUTS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker\Credit Card Benefit Tracker.lnk" "%USERPROFILE%\Desktop\Credit Card Benefit Tracker.lnk" "%PUBLIC%\Desktop\Credit Card Benefit Tracker.lnk"
for %%S in (%SHORTCUTS%) do (
  if exist %%S (
    del /F /Q %%S >nul 2>&1
    echo       Removed %%S
  )
)
REM Also drop the Start Menu folder if it's now empty.
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" (
  rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" 2>nul
)

echo.
echo [6/6] Verifying user data is intact...
if exist "%APPDATA%\Credit Card Benefit Tracker" (
  echo       Preserved: %APPDATA%\Credit Card Benefit Tracker
  echo       Your benefit usage history is safe.
) else (
  echo       No user data folder present ^(this is fine on a fresh setup^).
)

echo.
echo === Repair complete ===
echo.
echo You can now run "Credit Card Benefit Tracker Setup 1.0.13.exe" ^(or later^)
echo and it will install cleanly. v1.0.13 also overrides the installer's own
echo "is the app running" probe with a simpler version that will not loop on
echo the "cannot be closed" dialog even if this repair leaves something behind.
echo.
echo If [1/6] above showed one or more "Credit Card Benefit Tracker.exe" rows,
echo open Task Manager, end each of them by hand, then re-run this repair.
echo.
pause
endlocal
