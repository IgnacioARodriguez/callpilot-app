Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
command = "cmd.exe /d /s /c ""cd /d """ & repoDir & """ && npm run desktop:start"""

shell.Run command, 0, False
