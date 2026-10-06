param([string]$RemoteUrl = 'https://ggz24livehub.34-21-142-197.sslip.io/live')
# Run this yourself in PowerShell on the computer that holds the phones, AFTER the server has been set up.
# It asks for the agent token (hidden input), saves it in the ignored .env, starts the agent and installs autostart.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envFile = Join-Path $root '.env'
if (!(Test-Path -LiteralPath $envFile)) { throw 'Create the Live Hub .env first.' }
if ($RemoteUrl -notmatch '^https://[^/\s?#@]+(/[A-Za-z0-9._~/-]*)?$') { throw 'RemoteUrl must be an https URL without credentials.' }
$secure = Read-Host 'Paste the BOXPHONE_AGENT_TOKEN printed on the server (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$token = $token.Trim()
if ($token -notmatch '^[0-9a-f]{64}$') { throw 'The token must be the 64 hex characters printed by the server command.' }
$lines = @([IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch '^BOXPHONE_(REMOTE|REMOTE_URL|AGENT_TOKEN)=' })
$lines += @("BOXPHONE_REMOTE_URL=$RemoteUrl", "BOXPHONE_AGENT_TOKEN=$token")
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
$token = $null
# Restart the agent so it picks up the new settings.
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'boxphone-lab[\\/]agent\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
Push-Location $root
try {
  # The local web page talks to the bridge directly again (not through the hosted relay).
  docker compose up -d --no-deps web | Out-Null
  & (Join-Path $PSScriptRoot 'start-boxphone-local.ps1') -NoBrowser -InstallAutostart
} finally { Pop-Location }
Start-Sleep -Seconds 8
$log = Join-Path $root 'work\boxphone-agent.out.log'
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 3 }
Write-Host ''
Write-Host "Done. Open $($RemoteUrl -replace '/live$','')/live/boxphone while signed in; it should show your phones within about 10 seconds."
