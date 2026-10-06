param([switch]$NoBrowser, [switch]$InstallAutostart)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskEnv = Join-Path $taskRoot '.env'
if (!(Test-Path -LiteralPath $taskEnv)) { throw 'Create the Live Hub .env first.' }
$taskLines = [IO.File]::ReadAllLines($taskEnv)
$taskTokenLine = $taskLines | Where-Object { $_ -match '^BOXPHONE_BRIDGE_TOKEN=.{32,}$' } | Select-Object -First 1
if (!$taskTokenLine) {
  $taskRandom = New-Object byte[] 32
  $taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $taskRng.GetBytes($taskRandom); $taskRng.Dispose()
  $taskToken = ([BitConverter]::ToString($taskRandom)).Replace('-', '').ToLowerInvariant()
} else { $taskToken = $taskTokenLine.Substring('BOXPHONE_BRIDGE_TOKEN='.Length) }
$taskLines = @($taskLines | Where-Object { $_ -notmatch '^BOXPHONE_(ENABLED|BRIDGE_TOKEN|PORT)=' })
$taskLines += @('BOXPHONE_ENABLED=true', "BOXPHONE_BRIDGE_TOKEN=$taskToken", 'BOXPHONE_PORT=8767')
[IO.File]::WriteAllLines($taskEnv, $taskLines, (New-Object Text.UTF8Encoding($false)))
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$taskNodePath = if ($taskNodeCommand) { $taskNodeCommand.Source } else { $null }
foreach ($taskCandidate in @((Join-Path $taskRoot '.runtime\node.exe'), "$env:ProgramFiles\nodejs\node.exe", 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')) {
  if (!$taskNodePath -and (Test-Path -LiteralPath $taskCandidate)) { $taskNodePath = $taskCandidate }
}
if (!$taskNodePath) { throw 'Node.js 22 or later is required.' }
$taskHeaders = @{ 'x-boxphone-bridge-token' = $taskToken }
$taskReady = $false
try { $taskReady = (Invoke-RestMethod 'http://127.0.0.1:8767/health' -Headers $taskHeaders -TimeoutSec 2).app -eq 'boxphone-lab' } catch {}
if (!$taskReady) {
  $taskWork = Join-Path $taskRoot 'work'
  New-Item -ItemType Directory -Force -Path $taskWork | Out-Null
  $taskServer = Join-Path $taskRoot 'tools\boxphone-lab\server.mjs'
  $taskProcess = Start-Process -FilePath $taskNodePath -ArgumentList @("--env-file=`"$taskEnv`"", "`"$taskServer`"") -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskWork 'boxphone.out.log') -RedirectStandardError (Join-Path $taskWork 'boxphone.err.log')
  for ($taskAttempt = 0; $taskAttempt -lt 25; $taskAttempt++) {
    Start-Sleep -Milliseconds 200
    if ($taskProcess.HasExited) { throw 'Boxphone stopped. Check work/boxphone.err.log.' }
    try { $taskReady = (Invoke-RestMethod 'http://127.0.0.1:8767/health' -Headers $taskHeaders -TimeoutSec 1).app -eq 'boxphone-lab'; if ($taskReady) { break } } catch {}
  }
  if (!$taskReady) { throw 'Boxphone did not become ready.' }
}

# Hosted Live Hub (ggz24.com/live): connect OUT to it so its Boxphone page can use the phones on this computer.
$taskRemote = ($taskLines | Where-Object { $_ -match '^BOXPHONE_REMOTE_URL=.+$' } | Select-Object -First 1)
$taskAgentLine = ($taskLines | Where-Object { $_ -match '^BOXPHONE_AGENT_TOKEN=.{32,}$' } | Select-Object -First 1)
if ($taskRemote -and $taskAgentLine) {
  $taskRunning = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'boxphone-lab[\\/]agent\.mjs' }
  if (!$taskRunning) {
    $taskWork = Join-Path $taskRoot 'work'
    New-Item -ItemType Directory -Force -Path $taskWork | Out-Null
    $taskAgent = Join-Path $taskRoot 'tools\boxphone-lab\agent.mjs'
    Start-Process -FilePath $taskNodePath -ArgumentList @("--env-file=`"$taskEnv`"", "`"$taskAgent`"") -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskWork 'boxphone-agent.out.log') -RedirectStandardError (Join-Path $taskWork 'boxphone-agent.err.log') | Out-Null
  }
  Write-Host 'Hosted Live Hub connection is running.'
}
if ($InstallAutostart) {
  $taskStartup = [Environment]::GetFolderPath('Startup')
  $taskShell = New-Object -ComObject WScript.Shell
  $taskLink = $taskShell.CreateShortcut((Join-Path $taskStartup 'LiveHub-Boxphone.lnk'))
  $taskLink.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $taskLink.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -NoBrowser"
  $taskLink.WorkingDirectory = $taskRoot
  $taskLink.Save()
  Write-Host 'Boxphone will start automatically when you sign in to Windows.'
}
Write-Host 'Boxphone is ready. Open Live Hub > Boxphone.'
Write-Host 'If the menu reports disabled, run: docker compose up -d --no-deps web'
if (!$NoBrowser) { Start-Process 'http://localhost:3100/boxphone' }
