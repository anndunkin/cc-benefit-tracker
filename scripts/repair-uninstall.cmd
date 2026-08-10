@echo off
REM =====================================================================
REM  Credit Card Benefit Tracker - Uninstall Repair Utility
REM
REM  This wrapper re-launches itself under "cmd /k" so the window
REM  stays open no matter how the script is invoked (double-click,
REM  drag-and-drop, right-click Run, from a shortcut, etc.). If pause
REM  ever silently exits, the outer cmd /k keeps the window visible.
REM =====================================================================

REM If we are not already inside the persistent shell wrapper, re-launch
REM ourselves under cmd /k and exit the current instance.
if not "%~1"=="__inner__" (
    start "" "%ComSpec%" /k ""%~f0" __inner__"
    exit /b
)

setlocal EnableExtensions DisableDelayedExpansion
title Credit Card Benefit Tracker - Repair

echo.
echo ================================================================
echo   Credit Card Benefit Tracker - Uninstall Repair Utility
echo ================================================================
echo.
echo This cleans up leftover state from a botched uninstall so that
echo "Credit Card Benefit Tracker Setup 1.0.13.exe" can install cleanly.
echo.
echo Your logged benefit usage data in
echo   %%APPDATA%%\Credit Card Benefit Tracker
echo WILL be preserved. Only install artifacts are removed.
echo.
echo No administrator rights required.
echo.
pause

echo.
echo ----------------------------------------------------------------
echo [1/6] Diagnosing what tasklist reports about the app
echo       (This is the same signal the installer uses.)
echo ----------------------------------------------------------------
echo.
echo Processes matching "Credit Card Benefit Tracker.exe":
tasklist /FI "IMAGENAME eq Credit Card Benefit Tracker.exe" 2>&1
echo.
echo Processes matching "Uninstall Credit Card Benefit Tracker.exe":
tasklist /FI "IMAGENAME eq Uninstall Credit Card Benefit Tracker.exe" 2>&1
echo.

echo ----------------------------------------------------------------
echo [2/6] Force-terminating any lingering processes
echo ----------------------------------------------------------------
taskkill /F /IM "Credit Card Benefit Tracker.exe" /T 2>&1
taskkill /F /IM "Uninstall Credit Card Benefit Tracker.exe" /T 2>&1
echo.

echo ----------------------------------------------------------------
echo [3/6] Removing leftover registry entries
echo ----------------------------------------------------------------
call :DelKey "HKCU\Software\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded"
call :DelKey "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\0cad1474-5477-5366-bb89-f2f01e551ded"
echo.

echo ----------------------------------------------------------------
echo [4/6] Removing leftover install folders
echo ----------------------------------------------------------------
call :DelFolder "%LOCALAPPDATA%\Programs\Credit Card Benefit Tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\credit-card-benefit-tracker"
call :DelFolder "%LOCALAPPDATA%\Programs\cc-benefit-tracker"
call :DelFolder "%USERPROFILE%\Downloads\Credit Card Benefit Tracker"
call :DelFolder "%USERPROFILE%\Desktop\Credit Card Benefit Tracker"
echo.

echo ----------------------------------------------------------------
echo [5/6] Removing leftover shortcuts
echo ----------------------------------------------------------------
call :DelFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker.lnk"
call :DelFile "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker\Credit Card Benefit Tracker.lnk"
call :DelFile "%USERPROFILE%\Desktop\Credit Card Benefit Tracker.lnk"
call :DelFile "%PUBLIC%\Desktop\Credit Card Benefit Tracker.lnk"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" (
    rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Credit Card Benefit Tracker" 2>nul
)
echo.

echo ----------------------------------------------------------------
echo [6/6] Verifying user data is intact
echo ----------------------------------------------------------------
if exist "%APPDATA%\Credit Card Benefit Tracker" (
    echo       PRESERVED: %APPDATA%\Credit Card Benefit Tracker
    echo       Your benefit usage history is safe.
) else (
    echo       No user data folder present ^(fine on a fresh machine^).
)
echo.

echo ================================================================
echo   Repair complete.
echo ================================================================
echo.
echo Next step:
echo   Run "Credit Card Benefit Tracker Setup 1.0.13.exe" now.
echo.
echo If step [1/6] above listed ANY row under the tables
echo (i.e. any process actually running), open Task Manager, end
echo each Credit Card Benefit Tracker process by hand, then re-run
echo this repair script before installing.
echo.
echo This window will stay open. Close it when you are done reading.
echo.
goto :EOF

REM ==========================================================
REM Subroutines
REM ==========================================================

:DelKey
reg query %~1 >nul 2>&1
if %errorlevel% equ 0 (
    reg delete %~1 /f >nul 2>&1
    if not errorlevel 1 (
        echo       Deleted %~1
    ) else (
        echo       WARNING: could not delete %~1
    )
) else (
    echo       Not present: %~1
)
goto :EOF

:DelFolder
if exist %~1 (
    rmdir /S /Q %~1 2>nul
    if not exist %~1 (
        echo       Removed %~1
    ) else (
        echo       WARNING: could not fully remove %~1 ^(files may be in use^)
    )
) else (
    echo       Not present: %~1
)
goto :EOF

:DelFile
if exist %~1 (
    del /F /Q %~1 >nul 2>&1
    if not exist %~1 (
        echo       Removed %~1
    ) else (
        echo       WARNING: could not delete %~1
    )
)
goto :EOF
