<#
  hotkey-watch.ps1 —— 常驻，等一个全局热键
  ==========================================

  默认热键：Ctrl + Alt + Q
  按下后拉起 region-ask.ps1（框选 → 提问 → 写进收件箱）。

  由插件在启动时拉起；插件卸载/退出时把它杀掉。

  ⚠️ 全局热键是【整机唯一】的：第二个注册的会失败。
     所以两个 DSH 实例同时跑时，只有先起来的那个拿得到热键（这是预期行为）。
     实验室那个用 DSH_WECHAT_HOTKEY=0 关掉即可。

  ⚠️ 必须 UTF-8 带 BOM。
#>
param(
  [Parameter(Mandatory = $true)][string]$ShotsDir,
  [string]$LogPath = '',
  [string]$Keys = 'Ctrl+Alt+Q'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Write-Log([string]$m) {
  if (-not $LogPath) { return }
  try { [System.IO.File]::AppendAllText($LogPath, "$(Get-Date -Format 'MM-dd HH:mm:ss')  $m`r`n", [System.Text.Encoding]::UTF8) } catch { }
}

# 解析热键
$mods = 0
$vk = 0
$parts = $Keys -split '\+'
foreach ($p in $parts) {
  switch ($p.Trim().ToUpper()) {
    'CTRL' { $mods = $mods -bor 0x0002 }
    'CONTROL' { $mods = $mods -bor 0x0002 }
    'ALT' { $mods = $mods -bor 0x0001 }
    'SHIFT' { $mods = $mods -bor 0x0004 }
    'WIN' { $mods = $mods -bor 0x0008 }
    default {
      $k = $p.Trim().ToUpper()
      if ($k.Length -eq 1) { $vk = [int][char]$k }
      else { $vk = [int][System.Windows.Forms.Keys]::$k }
    }
  }
}
if ($mods -eq 0 -or $vk -eq 0) { Write-Log "热键解析失败: $Keys"; exit 1 }

Add-Type -TypeDefinition @"
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class DshHotKeyForm : Form {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event EventHandler Pressed;
  private int _id;
  private bool _ok;
  public bool Registered { get { return _ok; } }
  public DshHotKeyForm(int id, uint mods, uint vk) {
    _id = id;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    _ok = RegisterHotKey(this.Handle, id, mods, vk);
  }
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312 && m.WParam.ToInt32() == _id) {
      EventHandler h = Pressed;
      if (h != null) { try { h(this, EventArgs.Empty); } catch { } }
    }
    base.WndProc(ref m);
  }
}
"@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -ErrorAction Stop

$form = New-Object DshHotKeyForm(1, [uint32]$mods, [uint32]$vk)
if (-not $form.Registered) {
  Write-Log "注册热键 $Keys 失败（多半已经被另一个实例占用了），本进程退出"
  exit 2
}

$script:regionScript = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'region-ask.ps1'

$form.add_Pressed({
    Write-Log "热键按下，拉起框选"
    try {
      Start-Process -FilePath 'powershell' -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:regionScript,
        '-ShotsDir', $ShotsDir
      ) -WindowStyle Hidden
    } catch {
      Write-Log ("拉起框选失败: " + $_.Exception.Message)
    }
  })

Write-Log "热键已注册: $Keys  收件箱=$ShotsDir  进程=$PID"
try {
  [System.Windows.Forms.Application]::Run($form)
} catch {
  Write-Log ("消息循环退出: " + $_.Exception.Message)
}
Write-Log '监听结束'
exit 0
