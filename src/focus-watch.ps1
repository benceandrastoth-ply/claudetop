# Prints "<pid>`t<processName>`t<windowTitle>" for the foreground window whenever it changes.
# With lock-in mode on, a browser tab whose title matches the blocklist is reported as
# "LOCKIN`t<hwnd>`t<windowRect>`t<tabRect>" (physical pixels "l,t,r,b"; tabRect may be empty).
# claudetop animates, then asks for the tab to be closed by writing "close <hwnd>" to the
# command file. main.js fills in the __PLACEHOLDERS__ before running this.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -ReferencedAssemblies Accessibility @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class Fg {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Bring a window to the front. Windows only lets the foreground app do that, unless a key was
  // just pressed: tapping Alt first is the usual way round it.
  public static void Bring(IntPtr hWnd) {
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hWnd);
  }
}
// Where's the active tab? Browsers expose their tab strip through MSAA: walk the browser's
// own UI (not page content) for the selected page tab. Returns "l,t,r,b" or "".
public static class Tabs {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out] object[] children, out int obtained);
  const int ROLE_PAGETAB = 0x25, ROLE_DOCUMENT = 0xF, STATE_SELECTED = 0x2;
  public static string Active(IntPtr hwnd) {
    try {
      var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      object root;
      if (AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref iid, out root) != 0) return "";
      var queue = new Queue<KeyValuePair<IAccessible, int>>();
      queue.Enqueue(new KeyValuePair<IAccessible, int>((IAccessible)root, 0));
      for (int visited = 0; queue.Count > 0 && visited < 3000; visited++) {
        var item = queue.Dequeue();
        var acc = item.Key;
        int role = 0, state = 0;
        try { role = Convert.ToInt32(acc.get_accRole(0)); state = Convert.ToInt32(acc.get_accState(0)); } catch {}
        if (role == ROLE_PAGETAB) {
          if ((state & STATE_SELECTED) == 0) continue;
          int l, t, w, h;
          acc.accLocation(out l, out t, out w, out h, 0);
          return l + "," + t + "," + (l + w) + "," + (t + h);
        }
        if (role == ROLE_DOCUMENT || item.Value > 16) continue;
        int n = 0;
        try { n = acc.accChildCount; } catch {}
        if (n <= 0 || n > 400) continue;
        var kids = new object[n];
        int got;
        try { AccessibleChildren(acc, 0, n, kids, out got); } catch { continue; }
        foreach (var k in kids) {
          var child = k as IAccessible;
          if (child != null) queue.Enqueue(new KeyValuePair<IAccessible, int>(child, item.Value + 1));
        }
      }
    } catch {}
    return "";
  }
}
"@

# What's playing, via Windows' media controls (the volume-key popup). Prints
# "MEDIA`t<0|1>`t<appId>`t<artist>`t<title>`t<album>" when it changes. Optional: if WinRT
# isn't available, the focus watching still works.
$media = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$task.Wait(2000)
    $task.Result
  }
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $media = Await ($mgrType::RequestAsync()) $mgrType
} catch { $media = $null }
$lastMedia = $null
$tick = 0

$lockIn = '__LOCKIN__' -eq '1'
$blocklist = '__BLOCKLIST__'
$browsers = '__BROWSERS__' -split ','
$cmdFile = '__CMDFILE__'
$shell = New-Object -ComObject WScript.Shell
$cooldownUntil = [DateTime]::MinValue

$last = $null
$names = @{}
$sb = New-Object System.Text.StringBuilder 512
while ($true) {
  $hwnd = [Fg]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][Fg]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
  [void]$sb.Clear()
  [void][Fg]::GetWindowText($hwnd, $sb, 512)
  $title = $sb.ToString() -replace "`t", ' '
  if (-not $names.ContainsKey($fgPid)) {
    $names[$fgPid] = ''
    try { $names[$fgPid] = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
  }
  $fr = New-Object Fg+Rect
  [void][Fg]::GetWindowRect($hwnd, [ref]$fr)
  # The rect is left out for maximized windows: with an auto-hiding taskbar they cover the whole
  # monitor too, but they aren't fullscreen games.
  $rectText = if ([Fg]::IsZoomed($hwnd)) { '' } else { "$($fr.Left),$($fr.Top),$($fr.Right),$($fr.Bottom)" }
  $line = "$fgPid`t$($names[$fgPid])`t$title`t$rectText"
  if ($line -ne $last) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    $last = $line
  }

  if ($lockIn -and [DateTime]::Now -gt $cooldownUntil -and
      $browsers -contains $names[$fgPid].ToLower() -and $title -match $blocklist) {
    $wr = New-Object Fg+Rect
    [void][Fg]::GetWindowRect($hwnd, [ref]$wr)
    $tab = [Tabs]::Active($hwnd)
    [Console]::Out.WriteLine("LOCKIN`t$hwnd`t$($wr.Left),$($wr.Top),$($wr.Right),$($wr.Bottom)`t$tab")
    [Console]::Out.Flush()
    $cooldownUntil = [DateTime]::Now.AddSeconds(12) # claudetop is busy with its animation
  }

  # "close <hwnd>": Ctrl+W, but only if that same window is still in front.
  if (Test-Path $cmdFile) {
    $cmd = (Get-Content $cmdFile -Raw -ErrorAction SilentlyContinue)
    Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
    if ($cmd -match '^close (\d+)') {
      if ([Fg]::GetForegroundWindow() -eq [IntPtr][long]$Matches[1]) { $shell.SendKeys('^w') }
      $cooldownUntil = [DateTime]::Now.AddSeconds(1.5)
    }
    # "focus <pid,pid,...>": bring up the first of these processes that has a window (the
    # session's terminal or editor). Failing that, a terminal showing a Claude Code tab.
    if ($cmd -match '^focus ([\d,]*)') {
      $target = [IntPtr]::Zero
      foreach ($p in ($Matches[1] -split ',' | Where-Object { $_ })) {
        try { $h = (Get-Process -Id ([int]$p) -ErrorAction Stop).MainWindowHandle } catch { continue }
        if ($h -ne [IntPtr]::Zero) { $target = $h; break }
      }
      if ($target -eq [IntPtr]::Zero) {
        $hit = Get-Process -Name WindowsTerminal, Code, Cursor, Windsurf -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -match '^[^\p{L}\p{N}\s]\s|claude' } |
          Select-Object -First 1
        if ($hit) { $target = $hit.MainWindowHandle }
      }
      if ($target -ne [IntPtr]::Zero) { [Fg]::Bring($target) }
    }
  }

  $tick++
  if ($media -and $tick % 4 -eq 0) {
    $m = "MEDIA`t0"
    try {
      foreach ($s in $media.GetSessions()) {
        if ($s.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') { continue }
        $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
        $clean = { param($v) "$v" -replace "`t", ' ' }
        $m = "MEDIA`t1`t$($s.SourceAppUserModelId)`t$(& $clean $p.Artist)`t$(& $clean $p.Title)`t$(& $clean $p.AlbumTitle)"
        break
      }
    } catch {}
    if ($m -ne $lastMedia) {
      [Console]::Out.WriteLine($m)
      [Console]::Out.Flush()
      $lastMedia = $m
    }
  }

  Start-Sleep -Milliseconds 250
}
