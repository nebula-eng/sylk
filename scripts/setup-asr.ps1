# 下载本机转写运行时（whisper.cpp + ggml 模型）到 Sylk 的工具目录。
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-asr.ps1 -Model small
#
# Sylk 会自动识别 %LOCALAPPDATA%\Sylk\tools 里的 whisper-cli.exe 和 ggml-*.bin，
# 不需要在设置里手动填路径。

param(
  [ValidateSet('base', 'small', 'medium')]
  [string]$Model = 'base',
  [string]$Destination = "$env:LOCALAPPDATA\Sylk\tools"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$whisperVersion = 'v1.7.6'
$whisperZipUrl = "https://github.com/ggerganov/whisper.cpp/releases/download/$whisperVersion/whisper-bin-x64.zip"
$modelUrl = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
$modelFallback = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"

function Download($Url, $Path, $Fallback) {
  Write-Host "下载 $Url"
  & curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 -o $Path $Url
  if ($LASTEXITCODE -ne 0) {
    if (-not $Fallback) { throw "下载失败：$Url" }
    Write-Host "镜像失败，改试 $Fallback"
    & curl.exe -L --fail --retry 2 --connect-timeout 20 -o $Path $Fallback
    if ($LASTEXITCODE -ne 0) { throw "下载失败：$Fallback" }
  }
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$work = Join-Path $env:TEMP "sylk-asr-setup"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  $zip = Join-Path $work 'whisper-bin-x64.zip'
  Download $whisperZipUrl $zip $null
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'whisper') -Force

  $release = Get-ChildItem (Join-Path $work 'whisper') -Recurse -File -Filter 'whisper-cli.exe' |
    Select-Object -First 1
  if (-not $release) { throw '压缩包里没有 whisper-cli.exe' }
  $source = $release.Directory
  foreach ($name in @('whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll')) {
    $file = Join-Path $source $name
    if (Test-Path $file) { Copy-Item $file $Destination -Force }
  }

  $modelFile = Join-Path $Destination "ggml-$Model.bin"
  if (-not (Test-Path $modelFile)) {
    Download $modelUrl $modelFile $modelFallback
  }

  $exe = Join-Path $Destination 'whisper-cli.exe'
  if (-not (Test-Path $exe)) { throw 'whisper-cli.exe 没有落盘' }
  if (-not (Test-Path $modelFile)) { throw '模型没有落盘' }

  Write-Host ''
  Write-Host "完成：$Destination"
  Get-ChildItem $Destination -File |
    Where-Object { $_.Name -in @('whisper-cli.exe', "ggml-$Model.bin") } |
    ForEach-Object { "  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB) }
  Write-Host '打开 Sylk → 设置 → 转写，启用即可；应用会自动找到这套文件。'
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
