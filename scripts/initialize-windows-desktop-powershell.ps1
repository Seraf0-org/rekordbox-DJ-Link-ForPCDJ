# Shared fail-closed launcher boundary for Windows-native packaging scripts.
# Git Bash can preserve a pwsh 7-first PSModulePath into powershell.exe,
# making Windows PowerShell resolve incompatible Core modules (or no command).
# Every consumer must therefore require the Desktop host and accept only the
# inbox command identities below; caller-provided modules, aliases, duplicate
# command resolution, and fallback paths are rejected.
function Initialize-WindowsDesktopPowerShellBuildEnvironment {
  if ($PSVersionTable.PSEdition -cne "Desktop") {
    throw "Windows-native build scripts require Windows PowerShell Desktop; got PSEdition '$($PSVersionTable.PSEdition)'"
  }

  # Set the process module path before requesting any module-provided command.
  # The path is intentionally only this host's inbox module directory.
  $nativeModuleDirectory = "$PSHOME\Modules"
  $env:PSModulePath = $nativeModuleDirectory
  if (-not [System.IO.Directory]::Exists($nativeModuleDirectory)) {
    throw "Windows PowerShell inbox module directory is missing: $nativeModuleDirectory"
  }

  $requiredCommands = @(
    [pscustomobject]@{ Name = "Get-FileHash"; Source = "Microsoft.PowerShell.Utility"; CommandType = "Function" }
    [pscustomobject]@{ Name = "Get-AuthenticodeSignature"; Source = "Microsoft.PowerShell.Security"; CommandType = "Cmdlet" }
    [pscustomobject]@{ Name = "Compress-Archive"; Source = "Microsoft.PowerShell.Archive"; CommandType = "Function" }
  )
  foreach ($requiredCommand in $requiredCommands) {
    $commandInfos = @(Get-Command -Name $requiredCommand.Name -All -ErrorAction SilentlyContinue)
    $commandInfo = if ($commandInfos.Count -eq 1) { $commandInfos[0] } else { $null }
    if ($null -eq $commandInfo -or $commandInfo.Source -cne $requiredCommand.Source -or [string]$commandInfo.CommandType -cne $requiredCommand.CommandType) {
      $actualSource = if ($commandInfos.Count -eq 0) { "missing" } else { ($commandInfos | ForEach-Object { "$($_.CommandType):$($_.Source)" }) -join "," }
      throw "Windows PowerShell inbox command '$($requiredCommand.Name)' must resolve exactly once as '$($requiredCommand.CommandType):$($requiredCommand.Source)', got '$actualSource'"
    }
  }
}
