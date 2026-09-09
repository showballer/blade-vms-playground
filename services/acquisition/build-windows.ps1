param(
    [string]$Python = "python",
    [string]$SdkDirectory = "",
    [switch]$StageDesktop
)
$ErrorActionPreference = "Stop"
$serviceRoot = $PSScriptRoot
Push-Location $serviceRoot
try {
    & $Python -c "import platform, struct, sys; assert sys.platform == 'win32' and struct.calcsize('P') == 8 and platform.machine().lower() in ('amd64','x86_64'), 'Use Windows x64 Python'; assert sys.version_info >= (3, 12), 'Use Python 3.12+'"
    if ($LASTEXITCODE -ne 0) { throw "Windows x64 Python 3.12+ is required." }
    & $Python -m venv .venv-build
    if ($LASTEXITCODE -ne 0) { throw "Creating build virtual environment failed." }
    $buildPython = Join-Path $serviceRoot ".venv-build\Scripts\python.exe"
    & $buildPython -m pip install -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw "Installing build requirements failed." }
    & $buildPython -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw "Hardware-free service tests failed." }
    & $buildPython -m PyInstaller --noconfirm BladeAcquisition.spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed." }
    $bundle = Join-Path $serviceRoot "dist\BladeAcquisition"
    if ($SdkDirectory) {
        $sdk = (Resolve-Path $SdkDirectory).Path
        if (-not (Test-Path (Join-Path $sdk "DeviceCommunication.dll"))) {
            throw "SDK directory must contain DeviceCommunication.dll."
        }
        $vendor = Join-Path $bundle "vendor"
        New-Item -ItemType Directory -Force $vendor | Out-Null
        # Copy only binaries explicitly supplied by the developer. Do not fetch/install drivers.
        Get-ChildItem -LiteralPath $sdk -Filter *.dll -File | Copy-Item -Destination $vendor
    } else {
        Write-Warning "No vendor DLLs bundled. Configure BLADE_POLYTEC_DLL on the test machine."
    }
    & $buildPython -m pip freeze | Set-Content -Encoding utf8 (Join-Path $bundle "build-dependencies.txt")
    if ($LASTEXITCODE -ne 0) { throw "Recording resolved dependencies failed." }
    if ($StageDesktop) {
        $desktopDestination = Join-Path $serviceRoot "..\..\apps\desktop\resources\acquisition"
        New-Item -ItemType Directory -Force $desktopDestination | Out-Null
        Copy-Item -Path (Join-Path $bundle "*") -Destination $desktopDestination -Recurse -Force
        Write-Host "Staged service in $desktopDestination"
    }
    Write-Host "Built $bundle\BladeAcquisition.exe (keep the entire directory)."
} finally {
    Pop-Location
}
