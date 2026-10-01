param([string]$Destination)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'media-downloader-portable' }
$releases = Invoke-RestMethod 'https://api.github.com/repos/Nan-WenYuan/MediaDownloader/releases?per_page=30' -Headers $headers
$release = $releases | Where-Object { !$_.draft -and ($_.assets.name -contains 'update-manifest.json') } | Select-Object -First 1
if (!$release) { throw 'No complete release found.' }
$asset = $release.assets | Where-Object name -eq 'update-manifest.json'
$manifest = Invoke-RestMethod $asset.browser_download_url -Headers $headers
if (!$Destination) { $Destination = Join-Path $PSScriptRoot ('MediaDownloader-' + $manifest.version) }
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Choose a new empty folder; existing data will not be overwritten.' }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($file in $manifest.files) {
    if ($file.path -match '(^[/\\]|\.\.|:)' -or $file.path -match '^(数据|下载结果)/') { throw 'Invalid release path.' }
    $output = [IO.Path]::GetFullPath((Join-Path $target $file.path))
    if (!$output.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid release path.' }
    $download = $release.assets | Where-Object name -eq $file.asset
    if (!$download -or $download.browser_download_url -notmatch '^https://github.com/Nan-WenYuan/MediaDownloader/releases/download/') { throw 'Missing release asset.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
    Write-Host ('Downloading ' + $file.path)
    Invoke-WebRequest $download.browser_download_url -Headers $headers -UseBasicParsing -OutFile $output
    if ((Get-Item -LiteralPath $output).Length -ne $file.size -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Checksum mismatch: ' + $file.path) }
}
Write-Host ('Portable application ready: ' + $target)
