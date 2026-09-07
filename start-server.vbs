' Launches the Comps static server hidden (no console window).
' Double-click this, or drop a shortcut in shell:startup so the pinned app always has its server.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File serve.ps1", 0, False
