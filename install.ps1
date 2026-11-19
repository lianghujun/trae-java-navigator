param(
  [string]$PluginsRoot = '',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

# 已改为跨平台 Node 安装器；此脚本仅保留 Windows 便捷入口
$cliArgs = @()
if ($PluginsRoot) { $cliArgs += @('--plugins-root', $PluginsRoot) }
$cliArgs += $Rest
node "$PSScriptRoot\install.mjs" @cliArgs
exit $LASTEXITCODE