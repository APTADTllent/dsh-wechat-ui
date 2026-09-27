<#
  region-ask.ps1 —— 框选屏幕的一块，直接问 AI
  ============================================

  由 hotkey-watch.ps1 在按下热键时拉起。

  流程：
    1. 先把整个虚拟桌面抓下来当背景
    2. 铺一层全屏半透明遮罩，鼠标拖拽框选（框内保持明亮）
    3. 松开鼠标 → 裁剪那块 → 存成 PNG
    4. 弹一个很小的输入框（预填默认问题，回车发送 / Esc 取消）
    5. 把 PNG + 问题写进「收件箱」目录，由插件取走发进会话

  ⚠️ 为什么走文件而不是 HTTP：这样脚本完全不需要知道 DSH 端口，
     也不用碰插件的鉴权。插件只要轮询自己的 inbox 目录就行。

  ⚠️ 必须 UTF-8 带 BOM（PowerShell 5.1 会按 ANSI 读无 BOM 脚本）。
#>
param(
  [Parameter(Mandatory = $true)][string]$ShotsDir,
  [string]$DefaultQuestion = '这是我从屏幕上框选的一块，请帮我看看这是什么 / 有什么问题。',
  [int]$MaxWidth = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI 感知，否则缩放屏上坐标会错
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RegionDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@ -ErrorAction SilentlyContinue
  [void][RegionDpi]::SetProcessDPIAware()
} catch { }

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { exit 1 }

# 1) 背景：整个虚拟桌面
$bg = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bg)
try {
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bg.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally { $g.Dispose() }

# 2) 全屏选择窗口
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = $bounds
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.DoubleBuffered = $true

$script:sel = $null        # 选择框（屏幕坐标）
$script:start = $null
$script:done = $false
$script:cropPath = ''

$form.Add_MouseDown({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) { $script:done = $true; $form.Close(); return }
    $script:start = New-Object System.Drawing.Point($e.X, $e.Y)
    $script:sel = New-Object System.Drawing.Rectangle($e.X, $e.Y, 0, 0)
    $form.Invalidate()
  })

$form.Add_MouseMove({
    param($s, $e)
    if ($null -eq $script:start) { return }
    $x = [Math]::Min($script:start.X, $e.X); $y = [Math]::Min($script:start.Y, $e.Y)
    $w = [Math]::Abs($e.X - $script:start.X); $h = [Math]::Abs($e.Y - $script:start.Y)
    $script:sel = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    $form.Invalidate()
  })

$form.Add_MouseUp({
    param($s, $e)
    if ($null -eq $script:sel -or $script:sel.Width -lt 8 -or $script:sel.Height -lt 8) {
      # 太小当作误触，不发送，直接退出
      $script:done = $true; $form.Close(); return
    }
    $form.Close()
  })

$form.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:done = $true; $form.Close() }
  })

$form.Add_Paint({
    param($s, $e)
    try {
      $e.Graphics.DrawImage($bg, 0, 0)
      # 整屏压暗
      $dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
      $e.Graphics.FillRectangle($dim, 0, 0, $form.ClientSize.Width, $form.ClientSize.Height)
      $dim.Dispose()
      if ($script:sel -and $script:sel.Width -gt 0 -and $script:sel.Height -gt 0) {
        # 选中的那块还原成亮的
        $e.Graphics.DrawImage($bg,
          (New-Object System.Drawing.Rectangle($script:sel.X, $script:sel.Y, $script:sel.Width, $script:sel.Height)),
          (New-Object System.Drawing.Rectangle($script:sel.X, $script:sel.Y, $script:sel.Width, $script:sel.Height)),
          [System.Drawing.GraphicsUnit]::Pixel)
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(7, 193, 96), 2)
        $e.Graphics.DrawRectangle($pen, $script:sel)
        $pen.Dispose()
        # 尺寸提示（用 RectangleF，踩过 PointF 重载的坑）
        $txt = "$($script:sel.Width) x $($script:sel.Height)"
        $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        $pt = New-Object System.Drawing.PointF([float]($script:sel.X + 6), [float]([Math]::Max(2, $script:sel.Y - 22)))
        $e.Graphics.DrawString($txt, $font, $brush, $pt)
        $font.Dispose(); $brush.Dispose()
      }
    } catch { }
  })

