$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Server = '__SERVER__'
$Code = '__CODE__'
$NodeVersion = '22.14.0'

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host 'Live Hub Boxphone - connect this computer' -ForegroundColor Green
  # BOXPHONE_SETUP_ROOT and BOXPHONE_SETUP_DRYRUN exist so the installer can be tested without touching a real install.
  $Root = if ($env:BOXPHONE_SETUP_ROOT) { $env:BOXPHONE_SETUP_ROOT } else { Join-Path $env:LOCALAPPDATA 'LiveHubBoxphone' }
  $Lab = Join-Path $Root 'lab'
  $NodeDir = Join-Path $Root 'node'
  $Headers = @{ 'x-pairing-code' = $Code }
  New-Item -ItemType Directory -Force -Path $Root, $Lab, (Join-Path $Root 'logs') | Out-Null

  Step 'Stopping any older copy'
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" -and $_.Name -eq 'node.exe' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1

  Step 'Reading what to install from your Live Hub'
  $Manifest = Invoke-RestMethod -Uri "$Server/api/boxphone-agent/package" -Headers $Headers

  Step 'Getting Node.js (runs the connector)'
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
    $Zip = Join-Path $env:TEMP 'boxphone-node.zip'
    if ($Manifest.node) {
      Invoke-WebRequest -Uri "$Server/api/boxphone-agent/node" -Headers $Headers -OutFile $Zip
      if ((Get-Sha256 $Zip) -ne $Manifest.node.sha256) { throw 'Node package checksum does not match.' }
    } else {
      $File = "node-v$NodeVersion-win-x64.zip"
      Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$File" -OutFile $Zip
      $Sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content -split "`n"
      $Expected = (($Sums | Where-Object { $_ -match [regex]::Escape($File) + '\s*$' } | Select-Object -First 1) -split '\s+')[0]
      if (-not $Expected -or (Get-Sha256 $Zip) -ne $Expected.ToLowerInvariant()) { throw 'Node download checksum does not match nodejs.org.' }
    }
    $Temp = Join-Path $env:TEMP 'boxphone-node'
    if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
    Expand-Archive -LiteralPath $Zip -DestinationPath $Temp
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item -LiteralPath (Get-ChildItem $Temp -Directory | Select-Object -First 1).FullName -Destination $NodeDir
    Remove-Item -Recurse -Force $Temp, $Zip
  }

  Step 'Downloading the connector files'
  foreach ($F in $Manifest.files) {
    $Target = if ($F.name -eq 'run.ps1') { Join-Path $Root 'run.ps1' } else { Join-Path $Lab $F.name }
    Invoke-WebRequest -Uri ("$Server/api/boxphone-agent/file?name=" + [uri]::EscapeDataString($F.name)) -Headers $Headers -OutFile $Target
    if ((Get-Sha256 $Target) -ne $F.sha256) { throw "Checksum mismatch for $($F.name)." }
  }

  Step 'Looking for Xiaowei / ADB'
  $Adb = @(
    $env:BOXPHONE_ADB,
    "${env:ProgramFiles(x86)}\xiaowei\tools\adb.exe",
    "$env:ProgramFiles\xiaowei\tools\adb.exe",
    ((Get-Command adb.exe -ErrorAction SilentlyContinue).Source)
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($Adb) { Write-Host "Found: $Adb" } else { Write-Host 'ADB not found. Install Xiaowei on this computer; the connector will find it after you restart it.' -ForegroundColor Yellow }

  Step 'Pairing this computer with your Live Hub'
  $Body = @{ code = $Code; name = $env:COMPUTERNAME } | ConvertTo-Json
  $Paired = Invoke-RestMethod -Method Post -Uri "$Server/api/boxphone-agent/pair" -ContentType 'application/json' -Body $Body
  if (-not $Paired.token) { throw 'Pairing was refused.' }

  Step 'Saving settings (private to your Windows account)'
  $Bytes = New-Object byte[] 32
  $Rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $Rng.GetBytes($Bytes); $Rng.Dispose()
  $BridgeToken = ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
  $Config = [ordered]@{ server = $Server; agentToken = $Paired.token; bridgeToken = $BridgeToken; port = 8767; adb = $Adb }
  $ConfigPath = Join-Path $Root 'config.json'
  [IO.File]::WriteAllText($ConfigPath, ($Config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  icacls $ConfigPath /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null

  if (-not $env:BOXPHONE_SETUP_DRYRUN) {
  Step 'Starting automatically when you sign in to Windows'
  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'LiveHub-Boxphone.lnk'))
  $Link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Root 'run.ps1')`""
  $Link.WorkingDirectory = $Root
  $Link.Save()

  Step 'Starting now'
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Join-Path $Root 'run.ps1'))
  }

  Write-Host ''
  Write-Host "Done. This computer is now '$($Paired.name)' in Live Hub." -ForegroundColor Green
  Write-Host 'Open Live Hub > Boxphone: your phones appear within about 10 seconds.'
  Write-Host 'Keep this computer on and the phones connected to Xiaowei.'
} catch {
  Write-Host ''
  Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Make sure the pairing code on the web page is still valid (10 minutes) and try again with a new code.'
}
