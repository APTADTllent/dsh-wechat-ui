<#
  desktop-approval.ps1 —— 桌面确认窗（宿主半拉起，不经过浏览器）

  ⚠️ 这个文件必须是「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会按 ANSI 解码，
     里面的中文全部乱码并直接语法报错（实测：'桌面确认' 变成 '妗岄潰纭'）。
     安装脚本 plugin-mgr.mjs 会在复制时自动补 BOM；手工改完请重新跑一次安装。

  为什么用文件传参：PowerShell 命令行参数里的中文同样不可靠。
    入参 = UTF-8 JSON 文件，出参 = UTF-8 结果文件，绕开编码问题。
  为什么宿主端用 stdio:ignore 拉它：结果走文件，不需要 stdio，
    顺带避开沙箱对管道的限制。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File desktop-approval.ps1 `
      -RequestPath <请求.json> -ResultPath <结果.txt> [-DiagPath <诊断.log>]

  结果：
    权限类 → allowed-once | rejected | browser | error
    提问类 → 选中的选项文本 | browser

  v0.3.3 的窗口定位与自查（解决"窗口创建了但用户看不到"）：
    · 出现在鼠标所在那块屏幕的正中央（不是固定主屏）
    · Shown 事件里抢焦点（ShowDialog 之前窗口还没创建，那时调 Activate 是空操作）
    · 3 秒后再抢一次，并把位置/前台状态写进 DiagPath，便于事后定位
#>
param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [string]$DiagPath = ''
)

$ErrorActionPreference = 'Stop'

function Write-Diag([string]$text) {
  if (-not $DiagPath) { return }
  try {
    $line = "$(Get-Date -Format 'HH:mm:ss.fff')  $text`r`n"
    [System.IO.File]::AppendAllText($DiagPath, $line, [System.Text.Encoding]::UTF8)
  } catch { }
}

function Write-Result([string]$value) {
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
    [System.IO.File]::WriteAllBytes($ResultPath, $bytes)
  } catch { }
}

try {
  $raw = [System.IO.File]::ReadAllText($RequestPath, [System.Text.Encoding]::UTF8)
  $req = $raw | ConvertFrom-Json
} catch {
  Write-Result 'error'
  exit 1
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Result 'browser'
  exit 0
}

$timeoutSec = 60
if ($req.timeoutSec) { $timeoutSec = [int]$req.timeoutSec }
if ($timeoutSec -lt 5) { $timeoutSec = 5 }

$isQuestion = ($req.kind -eq 'question')
$options = @()
if ($isQuestion -and $req.options) { $options = @($req.options) }
$isSimpleQuestion = $isQuestion -and $options.Count -ge 2 -and $options.Count -le 5 -and -not $req.multiSelect

# 选项太多 / 多选 / 需要填自定义文本：交给浏览器更合适（那边交互完整）
if ($isQuestion -and -not $isSimpleQuestion) {
  Write-Diag "选项不适合弹窗（count=$($options.Count) multi=$($req.multiSelect)），交回浏览器"
  Write-Result 'browser'
  exit 0
}

$btnW = 434
$btnH = 42
$btnGap = 8
$contentH = if ($isQuestion) { 84 } else { 150 }
$listH = if ($isSimpleQuestion) { $options.Count * ($btnH + $btnGap) + $btnH + $btnGap } else { $btnH + $btnGap }
$clientH = 50 + $contentH + 8 + $listH + 34

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 桌面确认'
$form.ClientSize = New-Object System.Drawing.Size(470, $clientH)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)

# 出现在鼠标所在那块屏幕的正中央（多屏时不会跑到另一块屏上）
try {
  $cursor = [System.Windows.Forms.Cursor]::Position
  $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
  $wa = $screen.WorkingArea
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(
    [int]($wa.X + ($wa.Width - $form.Width) / 2),
    [int]($wa.Y + ($wa.Height - $form.Height) / 2)
  )
  Write-Diag "屏幕=$($screen.DeviceName) 工作区=$($wa.Width)x$($wa.Height)@($($wa.X),$($wa.Y)) 鼠标=($($cursor.X),$($cursor.Y)) 目标位置=($($form.Location.X),$($form.Location.Y))"
} catch {
  $form.StartPosition = 'CenterScreen'
  Write-Diag "定位失败，退回 CenterScreen：$($_.Exception.Message)"
}

$fontTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$fontBody = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $(if ($isQuestion) { 'DSH 有个问题问你' } else { 'DSH 请求执行一个操作' })
$lblTitle.Font = $fontTitle
$lblTitle.Location = New-Object System.Drawing.Point(18, 16)
$lblTitle.Size = New-Object System.Drawing.Size(434, 28)
$form.Controls.Add($lblTitle)

if ($isQuestion) {
  $body = [string]$req.question
  if ($req.header) { $body = "[$($req.header)]`r`n$body" }
} else {
  $body = "工具：$($req.toolName)`r`n`r`n原因：$($req.reason)"
}

$lblBody = New-Object System.Windows.Forms.Label
$lblBody.Text = $body
$lblBody.Font = $fontBody
$lblBody.Location = New-Object System.Drawing.Point(18, 50)
$lblBody.Size = New-Object System.Drawing.Size(434, $contentH)
$form.Controls.Add($lblBody)

function New-Btn([string]$text, [int]$left, [int]$top, [int]$w, $dialogResult, [bool]$primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Font = $fontBody
  $b.Location = New-Object System.Drawing.Point($left, $top)
  $b.Size = New-Object System.Drawing.Size($w, $btnH)
  $b.DialogResult = $dialogResult
  $b.TextAlign = 'MiddleLeft'
  if ($primary) {
    $b.BackColor = [System.Drawing.Color]::FromArgb(7, 193, 96)
    $b.ForeColor = [System.Drawing.Color]::White
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
  }
  $form.Controls.Add($b)
  return $b
}

$y = 50 + $contentH + 8
$script:picked = $null

if ($isSimpleQuestion) {
  for ($i = 0; $i -lt $options.Count; $i++) {
    $label = [string]$options[$i]
    $b = New-Btn $label 18 ($y + $i * ($btnH + $btnGap)) $btnW ([System.Windows.Forms.DialogResult]::Yes) ($i -eq 0)
    # GetNewClosure 把 $label 绑进这个按钮自己的作用域，否则所有按钮都会记成最后一个
    $b.Add_Click({ $script:picked = $label }.GetNewClosure())
  }
  $y = $y + $options.Count * ($btnH + $btnGap)
  [void](New-Btn '都不选 / 我自己去 DSH 里答' 18 $y $btnW ([System.Windows.Forms.DialogResult]::Cancel) $false)
  $y = $y + $btnH + $btnGap
} else {
  [void](New-Btn '允许一次' 18 $y 120 ([System.Windows.Forms.DialogResult]::Yes) $true)
  [void](New-Btn '拒绝' 148 $y 120 ([System.Windows.Forms.DialogResult]::No) $false)
  [void](New-Btn '交给浏览器' 278 $y 174 ([System.Windows.Forms.DialogResult]::Cancel) $false)
  $y = $y + $btnH + $btnGap
}

$lblCount = New-Object System.Windows.Forms.Label
$lblCount.Text = "$timeoutSec 秒后自动交给浏览器处理"
$lblCount.Font = $fontSmall
$lblCount.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 150)
$lblCount.Location = New-Object System.Drawing.Point(18, $y)
$lblCount.Size = New-Object System.Drawing.Size(434, 20)
$form.Controls.Add($lblCount)

# Shown：窗口真正出现之后才谈得上抢焦点
# （ShowDialog() 之前窗口还没创建，那时调 Activate() 是空操作 —— 踩过这个坑）
$form.Add_Shown({
    Write-Diag "Shown: loc=($($form.Location.X),$($form.Location.Y)) size=$($form.Width)x$($form.Height) visible=$($form.Visible)"
    try {
      $form.TopMost = $true
      $form.Activate()
      $form.BringToFront()
    } catch { Write-Diag "抢焦点异常：$($_.Exception.Message)" }
    try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }

    # 3 秒后复查：被别的窗口抢走就再抢一次
    $script:retry = New-Object System.Windows.Forms.Timer
    $script:retry.Interval = 3000
    $script:retry.Add_Tick({
        $script:retry.Stop()
        try {
          $active = [System.Windows.Forms.Form]::ActiveForm
          $isMine = ($active -ne $null) -and ($active -eq $form)
          Write-Diag "3s复查: 前台是我的=$isMine activeForm='$($active -ne $null)' topMost=$($form.TopMost) visible=$($form.Visible) loc=($($form.Location.X),$($form.Location.Y))"
          if (-not $isMine) {
            $form.Activate()
            $form.BringToFront()
            Write-Diag "重新抢了一次焦点"
          }
        } catch { Write-Diag "复查异常：$($_.Exception.Message)" }
      })
    $script:retry.Start()
  })

# 倒计时：到点自己关掉，结果 = browser
$script:left = $timeoutSec
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    $script:left--
    if ($script:left -le 0) {
      $timer.Stop()
      $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
      $form.Close()
      return
    }
    $lblCount.Text = "$script:left 秒后自动交给浏览器处理"
  })
$timer.Start()

Write-Diag "即将 ShowDialog（超时 ${timeoutSec}s）"
try { $form.ShowDialog() | Out-Null } catch { Write-Diag "ShowDialog 异常：$($_.Exception.Message)" }
$timer.Stop()
Write-Diag "ShowDialog 返回：$($form.DialogResult)"

if ($isSimpleQuestion) {
  if ($script:picked) { Write-Result $script:picked } else { Write-Result 'browser' }
} else {
  switch ($form.DialogResult) {
    ([System.Windows.Forms.DialogResult]::Yes) { Write-Result 'allowed-once' }
    ([System.Windows.Forms.DialogResult]::No) { Write-Result 'rejected' }
    default { Write-Result 'browser' }
  }
}
