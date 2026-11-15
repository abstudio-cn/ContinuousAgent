# GameAgent Web 一键启动：构建 + 运行 + 打开浏览器
# 用法: .\start.ps1 [-Port 7800] [-NoBuild] [-NoOpen]
param(
  [int]$Port = 7800,
  [switch]$NoBuild,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

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
