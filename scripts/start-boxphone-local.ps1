param([switch]$NoBrowser)
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
foreach ($taskCandidate in @("$env:ProgramFiles\nodejs\node.exe", 'C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')) {
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
Write-Host 'Boxphone is ready. Open Live Hub > Boxphone.'
Write-Host 'If the menu reports disabled, run: docker compose up -d --no-deps web'
if (!$NoBrowser) { Start-Process 'http://localhost:3100/boxphone' }
