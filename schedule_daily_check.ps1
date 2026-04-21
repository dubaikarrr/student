param(
    [string]$TaskName = "SPOM Seat Checker",
    [string]$DailyTime = "09:00",
    [string]$PythonExe = "python",
    [string]$State = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonScript = Join-Path $ScriptDir "spom_seat_checker.py"
$ReportsDir = Join-Path $ScriptDir "reports"

if (-not (Test-Path -LiteralPath $PythonScript)) {
    throw "Could not find $PythonScript"
}

$Arguments = "`"$PythonScript`" --output-dir `"$ReportsDir`" --stdout"
if ($State) {
    $Arguments += " --state `"$State`""
}

$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument $Arguments -WorkingDirectory $ScriptDir
$Trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($DailyTime, 'HH:mm', $null))
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Checks ICAI SPOM seat availability and writes daily reports." `
    -Force

Write-Host "Scheduled task '$TaskName' created for $DailyTime."
