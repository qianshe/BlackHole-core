# Explicit opt-in, repository-local tooling only. Never runs a BlackHole installer.
# Reviewed upstream tag is-6_7_3: setup.iss + isportable.iss. Portable mode disables
# uninstall registration, file associations and shortcuts; silent mode skips IDE.
param([switch]$ApprovedPortableTools)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ApprovedPortableTools) { throw 'Explicit approval for portable tooling is required.' }
if (-not $IsWindows) { throw 'Windows is required.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = Join-Path $repo '.tmp\toolchains\inno-6.7.3'
if (Test-Path $root) { throw "toolchain_target_exists_inspect_first:$root" }
$download = Join-Path $root 'innosetup-6.7.3.exe'
$tools = Join-Path $root 'compiler'
$log = Join-Path $root 'portable-prepare.log'
$url = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
$expectedHash = '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'
New-Item -ItemType Directory -Path $root | Out-Null
Invoke-WebRequest -Uri $url -OutFile $download -TimeoutSec 90 -MaximumRedirection 5
$hash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $expectedHash) { throw 'inno_download_hash_mismatch' }
$signature = Get-AuthenticodeSignature -LiteralPath $download
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Pyrsys B.V.') { throw "inno_signature_not_trusted:$($signature.Status)" }

function Get-RegistrationFingerprint {
  $result = [ordered]@{}
  foreach ($hive in @('HKCU','HKLM')) {
    foreach ($subkey in @('Software\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1','Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1','Software\Classes\.iss','Software\Classes\InnoSetupScriptFile')) {
      $location = "${hive}:\$subkey"
      if (-not (Test-Path -LiteralPath $location)) { $result[$location] = 'absent'; continue }
      $key = Get-Item -LiteralPath $location
      try {
        $values = [ordered]@{}
        foreach ($name in @($key.GetValueNames() | Sort-Object)) { $values[$name] = @($key.GetValueKind($name).ToString(), $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) }
        $bytes = [Text.Encoding]::UTF8.GetBytes(($values | ConvertTo-Json -Depth 10 -Compress))
        $result[$location] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
      } finally { $key.Close() }
    }
  }
  return ($result | ConvertTo-Json -Compress)
}
$before = Get-RegistrationFingerprint
$temp = Join-Path $root 'temp'
$profile = Join-Path $root 'profile'
New-Item -ItemType Directory -Path $temp,$profile | Out-Null
$start = [Diagnostics.ProcessStartInfo]::new($download)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $root
foreach ($argument in @('/PORTABLE=1','/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/SP-','/NORESTART','/NOICONS','/TASKS=','/NOCLOSEAPPLICATIONS','/NORESTARTAPPLICATIONS',"/DIR=$tools","/LOG=$log")) { $start.ArgumentList.Add($argument) }
$start.Environment['TEMP'] = $temp
$start.Environment['TMP'] = $temp
$start.Environment['HOME'] = $profile
$start.Environment['USERPROFILE'] = $profile
$start.Environment['LOCALAPPDATA'] = (Join-Path $profile 'AppData\Local')
$start.Environment['APPDATA'] = (Join-Path $profile 'AppData\Roaming')
$process = [Diagnostics.Process]::Start($start)
if (-not $process.WaitForExit(120000)) { throw "portable_prepare_outcome_unknown:pid=$($process.Id); inspect $log; do not repeat" }
if ($process.ExitCode -ne 0) { throw "portable_prepare_failed:$($process.ExitCode); inspect $log" }
$after = Get-RegistrationFingerprint
if ($before -ne $after) { throw 'registration_scope_changed_review_required_no_automatic_restore' }
if (Test-Path (Join-Path $tools 'unins000.exe')) { throw 'unexpected_toolchain_uninstaller' }
$compiler = Join-Path $tools 'ISCC.exe'
$compilerSignature = Get-AuthenticodeSignature -LiteralPath $compiler
if ($compilerSignature.Status -ne 'Valid' -or $compilerSignature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Pyrsys B.V.') { throw 'inno_compiler_signature_invalid' }
$receipt = [ordered]@{
  kind='repository-local-portable-toolchain'; version='6.7.3'; source=$url;
  sourceSha256=$hash; sourceSignature=$signature.Status.ToString(); publisher=$signature.SignerCertificate.Subject;
  compiler=$compiler; compilerSha256=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant(); compilerSignature=$compilerSignature.Status.ToString();
  registrationsUnchanged=$true; uninstallerCreated=$false; desktopInstallerExecuted=$false;
  portableMode=$true; systemInstallation=$false; preparedAt=[DateTime]::UtcNow.ToString('o')
}
$json = $receipt | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $root 'toolchain-receipt.json'), $json + "`n", [Text.UTF8Encoding]::new($false))
Write-Output $json
