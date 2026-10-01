param([string]$Destination)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'media-downloader-portable' }
$feed = Invoke-RestMethod 'https://raw.githubusercontent.com/Nan-WenYuan/MediaDownloader/main/update-feed.json' -Headers $headers
if ($feed.schema -ne 1 -or $feed.manifestUrl -notmatch '^https://github.com/Nan-WenYuan/MediaDownloader/releases/download/') { throw 'Invalid update feed.' }
$manifestResponse = Invoke-WebRequest $feed.manifestUrl -Headers $headers -UseBasicParsing
$manifest = [Text.Encoding]::UTF8.GetString($manifestResponse.RawContentStream.ToArray()) | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.files.Count -ne 14) { throw 'Invalid release manifest.' }
if (!$Destination) { $Destination = Join-Path $PSScriptRoot ('MediaDownloader-' + $manifest.version) }
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Choose a new empty folder; existing data will not be overwritten.' }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($file in $manifest.files) {
    if ($file.path -match '(^[/\\]|\.\.|:)' -or $file.path -match '^(数据|下载结果)/') { throw 'Invalid release path.' }
    $output = [IO.Path]::GetFullPath((Join-Path $target $file.path))
    if (!$output.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid release path.' }
    if ($file.url -notmatch '^https://github.com/Nan-WenYuan/MediaDownloader/releases/download/') { throw 'Missing release asset.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
    Write-Host ('Downloading ' + $file.path)
    Invoke-WebRequest $file.url -Headers $headers -UseBasicParsing -OutFile $output
    if ((Get-Item -LiteralPath $output).Length -ne $file.size -or (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Checksum mismatch: ' + $file.path) }
}
Write-Host ('Portable application ready: ' + $target)
