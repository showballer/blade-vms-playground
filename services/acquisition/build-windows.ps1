param(
    [string]$Python = "python",
    [string]$SdkDirectory = "",
    [string]$SdkLicenseDirectory = "",
    [string]$SdkSourceDirectory = "",
    [switch]$StageDesktop
)
$ErrorActionPreference = "Stop"
$serviceRoot = $PSScriptRoot
Push-Location $serviceRoot
try {
    if (-not $SdkDirectory) {
        throw "A complete service build requires -SdkDirectory containing the Windows x64 DeviceCommunication.dll."
    }
    $sdk = (Resolve-Path -LiteralPath $SdkDirectory).Path
    $sdkDll = Join-Path $sdk "DeviceCommunication.dll"
    if (-not (Test-Path -LiteralPath $sdkDll -PathType Leaf)) {
        throw "SDK directory must contain DeviceCommunication.dll."
    }
    $sdkBytes = [System.IO.File]::ReadAllBytes($sdkDll)
    if ($sdkBytes.Length -lt 128 -or [BitConverter]::ToUInt16($sdkBytes, 0) -ne 0x5A4D) {
        throw "DeviceCommunication.dll is not a Windows PE binary."
    }
    $peOffset = [BitConverter]::ToInt32($sdkBytes, 0x3C)
    if ($peOffset -lt 64 -or $peOffset + 26 -gt $sdkBytes.Length -or
        [BitConverter]::ToUInt32($sdkBytes, $peOffset) -ne 0x4550 -or
        [BitConverter]::ToUInt16($sdkBytes, $peOffset + 4) -ne 0x8664) {
        throw "DeviceCommunication.dll must be the Windows x64 version, not build32 or ARM64."
    }
    if (-not $SdkLicenseDirectory) { $SdkLicenseDirectory = Join-Path (Split-Path $sdk -Parent) "licenses" }
    if (-not $SdkSourceDirectory) { $SdkSourceDirectory = Join-Path (Split-Path $sdk -Parent) "source" }
    $sdkLicenses = (Resolve-Path -LiteralPath $SdkLicenseDirectory).Path
    $sdkSource = (Resolve-Path -LiteralPath $SdkSourceDirectory).Path
    foreach ($licenseName in @("LICENSE.md", "LICENSE.LESSER.md", "NOTICE.md")) {
        if (-not (Test-Path -LiteralPath (Join-Path $sdkLicenses $licenseName) -PathType Leaf)) {
            throw "SDK license directory must contain $licenseName."
        }
    }
    $sdkSourceArchive = Join-Path $sdkSource "DeviceCommunication-2021-source.zip"
    if (-not (Test-Path -LiteralPath $sdkSourceArchive -PathType Leaf)) {
        throw "The SDK corresponding-source archive DeviceCommunication-2021-source.zip is required."
    }
    & $Python -c "import platform, struct, sys; assert sys.platform == 'win32' and struct.calcsize('P') == 8 and platform.machine().lower() in ('amd64','x86_64'), 'Use Windows x64 Python'; assert sys.version_info >= (3, 12), 'Use Python 3.12+'"
    if ($LASTEXITCODE -ne 0) { throw "Windows x64 Python 3.12+ is required." }
    & $Python -m venv .venv-build
    if ($LASTEXITCODE -ne 0) { throw "Creating build virtual environment failed." }
    $buildPython = Join-Path $serviceRoot ".venv-build\Scripts\python.exe"
    & $buildPython -m pip --isolated install -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw "Installing build requirements failed." }
    & $buildPython -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw "Hardware-free service tests failed." }
    & $buildPython -m PyInstaller --clean --noconfirm BladeAcquisition.spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed." }
    $bundle = Join-Path $serviceRoot "dist\BladeAcquisition"
    & $buildPython collect_licenses.py (Join-Path $bundle "third-party-licenses")
    if ($LASTEXITCODE -ne 0) { throw "Collecting bundled Python/dependency license notices failed." }
    $vendor = Join-Path $bundle "vendor"
    New-Item -ItemType Directory -Force $vendor | Out-Null
    # Only explicitly supplied SDK binaries; no DevicePanel/Qt example libraries or drivers.
    Get-ChildItem -LiteralPath $sdk -Filter *.dll -File | Copy-Item -Destination $vendor
    $bundleLicenses = Join-Path $vendor "licenses"
    $bundleSource = Join-Path $vendor "source"
    New-Item -ItemType Directory -Force $bundleLicenses, $bundleSource | Out-Null
    foreach ($licenseName in @("LICENSE.md", "LICENSE.LESSER.md", "NOTICE.md")) {
        Copy-Item -LiteralPath (Join-Path $sdkLicenses $licenseName) -Destination $bundleLicenses
    }
    Copy-Item -LiteralPath $sdkSourceArchive -Destination $bundleSource
    & $buildPython -m pip freeze | Set-Content -Encoding utf8 (Join-Path $bundle "build-dependencies.txt")
    if ($LASTEXITCODE -ne 0) { throw "Recording resolved dependencies failed." }
    if ($StageDesktop) {
        $desktopResources = [System.IO.Path]::GetFullPath((Join-Path $serviceRoot "..\..\apps\desktop\resources"))
        $desktopDestination = Join-Path $desktopResources "acquisition"
        # Stage into a new directory, then replace the generated payload as a unit.
        # Keep a recoverable previous directory rather than mixing stale binaries.
        $stageId = [Guid]::NewGuid().ToString("N")
        $stageDirectory = Join-Path $desktopResources ".acquisition-stage-$stageId"
        New-Item -ItemType Directory -Force $stageDirectory | Out-Null
        Get-ChildItem -LiteralPath $bundle -Force | Copy-Item -Destination $stageDirectory -Recurse -Force
        if (Test-Path -LiteralPath $desktopDestination) {
            $previousDirectory = Join-Path $desktopResources ".acquisition-previous-$stageId"
            Move-Item -LiteralPath $desktopDestination -Destination $previousDirectory
            Write-Host "Previous generated service preserved in $previousDirectory"
        }
        Move-Item -LiteralPath $stageDirectory -Destination $desktopDestination
        Write-Host "Staged service in $desktopDestination"
    }
    Write-Host "Built $bundle\BladeAcquisition.exe (keep the entire directory)."
} finally {
    Pop-Location
}
