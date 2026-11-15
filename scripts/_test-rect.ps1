Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class T {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,Tt,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
}
'@
foreach ($hv in @(197832,2688204)) {
  $h = [IntPtr]$hv
  $p = New-Object T+POINT
  $p.X = 0; $p.Y = 0
  $ok = [T]::ClientToScreen($h, [ref]$p)
  $wr = New-Object T+RECT; [void][T]::GetWindowRect($h, [ref]$wr)
  $cr = New-Object T+RECT; [void][T]::GetClientRect($h, [ref]$cr)
  Write-Output ("hwnd=$hv ok=$ok origin=($($p.X),$($p.Y)) win=($($wr.L),$($wr.Tt))-$($wr.R)x$($wr.B) client=$($cr.R)x$($cr.B)")
}