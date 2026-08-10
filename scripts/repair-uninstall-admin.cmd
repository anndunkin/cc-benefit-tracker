@echo off
REM =====================================================================
REM  Credit Card Benefit Tracker - Admin Repair (Program Files cleanup)
REM
REM  Use this when the regular repair-uninstall.cmd runs clean but the
REM  installer still fails with:
REM    "Error opening file for writing:
REM     C:\Program Files\Benefits Tracker\Credit Card Benefit Tracker\
REM     Uninstall Credit Card Benefit Tracker.exe"
REM
REM  That path is a per-MACHINE install from an older elevated install.
REM  The regular repair script only cleans per-user locations, so a
REM  stale copy under C:\Program Files survives it. This script cleans
REM  that up, and re-launches itself with UAC elevation if needed.
REM =====================================================================

REM ---- Self-elevate to admin if we are not already elevated -----------
net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo Requesting administrator privileges via UAC...
    echo Click YES on the Windows prompt to continue.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title Credit Card Benefit Tracker - Admin Repair
color 07

echo.
echo ================================================================
echo   Credit Card Benefit Tracker - Admin Repair
echo   (elevated - cleans C:\Program Files residue)
echo ================================================================
echo.
echo This removes leftover machine-wide install artifacts that a
echo previous elevated install left behind under C:\Program Files.
echo.
echo Your logged benefit usage data in
echo   %APPDATA%\Credit Card Benefit Tracker
echo is NOT touched by this script.
echo.
pause

echo.
echo ----------------------------------------------------------------
echo [1 of 5] Killing any lingering processes (all users)
echo ----------------------------------------------------------------
taskkill /F /IM "Credit Card Benefit Tracker.exe" /T
taskkill /F /IM "Uninstall Credit Card Benefit Tracker.exe" /T
echo.

echo ----------------------------------------------------------------
echo [2 of 5] Removing C:\Program Files residue
echo ----------------------------------------------------------------
call :DelFolder "%ProgramFiles%\Benefits Tracker\Credit Card Benefit Tracker"
call :DelFolder "%ProgramFiles%\Benefits Tracker"
call :DelFolder "%ProgramFiles%\Credit Card Benefit Tracker"
call :DelFolder "%ProgramFiles(x86)%\Benefits Tracker\Credit Card Benefit Tracker"
call :DelFolder "%ProgramFiles(x86)%\Benefits Tracker"
call :DelFolder "%ProgramFiles(x86)%\Credit Card Benefit Tracker"
echo.

echo ----------------------------------------------------------------
echo [3 of 5] Removing machine-wide registry entries
echo ----------------------------------------------------------------
call :DelKey "HKLM\Software\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKLM\Software\WOW6432Node\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded"
echo.

echo ----------------------------------------------------------------
echo [4 of 5] Removing machine-wide shortcuts
echo ----------------------------------------------------------------
call :DelFile "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk"
call :DelFile "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker\Credit Card Benefit Tracker.lnk"
call :DelFile "%PUBLIC%\Desktop\Credit Card Benefit Tracker.lnk"
if exist "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" (
    rmdir "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" 2>nul
)
echo.

echo ----------------------------------------------------------------
echo [5 of 5] Also cleaning per-user residue for the current user
echo          (belt-and-suspenders; the regular script covers this)
echo ----------------------------------------------------------------
call :DelKey "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelFolder "%LOCALAPPDATA%\Programs\Credit Card Benefit Tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\credit-card-benefit-tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\cc-benefit-tracker"
call :DelFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk"
call :DelFile "%USERPROFILE%\Desktop\Credit Card Benefit Tracker.lnk"
echo.

echo ================================================================
echo   Admin repair complete.
echo ================================================================
echo.
echo Next step: run "Credit Card Benefit Tracker Setup 1.0.13.exe".
echo.
echo When you run it, when the installer asks whether to install for
echo YOU or for ALL USERS, choose "Only for me". That will install to
echo %%LOCALAPPDATA%%\Programs, which is what v1.0.13 is designed for.
echo.

:HoldOpen
echo Type EXIT and press Enter when you are done reading.
set /p _closeprompt=^>
if /I not "%_closeprompt%"=="EXIT" goto HoldOpen
goto :EOF


REM ==========================================================
REM Subroutines
REM ==========================================================

:DelKey
reg query %1 >nul 2>&1
if errorlevel 1 (
    echo       Not present: %1
    goto :EOF
)
reg delete %1 /f >nul 2>&1
if errorlevel 1 (
    echo       WARNING could not delete: %1
) else (
    echo       Deleted: %1
)
goto :EOF

:DelFolder
if not exist %1 (
    echo       Not present: %1
    goto :EOF
)
rmdir /S /Q %1 2>nul
if exist %1 (
    echo       WARNING could not fully remove: %1
) else (
    echo       Removed: %1
)
goto :EOF

:DelFile
if not exist %1 goto :EOF
del /F /Q %1 >nul 2>&1
if exist %1 (
    echo       WARNING could not delete: %1
) else (
    echo       Removed: %1
)
goto :EOF
