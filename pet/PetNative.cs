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

        // ⚠️ `GetCurrentThreadId` 在 **kernel32.dll**，不在 user32.dll。
        //
        // 这里曾经写成 user32 —— 后果是**调用必抛 EntryPointNotFoundException**，
        // 而 `ActivateWindow` 的整段逻辑被 try/catch 包着，异常被吞掉，
        // 于是"前置 DSH 主窗"这条链路**从来没有真正执行过**（表现为双击没反应）。
        // 自检加了"走真实路径调 ActivateWindow"的断言才把它暴露出来 ——
        // 纯函数断言永远发现不了 P/Invoke 的 DLL 归属错误。
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);

        /// <summary>SetWindowPos 的插入位置：把窗口放到 Z 序**最前**（0 = HWND_TOP）。</summary>
        public static readonly IntPtr HWND_TOP = IntPtr.Zero;
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
        /// 找 DSH 主窗：**非工具窗、非本进程**，标题含
        /// "DeepSeek Harness" / 同时含 DeepSeek+Harness。
        ///
        /// ⚠️ **不过滤最小化窗口**（这里踩过）：
        /// 原先有一句 `if (IsIconic(h)) return true;` —— 跳过最小化的窗口。
        /// 但用户双击桌宠的**目的恰恰是把最小化的 DSH 叫回来**，
        /// 那条过滤让"最小化时双击 → 未找到 DSH 主窗"（日志实测），
        /// 与使用意图直接矛盾。现在改为**优先未最小化者**，找不到就用最小化的那个。
        ///
        /// 可见性仍然过滤：完全不可见的窗口是 Electron 的辅助窗，不是主窗。
        /// 找不到返回 IntPtr.Zero（best-effort）。
        /// </summary>
        /// <summary>
        /// 单个窗口是否够格当"DSH 主窗"候选（**纯函数**，运行路径与自检共用）。
        ///
        /// ⚠️ 抽出来的原因：自检必须验**真实判定**。
        /// 第一版自检自己另造一个窗口去检查 `IsIconic` 语义 ——
        /// 结果把 `FindDshWindow` 里的过滤改回去，断言照样绿（等于没测）。
        ///
        /// 判据（顺序即理由）：
        ///   · 必须可见 —— 完全不可见的是 Electron 辅助窗；
        ///   · 非工具窗 —— 辅助窗带 WS_EX_TOOLWINDOW；
        ///   · 非本进程 —— 不能把自己当 DSH；
        ///   · 标题含 DeepSeek + Harness；
        ///   · **不因"最小化"排除** —— 双击的目的就是把最小化的 DSH 叫回来。
        /// </summary>
        internal static bool IsDshCandidate(IntPtr h, uint selfPid, out string title, out bool minimized)
        {
            title = null;
            minimized = false;
            if (!IsWindowVisible(h)) return false;
            if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return false;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == selfPid) return false;
            int len = GetWindowTextLength(h);
            if (len <= 0) return false;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string t = sb.ToString();
            if (t.Length == 0) return false;
            string lower = t.ToLowerInvariant();
            bool hit = lower.IndexOf("deepseek harness", StringComparison.Ordinal) >= 0;
            if (!hit && lower.IndexOf("deepseek") >= 0 && lower.IndexOf("harness") >= 0) hit = true;
            if (!hit) return false;
            title = t;
            minimized = IsIconic(h);
            return true;   // 最小化也算候选（由调用方决定优先级）
        }

        /// <summary>
        /// 找 DSH 主窗（见 <see cref="IsDshCandidate"/> 的判据）。
        /// 优先未最小化的；只有最小化的也接受（双击就是要把 DSH 叫回来）。
        /// 找不到返回 IntPtr.Zero（best-effort）。
        /// </summary>
        public static IntPtr FindDshWindow(out string title)
        {
            title = null;
            FindState st = new FindState();
            st.SelfPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            IntPtr minimizedHit = IntPtr.Zero;
            string minimizedTitle = null;
            try
            {
                EnumWindows(delegate(IntPtr h, IntPtr p)
                {
                    string t; bool mini;
                    if (!IsDshCandidate(h, st.SelfPid, out t, out mini)) return true;
                    if (mini)
                    {
                        // 记下但继续找 —— 万一还有未最小化的主窗，那个更该被前置
                        if (minimizedHit == IntPtr.Zero) { minimizedHit = h; minimizedTitle = t; }
                        return true;
                    }
                    st.Found = h;
                    st.FoundTitle = t;
                    return false; // 找到未最小化的，停止枚举
                }, IntPtr.Zero);
                if (st.Found == IntPtr.Zero && minimizedHit != IntPtr.Zero)
                {
                    st.Found = minimizedHit;
                    st.FoundTitle = minimizedTitle;
                }
            }
            catch (Exception ex)
            {
                PetLog.Info("EnumWindows 失败: " + PetLog.Describe(ex));
            }
            title = st.FoundTitle;
            return st.Found;
        }

        /// <summary>
        /// 恢复并前置窗口（best-effort）。
        ///
        /// ── 为什么需要这一堆"绕路"（实测踩过）────────────────────────────────
        ///
        /// 单纯 `SetForegroundWindow` 在**跨进程**时会被 Windows 的前台锁定拒绝：
        /// 实测 exe 调用它**返回 False**（日志："前置失败"），
        /// 而兜底的 `BringWindowToTop` 返回 True 却**只把窗口提到它所在 Z 序组的顶部**，
        /// 不是全局最前 —— 用户感觉"双击没反应"。更糟的是配合 `ShowWindow`,
        /// 窗口状态被改来改去，出现"DSH 反而被隐藏了"的观感。
        ///
        /// 正确做法（业界标准绕法）：把自己线程**挂到当前前台线程**上，
        /// 这样本进程就"有权"设置前台窗口；设置完再解挂。两步都做完才算成功。
        ///
        /// `SetWindowPos(HWND_TOP)` 一并使用：即使前台化被拒，至少把 Z 序提到最前，
        /// 保证"看起来出现了"，而不是默默失败。
        /// </summary>
        public static bool ActivateWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            bool ok = false;
            uint fgThread = 0;
            uint myThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                // 先恢复（最小化 → 正常）。**只在最小化时**动窗口状态：
                // 对已正常显示的窗口调 ShowWindow 是多余且可能扰动它的状态。
                if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);

                // ① 挂到前台线程（这是能真正抢到前台的关键）
                IntPtr fg = GetForegroundWindow();
                if (fg != IntPtr.Zero)
                {
                    fgThread = GetWindowThreadProcessId(fg, out _pidDummy);
                    if (fgThread != 0 && fgThread != myThread)
                    {
                        attached = AttachThreadInput(myThread, fgThread, true);
                    }
                }

                // ② 设置前台（此时成功率大幅提高）
                ok = SetForegroundWindow(hwnd);

                // ③ 无论前台化是否成功，都把 Z 序提到最前 ——
                //    这样"用户至少看得见它"，而不是像以前那样默默失败。
                try
                {
                    if (SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                                     SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW))
                    {
                        if (!ok) ok = true;   // Z 序提上去了，也算"看得见"
                    }
                }
                catch { }

                if (!ok) ok = BringWindowToTop(hwnd);
            }
            catch (Exception ex)
            {
                PetLog.Info("ActivateWindow 失败: " + PetLog.Describe(ex));
            }
            finally
            {
                // 必须在 finally 里解挂：否则会把本线程永久绑在前台线程上
                //（后续窗口消息处理会受牵连）。
                if (attached) { try { AttachThreadInput(myThread, fgThread, false); } catch { } }
            }
            return ok;
        }

        // ------------------------------------------------------------------
        // 自检诊断（只读观察面，不参与运行逻辑）
        // ------------------------------------------------------------------

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