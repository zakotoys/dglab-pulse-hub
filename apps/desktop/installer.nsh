!include LogicLib.nsh
!include MUI2.nsh
!include nsDialogs.nsh

Var TaskbarPinCheckbox
Var TaskbarPinPage

Function TaskbarPinPageCreate
  nsDialogs::Create 1018
  Pop $TaskbarPinPage
  ${If} $TaskbarPinPage == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 12u "固定到任务栏"
  Pop $TaskbarPinCheckbox
  ${NSD_SetState} $TaskbarPinCheckbox ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd

Function TaskbarPinPageLeave
  ${NSD_GetState} $TaskbarPinCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $TaskbarPinCheckbox 1
  ${Else}
    StrCpy $TaskbarPinCheckbox 0
  ${EndIf}
FunctionEnd

Page custom TaskbarPinPageCreate TaskbarPinPageLeave

!macro customInstall
  ${If} $TaskbarPinCheckbox == 1
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$${shell}=(New-Object -ComObject Shell.Application).NameSpace((Split-Path $\"$INSTDIR\\DGLab Pulse Hub.exe$\")).ParseName($\"DGLab Pulse Hub.exe$\"); $${shell}.InvokeVerb($\"taskbarpin$\")"'
  ${EndIf}
!macroend
