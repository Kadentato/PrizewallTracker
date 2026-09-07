# Register a Windows scheduled task that runs publish.ps1 every 6 hours while you are logged in.
# Run once:  powershell -ExecutionPolicy Bypass -File install-task.ps1
# Remove:    Unregister-ScheduledTask -TaskName "Prizewall 130point sync" -Confirm:$false
$script = Join-Path $PSScriptRoot "publish.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Prizewall 130point sync" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered 'Prizewall 130point sync' (every 6 hours). First run in ~5 minutes."
