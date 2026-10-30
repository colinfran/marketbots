# Starts the host agent's LibreHardwareMonitor elevated, minimized (docs/SERVER.md section 11). Run by the "Host sensors"
# sign-in task with -Wait; by hand from any PowerShell (it asks for elevation when it isn't elevated).
#
# LibreHardwareMonitor 0.9.6 saves a hash of its web password on exit but reads the setting as plain text on the
# next start, so the password is put back from data\lhm.json before every start. If it already runs and answers
# with the right login, nothing happens.
param([switch]$Wait)
$ErrorActionPreference = 'Stop'
$AgentDir = Split-Path -Parent $PSScriptRoot
$ToolDir = Join-Path $AgentDir 'data\LibreHardwareMonitor'
$Exe = Join-Path $ToolDir 'LibreHardwareMonitor.exe'
$ConfigFile = Join-Path $ToolDir 'LibreHardwareMonitor.config'
$ConnectionFile = Join-Path $AgentDir 'data\lhm.json'
if (-not (Test-Path $Exe) -or -not (Test-Path $ConnectionFile)) { throw 'Run install-sensors.ps1 as administrator first.' }

$Connection = Get-Content -LiteralPath $ConnectionFile -Raw | ConvertFrom-Json
if (-not ($Connection.port -is [int]) -or [string]::IsNullOrWhiteSpace($Connection.username) -or [string]::IsNullOrWhiteSpace($Connection.password)) {
    throw "Invalid connection file $ConnectionFile."
}

$IsAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Exe })
if ($Running) {
    $Auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($Connection.username):$($Connection.password)"))
    $Ok = $false
    $Unauthorized = $false
    for ($i = 0; $i -lt 5 -and -not $Ok -and -not $Unauthorized; $i++) {
        try {
            $Ok = (Invoke-WebRequest -Uri "http://127.0.0.1:$($Connection.port)/data.json" -Headers @{ Authorization = "Basic $Auth" } -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
        } catch [Net.WebException] {
            $Unauthorized = $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401
            if (-not $Unauthorized) { Start-Sleep -Milliseconds 500 }
        }
    }
    if ($Ok) {
        Write-Host 'LibreHardwareMonitor is already running and answering.'
        if ($Wait) { $Running | ForEach-Object { Wait-Process -Id $_.ProcessId } }
        exit 0
    }
    if (-not $Unauthorized) { throw 'LibreHardwareMonitor is running but its sensor server is not answering.' }
    if (-not $IsAdmin) { throw 'LibreHardwareMonitor runs with a stale password: run this as administrator to restart it.' }
    foreach ($P in $Running) {
        Stop-Process -Id $P.ProcessId
        Wait-Process -Id $P.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
}

$Document = New-Object System.Xml.XmlDocument
$Document.Load($ConfigFile)
$AppSettings = $Document.DocumentElement.SelectSingleNode('appSettings')
if (-not $AppSettings) { throw 'The LibreHardwareMonitor config has no appSettings.' }
$Required = @{ authenticationEnabled = 'true'; authenticationUserName = $Connection.username; authenticationPassword = $Connection.password; listenerIp = '127.0.0.1'; listenerPort = "$($Connection.port)" }
$Changed = $false
foreach ($Key in $Required.Keys) {
    $Element = $AppSettings.SelectSingleNode("add[@key='$Key']")
    if (-not $Element) { $Element = $Document.CreateElement('add'); $Element.SetAttribute('key', $Key); [void]$AppSettings.AppendChild($Element) }
    if ($Element.GetAttribute('value') -cne $Required[$Key]) { $Element.SetAttribute('value', $Required[$Key]); $Changed = $true }
}
if ($Changed) {
    $Tmp = "$ConfigFile.tmp"
    try {
        $WriterSettings = New-Object System.Xml.XmlWriterSettings
        $WriterSettings.Encoding = New-Object System.Text.UTF8Encoding($false)
        $WriterSettings.Indent = $true
        $Writer = [System.Xml.XmlWriter]::Create($Tmp, $WriterSettings)
        try { $Document.Save($Writer) } finally { $Writer.Dispose() }
        Move-Item -LiteralPath $Tmp -Destination $ConfigFile -Force
    } finally {
        if (Test-Path $Tmp) { Remove-Item -LiteralPath $Tmp -Force }
    }
}

if ($IsAdmin) {
    $Process = Start-Process -FilePath $Exe -WorkingDirectory $ToolDir -WindowStyle Minimized -PassThru
} else {
    $Process = Start-Process -FilePath $Exe -WorkingDirectory $ToolDir -Verb RunAs -WindowStyle Minimized -PassThru
}
Write-Host 'LibreHardwareMonitor started. Approve the PawnIO driver prompt if one appears.'
if ($Wait) {
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) { throw "LibreHardwareMonitor exited with code $($Process.ExitCode)." }
}
