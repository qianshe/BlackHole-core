; Per-user Windows x64 offline Desktop. Never packages or deletes user/Core data.
; Invoke only through the reviewed packager with a verified, fresh StageRoot.
#ifndef StageRoot
  #error StageRoot is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef BuildEnvironment
  #error BuildEnvironment is required
#endif
#if BuildEnvironment == "test"
  #define ProductId "StellarBridge.BlackHole.Desktop.Test"
  #define ProductName "BlackHole Desktop (Test)"
  #define ProductDirectory "BlackHole Desktop Test"
#else
  #if BuildEnvironment != "production"
    #error BuildEnvironment must be test or production
  #endif
  #define ProductId "StellarBridge.BlackHole.Desktop"
  #define ProductName "BlackHole Desktop"
  #define ProductDirectory "BlackHole Desktop"
#endif

[Setup]
AppId={#ProductId}
AppName={#ProductName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\{#ProductDirectory}
; First install can choose a directory; an upgrade keeps the previous AppId path.
DisableDirPage=auto
UsePreviousAppDir=yes
UsePreviousTasks=yes
DefaultGroupName={#ProductName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UninstallDisplayIcon={app}\blackhole.exe
LicenseFile={#StageRoot}\LICENSE.txt
OutputDir={#StageRoot}\installer
OutputBaseFilename=BlackHole-Desktop-{#AppVersion}-{#BuildEnvironment}-unsigned-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Do not terminate native windows/daemons as an implicit upgrade policy.
CloseApplications=no
RestartApplications=no
DisableProgramGroupPage=yes
; Refuse overwriting a live Desktop window/tray. This mutex is owned only by
; the native shell, not the independently running Shared Core/VS Code process.
#if BuildEnvironment == "test"
AppMutex=Local\BlackHoleDesktopTestInstall,Local\BlackHoleTray-7306,Local\BlackHoleTray-17306
#else
AppMutex=Local\BlackHoleDesktopInstall,Local\BlackHoleTray-7306
#endif

[Files]
; Embedded installer-only helper; extracted to {tmp}, never installed as app code.
Source: "{#StageRoot}\installer-preflight-cli.cjs"; Flags: dontcopy
Source: "{#StageRoot}\blackhole.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageRoot}\bootstrap\node.exe"; DestDir: "{app}\bootstrap"; Flags: ignoreversion
Source: "{#StageRoot}\bootstrap\node-LICENSE"; DestDir: "{app}\bootstrap"; Flags: ignoreversion
Source: "{#StageRoot}\bootstrap\core-manager-cli.mjs"; DestDir: "{app}\bootstrap"; Flags: ignoreversion
Source: "{#StageRoot}\bootstrap\trust.json"; DestDir: "{app}\bootstrap"; Flags: ignoreversion
Source: "{#StageRoot}\seed\core.zip"; DestDir: "{app}\seed"; Flags: ignoreversion
Source: "{#StageRoot}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageRoot}\NOTICE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
; Enabled by default on first install; preserve the user's choice on upgrades.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Icons]
Name: "{autoprograms}\{#ProductName}"; Filename: "{app}\blackhole.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\BlackHole"; Filename: "{app}\blackhole.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\blackhole.exe"; Description: "Launch {#ProductName}"; Flags: nowait postinstall skipifsilent

[Code]
// Explicitly reject manual/older installers before any files are replaced.
// Online releases also enforce monotonic versions, but an old setup.exe can
// be launched directly outside the updater, so the installer needs a gate.
function InitializeSetup(): Boolean;
var
  OldVersion: String;
  OldPacked, NewPacked: Int64;
begin
  Result := False;
  if not StrToVersion('{#AppVersion}', NewPacked) then
    RaiseException('Invalid package version. Installation cancelled.');
  if RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#ProductId}_is1',
    'DisplayVersion', OldVersion) then begin
    if not StrToVersion(OldVersion, OldPacked) then
      RaiseException('Installed version cannot be verified. Repair or migrate explicitly; no files were replaced.');
    if ComparePackedVersion(OldPacked, NewPacked) > 0 then
      RaiseException('An older BlackHole version cannot overwrite a newer installation. No files were replaced.');
  end;
  // Older Desktop test builds may lack the new installation mutex. Block a
  // known native window before copying shell files; do not close it forcibly.
  if FindWindowByWindowName('BlackHole · 7306') <> 0 then
    RaiseException('BlackHole window is open. Close it normally before installing; no files were replaced.');
#if BuildEnvironment == "test"
  // Detect pre-unification Test shells only; 17306 is not a default anymore.
  if FindWindowByWindowName('BlackHole · 17306') <> 0 then
    RaiseException('An older BlackHole Test window is open. Close it normally before installing; no files were replaced.');
#endif
  Result := True;
end;

// Installation files and mutable Core/database files must never share a root.
// Reject a user-selected path underneath either existing application-data root,
// including silent installs that have no Select Directory page.
function IsInsideFolder(const Destination, Root: String): Boolean;
var
  Chosen, DataRoot: String;
begin
  Chosen := AddBackslash(ExpandFileName(Destination));
  DataRoot := AddBackslash(ExpandFileName(Root));
  Result := CompareText(Copy(Chosen, 1, Length(DataRoot)), DataRoot) = 0;
end;

// Return on the Preparing page BEFORE copying application files. This
// conservative gate never closes VS Code, stops a daemon or deletes journals.
// Postinstall Manager checks are still mandatory (preflight is not a lock).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Result := '';
  if (GetEnv('USERPROFILE') = '') or (GetEnv('NODE_OPTIONS') <> '') or
     (GetEnv('NODE_PATH') <> '') or (GetEnv('ELECTRON_RUN_AS_NODE') <> '') then begin
    Result := '无法安全确认运行环境。请移除 Node 注入环境变量后重试。尚未复制程序文件。';
    Exit;
  end;
  try
    ExtractTemporaryFile('node.exe');
    ExtractTemporaryFile('installer-preflight-cli.cjs');
    if not Exec(ExpandConstant('{tmp}\node.exe'), '"' + ExpandConstant('{tmp}\installer-preflight-cli.cjs') + '"', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then begin
      Result := '无法运行安装前检查。尚未复制程序文件；没有停止服务或修改数据库。';
      Exit;
    end;
    case Code of
      0: Result := '';
      40: Result := 'BlackHole Core 仍在运行。请先完成活动任务并通过应用正常停止后台，再重试安装。';
      41: Result := '旧版 BlackHole（例如 VS Code 中的 200 版）仍在使用原数据库。请正常退出旧实例，不能同时启用两个 Core。';
      42: Result := '仍有客户端占用共享 Core。请关闭相关 BlackHole 窗口或 VS Code 客户端，再重试。';
      43: Result := '存在未完成的启动或维护记录。请先检查恢复状态；不要手动删除记录或强杀进程。';
      44: Result := '无法验证 .blackhole 的路径或维护记录。请检查配置，安装没有改变原数据。';
      45: Result := '无法确认本地服务是否停止（端口响应未知）。请检查运行状态后重试。';
    else
      Result := '安装前检查未通过。请保留日志，不要反复强制安装。';
    end;
    if Result <> '' then Result := Result + #13#10#13#10 + '尚未复制新版程序文件。没有停止任何进程，也没有修改原数据库。';
  except
    Result := '无法加载安装前检查组件。尚未复制新版程序文件；请重新获取经过验证的安装包。';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer;
begin
  if CurStep = ssInstall then begin
    if GetEnv('USERPROFILE') = '' then
      RaiseException('Cannot verify the existing user data location. No program files were installed.');
    if IsInsideFolder(ExpandConstant('{app}'), AddBackslash(GetEnv('USERPROFILE')) + '.blackhole') or
       IsInsideFolder(ExpandConstant('{app}'), ExpandConstant('{localappdata}\BlackHole')) or
       IsInsideFolder(ExpandConstant('{app}'), ExpandConstant('{localappdata}\BlackHole-Test')) then
      RaiseException('Choose an application directory outside BlackHole Core and user data. No program files were installed.');
  end;
  if CurStep = ssPostInstall then begin
    // Provision the bundled signed Core and upgrade through Manager's guarded
    // transaction. --provision-only would otherwise reuse the older Core.
    if not Exec(ExpandConstant('{app}\blackhole.exe'), '--apply-bundled-core --print', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then
      RaiseException('Bundled Core activation could not run. Existing Core/data are preserved.');
    if Code <> 0 then
      RaiseException('Bundled Core upgrade was not completed. Existing Core/data are preserved. Close other clients, inspect Manager state, then retry without forcing a process stop.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Current, Expected: String;
begin
  if ('{#BuildEnvironment}' = 'production') and (CurUninstallStep = usUninstall) then begin
    Expected := '"' + ExpandConstant('{app}\blackhole.exe') + '" --tray';
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'BlackHole', Current) then
      if CompareText(Current, Expected) = 0 then
        RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'BlackHole');
  end;
end;

// No Core cleanup, registry-wide deletion or daemon Stop.
// Inno removes only tracked shell/bootstrap/Seed files and its own shortcut.
