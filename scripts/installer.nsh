; installer.nsh — Custom NSIS macros for Credit Card Benefit Tracker
;
; Fixes the "cannot find .exe / app is open" reinstall failure that hit users
; whose previous uninstall was interrupted or left registry / files behind.
;
; Design:
;  1) customInit only overrides $INSTDIR when there is NO existing
;     InstallLocation in the registry. Previously it clobbered $INSTDIR
;     unconditionally, which meant updates and re-installs silently moved
;     the app to "$EXEDIR\Credit Card Benefit Tracker" (next to whichever
;     setup.exe the user happened to double-click), decoupling from where
;     the app really lived.
;  2) customUnInit kills any lingering app process so RMDir won't fail on
;     locked files. This is belt-and-suspenders on top of NSIS's own
;     CHECK_APP_RUNNING, which some users report is insufficient when a
;     background helper process is holding a handle.
;  3) customUnInstall scrubs the InstallLocation registry entry so a future
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
