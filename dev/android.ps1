<#
    Run Quiet Feed on an emulated Android phone.

    Boots the 'fenix-test' AVD if it isn't already running, then hands the
    extension to Firefox Beta via web-ext. web-ext stays in the foreground and
    reloads the add-on whenever a source file changes -- Ctrl+C to stop.

    Usage:  powershell -ExecutionPolicy Bypass -File dev\android.ps1
#>

$ErrorActionPreference = 'Stop'

$Sdk    = 'C:\Android\Sdk'
$Adb    = "$Sdk\platform-tools\adb.exe"
$Emu    = "$Sdk\emulator\emulator.exe"
$WebExt = "$env:APPDATA\npm\web-ext.cmd"
$Avd    = 'fenix-test'
$Pkg    = 'org.mozilla.firefox_beta'
$Source = Split-Path -Parent $PSScriptRoot

$env:ANDROID_SDK_ROOT = $Sdk
$env:ANDROID_HOME     = $Sdk
$env:Path             = "$Sdk\platform-tools;$env:Path"

# --- boot the emulator if needed -----------------------------------------
$running = (& $Adb devices | Select-String -Pattern '^emulator-\d+\s+device')
if (-not $running) {
    Write-Host "Starting emulator '$Avd'..." -ForegroundColor Cyan
    Start-Process -FilePath $Emu -ArgumentList '-avd', $Avd, '-gpu', 'auto', '-no-boot-anim'
    & $Adb wait-for-device
} else {
    Write-Host "Emulator already running." -ForegroundColor Cyan
}

# Wait for Android to finish booting; the debugger socket won't exist before this.
Write-Host "Waiting for boot to complete..." -ForegroundColor Cyan
while ((& $Adb shell getprop sys.boot_completed).Trim() -ne '1') { Start-Sleep -Seconds 3 }

# --- remote debugging ------------------------------------------------------
# Fenix only opens its debugger socket when this pref is on. It survives normal
# restarts but is lost if Firefox's data is cleared or the app is reinstalled,
# in which case re-enable it under Settings -> Developer tools.
$prefs = "/data/data/$Pkg/shared_prefs/fenix_preferences.xml"
& $Adb root | Out-Null
Start-Sleep -Seconds 2
& $Adb wait-for-device
$hasPref = (& $Adb shell "grep -c pref_key_remote_debugging $prefs 2>/dev/null").Trim()
if ($hasPref -ne '1') {
    Write-Warning "Remote debugging pref is missing. Turn it on in Firefox: Settings -> Developer tools -> Remote debugging via USB."
}

# --- hand off to web-ext ---------------------------------------------------
$device = ((& $Adb devices | Select-String -Pattern '^(emulator-\d+)').Matches[0].Value)
Write-Host "Launching Quiet Feed on $device ..." -ForegroundColor Green

& $WebExt run `
    --target firefox-android `
    --android-device $device `
    --firefox-apk $Pkg `
    --source-dir $Source `
    --adb-bin $Adb
