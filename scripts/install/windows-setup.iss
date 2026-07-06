; WhipDesk Windows setup wizard (Inno Setup 6). Built by .github/workflows/release.yml AFTER the
; inner whipdesk.exe is SignPath-signed; the resulting installer is then SignPath-signed itself
; and shipped as whipdesk-<version>-windows-x64-setup.exe next to the portable zip.
;
; Per-user install (no admin prompt): %LOCALAPPDATA%\Programs\WhipDesk, added to the USER PATH.
; Compile: ISCC /DAppVersion=1.2.3 /DStageDir=<staged files> /DOutDir=<out> /DOutBase=<name> windows-setup.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\apps\desktop-agent\dist\stage"
#endif
#ifndef OutDir
  #define OutDir "."
#endif
#ifndef OutBase
  #define OutBase "whipdesk-setup"
#endif

[Setup]
AppId={{AB34B7B4-339B-47BB-B6D3-2972E2BE15AF}
AppName=WhipDesk
AppVersion={#AppVersion}
AppPublisher=BinaryBanana LLC
AppPublisherURL=https://whipdesk.com
AppSupportURL=https://github.com/BinaryBananaLLC/WhipDesk/issues
DefaultDirName={localappdata}\Programs\WhipDesk
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename={#OutBase}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
WizardStyle=modern

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
; WhipDesk is a console app — the shortcut opens it in the user's default terminal.
Name: "{userprograms}\WhipDesk"; Filename: "{app}\whipdesk.exe"

[Registry]
; Append {app} to the USER Path (deduped by NeedsAddPath below) so `whipdesk` works in any new shell.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  { look for the path with leading and trailing semicolon; Pos() is case-sensitive so lowercase both }
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

[Run]
Filename: "{app}\whipdesk.exe"; Description: "Run WhipDesk now"; Flags: postinstall nowait skipifsilent shellexec
