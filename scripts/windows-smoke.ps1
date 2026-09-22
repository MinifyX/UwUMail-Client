# Puts a freshly built Windows setup through its paces on a CI runner: silent install, start
# UwUMail, update over the running app, refuse an older version, open the setup window, uninstall.
# The counterpart of scripts/desktop-smoke.sh for macOS and Linux.
#
# Usage: pwsh scripts/windows-smoke.ps1 <setup .exe> <version> <arch: x64|arm64> <evidence folder>
#
# Windows' known folders can't be moved to a throwaway profile the way $HOME can, so this installs
# for the runner's user, as a real install would. Only run it on a runner that is thrown away.
param(
  [Parameter(Mandatory)][string]$Setup,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][ValidateSet("x64", "arm64")][string]$Arch,
  [Parameter(Mandatory)][string]$Evidence
)

$ErrorActionPreference = "Stop"
$Setup = (Resolve-Path $Setup).Path
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path

function Step($text) { Write-Host ""; Write-Host "▸ $text" }
function Fail($text) { Write-Host "::error::$text"; exit 1 }
function Check([scriptblock]$test, [string]$text) {
  if (-not (& $test)) { Fail $text }
  Write-Host "  ✓ $text"
}

# The machine a program is built for, from its PE header: 0x8664 is x64, 0xAA64 is ARM64.
function Machine([string]$file) {
  $bytes = [IO.File]::ReadAllBytes($file)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  [BitConverter]::ToUInt16($bytes, $pe + 4)
}
$expectedMachine = @{ x64 = 0x8664; arm64 = 0xAA64 }[$Arch]

# Runs the setup (a windowed program, so it has to be waited for) and returns its exit code.
$runs = 0
function Run-Setup([string[]]$arguments, [int]$seconds = 300) {
  $script:runs++
  $log = Join-Path $Evidence "setup-$script:runs"
  $process = Start-Process -FilePath $Setup -ArgumentList $arguments -PassThru -NoNewWindow `
    -RedirectStandardOutput "$log.out.txt" -RedirectStandardError "$log.err.txt"
  # Without touching the handle now, PowerShell may lose the exit code once the process is gone.
  $null = $process.Handle
  if (-not $process.WaitForExit($seconds * 1000)) {
    $process.Kill()
    Fail "UwUMail Setup $($arguments -join ' ') didn't finish within $seconds seconds"
  }
  Get-Content "$log.out.txt", "$log.err.txt" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
  $process.ExitCode
}

function Screenshot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
    [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
    $bitmap.Save((Join-Path $Evidence "$name.png"))
  } catch {
    Write-Host "  (no screenshot: $_)"
  }
}

$dir = Join-Path $env:LOCALAPPDATA "Programs\UwUMail"
$app = Join-Path $dir "UwUMail.exe"
$uninstaller = Join-Path $dir "uninstall.exe"
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "UwUMail.lnk"
$desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "UwUMail.lnk"
$setupKey = "HKCU:\Software\UwUMail\Setup"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\UwUMail"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$mailto = "HKCU:\Software\Classes\UwUMail.mailto\shell\open\command"
$data = @((Join-Path $env:APPDATA "app.uwumail.desktop"), (Join-Path $env:LOCALAPPDATA "app.uwumail.desktop"))
function Value($key, $name) { (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name }
function Running { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $app }).Count -gt 0 }

Step "The setup"
Check { Test-Path $Setup } "$(Split-Path $Setup -Leaf) is there"
Check { (Machine $Setup) -eq $expectedMachine } "the setup is built for $Arch"
Check { -not (Test-Path $dir) } "nothing is installed yet"

Step "Silent install"
Check { (Run-Setup @("--silent", "--autostart", "--default-mail-app")) -eq 0 } "the setup succeeded"
Check { Test-Path $app } "UwUMail.exe is in $dir"
Check { (Machine $app) -eq $expectedMachine } "UwUMail.exe is built for $Arch"
Check { (Test-Path $uninstaller) -and (Machine $uninstaller) -eq $expectedMachine } "the uninstaller is in place"
Check { (Value $setupKey "Version") -eq $Version } "the setup remembers version $Version"
Check { (Value $uninstallKey "DisplayVersion") -eq $Version } "Installed apps lists UwUMail $Version"
Check { (Value $uninstallKey "UninstallString") -like "*uninstall.exe*--uninstall" } "Installed apps can remove it"
Check { (Value $runKey "UwUMail") -like "*UwUMail.exe*--autostart" } "UwUMail starts with Windows, hidden"
Check { (Value $mailto "(default)") -like "*UwUMail.exe*%1*" } "UwUMail takes mailto: links"
Check { (Value "HKCU:\Software\RegisteredApplications" "UwUMail") } "UwUMail is a registered mail app"
Check { (Test-Path $startMenu) -and (Test-Path $desktopLink) } "Start menu and desktop shortcuts exist"

Step "UwUMail starts"
$process = Start-Process -FilePath $app -PassThru
Start-Sleep -Seconds 20
Check { -not $process.HasExited } "UwUMail runs"
Screenshot "app"
Check { @($data | Where-Object { Test-Path $_ }).Count -gt 0 } "UwUMail created its data folder"

Step "Update over the running app"
Check { (Run-Setup @("--silent", "--update")) -eq 0 } "the update succeeded"
Check { -not (Running) } "the setup closed the running UwUMail"
Check { (Test-Path $app) -and -not (Test-Path "$app.new") } "the updated app is in place, no leftovers"

Step "An older setup is refused"
Set-ItemProperty -Path $setupKey -Name Version -Value "99.0.0"
Check { (Run-Setup @("--silent", "--update") 120) -ne 0 } "an older update doesn't replace a newer UwUMail"
Check { Test-Path $app } "UwUMail is still there"

Step "The setup window opens"
$window = Start-Process -FilePath $Setup -PassThru
Start-Sleep -Seconds 15
Check { -not $window.HasExited } "the setup window runs"
Screenshot "setup"
Stop-Process -Id $window.Id -Force -ErrorAction SilentlyContinue
$window.WaitForExit(10000) | Out-Null

Step "Uninstall"
Check { (Run-Setup @("--silent", "--uninstall", "--delete-data") 120) -eq 0 } "the uninstall succeeded"
Check { -not (Test-Path $dir) } "UwUMail's folder is gone"
Check { -not (Test-Path $startMenu) -and -not (Test-Path $desktopLink) } "the shortcuts are gone"
Check { -not (Test-Path $uninstallKey) -and -not (Test-Path $setupKey) } "Installed apps forgot UwUMail"
Check { -not (Value $runKey "UwUMail") } "UwUMail no longer starts with Windows"
Check { -not (Test-Path "HKCU:\Software\Classes\UwUMail.mailto") } "mailto: is handed back"
Check { @($data | Where-Object { Test-Path $_ }).Count -eq 0 } "mail data is deleted on request"

Write-Host ""
Write-Host "✧ The setup works on Windows ($Arch, $env:PROCESSOR_ARCHITECTURE)"
