#requires -version 5.1
# GameAgent Web native host: line-delimited JSON over stdin/stdout.
# Pure ASCII on purpose: Windows PowerShell 5.1 parses it without a BOM.
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$cs = @'
using System;
using System.Collections;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeOps
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000;
    const uint PW_RENDERFULLCONTENT = 0x2;

    static string ProcName(uint pid)
    {
        try { return Process.GetProcessById((int)pid).ProcessName; }
        catch { return "unknown"; }
    }

    static Hashtable Info(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        var sb = new StringBuilder(GetWindowTextLength(hwnd) + 2);
        GetWindowText(hwnd, sb, sb.Capacity);
        RECT cr;
        GetClientRect(hwnd, out cr);
        var d = new Hashtable();
        d["pid"] = (int)pid;
        d["hwnd"] = hwnd.ToInt64().ToString();
        d["title"] = sb.ToString();
        d["processName"] = ProcName(pid);
        d["width"] = cr.Right - cr.Left;
        d["height"] = cr.Bottom - cr.Top;
        d["isForeground"] = GetForegroundWindow() == hwnd;
        return d;
    }

    public static ArrayList GetWindowList()
    {
        var list = new ArrayList();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) <= 0) return true;
            RECT cr;
            GetClientRect(hWnd, out cr);
            if (cr.Right - cr.Left < 40 || cr.Bottom - cr.Top < 40) return true;
            list.Add(Info(hWnd));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static Hashtable GetWindowInfo(long hwndValue)
    {
        return Info(new IntPtr(hwndValue));
    }

    public static int[] ClientOrigin(long hwndValue)
    {
        var hwnd = new IntPtr(hwndValue);
        var p = new POINT();
        p.X = 0;
        p.Y = 0;
        ClientToScreen(hwnd, ref p);
        return new int[] { p.X, p.Y };
    }

    public static bool Activate(long hwndValue)
    {
        var hwnd = new IntPtr(hwndValue);
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        return SetForegroundWindow(hwnd);
    }

    public static Hashtable ForegroundInfo()
    {
        return Info(GetForegroundWindow());
    }

    // True when another top-level window sits at the centre of the client area.
    // Uses WindowFromPoint only: no activation, no z-order change.
    public static bool IsOccluded(long hwndValue)
    {
        var hwnd = new IntPtr(hwndValue);
        RECT cr;
        if (!GetClientRect(hwnd, out cr)) return false;
        var p = new POINT();
        p.X = (cr.Right - cr.Left) / 2;
        p.Y = (cr.Bottom - cr.Top) / 2;
        ClientToScreen(hwnd, ref p);
        IntPtr hit = WindowFromPoint(p);
        if (hit == IntPtr.Zero || hit == hwnd) return false;
        return GetAncestor(hit, 2) != hwnd;
    }

    public static Hashtable WindowState(long hwndValue)
    {
        var hwnd = new IntPtr(hwndValue);
        var d = new Hashtable();
        d["isForeground"] = GetForegroundWindow() == hwnd;
        d["minimized"] = IsIconic(hwnd);
        d["visible"] = IsWindowVisible(hwnd);
        d["occluded"] = IsOccluded(hwndValue);
        return d;
    }

    static Hashtable SaveScaled(Bitmap bmp, int maxWidth, string outPath, string format)
    {
        int w = bmp.Width, h = bmp.Height;
        Bitmap scaled = bmp;
        if (maxWidth > 0 && w > maxWidth)
        {
            int nw = maxWidth;
            int nh = Math.Max(1, (int)Math.Round((double)h * nw / w));
            scaled = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(bmp, 0, 0, nw, nh);
            }
        }
        try
        {
            if (string.Equals(format, "png", StringComparison.OrdinalIgnoreCase))
            {
                scaled.Save(outPath, ImageFormat.Png);
            }
            else
            {
                var codec = GetEncoder(ImageFormat.Jpeg);
                var eps = new EncoderParameters(1);
                eps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 60L);
                scaled.Save(outPath, codec, eps);
            }
            var meta = new Hashtable();
            meta["width"] = scaled.Width;
            meta["height"] = scaled.Height;
            meta["clientWidth"] = w;
            meta["clientHeight"] = h;
            meta["path"] = outPath;
            return meta;
        }
        finally
        {
            if (!ReferenceEquals(scaled, bmp)) scaled.Dispose();
        }
    }

    // Sampled uniformity check: a minimized / non-rendering window yields one flat colour.
    static bool IsBlank(Bitmap bmp)
    {
        int stepX = Math.Max(1, bmp.Width / 48);
        int stepY = Math.Max(1, bmp.Height / 48);
        int r0 = -1, g0 = 0, b0 = 0;
        for (int y = 0; y < bmp.Height; y += stepY)
        {
            for (int x = 0; x < bmp.Width; x += stepX)
            {
                Color c = bmp.GetPixel(x, y);
                if (r0 < 0) { r0 = c.R; g0 = c.G; b0 = c.B; }
                else if (Math.Abs(c.R - r0) > 6 || Math.Abs(c.G - g0) > 6 || Math.Abs(c.B - b0) > 6) return false;
            }
        }
        return true;
    }

    // Background capture: PrintWindow only. Never grabs screen pixels, never activates,
    // never restores a minimized window - so concurrent sessions cannot steal focus
    // from each other and an occluded window still yields its own content.
    public static Hashtable CaptureBackground(long hwndValue, int maxWidth, string outPath, string format)
    {
        var hwnd = new IntPtr(hwndValue);
        bool minimized = IsIconic(hwnd);
        RECT cr, wr;
        if (!GetClientRect(hwnd, out cr)) throw new Exception("GetClientRect failed");
        int cw = cr.Right - cr.Left, ch = cr.Bottom - cr.Top;
        if (cw <= 0 || ch <= 0) throw new Exception("window has no client area");
        if (!GetWindowRect(hwnd, out wr)) throw new Exception("GetWindowRect failed");
        int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
        if (ww <= 0 || wh <= 0 || ww >= 20000 || wh >= 20000) throw new Exception("invalid window size");

        using (var shot = new Bitmap(ww, wh, PixelFormat.Format32bppArgb))
        {
            bool ok = false;
            using (var g = Graphics.FromImage(shot))
            {
                IntPtr hdc = g.GetHdc();
                try { ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
            }
            if (!ok)
            {
                using (var g2 = Graphics.FromImage(shot))
                {
                    IntPtr hdc2 = g2.GetHdc();
                    try { ok = PrintWindow(hwnd, hdc2, 0); }
                    finally { g2.ReleaseHdc(hdc2); }
                }
            }
            if (!ok) throw new Exception("PrintWindow failed: window is minimized or cannot render in background");

            var cp = new POINT();
            ClientToScreen(hwnd, ref cp);
            int ox = cp.X - wr.Left, oy = cp.Y - wr.Top;
            if (ox < 0 || oy < 0 || ox + cw > shot.Width || oy + ch > shot.Height)
                throw new Exception("client area outside window");

            using (var crop = new Bitmap(cw, ch, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(crop))
                {
                    g.DrawImage(shot, new Rectangle(0, 0, cw, ch), new Rectangle(ox, oy, cw, ch), GraphicsUnit.Pixel);
                }
                bool blank = IsBlank(crop);
                var meta = SaveScaled(crop, maxWidth, outPath, format);
                meta["method"] = "printwindow";
                meta["minimized"] = minimized;
                meta["isForeground"] = GetForegroundWindow() == hwnd;
                meta["occluded"] = IsOccluded(hwndValue);
                meta["blank"] = blank;
                return meta;
            }
        }
    }

    static Bitmap CaptureClient(IntPtr hwnd)
    {
        RECT cr, wr;
        if (!GetClientRect(hwnd, out cr)) throw new Exception("GetClientRect failed");
        int cw = cr.Right - cr.Left, ch = cr.Bottom - cr.Top;
        if (cw <= 0 || ch <= 0) throw new Exception("window has no client area");

        Bitmap windowShot = null;
        try
        {
            GetWindowRect(hwnd, out wr);
            int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
            if (ww > 0 && wh > 0 && ww < 20000 && wh < 20000)
            {
                windowShot = new Bitmap(ww, wh, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(windowShot))
                {
                    IntPtr hdc = g.GetHdc();
                    bool ok = false;
                    try { ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                    finally { g.ReleaseHdc(hdc); }
                    if (!ok) { windowShot.Dispose(); windowShot = null; }
                }
            }
        }
        catch { if (windowShot != null) { windowShot.Dispose(); windowShot = null; } }

        if (windowShot != null)
        {
            var cp = new POINT();
            ClientToScreen(hwnd, ref cp);
            GetWindowRect(hwnd, out wr);
            int ox = cp.X - wr.Left, oy = cp.Y - wr.Top;
            if (ox >= 0 && oy >= 0 && ox + cw <= windowShot.Width && oy + ch <= windowShot.Height)
            {
                var crop = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(crop))
                {
                    g.DrawImage(windowShot, new Rectangle(0, 0, cw, ch), new Rectangle(ox, oy, cw, ch), GraphicsUnit.Pixel);
                }
                windowShot.Dispose();
                return crop;
            }
            windowShot.Dispose();
        }

        var bmp = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var cp = new POINT();
            ClientToScreen(hwnd, ref cp);
            IntPtr dst = g.GetHdc();
            IntPtr src = GetDC(IntPtr.Zero);
            try
            {
                BitBlt(dst, 0, 0, cw, ch, src, cp.X, cp.Y, 0x00CC0020 | 0x40000000);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, src);
                g.ReleaseHdc(dst);
            }
        }
        return bmp;
    }

    public static Hashtable Capture(long hwndValue, int maxWidth, string outPath, string format)
    {
        var hwnd = new IntPtr(hwndValue);
        using (var bmp = CaptureClient(hwnd))
        {
            int w = bmp.Width, h = bmp.Height;
            Bitmap scaled = bmp;
            if (maxWidth > 0 && w > maxWidth)
            {
                int nw = maxWidth;
                int nh = Math.Max(1, (int)Math.Round((double)h * nw / w));
                scaled = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(bmp, 0, 0, nw, nh);
                }
            }
            try
            {
                if (string.Equals(format, "png", StringComparison.OrdinalIgnoreCase))
                {
                    scaled.Save(outPath, ImageFormat.Png);
                }
                else
                {
                    var codec = GetEncoder(ImageFormat.Jpeg);
                    var eps = new EncoderParameters(1);
                    eps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 60L);
                    scaled.Save(outPath, codec, eps);
                }
                var meta = new Hashtable();
                meta["width"] = scaled.Width;
                meta["height"] = scaled.Height;
                meta["clientWidth"] = w;
                meta["clientHeight"] = h;
                meta["path"] = outPath;
                return meta;
            }
            finally
            {
                if (!ReferenceEquals(scaled, bmp)) scaled.Dispose();
            }
        }
    }

    static ImageCodecInfo GetEncoder(ImageFormat fmt)
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.FormatID == fmt.Guid) return c;
        return null;
    }

    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    static void MouseDown(string button)
    {
        if (button == "right") mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
        else if (button == "middle") mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, UIntPtr.Zero);
        else mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    }

    static void MouseUp(string button)
    {
        if (button == "right") mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
        else if (button == "middle") mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
        else mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void Click(int x, int y, string button, int count, int holdMs)
    {
        if (x >= 0 && y >= 0) SetCursorPos(x, y);
        for (int i = 0; i < count; i++)
        {
            MouseDown(button);
            System.Threading.Thread.Sleep(holdMs);
            MouseUp(button);
            if (i < count - 1) System.Threading.Thread.Sleep(40);
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button, int steps)
    {
        SetCursorPos(x1, y1);
        System.Threading.Thread.Sleep(30);
        MouseDown(button);
        for (int i = 1; i <= steps; i++)
        {
            int x = x1 + (x2 - x1) * i / steps;
            int y = y1 + (y2 - y1) * i / steps;
            SetCursorPos(x, y);
            System.Threading.Thread.Sleep(8);
        }
        System.Threading.Thread.Sleep(30);
        MouseUp(button);
    }

    public static void Scroll(int delta, bool horizontal)
    {
        uint flag = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
        mouse_event(flag, 0, 0, delta * 120, UIntPtr.Zero);
    }

    static int Vk(string name)
    {
        switch (name)
        {
            case "shift": return 0x10;
            case "ctrl": case "control": return 0x11;
            case "alt": return 0x12;
            case "win": case "lwin": return 0x5B;
            case "enter": case "return": return 0x0D;
            case "tab": return 0x09;
            case "esc": case "escape": return 0x1B;
            case "space": return 0x20;
            case "backspace": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": return 0x2D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": case "prior": return 0x21;
            case "pagedown": case "next": return 0x22;
            case "up": return 0x26;
            case "down": return 0x28;
            case "left": return 0x25;
            case "right": return 0x27;
            case "capslock": return 0x14;
            case "minus": return 0xBD;
            case "equals": return 0xBB;
            case "comma": return 0xBC;
            case "period": return 0xBE;
            case "slash": return 0xBF;
            case "semicolon": return 0xBA;
            case "quote": return 0xDE;
            case "backtick": return 0xC0;
            case "bracketleft": return 0xDB;
            case "bracketright": return 0xDD;
            case "backslash": return 0xDC;
        }
        if (name.Length == 1)
        {
            char c = char.ToUpperInvariant(name[0]);
            if (c >= 'A' && c <= 'Z') return c;
            if (c >= '0' && c <= '9') return c;
            switch (c)
            {
                case '-': return 0xBD;
                case '=': return 0xBB;
                case ',': return 0xBC;
                case '.': return 0xBE;
                case '/': return 0xBF;
                case ';': return 0xBA;
                case '[': return 0xDB;
                case ']': return 0xDD;
            }
        }
        if (name.Length >= 2 && name[0] == 'f')
        {
            int n;
            if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return 0x6F + n;
        }
        throw new Exception("unknown key name: " + name);
    }

    static bool IsExtended(int vk)
    {
        return vk == 0x26 || vk == 0x28 || vk == 0x25 || vk == 0x27 || vk == 0x2D || vk == 0x2E ||
               vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22;
    }

    static INPUT KeyInput(int vk, bool up)
    {
        var inp = new INPUT();
        inp.type = INPUT_KEYBOARD;
        inp.u.ki.wVk = (ushort)vk;
        inp.u.ki.wScan = 0;
        inp.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
        inp.u.ki.time = 0;
        inp.u.ki.dwExtraInfo = IntPtr.Zero;
        return inp;
    }

    static int SendKeys(string keys, bool release)
    {
        var parts = keys.Split('+');
        var inputs = new System.Collections.Generic.List<INPUT>();
        if (release)
        {
            for (int i = parts.Length - 1; i >= 0; i--)
            {
                var name = parts[i].Trim().ToLowerInvariant();
                if (name.Length == 0) continue;
                inputs.Add(KeyInput(Vk(name), true));
            }
        }
        else
        {
            foreach (var raw in parts)
            {
                var name = raw.Trim().ToLowerInvariant();
                if (name.Length == 0) continue;
                inputs.Add(KeyInput(Vk(name), false));
            }
        }
        if (inputs.Count == 0) return 0;
        return (int)SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    public static void KeyDownCombo(string keys) { SendKeys(keys, false); }

    public static void KeyUpCombo(string keys) { SendKeys(keys, true); }

    public static void KeyCombo(string keys, int holdMs)
    {
        SendKeys(keys, false);
        if (holdMs > 0) System.Threading.Thread.Sleep(holdMs);
        SendKeys(keys, true);
    }

    public static void TypeText(string text, int intervalMs)
    {
        foreach (var ch in text)
        {
            var down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.u.ki.wVk = 0;
            down.u.ki.wScan = (ushort)ch;
            down.u.ki.dwFlags = KEYEVENTF_UNICODE;
            var up = down;
            up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            var arr = new INPUT[] { down, up };
            SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
            if (intervalMs > 0) System.Threading.Thread.Sleep(intervalMs);
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing, System.Windows.Forms


# ---- OCR (WinRT) ----
$ocrReady = $false
$asTaskGeneric = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  })[0]
  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $ocrReady = $null -ne $asTaskGeneric
} catch { $ocrReady = $false }

function Await-WinRt($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

function Invoke-Ocr($path, $language) {
  if (-not $ocrReady) { throw 'WinRT OCR unavailable in this PowerShell' }
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = $null
  try {
    $lang = New-Object Windows.Globalization.Language $language
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch { $engine = $null }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { throw 'no OCR language pack available' }
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $x1 = [double]::MaxValue
    $y1 = [double]::MaxValue
    $x2 = 0.0
    $y2 = 0.0
    $txt = ''
    foreach ($word in $words) {
      $r = $word.BoundingRect
      if ($r.X -lt $x1) { $x1 = $r.X }
      if ($r.Y -lt $y1) { $y1 = $r.Y }
      if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
      if ($txt.Length -gt 0) { $txt += ' ' }
      $txt += $word.Text
    }
    $item = New-Object System.Collections.Hashtable
    $item['text'] = $txt
    $item['x'] = [int][Math]::Round($x1)
    $item['y'] = [int][Math]::Round($y1)
    $item['width'] = [int][Math]::Round($x2 - $x1)
    $item['height'] = [int][Math]::Round($y2 - $y1)
    [void]$lines.Add($item)
  }
  return , $lines
}

$tempRoot = Join-Path $env:TEMP 'gameagent-web'
if (-not (Test-Path $tempRoot)) { New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null }

function Respond($id, $ok, $data, $err) {
  $resp = @{ id = $id; ok = $ok }
  if ($ok) { $resp.data = $data } else { $resp.error = $err }
  $json = $resp | ConvertTo-Json -Compress -Depth 12
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $cmd = [string]$req.cmd
    $a = $req.args
    $data = $null
    switch ($cmd) {
      'ping' { $data = @{ pid = $PID; ocr = $ocrReady; host = $env:COMPUTERNAME } }
      'list-windows' { $data = @{ windows = @([NativeOps]::GetWindowList()) } }
      'window-info' { $data = [NativeOps]::GetWindowInfo([int64]$a.hwnd) }
      'activate' { $data = @{ activated = [bool]([NativeOps]::Activate([int64]$a.hwnd)) } }
      'client-origin' {
        $o = [NativeOps]::ClientOrigin([int64]$a.hwnd)
        $data = @{ x = $o[0]; y = $o[1] }
      }
      'screenshot' {
        $ext = '.jpg'
        if ([string]$a.format -eq 'png') { $ext = '.png' }
        $out = Join-Path $tempRoot ('shot-' + [Guid]::NewGuid().ToString('N') + $ext)
        $data = [NativeOps]::Capture([int64]$a.hwnd, [int]$a.maxWidth, $out, [string]$a.format)
      }
      'capture-bg' {
        $ext = '.jpg'
        if ([string]$a.format -eq 'png') { $ext = '.png' }
        $out = Join-Path $tempRoot ('shot-' + [Guid]::NewGuid().ToString('N') + $ext)
        $data = [NativeOps]::CaptureBackground([int64]$a.hwnd, [int]$a.maxWidth, $out, [string]$a.format)
      }
      'window-state' { $data = [NativeOps]::WindowState([int64]$a.hwnd) }
      'foreground' { $data = [NativeOps]::ForegroundInfo() }
      'mouse-move' { [NativeOps]::MoveTo([int]$a.x, [int]$a.y); $data = @{ ok = $true } }
      'mouse-click' {
        $x = -1
        $y = -1
        if ($null -ne $a.x) { $x = [int]$a.x }
        if ($null -ne $a.y) { $y = [int]$a.y }
        [NativeOps]::Click($x, $y, [string]$a.button, [int]$a.count, [int]$a.holdMs)
        $data = @{ ok = $true }
      }
      'mouse-drag' {
        [NativeOps]::Drag([int]$a.x1, [int]$a.y1, [int]$a.x2, [int]$a.y2, [string]$a.button, [int]$a.steps)
        $data = @{ ok = $true }
      }
      'scroll' { [NativeOps]::Scroll([int]$a.delta, [bool]$a.horizontal); $data = @{ ok = $true } }
      'keys' {
        if ([string]$a.action -eq 'down') { [NativeOps]::KeyDownCombo([string]$a.keys) }
        elseif ([string]$a.action -eq 'up') { [NativeOps]::KeyUpCombo([string]$a.keys) }
        else { [NativeOps]::KeyCombo([string]$a.keys, [int]$a.holdMs) }
        $data = @{ ok = $true }
      }
      'type' { [NativeOps]::TypeText([string]$a.text, [int]$a.intervalMs); $data = @{ ok = $true } }
      'ocr' {
        $lines = Invoke-Ocr ([string]$a.path) ([string]$a.language)
        $data = @{ lines = @($lines); engine = 'Windows.Media.Ocr' }
      }
      'remove' {
        $p = [string]$a.path
        if (Test-Path $p) { Remove-Item -Force $p }
        $data = @{ ok = $true }
      }
      'shutdown' { Respond $id $true @{ bye = $true } $null; break }
      default { throw ('unknown command: ' + $cmd) }
    }
    Respond $id $true $data $null
  } catch {
    Respond $id $false $null ($_.Exception.Message)
  }
}