; The prerequisite section runs after the user chooses Install, but before an old
; BladeVMS version is removed. A failed/cancelled prerequisite leaves it intact.
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "payload.generated.nsh"

!macro customInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "BladeVMS requires native Windows x64 (Intel/AMD). ARM Windows is not supported by this device SDK."
    SetErrorLevel 1633
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "BladeVMS requires Windows 10 or Windows 11 x64."
    SetErrorLevel 1633
    Quit
  ${EndIf}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var bladeVcReady
    Var bladeVcVersion
    Var bladeVcInstalled
    Var bladeVcCompare
    Var bladeVcResult
    Var bladeVcHandle
    Var bladeVcExit
    Var bladeVcArguments

    Function .onInstSuccess
      IfRebootFlag 0 +2
      SetErrorLevel 3010
    FunctionEnd

    Function BladeCheckVcRuntime
      StrCpy $bladeVcReady "0"
      ; Microsoft has used both registry views for the x64 runtime. Never check
      ; the x86 runtime or use a lexical version comparison.
      SetRegView 32
      ReadRegDWORD $bladeVcInstalled HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
      ReadRegStr $bladeVcVersion HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
      ${If} $bladeVcInstalled == "1"
      ${AndIf} $bladeVcVersion != ""
        StrCpy $bladeVcCompare $bladeVcVersion 1
        ${If} $bladeVcCompare == "v"
          StrCpy $bladeVcVersion $bladeVcVersion "" 1
        ${EndIf}
        ${VersionCompare} $bladeVcVersion "${BLADE_VC_MIN_VERSION}" $bladeVcCompare
        ${If} $bladeVcCompare != "2"
          StrCpy $bladeVcReady "1"
        ${EndIf}
      ${EndIf}
      SetRegView 64
      ReadRegDWORD $bladeVcInstalled HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
      ReadRegStr $bladeVcVersion HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
      ${If} $bladeVcInstalled == "1"
      ${AndIf} $bladeVcVersion != ""
        StrCpy $bladeVcCompare $bladeVcVersion 1
        ${If} $bladeVcCompare == "v"
          StrCpy $bladeVcVersion $bladeVcVersion "" 1
        ${EndIf}
        ${VersionCompare} $bladeVcVersion "${BLADE_VC_MIN_VERSION}" $bladeVcCompare
        ${If} $bladeVcCompare != "2"
          StrCpy $bladeVcReady "1"
        ${EndIf}
      ${EndIf}
    FunctionEnd

    Section "-Microsoft Visual C++ x64 Runtime"
      Call BladeCheckVcRuntime
      ${If} $bladeVcReady != "1"
        InitPluginsDir
        SetOutPath $PLUGINSDIR
        File /oname=vc_redist.x64.exe "${PROJECT_DIR}/resources/prerequisites/vc_redist.x64.exe"
        StrCpy $bladeVcArguments '/install /passive /norestart /log "$TEMP\BladeVMS-vc-redist.log"'
        ${If} ${Silent}
          StrCpy $bladeVcArguments '/install /quiet /norestart /log "$TEMP\BladeVMS-vc-redist.log"'
        ${EndIf}
        DetailPrint "Installing Microsoft Visual C++ x64 runtime ${BLADE_VC_MIN_VERSION}..."
        ; Elevate only the signed Microsoft prerequisite. The desktop app stays
        ; per-user unless the user explicitly selected installation for everyone.
        ${StdUtils.ExecShellWaitEx} $bladeVcResult $bladeVcHandle "$PLUGINSDIR\vc_redist.x64.exe" "runas" $bladeVcArguments
        ${If} $bladeVcResult != "ok"
          ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ runtime could not start (error $bladeVcHandle). Allow the Windows administrator prompt and run this installer again. BladeVMS was not installed or upgraded."
          ${EndIf}
          SetErrorLevel 1603
          Abort
        ${EndIf}
        ${StdUtils.WaitForProcEx} $bladeVcExit $bladeVcHandle
        ${If} $bladeVcExit == "3010"
        ${OrIf} $bladeVcExit == "1641"
          SetRebootFlag true
          ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONINFORMATION "The Microsoft runtime requires a Windows restart. BladeVMS installation will finish now. Restart Windows before launching BladeVMS or connecting the device."
          ${EndIf}
        ${Else}
          Call BladeCheckVcRuntime
          ; Also accepts the redistributable's 'newer version installed' result
          ; only after independently verifying that the newer x64 runtime exists.
          ${If} $bladeVcReady != "1"
            ${IfNot} ${Silent}
              MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ x64 runtime installation did not complete (exit $bladeVcExit). See $TEMP\BladeVMS-vc-redist.log. Restart Windows if necessary, then run this installer again. BladeVMS was not installed or upgraded."
            ${EndIf}
            SetErrorLevel 1603
            Abort
          ${EndIf}
        ${EndIf}
      ${Else}
        DetailPrint "Compatible Microsoft Visual C++ x64 runtime is already installed; no change needed."
      ${EndIf}
    SectionEnd
  !endif
!macroend

; Deliberately no custom uninstall: never uninstall the shared VC++ runtime,
; change system PATH, remove Python/Conda environments, or delete user recordings.
