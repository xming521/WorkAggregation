param([Parameter(Mandatory=$true)][long]$WindowHandle, [Parameter(Mandatory=$true)][uint32]$OwnerProcessId,
  [Parameter(Mandatory=$true)][double]$XRatio, [Parameter(Mandatory=$true)][double]$YRatio)
$ErrorActionPreference = 'Stop'
if ($XRatio -lt 0.1 -or $XRatio -gt 0.9 -or $YRatio -lt 0.1 -or $YRatio -gt 0.9) { throw 'Unsafe owned-window click point' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HaruOwnedMouse {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X=x; Y=y; } }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$handle = [IntPtr]$WindowHandle
$actualPid = [uint32]0
[void][HaruOwnedMouse]::GetWindowThreadProcessId($handle, [ref]$actualPid)
if ($actualPid -ne $OwnerProcessId) { throw 'Window does not belong to the launched Electron process' }
$box = New-Object HaruOwnedMouse+RECT
if (-not [HaruOwnedMouse]::GetWindowRect($handle, [ref]$box)) { throw 'Owned window rectangle unavailable' }
$pointerX = [int]($box.Left + ($box.Right - $box.Left) * $XRatio)
$pointerY = [int]($box.Top + ($box.Bottom - $box.Top) * $YRatio)
$under = [HaruOwnedMouse]::GetAncestor([HaruOwnedMouse]::WindowFromPoint([HaruOwnedMouse+POINT]::new($pointerX, $pointerY)), 2)
if ($under -ne $handle) { throw 'Another window covers the intended owned-window point' }
if (-not [HaruOwnedMouse]::SetCursorPos($pointerX, $pointerY)) { throw 'Cursor move failed' }
try {
  [HaruOwnedMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  for ($step = 1; $step -le 8; $step++) {
    [void][HaruOwnedMouse]::SetCursorPos($pointerX - $step * 5, $pointerY - $step * 3)
    Start-Sleep -Milliseconds 60
  }
} finally { [HaruOwnedMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
Write-Output '{"ownedNativeDrag":true}'
