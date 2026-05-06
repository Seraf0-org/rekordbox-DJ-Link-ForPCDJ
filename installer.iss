[Setup]
AppName=DJLinkForPCDJ
AppVersion=1.0.0
AppPublisher=DJLinkForPCDJ
DefaultDirName={autopf}\DJLinkForPCDJ
DefaultGroupName=DJLinkForPCDJ
OutputBaseFilename=DJLinkForPCDJ-setup
OutputDir=dist
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "dist\server.exe";          DestDir: "{app}"; Flags: ignoreversion
Source: "dist\inject_hook.exe";     DestDir: "{app}"; Flags: ignoreversion
Source: "dist\content_lookup.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "dist\native\bin\rb_hook.dll"; DestDir: "{app}\native\bin"; Flags: ignoreversion
Source: "dist\public\*";            DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "start-rb.bat";             DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成"; GroupDescription: "追加タスク:"; Flags: unchecked

[Icons]
Name: "{group}\DJLinkForPCDJ";       Filename: "{app}\start-rb.bat"; WorkingDir: "{app}"
Name: "{commondesktop}\DJLinkForPCDJ"; Filename: "{app}\start-rb.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\start-rb.bat"; Description: "DJLinkForPCDJ を起動する"; Flags: postinstall nowait shellexec
