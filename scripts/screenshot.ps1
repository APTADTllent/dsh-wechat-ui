<#
  screenshot.ps1 —— 截取桌面
  ========================

  独立脚本，不依赖 DSH。宿主半或用户都可以直接调。

  ⚠️ 这个文件必须是「UTF-8 带 BOM」（同 desktop-approval.ps1 的理由：
     PowerShell 5.1 会按 ANSI 读无 BOM 脚本，中文直接乱码报错）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File screenshot.ps1 `
      -Out "D:\shots\latest.png" [-Mode entire|primary] [-MaxWidth 1280] [-MaxKeep 10]

  参数：
    -Out       输出 PNG 路径
    -Mode      entire = 所有显示器拼起来（默认）；primary = 只主屏
    -MaxWidth  超过这个宽度就等比缩小（省 token；0 = 不缩）
    -MaxKeep   只保留最近 N 张（按文件名排序删旧的；0 = 不清理）

  输出：成功时往 stdout 写一行 JSON（含路径、尺寸、字节数、耗时）
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [ValidateSet('entire', 'primary')][string]$Mode = 'entire',
  [int]$MaxWidth = 1280,
  [int]$MaxKeep = 10,
  # 画面和上一张完全一样时不写文件（定时截屏用得上：你盯着文档不动的时候，
  # 每 60 秒存一张一模一样的图纯属白占磁盘）
  [switch]$SkipIfSame
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 让进程「DPI 感知」——否则在缩放 125%/150% 的屏幕上只能截到左上角一块
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@ -ErrorAction SilentlyContinue
  [void][DpiAware]::SetProcessDPIAware()
} catch { }

# 目标区域
if ($Mode -eq 'primary') {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
} else {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
}

if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
  Write-Output '{"ok":false,"error":"bad-screen-bounds"}'
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally { $g.Dispose() }

  # 等比缩小
  $final = $bmp
  if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
    $ratio = $MaxWidth / $bmp.Width
    $nw = [int]($bmp.Width * $ratio)
    $nh = [int]($bmp.Height * $ratio)
    $small = New-Object System.Drawing.Bitmap($nw, $nh)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    try {
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bmp, 0, 0, $nw, $nh)
    } finally { $g2.Dispose() }
    $final = $small
  }

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  # -SkipIfSame：算一个"画面指纹"，跟上一张比；一样就不落盘
  #
  # ⚠ 指纹不能用整图的哈希 —— 第一版就是这么写的，结果永远不相等：
  #   输入框里闪烁的光标、任何小动画，都会让整图像素每帧都在变。
  #   改成"极度缩小 + 颜色量化"：缩到 64x40、隔一个像素取一个、每通道压到 16 级。
  #   光标闪烁这类小变化被平均掉了，而换窗口 / 滚动 / 画面大幅变化照样看得出来。
  $script:skipped = $false
  if ($SkipIfSame) {
    $hashFile = Join-Path $dir '.last-image-hash'
    $thumb = New-Object System.Drawing.Bitmap(64, 40)
    $gt = [System.Drawing.Graphics]::FromImage($thumb)
    try {
      $gt.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $gt.DrawImage($final, 0, 0, 64, 40)
    } finally { $gt.Dispose() }

    # 采样 32x20 个点的原始 RGB（每点 3 字节），存成 base64 当"上一张"的记录
    $samples = New-Object byte[] (32 * 20 * 3)
    $k = 0
    for ($yy = 0; $yy -lt 40; $yy += 2) {
      for ($xx = 0; $xx -lt 64; $xx += 2) {
        $c = $thumb.GetPixel($xx, $yy)
        $samples[$k] = $c.R; $samples[$k + 1] = $c.G; $samples[$k + 2] = $c.B
        $k += 3
      }
    }
    $thumb.Dispose()

    $prevBytes = $null
    if (Test-Path $hashFile) {
      try { $prevBytes = [System.Convert]::FromBase64String((Get-Content $hashFile -Raw).Trim()) } catch { $prevBytes = $null }
    }

    # ⚠ 判等用「平均绝对差」，不要用"逐字符完全相同"。
    #   踩过的坑：先按 16 级量化成字符串再比，通道差 1 级就算不同 ——
    #   实测同一块静态画面相邻两帧经常差 8~15%（光标闪烁），于是永远不跳过。
    #   平均绝对差对这类噪声天然鲁棒：光标只影响少数采样点，均值仍然很低；
    #   而换窗口 / 滚动 / 画面大变会把均值直接顶上去。
    $same = $false
    if ($prevBytes -and $prevBytes.Length -eq $samples.Length) {
      $sum = 0
      for ($i = 0; $i -lt $samples.Length; $i++) { $sum += [Math]::Abs([int]$samples[$i] - [int]$prevBytes[$i]) }
      $mad = $sum / $samples.Length
      $same = ($mad -le 4)     # 平均每通道差 ≤ 4/255 就算"画面没变"
    }

    if ($same) {
      $script:skipped = $true
    } else {
      $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      Set-Content -Path $hashFile -Value ([System.Convert]::ToBase64String($samples)) -Encoding ASCII
    }
  } else {
    $final.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  }

  $outW = $final.Width
  $outH = $final.Height
  if ($final -ne $bmp) { $final.Dispose() }
} finally {
  $bmp.Dispose()
}

# 画面没变：不生成文件，直接回报 skipped
if ($script:skipped) {
  [ordered]@{
    ok      = $true
    skipped = $true
    reason  = 'unchanged'
    path    = ''
    width   = $outW
    height  = $outH
    bytes   = 0
    kept    = $MaxKeep
    removed = 0
    ms      = [int]$sw.Elapsed.TotalMilliseconds
    screen  = "$($bounds.Width)x$($bounds.Height)"
    mode    = $Mode
  } | ConvertTo-Json -Compress
  exit 0
}

$info = Get-Item $Out

# 只保留最近 N 张
$removed = 0
if ($MaxKeep -gt 0) {
  $dir = Split-Path -Parent $Out
  $like = [System.IO.Path]::GetFileNameWithoutExtension($Out)
  $siblings = Get-ChildItem -Path $dir -Filter '*.png' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($siblings.Count -gt $MaxKeep) {
    $siblings | Select-Object -Skip $MaxKeep | ForEach-Object {
      try { Remove-Item $_.FullName -Force; $removed++ } catch { }
    }
  }
}

$result = [ordered]@{
  ok       = $true
  path     = $info.FullName
  width    = $outW
  height   = $outH
  bytes    = $info.Length
  kept     = $MaxKeep
  removed  = $removed
  ms       = [int]$sw.Elapsed.TotalMilliseconds
  screen   = "$($bounds.Width)x$($bounds.Height)"
  mode     = $Mode
}
$result | ConvertTo-Json -Compress
