# ContinuousAgent 一键启动（Windows）：环境检测 → 构建 → 运行 → 打开浏览器
# 用法: .\start-windows.ps1 [-Port 7800] [-NoBuild] [-NoOpen] [-CheckEnv] [-NoAutoInstall]
param(
  [int]$Port = 7800,
  [switch]$NoBuild,
  [switch]$NoOpen,
  [switch]$CheckEnv,
  [switch]$NoAutoInstall
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 必需运行环境口径：与 package.json 的 engines.node 一致
$NodeMinMajor = 20
$NodeSeries   = 22
$NodeDist     = 'https://nodejs.org/dist'
$script:EnvProblem  = ''
$script:NodeVersion = ''

# 安装程序改的是注册表里的 PATH，当前会话不会自动生效，需要重新拼一次
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $candidates.Add((Join-Path $pf86 'nodejs\node.exe')) }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')) }
  foreach ($p in $candidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

# 返回 $true 表示环境可用；否则把原因写进 $script:EnvProblem
function Test-Env {
  $script:EnvProblem = ''
  $exe = Get-NodeExe
  if (-not $exe) {
    $script:EnvProblem = "未找到 Node.js（要求 >= $NodeMinMajor）"
    return $false
  }
  $verText = $null
  try { $verText = & $exe -v 2>$null } catch { $verText = $null }
  if (-not $verText) {
    $script:EnvProblem = "无法执行 $exe -v"
    return $false
  }
  $verText = ($verText | Select-Object -First 1).ToString().Trim()
  $major = 0
  $head = ($verText -replace '^v', '').Split('.')[0]
  if (-not [int]::TryParse($head, [ref]$major)) {
    $script:EnvProblem = "无法识别 Node.js 版本：$verText"
    return $false
  }
  if ($major -lt $NodeMinMajor) {
    $script:EnvProblem = "Node.js 版本过低（当前 $verText，要求 >= $NodeMinMajor）"
    return $false
  }
  $script:NodeVersion = $verText
  $script:NodeExe = $exe
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    $script:EnvProblem = "未找到 npm（Node.js $verText 本应自带，请检查安装是否完整）"
    return $false
  }
  return $true
}

# 解析官方安装包地址与校验值；网络不可达时抛异常
function Get-InstallerPlan {
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  $sumsUrl = "$NodeDist/latest-v$NodeSeries.x/SHASUMS256.txt"
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -TimeoutSec 60).Content
  $line = @(($sums -split '\r?\n') | Where-Object { $_ -match "node-v[\d.]+-$arch\.msi$" })
  if ($line.Count -eq 0) { throw "版本清单里没有 $arch 的 MSI 安装包" }
  $parts = $line[0].Trim() -split '\s+'
  $file = $parts[-1]
  $ver = $file -replace '^node-v', '' -replace "-$arch\.msi$", ''
  [pscustomobject]@{
    Arch    = $arch
    Version = $ver
    File    = $file
    Sha256  = $parts[0]
    Url     = "$NodeDist/v$ver/$file"
  }
}

function Install-NodeMsi {
  $plan = Get-InstallerPlan
  $tmp = Join-Path $env:TEMP $plan.File
  Write-Host "下载 $($plan.Url)" -ForegroundColor Cyan
  Invoke-WebRequest -UseBasicParsing -Uri $plan.Url -OutFile $tmp -TimeoutSec 600
  $actual = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
  if ($plan.Sha256 -and $actual -ne $plan.Sha256.ToLower()) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Write-Host "SHA256 校验失败：期望 $($plan.Sha256)，实际 $actual" -ForegroundColor Red
    return $false
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host 'MSI 静默安装需要管理员权限。' -ForegroundColor Yellow
    Write-Host "请用管理员身份打开 PowerShell 后重跑本脚本，或手动安装 Node.js $NodeMinMajor+：$($plan.Url)" -ForegroundColor Yellow
    return $false
  }
  Write-Host '安装中（静默）…' -ForegroundColor Cyan
  $msiArgs = '/i "' + $tmp + '" /qn /norestart'
  $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0) {
    Write-Host "MSI 安装失败，退出码 $($proc.ExitCode)" -ForegroundColor Red
    return $false
  }
  Update-SessionPath
  return [bool](Get-NodeExe)
}

# 优先 winget（免手动下载），失败退回官方 MSI
function Install-Node {
  Update-SessionPath
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '使用 winget 安装 Node.js LTS（OpenJS.NodeJS.LTS）…' -ForegroundColor Cyan
    $code = -1
    try {
      & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
      $code = $LASTEXITCODE
    } catch {
      $code = -1
    }
    Update-SessionPath
    # 0 = 安装成功；-1978335189 = 已安装最新版
    if (($code -eq 0 -or $code -eq -1978335189) -and (Get-NodeExe)) { return $true }
    Write-Host "winget 未成功（退出码 $code），改用官方 MSI。" -ForegroundColor Yellow
  }
  return Install-NodeMsi
}

if ($CheckEnv) {
  Write-Host "运行环境检测（要求 Node.js >= $NodeMinMajor）：" -ForegroundColor Cyan
  if (Test-Env) {
    Write-Host "  Node.js  $($script:NodeVersion)   ok"
    Write-Host "  npm      $((& npm -v) -join '')   ok"
    Write-Host '结论：可以运行。' -ForegroundColor Green
    exit 0
  }
  Write-Host "  $($script:EnvProblem)" -ForegroundColor Red
  Write-Host '结论：不能运行。'
  if ($NoAutoInstall) {
    Write-Host "已指定 -NoAutoInstall，请手动安装 Node.js $NodeMinMajor 及以上版本：https://nodejs.org/zh-cn/download"
  }
  else {
    Write-Host '修复方案（去掉 -CheckEnv 直接运行即会自动执行）：' -ForegroundColor Cyan
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Write-Host '  1) winget install --id OpenJS.NodeJS.LTS -e --silent'
    }
    try {
      $plan = Get-InstallerPlan
      Write-Host "  2) 官方 MSI：$($plan.Url)（Node.js $($plan.Version) / $($plan.Arch)）"
    } catch {
      Write-Host "  2) 官方 MSI 地址获取失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  exit 1
}

if (-not (Test-Env)) {
  Write-Host "运行环境检测：$($script:EnvProblem)" -ForegroundColor Yellow
  if ($NoAutoInstall) {
    throw "已指定 -NoAutoInstall。请先安装 Node.js $NodeMinMajor 及以上版本：https://nodejs.org/zh-cn/download"
  }
  if (-not (Install-Node)) {
    throw "自动安装 Node.js 失败。请手动安装 $NodeMinMajor 及以上版本：https://nodejs.org/zh-cn/download"
  }
  if (-not (Test-Env)) {
    throw "自动安装后仍不可用：$($script:EnvProblem)"
  }
  Write-Host "环境就绪：$($script:NodeVersion)" -ForegroundColor Green
}

if (-not $NoBuild -or -not (Test-Path 'dist\server\index.js')) {
  Write-Host '构建中…' -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw '构建失败' }
}

if (-not $NoOpen) {
  Start-Job -ScriptBlock {
    param($url)
    Start-Sleep -Seconds 2
    Start-Process $url
  } -ArgumentList "http://127.0.0.1:$Port" | Out-Null
}

$env:PORT = "$Port"
Write-Host "启动 http://127.0.0.1:$Port" -ForegroundColor Green
node dist/server/index.js
