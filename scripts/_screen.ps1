Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R2,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
'@
$h = [IntPtr]197832
[void][W]::ShowWindow($h, 9)
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 900
$cr = New-Object W+RECT; [void][W]::GetClientRect($h, [ref]$cr)
$p = New-Object W+POINT; $p.X = 0; $p.Y = 0; [void][W]::ClientToScreen($h, [ref]$p)
$bmp = New-Object System.Drawing.Bitmap($cr.R2, $cr.B)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($p.X, $p.Y, 0, 0, (New-Object System.Drawing.Size($cr.R2, $cr.B)))
$g.Dispose()
$bmp.Save('C:\Users\abstudio\.openclaw\workspace\ui-screen.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("captured " + $cr.R2 + "x" + $cr.B + " at " + $p.X + "," + $p.Y)