[void]$form.ShowDialog()
$form.Dispose()

if (-not $script:sel -or $script:sel.Width -lt 8 -or $script:sel.Height -lt 8) {
  $bg.Dispose()
  exit 0
}

# 3) 裁剪
$sel = $script:sel
$crop = New-Object System.Drawing.Bitmap($sel.Width, $sel.Height)
$gc = [System.Drawing.Graphics]::FromImage($crop)
try {
  $gc.DrawImage($bg, (New-Object System.Drawing.Rectangle(0, 0, $sel.Width, $sel.Height)),
    (New-Object System.Drawing.Rectangle($sel.X, $sel.Y, $sel.Width, $sel.Height)),
    [System.Drawing.GraphicsUnit]::Pixel)
} finally { $gc.Dispose() }
$bg.Dispose()

# 需要的话缩小（省 token）
if ($MaxWidth -gt 0 -and $crop.Width -gt $MaxWidth) {
  $r = $MaxWidth / $crop.Width
  $small = New-Object System.Drawing.Bitmap([int]($crop.Width * $r), [int]($crop.Height * $r))
  $gs = [System.Drawing.Graphics]::FromImage($small)
  try {
    $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gs.DrawImage($crop, 0, 0, $small.Width, $small.Height)
  } finally { $gs.Dispose() }
  $crop.Dispose()
  $crop = $small
}

# 4) 问一句（可直接回车用默认问题）
$qForm = New-Object System.Windows.Forms.Form
$qForm.Text = '问 AI'
$qForm.ClientSize = New-Object System.Drawing.Size(520, 128)
$qForm.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$qForm.TopMost = $true
$qForm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)

$qBox = New-Object System.Windows.Forms.TextBox
$qBox.Multiline = $true
$qBox.Location = New-Object System.Drawing.Point(10, 10)
$qBox.Size = New-Object System.Drawing.Size(500, 74)
$qBox.Text = $DefaultQuestion
$qForm.Controls.Add($qBox)

$qOk = New-Object System.Windows.Forms.Button
$qOk.Text = '发送（Enter）'
$qOk.Location = New-Object System.Drawing.Point(380, 90)
$qOk.Size = New-Object System.Drawing.Size(130, 28)
$qForm.Controls.Add($qOk)

$qHint = New-Object System.Windows.Forms.Label
$qHint.Location = New-Object System.Drawing.Point(10, 94)
$qHint.Size = New-Object System.Drawing.Size(360, 22)
$qHint.Text = 'Esc 取消 · 可以改问题'
$qForm.Controls.Add($qHint)

$script:qSend = $false
$qSend2 = {
  $script:qSend = $true
  $qForm.Close()
}
$qOk.Add_Click($qSend2)
$qBox.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $qForm.Close() }
    elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter -and -not $e.Shift -and -not $e.Control) {
      $script:qSend = $true; $e.SuppressKeyPress = $true; $qForm.Close()
    }
  })
$qForm.Add_Shown({ $qBox.Focus(); $qBox.SelectAll() })
[void]$qForm.ShowDialog()

if (-not $script:qSend) { $crop.Dispose(); exit 0 }
$question = $qBox.Text.Trim()
$qForm.Dispose()

# 5) 写进收件箱（插件轮询取走）
if (-not (Test-Path $ShotsDir)) { New-Item -ItemType Directory -Force -Path $ShotsDir | Out-Null }
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$png = Join-Path $ShotsDir "region-$stamp.png"
$json = Join-Path $ShotsDir "region-$stamp.json"
try {
  $crop.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $crop.Dispose() }

@{
  file     = (Split-Path $png -Leaf)
  question = $question
  width    = $sel.Width
  height   = $sel.Height
  at       = $stamp
} | ConvertTo-Json -Compress | Set-Content -Path $json -Encoding UTF8

exit 0
