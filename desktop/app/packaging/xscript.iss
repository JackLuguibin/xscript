; Inno Setup 6 script for the XScript desktop client (Windows x64). Built by packaging/build_windows.sh:
;   ISCC /DAppVersion=X.Y.Z /DSourceDir=<dist\XScript> /DOutputDir=<dist> /DIconFile=<XScript.ico> xscript.iss
; Per-user install (no admin, %LOCALAPPDATA%\Programs\XScript); the same AppId upgrades in place, which the
; desktop auto-update relies on. Not code-signed (no certificate): SmartScreen shows "unknown publisher".
#ifndef AppVersion
  #error AppVersion is required (/DAppVersion=X.Y.Z)
#endif
#ifndef SourceDir
  #error SourceDir is required (the PyInstaller onedir output)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
AppId={{6C1F4E2A-9B7D-4C35-8E21-5A0D3F7B9C64}
AppName=XScript
AppVersion={#AppVersion}
AppVerName=XScript {#AppVersion}
AppPublisher=XScript
AppPublisherURL=https://github.com/JackLuguibin/xscript
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\XScript
DefaultGroupName=XScript
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=xscript-desktop-v{#AppVersion}-windows-x64-setup
#ifdef IconFile
SetupIconFile={#IconFile}
#endif
UninstallDisplayIcon={app}\XScript.exe
UninstallDisplayName=XScript
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
#ifexist "compiler:Languages\ChineseSimplified.isl"
Name: "zh"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; an upgrade must not keep modules of the previous build next to the new ones
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\XScript"; Filename: "{app}\XScript.exe"
Name: "{autodesktop}\XScript"; Filename: "{app}\XScript.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\XScript.exe"; Description: "{cm:LaunchProgram,XScript}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\_internal"
