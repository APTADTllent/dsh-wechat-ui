<#
  desktop-say.ps1 —— 不打开浏览器就能对 DeepSeek 说话
  ==================================================

  弹一个桌面小窗，你打一句话，它直接发进 DSH 当前打开的会话；
  模型的回答会由插件的桌面弹窗（desktop-toast.ps1）推回到屏幕顶部。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File desktop-say.ps1 [-Port 3080]

  -Port 不填就自动在 3080..3085 里找一个正在跑且装了微信插件的 DSH。

  ⚠️ 这个文件必须「UTF-8 带 BOM」，否则 PowerShell 5.1 会按 ANSI 读，中文全是乱码。
#>
param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Find-DshPort {
  param([int]$Preferred)
  $cands = New-Object System.Collections.ArrayList
  if ($Preferred -gt 0) { [void]$cands.Add($Preferred) }
  foreach ($p in @(3080, 3081, 3082, 3083, 3084, 3085)) { [void]$cands.Add($p) }
  foreach ($p in ($cands | Select-Object -Unique)) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/wechat-ui/version" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return $p }
    } catch { }
  }
  return 0
}

$port = Find-DshPort -Preferred $Port
if ($port -eq 0) {
  [void][System.Windows.Forms.MessageBox]::Show(
    "没有找到正在运行、且装了微信插件的 DSH。`n`n请确认 DSH 开着（端口 3080-3085 之一）。",
    '桌面输入')
  exit 1
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '对 DeepSeek 说（不用打开浏览器）'
$form.ClientSize = New-Object System.Drawing.Size(560, 236)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ScrollBars = 'Vertical'
$box.AcceptsReturn = $true
$box.Location = New-Object System.Drawing.Point(12, 12)
$box.Size = New-Object System.Drawing.Size(536, 150)
$box.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$form.Controls.Add($box)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = '发送（Ctrl+Enter）'
$btn.Location = New-Object System.Drawing.Point(408, 172)
$btn.Size = New-Object System.Drawing.Size(140, 34)
$form.Controls.Add($btn)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(12, 180)
$status.Size = New-Object System.Drawing.Size(386, 40)
$status.Text = "已连上 127.0.0.1:$port"
$form.Controls.Add($status)

$REASON = @{
  'empty'            = '没输入内容'
  'too-long'         = '太长了（上限 4000 字）'
  'no-session'       = '还没认出当前会话 —— 先在浏览器里聊一句再来'
  'no-agent'         = '当前会话不在内存里'
  'session-running'  = '模型正在回答，等它说完再发'
  'context-too-big'  = '会话上下文太大，为省钱跳过了'
  'no-service'       = '宿主半拿不到会话服务'
  'error'            = '发送出错（详见诊断）'
}

$doSend = {
  $text = $box.Text.Trim()
  if (-not $text) { $status.Text = '没输入内容'; return }
  $btn.Enabled = $false
  $status.Text = '发送中…'
  $form.Refresh()
  try {
    $enc = [System.Uri]::EscapeDataString($text)
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/wechat-ui/say" -Method POST `
      -Body "text=$enc" -ContentType 'application/x-www-form-urlencoded' `
      -UseBasicParsing -TimeoutSec 20
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok) {
      $form.Close()
    } else {
      $why = [string]$j.reason
      if ($REASON.ContainsKey($why)) { $why = $REASON[$why] }
      $status.Text = '没发出去：' + $why
    }
  } catch {
    $status.Text = '请求失败：' + $_.Exception.Message
  }
  $btn.Enabled = $true
}

$btn.Add_Click($doSend)
$box.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
    & $doSend
    $_.SuppressKeyPress = $true
  }
})
$form.Add_Shown({ $box.Focus() })
[void]$form.ShowDialog()
