$ErrorActionPreference = 'Stop'
# Starts the Boxphone bridge and the agent for this computer. Runs hidden at Windows sign-in.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$Node = Join-Path $Root 'node\node.exe'
$Lab = Join-Path $Root 'lab'
$Logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$env:BOXPHONE_BRIDGE_TOKEN = [string]$Config.bridgeToken
$env:BOXPHONE_PORT = [string]$Config.port
$env:BOXPHONE_REMOTE_URL = [string]$Config.server
$env:BOXPHONE_AGENT_TOKEN = [string]$Config.agentToken
if ($Config.adb) { $env:BOXPHONE_ADB = [string]$Config.adb }

function Start-Part([string]$Script, [string]$Name) {
  $Pattern = [regex]::Escape($Script)
  $Running = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $Pattern }
  if ($Running) { return }
  Start-Process -FilePath $Node -ArgumentList @("`"$Script`"") -WorkingDirectory $Lab -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Logs "$Name.out.log") -RedirectStandardError (Join-Path $Logs "$Name.err.log")
}

Start-Part (Join-Path $Lab 'server.mjs') 'bridge'
Start-Sleep -Seconds 2
Start-Part (Join-Path $Lab 'agent.mjs') 'agent'
