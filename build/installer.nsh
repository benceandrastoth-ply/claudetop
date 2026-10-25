; Extra installer page with claudetop's options, plus the matching install/uninstall steps.
; Included by electron-builder (see "nsis.include" in package.json).

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var DesktopCheckbox
  Var HooksCheckbox
  Var StartupCheckbox
  Var AgentCheckbox
  Var WantDesktop
  Var WantHooks
  Var WantStartup
  Var WantAgent

  ; The page functions live inside this macro so they're compiled after the Modern UI
  ; macros (MUI_HEADER_TEXT) are available.
  !macro customPageAfterChangeDir
    Page custom OptionsPageCreate OptionsPageLeave

  Function OptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "Options" "Choose how claudetop should be set up."
    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateCheckbox} 0 0 100% 12u "Create a &desktop shortcut"
    Pop $DesktopCheckbox
    ${NSD_Check} $DesktopCheckbox

    ${NSD_CreateCheckbox} 0 20u 100% 12u "&Connect to Claude Code (adds hooks to ~/.claude/settings.json)"
    Pop $HooksCheckbox
    ${NSD_Check} $HooksCheckbox
    ${NSD_CreateLabel} 12u 34u 95% 20u "Lets the little Claude know when Claude Code is working, done or out of credits. You can turn this off later from its right-click menu."
    Pop $0

    ${NSD_CreateCheckbox} 0 62u 100% 12u "Start claudetop when &Windows starts"
    Pop $StartupCheckbox

    ${NSD_CreateCheckbox} 0 82u 100% 12u "Turn Claude into &Agent 47 (suit, red tie, barcode)"
    Pop $AgentCheckbox
    ${NSD_CreateLabel} 12u 96u 95% 20u "Sneaks around, speaks like a professional, and deals with NSFW tabs using a rubber duck. You can change it later under Hat."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function OptionsPageLeave
    ${NSD_GetState} $DesktopCheckbox $WantDesktop
    ${NSD_GetState} $HooksCheckbox $WantHooks
    ${NSD_GetState} $StartupCheckbox $WantStartup
    ${NSD_GetState} $AgentCheckbox $WantAgent
  FunctionEnd
  !macroend

  !macro customInstall
    ${If} $WantDesktop == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
    ${If} $WantHooks == ${BST_CHECKED}
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-hooks'
    ${EndIf}
    ${If} $WantStartup == ${BST_CHECKED}
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --start-with-windows'
    ${EndIf}
    ${If} $WantAgent == ${BST_CHECKED}
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --set-hat=agent47'
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  ; An upgrade runs the old uninstaller first; keep the user's setup in that case.
  ${IfNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hooks --no-start-with-windows'
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${EndIf}
!macroend
