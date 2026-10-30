# Registers the host agent's two scheduled tasks under \marketbots\ (docs/SERVER.md section 11.3). Run from an
# administrator PowerShell, as the account that signs in on the server, after install-sensors.ps1 and once
# .env.host exists and the agent is built (pnpm --filter @mb/host-agent build):
#
#   .\apps\host-agent\scripts\install-tasks.ps1
#
#   Host sensors  LibreHardwareMonitor, elevated, at sign-in (it is a desktop app); restarted if it exits.
#   Host agent    node dist\main.js with .env.host, at startup, without a window (S4U); restarted if it exits.
#                 Before sign-in it runs without the motherboard sensors, and the BIOS runs the fans.
#
# Re-running replaces both tasks. Neither starts here: start them with Start-ScheduledTask (section 11.3).
$ErrorActionPreference = 'Stop'
$AgentDir = Split-Path -Parent $PSScriptRoot
$RepoDir = Split-Path -Parent (Split-Path -Parent $AgentDir)
$EnvFile = Join-Path $RepoDir '.env.host'
$Main = Join-Path $AgentDir 'dist\main.js'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$UserId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an administrator PowerShell.'
}
if (-not (Test-Path $EnvFile)) { throw "Create $EnvFile first (from .env.host.example)." }
if (-not (Test-Path $Main)) { throw 'Build the agent first: pnpm --filter @mb/host-agent build' }
if (-not (Test-Path (Join-Path $AgentDir 'data\lhm.json'))) { throw 'Run install-sensors.ps1 first.' }

$Forever = [TimeSpan]::Zero
$Sensors = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'start-sensors.ps1')`" -Wait" -WorkingDirectory $AgentDir
Register-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host sensors' -Force `
    -Description 'LibreHardwareMonitor for the marketbots host agent (docs/SERVER.md section 11).' `
    -Action $Sensors -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $UserId) `
    -Principal (New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest) `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $Forever -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)) | Out-Null

$Agent = New-ScheduledTaskAction -Execute $Node -Argument "--enable-source-maps --env-file=`"$EnvFile`" `"$Main`"" -WorkingDirectory $AgentDir
$Startup = New-ScheduledTaskTrigger -AtStartup
$Startup.Delay = 'PT30S'
Register-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent' -Force `
    -Description 'The marketbots host agent: Admin > Server and the motherboard fans (docs/SERVER.md section 11).' `
    -Action $Agent -Trigger $Startup `
    -Principal (New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited) `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $Forever -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)) | Out-Null

Write-Host "Registered \marketbots\Host sensors (at sign-in, elevated) and \marketbots\Host agent (at startup, no window) for $UserId."
Write-Host "Start them: Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host sensors'; Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Host agent'"
