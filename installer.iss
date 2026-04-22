[Setup]
AppName=rb-output
AppVersion=1.0.0
AppPublisher=rb-output
DefaultDirName={autopf}\rb-output
DefaultGroupName=rb-output
OutputBaseFilename=rb-output-setup
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
Name: "{group}\rb-output";       Filename: "{app}\start-rb.bat"; WorkingDir: "{app}"
Name: "{commondesktop}\rb-output"; Filename: "{app}\start-rb.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\start-rb.bat"; Description: "rb-output を起動する"; Flags: postinstall nowait shellexec
