@echo off
REM =====================================================================
REM  Credit Card Benefit Tracker - Uninstall Repair Utility
REM
REM  This script uses no delayed expansion, no self-relaunch, no
REM  complex quoting, and ends with an explicit "press Enter to
REM  close" loop so the window cannot vanish silently.
REM =====================================================================

title Credit Card Benefit Tracker - Repair
color 07

echo.
echo ================================================================
echo   Credit Card Benefit Tracker - Uninstall Repair Utility
echo ================================================================
echo.
echo This cleans up leftover state from a botched uninstall so that
echo "Credit Card Benefit Tracker Setup 1.0.13.exe" can install cleanly.
echo.
echo Your logged benefit usage data in
echo   %APPDATA%\Credit Card Benefit Tracker
echo WILL be preserved. Only install artifacts are removed.
echo.
echo No administrator rights required.
echo.
echo Press any key to begin, or close this window to cancel.
pause >nul

echo.
echo ----------------------------------------------------------------
echo [1 of 6] What tasklist reports about the app right now
echo          (This is the same signal the installer uses.)
echo ----------------------------------------------------------------
echo.
echo Looking for "Credit Card Benefit Tracker.exe":
tasklist /FI "IMAGENAME eq Credit Card Benefit Tracker.exe"
echo.
echo Looking for "Uninstall Credit Card Benefit Tracker.exe":
tasklist /FI "IMAGENAME eq Uninstall Credit Card Benefit Tracker.exe"
echo.

echo ----------------------------------------------------------------
echo [2 of 6] Force-terminating any lingering processes
echo ----------------------------------------------------------------
taskkill /F /IM "Credit Card Benefit Tracker.exe" /T
taskkill /F /IM "Uninstall Credit Card Benefit Tracker.exe" /T
echo.

echo ----------------------------------------------------------------
echo [3 of 6] Removing leftover registry entries
echo ----------------------------------------------------------------
call :DelKey HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded
call :DelKey HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded
call :DelKey HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded
echo.

echo ----------------------------------------------------------------
echo [4 of 6] Removing leftover install folders
echo ----------------------------------------------------------------
call :DelFolder "%LOCALAPPDATA%\Programs\Credit Card Benefit Tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\credit-card-benefit-tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\cc-benefit-tracker"
call :DelFolder "%USERPROFILE%\Downloads\Credit Card Benefit Tracker"
call :DelFolder "%USERPROFILE%\Desktop\Credit Card Benefit Tracker"
echo.

echo ----------------------------------------------------------------
echo [5 of 6] Removing leftover shortcuts
echo ----------------------------------------------------------------
call :DelFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk"
call :DelFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker\Credit Card Benefit Tracker.lnk"
call :DelFile "%USERPROFILE%\Desktop\Credit Card Benefit Tracker.lnk"
call :DelFile "%PUBLIC%\Desktop\Credit Card Benefit Tracker.lnk"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" 2>nul
echo.

echo ----------------------------------------------------------------
echo [6 of 6] Checking user data
echo ----------------------------------------------------------------
if exist "%APPDATA%\Credit Card Benefit Tracker" (
    echo       PRESERVED: %APPDATA%\Credit Card Benefit Tracker
    echo       Your benefit usage history is safe.
) else (
    echo       No user data folder present. This is fine on a fresh machine.
)
echo.

echo ================================================================
echo   Repair complete.
echo ================================================================
echo.
echo Next step: run "Credit Card Benefit Tracker Setup 1.0.13.exe".
echo.
echo Before you close this window, look at step [1 of 6] above.
echo If either tasklist showed a real process row instead of
echo "No tasks are running which match the specified criteria",
echo open Task Manager, end that process by hand, then re-run
echo this repair before installing.
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
