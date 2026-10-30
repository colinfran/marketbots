# Installs LibreHardwareMonitor for the host agent (docs/SERVER.md section 11.2). Run once, from an administrator PowerShell:
#
#   .\apps\host-agent\scripts\install-sensors.ps1
#
# Downloads the official v0.9.6 release, checks its published SHA-256, and configures its sensor web server on
# 127.0.0.1:8086 behind a generated password, with a firewall rule blocking remote access to the port (LHM may
# listen on every interface whatever it is told). The login goes to data\lhm.json, readable only by this account,
# SYSTEM and Administrators; it is never printed. Start it with start-sensors.ps1 (or its sign-in task).
param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$AgentDir = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $AgentDir 'data'
$ToolDir = Join-Path $DataDir 'LibreHardwareMonitor'
$Exe = Join-Path $ToolDir 'LibreHardwareMonitor.exe'
$ConfigFile = Join-Path $ToolDir 'LibreHardwareMonitor.config'
$ConnectionFile = Join-Path $DataDir 'lhm.json'
$Port = 8086

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($Identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an administrator PowerShell: it adds a firewall rule.'
}
if (Test-Path $ConnectionFile) { throw "Already installed ($ConnectionFile exists). Use start-sensors.ps1." }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is in use; nothing was installed." }

New-Item -ItemType Directory -Force -Path $ToolDir | Out-Null
& icacls.exe $ToolDir /inheritance:r /grant:r "$($Identity.Name):(OI)(CI)(F)" 'SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the LibreHardwareMonitor folder.' }

$Archive = Join-Path $ToolDir 'LibreHardwareMonitor-v0.9.6.zip'
try {
    Invoke-WebRequest -Uri 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip' -OutFile $Archive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne '086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001') {
        throw 'The release archive failed its SHA-256 check; nothing was installed.'
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $ToolDir -Force
} finally {
    if (Test-Path $Archive) { Remove-Item -LiteralPath $Archive }
}
if (-not (Test-Path $Exe)) { throw 'The archive had no LibreHardwareMonitor.exe.' }

# Block remote access to the port before the listener is configured.
if (-not (Get-NetFirewallRule -Name 'marketbots-host-sensors-block' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'marketbots-host-sensors-block' -DisplayName 'marketbots: block remote LibreHardwareMonitor access' `
        -Direction Inbound -Action Block -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
}

$Bytes = New-Object byte[] 32
$Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
$Password = [Convert]::ToBase64String($Bytes)
$Username = 'host-agent'
$Settings = @{
    listenerIp = '127.0.0.1'
    listenerPort = "$Port"
    authenticationEnabled = 'true'
    authenticationUserName = $Username
    authenticationPassword = $Password
    runWebServerMenuItem = 'true'
    cpuMenuItem = 'true'
    mainboardMenuItem = 'true'
    gpuMenuItem = 'true'
    hddMenuItem = 'true'
    startMinMenuItem = 'true'
    minTrayMenuItem = 'true'
}
$Document = New-Object System.Xml.XmlDocument
if (Test-Path $ConfigFile) { $Document.Load($ConfigFile); $Root = $Document.DocumentElement } else { $Root = $Document.CreateElement('configuration'); [void]$Document.AppendChild($Root) }
$AppSettings = $Root.SelectSingleNode('appSettings')
if (-not $AppSettings) { $AppSettings = $Document.CreateElement('appSettings'); [void]$Root.AppendChild($AppSettings) }
foreach ($Key in $Settings.Keys) {
    $Element = $AppSettings.SelectSingleNode("add[@key='$Key']")
    if (-not $Element) { $Element = $Document.CreateElement('add'); [void]$AppSettings.AppendChild($Element) }
    $Element.SetAttribute('key', $Key)
    $Element.SetAttribute('value', $Settings[$Key])
}
$Document.Save($ConfigFile)

# The connection file: created empty, restricted, then filled.
[IO.File]::Create($ConnectionFile).Dispose()
& icacls.exe $ConnectionFile /inheritance:r /grant:r "$($Identity.Name):(F)" 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the connection file.' }
@{ port = $Port; username = $Username; password = $Password } | ConvertTo-Json | Set-Content -LiteralPath $ConnectionFile -Encoding UTF8

Write-Host "Installed LibreHardwareMonitor v0.9.6 on 127.0.0.1:$Port with a password and a firewall block."
Write-Host 'Approve the PawnIO driver prompt when it first starts. Next: install-tasks.ps1.'
if ($Launch) { & (Join-Path $PSScriptRoot 'start-sensors.ps1') }
