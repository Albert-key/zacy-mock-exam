# ============================================================
#  朝这儿练 · 首次运行环境引导（Windows PowerShell 5.1+）
#  作用：检查 / 自动下载安装 Node.js 与无头浏览器，然后启动答题
#  用法：powershell -ExecutionPolicy Bypass -File bootstrap.ps1
#  参数：-CheckOnly 只检查不启动；-NoBrowser 跳过浏览器下载；
#        -ForceNode 忽略系统 Node 强制安装；-ForceBrowser 忽略本机浏览器强制安装；
#        -Root 指定安装根目录
# ============================================================
param(
  [switch]$CheckOnly,
  [switch]$NoBrowser,
  [switch]$ForceNode,
  [switch]$ForceBrowser,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MainJs = Join-Path $ScriptDir 'mock-exam.js'
if (-not $Root) {
  if ($env:ZACY_HOME) { $Root = $env:ZACY_HOME } else { $Root = Join-Path $env:LOCALAPPDATA 'zacy-mock-exam' }
}
$NodeHome = Join-Path $Root 'node'
$ChromeHome = Join-Path $Root 'chrome'
$Curl = $null
$c = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($c) { $Curl = $c.Source }

function Say($msg, $color = 'Cyan') { Write-Host $msg -ForegroundColor $color }
function Ok($msg) { Write-Host ("   √ " + $msg) -ForegroundColor Green }
function Warn($msg) { Write-Host ("   ! " + $msg) -ForegroundColor Yellow }
function Fail($msg) { Write-Host ("   × " + $msg) -ForegroundColor Red }

# ---------------------------------------------------------- 下载（多源 + 断点重试）
function Get-RemoteFile {
  param([string[]]$Urls, [string]$Dest, [long]$MinBytes = 1000)
  foreach ($u in $Urls) {
    Say ("     下载 " + $u) 'DarkGray'
    if ($Curl) {
      & $Curl -L --fail --retry 2 --connect-timeout 15 --max-time 900 -o $Dest $u
      if ($LASTEXITCODE -eq 0 -and (Test-Path $Dest) -and ((Get-Item $Dest).Length -ge $MinBytes)) { return $true }
    }
    try {
      Invoke-WebRequest -Uri $u -OutFile $Dest -UseBasicParsing -TimeoutSec 600
      if ((Test-Path $Dest) -and ((Get-Item $Dest).Length -ge $MinBytes)) { return $true }
    } catch {
      Warn ("     该源失败：" + $_.Exception.Message)
    }
  }
  return $false
}

function Get-RemoteJson {
  param([string[]]$Urls)
  foreach ($u in $Urls) {
    $tmp = Join-Path $env:TEMP ('zacy-index-' + [guid]::NewGuid().ToString('N') + '.json')
    if (Get-RemoteFile -Urls @($u) -Dest $tmp -MinBytes 100) {
      try { return ((Get-Content -Path $tmp -Raw -Encoding UTF8) | ConvertFrom-Json) } catch { Warn '     索引解析失败' }
    }
  }
  return $null
}

# ---------------------------------------------------------- Node.js 检测与安装
function Get-NodeInfo {
  param([string]$Exe)
  if (-not $Exe -or -not (Test-Path $Exe)) { return $null }
  try {
    $v = (& $Exe -v 2>$null)
    if ($v -match '^v(\d+)\.') {
      return [pscustomobject]@{ Exe = $Exe; Version = $v.Trim(); Major = [int]$Matches[1] }
    }
  } catch {}
  return $null
}

function Find-Node {
  $cands = @()
  $cands += (Join-Path $NodeHome 'node.exe')
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $cands += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $old = $null
  foreach ($p in ($cands | Select-Object -Unique)) {
    $n = Get-NodeInfo -Exe $p
    if (-not $n) { continue }
    if ($n.Major -ge 22 -and -not $ForceNode) { return $n }
    if (-not $old) { $old = $n }
  }
  if ($old -and -not $ForceNode) { return $old }
  return $null
}

function Install-Node {
  Say '   未检测到 Node.js 22+，开始自动安装（国内镜像，约 35MB）…' 'Yellow'
  $versions = @()
  $index = Get-RemoteJson -Urls @(
    'https://cdn.npmmirror.com/binaries/node/index.json',
    'https://registry.npmmirror.com/-/binary/node/index.json',
    'https://mirrors.huaweicloud.com/nodejs/index.json'
  )
  if ($index) {
    $versions = @($index | Where-Object {
        $_.version -match '^v(22|24)\.' -and ($_.files -contains 'win-x64-zip')
      } | Select-Object -First 3 | ForEach-Object { $_.version })
  }
  if (-not $versions -or $versions.Count -eq 0) { $versions = @('v22.20.0', 'v22.11.0') }

  foreach ($ver in $versions) {
    $file = "node-$ver-win-x64.zip"
    Say ("   尝试版本 " + $ver) 'DarkGray'
    $zip = Join-Path $env:TEMP $file
    $urls = @(
      "https://cdn.npmmirror.com/binaries/node/$ver/$file",
      "https://npmmirror.com/mirrors/node/$ver/$file",
      "https://mirrors.huaweicloud.com/nodejs/$ver/$file",
      "https://nodejs.org/dist/$ver/$file"
    )
    if (-not (Get-RemoteFile -Urls $urls -Dest $zip -MinBytes 20000000)) { continue }

    $tmp = Join-Path $env:TEMP ('zacy-node-' + [guid]::NewGuid().ToString('N'))
    try {
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
      if (-not $inner) { throw '压缩包结构异常' }
      if (Test-Path $NodeHome) { Remove-Item $NodeHome -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $NodeHome | Out-Null
      Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $NodeHome -Recurse -Force
      $exe = Join-Path $NodeHome 'node.exe'
      $info = Get-NodeInfo -Exe $exe
      if ($info -and $info.Major -ge 22) {
        Ok ("Node.js " + $info.Version + " 已安装到 " + $NodeHome)
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        return $info
      }
      throw '安装后校验未通过'
    } catch {
      Warn ("     安装失败：" + $_.Exception.Message)
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw 'Node.js 自动安装失败，请手动安装 Node 22+ 后重试：https://npmmirror.com/mirrors/node/'
}

# ---------------------------------------------------------- 浏览器检测与安装
function Find-Browser {
  $cands = @()
  if ($env:CHROME_PATH) { $cands += $env:CHROME_PATH }
  $cands += (Join-Path $ChromeHome 'chrome-headless-shell-win64\chrome-headless-shell.exe')
  $cands += (Join-Path $ChromeHome 'chrome.exe')
  $cands += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
  $cands += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
  $cands += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  foreach ($p in ($cands | Select-Object -Unique)) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Install-Browser {
  Say '   未检测到 Chrome/Edge，开始下载 Chrome Headless Shell（国内镜像，约 100MB）…' 'Yellow'
  $versions = @()
  $index = Get-RemoteJson -Urls @('https://registry.npmmirror.com/-/binary/chrome-for-testing/')
  if ($index) {
    $versions = @($index |
        Where-Object { $_.type -eq 'dir' -and $_.name -match '^\d+\.\d+\.\d+\.\d+/$' } |
        ForEach-Object { $_.name.TrimEnd('/') } |
        Sort-Object { [version]$_ } -Descending |
        Select-Object -First 5)
  }
  if (-not $versions -or $versions.Count -eq 0) { $versions = @('140.0.7339.80', '131.0.6778.85') }

  foreach ($ver in $versions) {
    $url = "https://cdn.npmmirror.com/binaries/chrome-for-testing/$ver/win64/chrome-headless-shell-win64.zip"
    Say ("   尝试版本 " + $ver) 'DarkGray'
    $zip = Join-Path $env:TEMP 'chrome-headless-shell-win64.zip'
    if (-not (Get-RemoteFile -Urls @($url) -Dest $zip -MinBytes 30000000)) { continue }
    $tmp = Join-Path $env:TEMP ('zacy-chrome-' + [guid]::NewGuid().ToString('N'))
    try {
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
      if (-not $inner) { throw '压缩包结构异常' }
      if (Test-Path $ChromeHome) { Remove-Item $ChromeHome -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $ChromeHome | Out-Null
      Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $ChromeHome -Recurse -Force
      $exe = Join-Path $ChromeHome 'chrome-headless-shell.exe'
      if (Test-Path $exe) {
        Ok ("浏览器已安装到 " + $exe)
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        return $exe
      }
      throw '安装后未找到可执行文件'
    } catch {
      Warn ("     安装失败：" + $_.Exception.Message)
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  return $null
}

# ---------------------------------------------------------- 网络检查
function Test-Site {
  param([string]$HostName = 'www.zacy.top', [int]$Port = 443, [int]$TimeoutMs = 6000)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    $client.Close()
    return $ok
  } catch { return $false }
}

# ---------------------------------------------------------- 主流程
Say ''
Say '==== 朝这儿练 · 环境检查 ====' 'White'
Say ("   安装目录：" + $Root) 'DarkGray'

# 1) Node.js
$node = $null
if ($ForceNode) {
  $node = Get-NodeInfo -Exe (Join-Path $NodeHome 'node.exe')
  if (-not $node -or $node.Major -lt 22) { $node = Install-Node }
} else {
  $node = Find-Node
  if ($node -and $node.Major -ge 22) {
    Ok ("Node.js " + $node.Version + "  " + $node.Exe)
  } elseif ($node) {
    Warn ("Node.js " + $node.Version + " 版本过低（需要 22+），开始安装新版…")
    $node = Install-Node
  } else {
    $node = Install-Node
  }
}

# 2) 浏览器
$browser = Find-Browser
if ($ForceBrowser) {
  $browser = Install-Browser
  if (-not $browser) { Warn '浏览器安装失败，答题可继续，但无法自动截图' }
} elseif ($browser) {
  Ok ("浏览器 " + $browser)
} elseif ($NoBrowser) {
  Warn '未找到浏览器，按参数要求跳过下载（将无法自动截图）'
} else {
  $browser = Install-Browser
  if (-not $browser) { Warn '浏览器安装失败，答题可继续，但无法自动截图' }
}

# 3) 站点连通性
if (Test-Site) {
  Ok 'www.zacy.top:443 可访问'
} else {
  Warn 'www.zacy.top:443 连接失败，请检查网络/代理后重试'
}

if ($browser) { $env:CHROME_PATH = $browser }
Say ''
Say '==== 环境就绪 ====' 'White'
Say ''

if ($CheckOnly) { exit 0 }

if (-not (Test-Path $MainJs)) {
  Fail ("未找到 " + $MainJs)
  exit 1
}

& $node.Exe $MainJs @args
$code = $LASTEXITCODE
exit $code
