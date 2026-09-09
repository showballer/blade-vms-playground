# Build-time only. End users do not download dependencies or install Python.
param([string]$Destination = (Join-Path $PSScriptRoot "..\apps\desktop\resources\prerequisites"))
$ErrorActionPreference = "Stop"
if (-not [Environment]::Is64BitOperatingSystem -or $env:OS -ne "Windows_NT") { throw "Run on Windows x64." }
New-Item -ItemType Directory -Force $Destination | Out-Null
$target = Join-Path $Destination "vc_redist.x64.exe"
$source = "https://aka.ms/vc14/vc_redist.x64.exe"
Invoke-WebRequest -Uri $source -OutFile $target
$signature = Get-AuthenticodeSignature -FilePath $target
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "VC++ prerequisite has no valid Microsoft signature; refusing to package."
}
$info = (Get-Item -LiteralPath $target).VersionInfo
$version = "{0}.{1}.{2}.{3}" -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart
if ([version]$version -lt [version]"14.40.33810.0") { throw "Unexpected old VC++ runtime: $version" }
@{architecture="x64"; version=$version; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant(); source=$source; signer=$signature.SignerCertificate.Subject} |
    ConvertTo-Json | Set-Content -Encoding utf8NoBOM (Join-Path $Destination "manifest.json")
Write-Host "Verified Microsoft VC++ x64 runtime $version"
