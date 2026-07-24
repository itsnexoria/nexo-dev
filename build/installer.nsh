; Adds "Open with Nexo Dev" to the right-click menu for files, folders, and
; folder backgrounds — the same pattern editors like VS Code use. Registered
; per-user (HKCU) so it doesn't need admin elevation, matching the default
; per-user NSIS install this app uses.
;
; electron-builder calls the customInstall/customUnInstall macros
; automatically as part of its own install/uninstall sections — nothing else
; needs to reference this file except the "nsis.include" entry in package.json.

!macro customInstall
  ; Right-click on any file
  WriteRegStr HKCU "Software\Classes\*\shell\NexoDev" "" "Open with Nexo Dev"
  WriteRegStr HKCU "Software\Classes\*\shell\NexoDev" "Icon" "$INSTDIR\Nexo Dev.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\NexoDev\command" "" '"$INSTDIR\Nexo Dev.exe" "%1"'

  ; Right-click directly on a folder
  WriteRegStr HKCU "Software\Classes\Directory\shell\NexoDev" "" "Open Folder with Nexo Dev"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NexoDev" "Icon" "$INSTDIR\Nexo Dev.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NexoDev\command" "" '"$INSTDIR\Nexo Dev.exe" "%1"'

  ; Right-click on empty space inside a folder (opens that folder)
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NexoDev" "" "Open Folder with Nexo Dev"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NexoDev" "Icon" "$INSTDIR\Nexo Dev.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\NexoDev\command" "" '"$INSTDIR\Nexo Dev.exe" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\NexoDev"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NexoDev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\NexoDev"
!macroend
