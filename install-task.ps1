# Register a Windows scheduled task that runs publish.ps1 every 6 hours while you are logged in.
# Run once:  powershell -ExecutionPolicy Bypass -File install-task.ps1
# Remove:    Unregister-ScheduledTask -TaskName "Prizewall 130point sync" -Confirm:$false
$script = Join-Path $PSScriptRoot "publish.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
# Four fixed daily times (a repeating "once" trigger does not reliably repeat on Windows 11).
$triggers = @("02:07", "08:07", "14:07", "20:07") | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Prizewall 130point sync" -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Host "Registered 'Prizewall 130point sync' at 02:07, 08:07, 14:07 and 20:07 daily."
