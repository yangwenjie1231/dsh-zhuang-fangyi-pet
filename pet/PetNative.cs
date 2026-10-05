using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// Win32 互操作 + 多屏/DPI 工作区工具。
    /// 「唤起 DSH 主窗」是 **best-effort**：Electron 窗口标题/类名随版本可能变，
    /// 找不到就静默失败（绝不抛异常、绝不阻塞桌宠）。
    /// </summary>
    internal static class PetNative
    {
        // ---- 窗口消息 ----
        public const int WM_NCHITTEST = 0x0084;
        public const int WM_MOUSEACTIVATE = 0x0021;
        public const int WM_DISPLAYCHANGE = 0x007E;
        public const int WM_DPICHANGED = 0x02E0;
        public const int WM_WINDOWPOSCHANGING = 0x0046;
        public const int WM_EXITSIZEMOVE = 0x0232;
        public const int WM_NCLBUTTONDOWN = 0x00A1;

        public const int HTTRANSPARENT = -1;
        public const int HTCLIENT = 1;
        public const int HTCAPTION = 2;
        public const int MA_NOACTIVATE = 3;

        public const int SW_RESTORE = 9;
        public const int SW_SHOW = 5;

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        /// <summary>
        /// 读某个虚拟键当前是否按下（异步、无焦点要求）。
        ///
        /// 用途：整窗穿透（`clickThrough`）时给用户一个**临时恢复交互**的出口 ——
        /// 按住 Ctrl 悬停即可拖/点/滚轮，否则只能去托盘里关掉穿透。
        /// 高位（0x8000）表示当前按下。
        /// </summary>
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        public const int VK_CONTROL = 0x11;

        /// <summary>Ctrl 当前是否按住（任一 Ctrl）。</summary>
        public static bool IsCtrlDown()
        {
            try { return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0; }
            catch { return false; }
        }

        [DllImport("user32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindowInternal();

        // ---- DPI（Win10 1607+ 才有 GetDpiForWindow）----
        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr LoadLibraryA(string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr module, string proc);

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate uint GetDpiForWindowDelegate(IntPtr hwnd);

        private static GetDpiForWindowDelegate _getDpiForWindow;
        private static bool _dpiProbed;

        /// <summary>窗口 DPI；拿不到时回落 96。永不抛。</summary>
        public static uint GetDpiForWindowSafe(IntPtr hwnd)
        {
            try
            {
                if (!_dpiProbed)
                {
                    _dpiProbed = true;
                    IntPtr user32 = LoadLibraryA("user32.dll");
                    if (user32 != IntPtr.Zero)
                    {
                        IntPtr p = GetProcAddress(user32, "GetDpiForWindow");
                        if (p != IntPtr.Zero)
                            _getDpiForWindow = (GetDpiForWindowDelegate)Marshal.GetDelegateForFunctionPointer(
                                p, typeof(GetDpiForWindowDelegate));
                    }
                }
                if (_getDpiForWindow != null && hwnd != IntPtr.Zero)
                {
                    uint d = _getDpiForWindow(hwnd);
                    if (d >= 72 && d <= 480) return d;
                }
            }
            catch { }
            return 96;
        }

        /// <summary>把 DIP（WPF 单位）换算成该窗口 DPI 下的物理像素。</summary>
        public static double DipToPixels(IntPtr hwnd, double dip)
        {
            return dip * GetDpiForWindowSafe(hwnd) / 96.0;
        }

        // ------------------------------------------------------------------
        // 多屏工作区
        // ------------------------------------------------------------------

        public sealed class WorkArea
        {
            public int X, Y, W, H;
            public string Device;
            public bool Primary;

            public int Right { get { return X + W; } }
            public int Bottom { get { return Y + H; } }
        }

        public static List<WorkArea> Screens()
        {
            List<WorkArea> list = new List<WorkArea>();
            try
            {
                Screen[] ss = Screen.AllScreens;
                for (int i = 0; i < ss.Length; i++)
                {
                    Screen s = ss[i];
                    System.Drawing.Rectangle r = s.WorkingArea;
                    WorkArea w = new WorkArea();
                    w.X = r.X; w.Y = r.Y; w.W = r.Width; w.H = r.Height;
                    w.Device = s.DeviceName;
                    w.Primary = s.Primary;
                    list.Add(w);
                }
            }
            catch (Exception ex)
            {
                PetLog.Warn("枚举屏幕失败: " + PetLog.Describe(ex));
            }
            if (list.Count == 0)
            {
                WorkArea w = new WorkArea();
                w.X = 0; w.Y = 0; w.W = 1920; w.H = 1080;
                w.Device = "(fallback)"; w.Primary = true;
                list.Add(w);
            }
            return list;
        }

        /// <summary>多屏合并的虚拟工作区包围盒（用于「整只宠物必须可见」的宽松 clamp）。</summary>
        public static WorkArea VirtualWorkspace()
        {
            List<WorkArea> ss = Screens();
            int x0 = int.MaxValue, y0 = int.MaxValue, x1 = int.MinValue, y1 = int.MinValue;
            for (int i = 0; i < ss.Count; i++)
            {
                if (ss[i].X < x0) x0 = ss[i].X;
                if (ss[i].Y < y0) y0 = ss[i].Y;
                if (ss[i].Right > x1) x1 = ss[i].Right;
                if (ss[i].Bottom > y1) y1 = ss[i].Bottom;
            }
            WorkArea v = new WorkArea();
            v.X = x0; v.Y = y0; v.W = Math.Max(1, x1 - x0); v.H = Math.Max(1, y1 - y0);
            v.Device = "(virtual)";
            return v;
        }

        /// <summary>离 (x,y) 最近的屏幕（按矩形中心距离）。</summary>
        public static WorkArea NearestScreen(int x, int y)
        {
            List<WorkArea> ss = Screens();
            WorkArea best = ss[0];
            long bestD = long.MaxValue;
            for (int i = 0; i < ss.Count; i++)
            {
                WorkArea w = ss[i];
                int cx = w.X + w.W / 2;
                int cy = w.Y + w.H / 2;
                long dx = x - cx, dy = y - cy;
                long d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = w; }
            }
            return best;
        }

        /// <summary>
        /// 把窗口位置 clamp 到「最近屏幕的工作区」内：整窗必须可见，
        /// 但允许窗口大于工作区时贴左上（避免抖动）。
        /// </summary>
        public static void ClampToWorkspace(int x, int y, int w, int h, out int cx, out int cy)
        {
            WorkArea s = NearestScreen(x + w / 2, y + h / 2);
            int maxX = s.Right - w;
            int maxY = s.Bottom - h;
            if (maxX < s.X) maxX = s.X;
            if (maxY < s.Y) maxY = s.Y;
            cx = Math.Min(Math.Max(x, s.X), maxX);
            cy = Math.Min(Math.Max(y, s.Y), maxY);
        }

        /// <summary>缺省位置：主屏右下角，留 24px 边距。</summary>
        public static void DefaultPosition(int w, int h, out int x, out int y)
        {
            WorkArea s = null;
            List<WorkArea> ss = Screens();
            for (int i = 0; i < ss.Count; i++) if (ss[i].Primary) { s = ss[i]; break; }
            if (s == null) s = ss[0];
            x = s.Right - w - 24;
            y = s.Bottom - h - 24;
            if (x < s.X) x = s.X;
            if (y < s.Y) y = s.Y;
        }

        // ------------------------------------------------------------------
        // 唤起 DSH 主窗（best-effort）
        // ------------------------------------------------------------------

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

        private sealed class FindState
        {
            public uint SelfPid;
            public IntPtr Found;
            public string FoundTitle;
        }

        /// <summary>
        /// 找 DSH 主窗：可见、非最小化、非工具窗、非本进程，
        /// 标题含 "DeepSeek Harness" / "deepseek harness" / 同时含 DeepSeek+Harness。
        /// 找不到返回 IntPtr.Zero（best-effort）。
        /// </summary>
        public static IntPtr FindDshWindow(out string title)
        {
            title = null;
            FindState st = new FindState();
            st.SelfPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            try
            {
                EnumWindows(delegate(IntPtr h, IntPtr p)
                {
                    if (!IsWindowVisible(h)) return true;
                    if (IsIconic(h)) return true;
                    int ex = GetWindowLong(h, GWL_EXSTYLE);
                    if ((ex & WS_EX_TOOLWINDOW) != 0) return true;

                    uint pid;
                    GetWindowThreadProcessId(h, out pid);
                    if (pid == st.SelfPid) return true;

                    int len = GetWindowTextLength(h);
                    if (len <= 0) return true;
                    StringBuilder sb = new StringBuilder(len + 2);
                    GetWindowText(h, sb, sb.Capacity);
                    string t = sb.ToString();
                    if (t.Length == 0) return true;

                    string lower = t.ToLowerInvariant();
                    bool hit = lower.IndexOf("deepseek harness", StringComparison.Ordinal) >= 0;
                    if (!hit && lower.IndexOf("deepseek") >= 0 && lower.IndexOf("harness") >= 0) hit = true;
                    if (!hit) return true;

                    st.Found = h;
                    st.FoundTitle = t;
                    return false; // 停止枚举
                }, IntPtr.Zero);
            }
            catch (Exception ex)
            {
                PetLog.Info("EnumWindows 失败: " + PetLog.Describe(ex));
            }
            title = st.FoundTitle;
            return st.Found;
        }

        /// <summary>恢复并前置窗口（best-effort，含 AttachThreadInput 提升成功率）。</summary>
        public static bool ActivateWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            bool ok = false;
            try
            {
                if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
                else ShowWindow(hwnd, SW_SHOW);

                IntPtr fg = GetForegroundWindow();
                uint fgThread = GetWindowThreadProcessId(fg, out _pidDummy);
                uint myThread = GetCurrentThreadId();
                bool attached = false;
                if (fgThread != 0 && fgThread != myThread)
                {
                    attached = AttachThreadInput(myThread, fgThread, true);
                }
                try
                {
                    ok = SetForegroundWindow(hwnd);
                    if (!ok) ok = BringWindowToTop(hwnd);
                }
                finally
                {
                    if (attached) AttachThreadInput(myThread, fgThread, false);
                }
            }
            catch (Exception ex)
            {
                PetLog.Info("ActivateWindow 失败: " + PetLog.Describe(ex));
            }
            return ok;
        }

        private static uint _pidDummy;

        /// <summary>整体 best-effort：找到就前置，找不到只记一行日志。</summary>
        public static bool FocusDsh()
        {
            string title;
            IntPtr h = FindDshWindow(out title);
            if (h == IntPtr.Zero)
            {
                PetLog.Info("FocusDsh: 未找到 DSH 主窗（best-effort，忽略）");
                return false;
            }
            bool ok = ActivateWindow(h);
            PetLog.Info("FocusDsh: " + (ok ? "已前置" : "前置失败") + " \"" + title + "\"");
            return ok;
        }
    }
}