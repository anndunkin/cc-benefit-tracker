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
echo [1/5] Killing any lingering app / uninstaller processes...
taskkill /F /IM "Credit Card Benefit Tracker.exe" /T >nul 2>&1
taskkill /F /IM "Uninstall Credit Card Benefit Tracker.exe" /T >nul 2>&1
if !errorlevel! equ 0 (
  echo       Terminated running processes.
) else (
  echo       No matching processes were running.
)

echo.
echo [2/5] Removing leftover registry entries...
REM App install-metadata key
reg query "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded" >nul 2>&1
if !errorlevel! equ 0 (
  reg delete "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded" /f >nul 2>&1
  echo       Deleted HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded
) else (
  echo       HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded not present.
)

REM Uninstall key that Programs and Features reads
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" >nul 2>&1
if !errorlevel! equ 0 (
  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded" /f >nul 2>&1
  echo       Deleted Programs and Features uninstall entry.
) else (
  echo       Uninstall registry entry not present.
)

echo.
echo [3/5] Removing leftover install folders...
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
echo [4/5] Removing leftover shortcuts...
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
echo [5/5] Verifying user data is intact...
if exist "%APPDATA%\Credit Card Benefit Tracker" (
  echo       Preserved: %APPDATA%\Credit Card Benefit Tracker
  echo       Your benefit usage history is safe.
) else (
  echo       No user data folder present ^(this is fine on a fresh setup^).
)

echo.
echo === Repair complete ===
echo.
echo You can now run "Credit Card Benefit Tracker Setup 1.0.12.exe" ^(or later^)
echo and it will install cleanly. If you still see the previous "app is open"
echo error, sign out of Windows and sign back in ^(clears any process handles
echo the OS is holding^) and then re-run the installer.
echo.
pause
endlocal
