; installer.nsh — Custom NSIS macros for Credit Card Benefit Tracker
;
; Fixes two related install failure modes:
;
;   A) The "cannot find .exe / app is open" family of errors on reinstall
;      after a previous uninstall was interrupted, cancelled, or left
;      registry / files behind (v1.0.12 fix).
;
;   B) The mid-install "Credit Card Benefit Tracker cannot be closed. Please
;      close it manually and click Retry to continue" dialog that would
;      loop indefinitely even after a full reboot (v1.0.13 fix). Root cause
;      is electron-builder's default _CHECK_APP_RUNNING probe: it prefers a
;      PowerShell Get-CimInstance query whose $INSTDIR-based filter and
;      $_.Path.StartsWith call can throw, exit with a non-standard code, or
;      false-positive against ghost process records. When it does, the
;      template's own retry loop shows the "cannot be closed" dialog with
;      NO way for the user to escape and no diagnostic output.
;
; Design:
;  1) customInit only overrides $INSTDIR when there is NO existing
;     InstallLocation in the registry. Previously it clobbered $INSTDIR
;     unconditionally, which meant updates and re-installs silently moved
;     the app to "$EXEDIR\Credit Card Benefit Tracker" (next to whichever
;     setup.exe the user happened to double-click), decoupling from where
;     the app really lived.
;  2) customCheckAppRunning replaces electron-builder's default probe with a
;     simple, deterministic tasklist + taskkill loop. The default template
;     honors this macro via !ifmacrodef and skips its own _CHECK_APP_RUNNING
;     entirely (see node_modules/app-builder-lib/templates/nsis/include/
;     allowOnlyOneInstallerInstance.nsh). We use tasklist (never PowerShell,
;     which is where the false-positive originates), we taskkill /F, and if
;     the process really is unkillable we abort with a clear message instead
;     of the built-in retry loop.
;  3) customUnInit kills any lingering app process so RMDir won't fail on
;     locked files. This is belt-and-suspenders on top of NSIS's own
;     CHECK_APP_RUNNING, which some users report is insufficient when a
;     background helper process is holding a handle.
;  4) customUnInstall scrubs the InstallLocation registry entry so a future
;     installer treats this machine as fresh, and also drops the secondary
;     per-GUID Uninstall key that electron-builder sometimes registers.
;
; We deliberately do NOT override customRemoveFiles — the default
; electron-builder template implements a smart atomicRMDir path used during
; updates that we don't want to lose.

!macro preInit
  ; intentionally empty — path decisions happen in customInit
!macroend

!macro customInit
  Push $0
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ; Truly fresh install: default next to the setup .exe, matching the
    ; historical layout users are used to.
    StrCpy $INSTDIR "$EXEDIR\Credit Card Benefit Tracker"
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
!macroend

; Override the electron-builder default _CHECK_APP_RUNNING probe.
;
; The default probe prefers PowerShell + Get-CimInstance Win32_Process, then
; falls back to tasklist. Both branches feed into a retry loop that pops the
; "Credit Card Benefit Tracker cannot be closed" dialog when it thinks the
; app is still running after a kill. On some machines that check false-
; positives even across reboots (issue #8131 in electron-builder), which is
; how users end up in an unrecoverable install state.
;
; This replacement:
;   * Uses tasklist only (skip the fragile PowerShell path entirely).
;   * Matches on IMAGENAME exactly, scoped to the current user.
;   * If found, taskkill /F once, waits 1s, and re-checks.
;   * If STILL found (which would be a real "app is legitimately elevated /
;     locked" case), aborts with a diagnostic message that names the exact
;     process rather than looping forever.
;
; This macro is executed from the Install Section (see installSection.nsh),
; after customInit / initMultiUser and before the install proper begins.
!macro customCheckAppRunning
  Push $0
  Push $R0
  Push $R1

  ; Probe 1: is the app currently running under this user?
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0

  ${If} $R0 == 0
    ; Process really is running — kill it hard, then verify.
    DetailPrint "Stopping running ${APP_EXECUTABLE_FILENAME}..."
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T /FI "USERNAME eq %USERNAME%"`
    Pop $0
    Sleep 1000

    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R1

    ${If} $R1 == 0
      ; Still running after force-kill — this is a real elevation problem,
      ; not a template false-positive. Give the user a clear next step
      ; instead of the endless "Retry" loop.
      MessageBox MB_OK|MB_ICONSTOP "Credit Card Benefit Tracker is still running and could not be closed automatically.$\r$\n$\r$\nOpen Task Manager, end every 'Credit Card Benefit Tracker.exe' process (including background helpers), then re-run this installer.$\r$\n$\r$\nIf that still fails, sign out of Windows and sign back in, then re-run the installer."
      Quit
    ${EndIf}
  ${EndIf}

  Pop $R1
  Pop $R0
  Pop $0
!macroend

!macro customUnInit
  ; Release any file handles a lingering app process may still hold. Ignore
  ; taskkill's exit code — the common case is "process not found", which
  ; returns non-zero.
  nsExec::Exec 'taskkill /F /IM "Credit Card Benefit Tracker.exe" /T'
  Pop $0
!macroend

!macro customUnInstall
  ; Belt-and-suspenders: kill again in case a helper spawned since un.onInit.
  nsExec::Exec 'taskkill /F /IM "Credit Card Benefit Tracker.exe" /T'
  Pop $0

  ; Clear our own InstallLocation so the next installer starts fresh.
  DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  DeleteRegKey /ifempty HKCU "${INSTALL_REGISTRY_KEY}"

  ; Drop the secondary per-GUID Uninstall key if electron-builder wrote one.
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
!macroend
