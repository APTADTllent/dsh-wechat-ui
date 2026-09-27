<#
  desktop-toast.ps1 —— 桌面顶部弹出的微信风格通知
  ==============================================

  独立脚本，宿主半调用。无边框、圆角、半透明、顶部居中、到点自动关闭。

  ⚠️ 必须是「UTF-8 带 BOM」（PowerShell 5.1 会按 ANSI 读无 BOM 脚本）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File desktop-toast.ps1 `
      -Text "消息内容" [-Slot 0] [-Duration 6] [-MaxWidth 560] [-DiagPath <日志>]

  参数：
    -Text      要显示的文本（已由调用方截断好）
    -Slot      第几个弹窗（0 起），向下堆叠避免互相盖住
    -Duration  显示秒数
    -MaxWidth  最大宽度（像素）
    -DiagPath  可选：把关键步骤写进这个文件，便于排查

  注：这一版刻意不做淡出动画。之前用嵌套 Timer 做淡出，在 PowerShell 5.1 里
      会因为作用域问题让脚本挂住 60 秒以上（实测 67648ms 才退出）。
      最简单的「到点 Close」最可靠，观感上的损失可以接受。
#>
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [int]$Slot = 0,
  [int]$Duration = 6,
  [int]$MaxWidth = 560,
  [double]$Opacity = 0.94,
  [string]$DiagPath = ''
)

function Write-Diag([string]$message) {
  if (-not $DiagPath) { return }
  try {
    [System.IO.File]::AppendAllText($DiagPath, "$(Get-Date -Format 'HH:mm:ss.fff')  $message`r`n", [System.Text.Encoding]::UTF8)
  } catch { }
}

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Text)) { Write-Diag '空文本，直接退出'; exit 0 }

Write-Diag "启动 slot=$Slot dur=$Duration text=$($Text.Length)字"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# DPI 感知，避免缩放屏上算错尺寸
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ToastDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@ -ErrorAction SilentlyContinue
  [void][ToastDpi]::SetProcessDPIAware()
} catch { }

$script:font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5)
$script:padX = 18
$script:padY = 13
$radius = 14

$measure = [System.Windows.Forms.TextRenderer]::MeasureText(
  $Text, $script:font,
  (New-Object System.Drawing.Size(($MaxWidth - $script:padX * 2), 2000)),
  [System.Windows.Forms.TextFormatFlags]::WordBreak)

$w = [int][Math]::Min($MaxWidth, [Math]::Max(220, $measure.Width + $script:padX * 2))
$h = [int]($measure.Height + $script:padY * 2)
Write-Diag "尺寸 ${w}x${h}"

$script:form = New-Object System.Windows.Forms.Form
$form = $script:form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 33, 36)
$form.Opacity = [Math]::Max(0.2, [Math]::Min(1.0, $Opacity))
$form.Size = New-Object System.Drawing.Size($w, $h)

# 顶部居中；按 Slot 向下堆叠
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$gap = 10
$x = [int]($wa.X + ($wa.Width - $w) / 2)
$y = [int]($wa.Y + 14 + $Slot * ($h + $gap))
if ($y + $h -gt $wa.Y + $wa.Height) { $y = [int]($wa.Y + $wa.Height - $h - $gap) }
$form.Location = New-Object System.Drawing.Point($x, $y)
Write-Diag "位置 ($x,$y) 屏幕 $($wa.Width)x$($wa.Height)"

# 圆角
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($w - $d, 0, $d, $d, 270, 90)
$path.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
$path.AddArc(0, $h - $d, $d, $d, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)

# 画：左侧绿条 + 正文
#
# ⚠️ 这里所有东西都必须走 $script: 作用域。
# 踩过的坑：原来正文写的是裸变量 $Text，事件处理器里取到的是 $null，
# DrawString 抛异常被 catch 吞掉 —— 结果窗口正常弹出、绿条也画得出来，
# 但**正文一片空白**。用户看到的就是一个空的深色条，根本认不出是消息。
$script:toastText = $Text
$script:toastFont = $script:font
$script:toastDiag = $DiagPath
$form.Add_Paint({
    param($sender, $e)
    try {
      $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $e.Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

      $bar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(7, 193, 96))
      $e.Graphics.FillRectangle($bar, 0, 0, 4, $sender.ClientSize.Height)
      $bar.Dispose()

      $fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 238, 240))
      # ⚠ 必须显式用 RectangleF。
      # 踩过的坑：传 System.Drawing.Rectangle 时，PowerShell 会去选
      #   DrawString(string, Font, Brush, PointF)
      # 这个重载，而 Rectangle 转不成 PointF，于是抛
      #   "Cannot convert ... to type System.Drawing.PointF"
      # 异常又被 catch 吞掉 —— 窗口正常弹出、绿条也画得出来，只有正文空白。
      $rect = New-Object System.Drawing.RectangleF(
        [float]$script:padX, [float]$script:padY,
        [float]($sender.ClientSize.Width - $script:padX * 2),
        [float]($sender.ClientSize.Height - $script:padY * 2))
      $e.Graphics.DrawString([string]$script:toastText, $script:toastFont, $fg, $rect)
      $fg.Dispose()
    } catch {
      # 绝不能再静默失败：画不出来必须留下证据
      if ($script:toastDiag) {
        try {
          [System.IO.File]::AppendAllText($script:toastDiag,
            "$(Get-Date -Format 'HH:mm:ss.fff')  绘制失败: $($_.Exception.Message)`r`n",
            [System.Text.Encoding]::UTF8)
        } catch { }
      }
    }
  })

# 到点关闭（不做动画）
$script:timer = New-Object System.Windows.Forms.Timer
$timer = $script:timer
$timer.Interval = [Math]::Max(1, $Duration) * 1000
$timer.Add_Tick({
    try { $script:timer.Stop() } catch { }
    try { $script:form.Close() } catch { }
  })
$timer.Start()

Write-Diag '即将 ShowDialog'
try {
  [void]$form.ShowDialog()
  Write-Diag 'ShowDialog 已返回'
} catch {
  Write-Diag "ShowDialog 异常：$($_.Exception.Message)"
}
try { $timer.Stop(); $timer.Dispose() } catch { }
try { $form.Dispose() } catch { }
Write-Diag '结束'
exit 0
