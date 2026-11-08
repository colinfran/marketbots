# Sets up the dashboards' automatic deploys (docs/SERVER.md section 8). Run once from an administrator
# PowerShell, as the account that signs in on the server, from anywhere:
#
#   .\docker\web\install-autodeploy.ps1
#
#   Web deploy   the task: node docker\web\autodeploy.mjs, on demand only, without a window (S4U),
#                one run at a time (a run asked for meanwhile waits its turn)
#   hooks        git config core.hooksPath .githooks in this clone: post-commit and post-merge on
#                main start the task
#
# Re-running replaces the task. To pause automatic deploys: Disable-ScheduledTask -TaskPath '\marketbots\'
# -TaskName 'Web deploy' (Enable-ScheduledTask to resume); the hooks then only say they couldn't start it.
$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Script = Join-Path $PSScriptRoot 'autodeploy.mjs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$UserId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an administrator PowerShell.'
}
if (-not (Test-Path (Join-Path $RepoDir '.env'))) { throw "Create $(Join-Path $RepoDir '.env') first (from .env.example)." }

$Action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`"" -WorkingDirectory $RepoDir
Register-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Web deploy' -Force `
    -Description 'Deploys the marketbots dashboards from main (started by the repo''s git hooks; docs/SERVER.md section 8).' `
    -Action $Action `
    -Principal (New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited) `
    -Settings (New-ScheduledTaskSettingsSet -MultipleInstances Queue -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)) | Out-Null

# The hooks run in whatever shell made the commit, elevated or not: let the account start the task
# (read and execute), not only read it, which is all a task registered from an elevated shell allows.
$Sid = ([Security.Principal.NTAccount]$UserId).Translate([Security.Principal.SecurityIdentifier]).Value
$Scheduler = New-Object -ComObject Schedule.Service
$Scheduler.Connect()
$Task = $Scheduler.GetFolder('\marketbots').GetTask('Web deploy')
$Sddl = $Task.GetSecurityDescriptor(0xF) -replace "\(A;;FR;;;$Sid\)", ''
$Task.SetSecurityDescriptor($Sddl + "(A;;FRFX;;;$Sid)", 0)

git -C $RepoDir config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git config core.hooksPath failed' }

Write-Host "Registered \marketbots\Web deploy (on demand, no window) for $UserId, and set core.hooksPath=.githooks in $RepoDir."
Write-Host "A commit on main now deploys the dashboards. Run it now: Start-ScheduledTask -TaskPath '\marketbots\' -TaskName 'Web deploy'"
