; installer.nsh — Custom NSIS macros for Credit Card Benefit Tracker

!macro preInit
  ; intentionally empty — path override happens in customInit
!macroend

!macro customInit
  StrCpy $INSTDIR "$EXEDIR\Credit Card Benefit Tracker"
!macroend

!macro customInstall
!macroend

!macro customUnInstall
!macroend
