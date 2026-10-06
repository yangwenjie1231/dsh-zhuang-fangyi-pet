using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 原生桌面窗的**番茄钟倒计时**（用户点名："增加番茄钟提醒我休息"）。
    ///
    /// ── 为什么是独立窗口（与 `PetStatusLabel` 同一理由，绝不合并）────────────
    ///
    /// **绝不能把倒计时塞进本体窗**，那会破坏两条硬不变式：
    ///   ① `PetWindow.ApplyDipSizeFor` 用精灵帧尺寸定窗口大小，
    ///      自检断言"物理像素 1:1"（`dipOk`）—— 加文字就撑大了窗口；
    ///   ② `HitTestDip` 用 `ActualWidth/Height` 把鼠标坐标归一化后查 alpha 掩码
    ///      —— 窗口尺寸一变，命中位置整体算错。
    ///
    /// ── 为什么不复用 `PetStatusLabel` ─────────────────────────────────────────
    ///
    /// 两者**显隐规则完全不同**，混在一起会让"状态文字"和"计时器"互相绑死：
    ///   · 状态文字：悬停才显示 / 常显 / 关闭（用户对"状态"的选择）；
    ///   · 番茄钟：**只要在跑就必须看得见** —— 那是他自己按的计时器，
    ///     藏起来等于功能失效。且 `clickThrough` 时状态文字要隐藏
    ///     （穿透后收不到悬停），但倒计时**必须照显示**（否则开了穿透就瞎了）。
    ///
    /// 所以两个窗口各管各的，位置由 Program 协调（倒计时在上、状态文字在下）。
    ///
    /// ── 显示什么 ──────────────────────────────────────────────────────────────
    ///
    /// `专注 24:59 · 第 2/4 轮`。阶段名与剩余时间**都由 Host 给语义、exe 只排版**：
    /// 剩余时间每秒由 exe 用 `EndsAt` 本地插值（不劳 Host 每秒推帧），
    /// 但**格式化函数与 Host 同源**（`formatRemaining` 的口径：向上取整）。
    /// </summary>
    internal sealed class PetPomodoro : Window
    {
        private const double BaseFontSize = 11;
        private const double MinFontSize = 8;
        private const double BasePaddingX = 6;
        private const double BasePaddingY = 1;
        private const double BaseCornerRadius = 6;
        /// <summary>与本体底边的间距（DIP）。</summary>
        private const double GapBelowPet = 4;

        private readonly Border _chrome;
        private readonly TextBlock _text;
        private IntPtr _hwnd;
        private HwndSource _source;
        private bool _reallyClosing;

        private double _scale = 1.0;
        private bool _dark;
        /// <summary>最近一次已知的本体矩形（缩放/主题变化后要重新定位时用）。</summary>
        private int[] _lastPetRect;
        /// <summary>
        /// 定位锚点：默认贴本体下方；若状态文字也在显示，则由 Program 传入
        /// **状态文字之上的位置**，避免两个窗口叠在一起。
        /// </summary>
        private int[] _anchorRect;

        /// <summary>当前是否该显示（`Show` + 有内容）。</summary>
        private bool _wanted;

        public PetPomodoro()
        {
            Title = "DSH 庄方宜桌宠-番茄钟";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            // ShowActivated=false：倒计时绝不能把用户的编辑器焦点抢走。
            ShowActivated = false;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _text = new TextBlock();
            _text.FontSize = BaseFontSize;
            _text.TextAlignment = TextAlignment.Center;
            _text.TextWrapping = TextWrapping.NoWrap;

            _chrome = new Border();
            _chrome.CornerRadius = new CornerRadius(BaseCornerRadius);
            _chrome.Padding = new Thickness(BasePaddingX, BasePaddingY, BasePaddingX, BasePaddingY);
            _chrome.BorderThickness = new Thickness(1);
            _chrome.Child = _text;
            Content = _chrome;

            ApplyTheme(false);
            Loaded += OnLoaded;
            Closing += OnClosing;
        }

        /// <summary>自检诊断用：是否处于"纯展示"（不吃焦点、置顶）。</summary>
        internal bool IsPureDisplay
        {
            get { return ShowActivated == false && Topmost; }
        }

        /// <summary>自检诊断用：当前显示的文字。</summary>
        internal string DiagText { get { return _text == null ? "" : (_text.Text ?? ""); } }

        /// <summary>自检诊断用：当前字号。</summary>
        internal double DiagFontSize { get { return _text == null ? 0 : _text.FontSize; } }

        /// <summary>自检诊断用：当前是否处于可见态。</summary>
        internal bool DiagShouldShow { get { return _wanted; } }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            if (_hwnd != IntPtr.Zero)
            {
                _source = HwndSource.FromHwnd(_hwnd);
                if (_source != null) _source.AddHook(WndProc);
                int ex = PetNative.GetWindowLong(_hwnd, PetNative.GWL_EXSTYLE);
                PetNative.SetWindowLong(_hwnd, PetNative.GWL_EXSTYLE,
                    ex | PetNative.WS_EX_TOOLWINDOW | PetNative.WS_EX_NOACTIVATE);
            }
            PetLog.Info("番茄钟窗已创建 hwnd=0x" + _hwnd.ToInt64().ToString("X"));
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!_reallyClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            if (_source != null)
            {
                _source.RemoveHook(WndProc);
                _source = null;
            }
        }

        /// <summary>退出时真正关掉（否则 Closing 里会把关闭取消成 Hide）。</summary>
        public void ForceClose()
        {
            _reallyClosing = true;
            try { Close(); } catch { }
        }

        /// <summary>
        /// 纯展示：整窗**恒** HTTRANSPARENT —— 鼠标永远穿过去。
        /// 与气泡/状态文字同一做法：倒计时是说明，不该挡住桌面图标，也不该参与命中。
        /// </summary>
        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == PetNative.WM_NCHITTEST)
            {
                handled = true;
                return new IntPtr(PetNative.HTTRANSPARENT);
            }
            if (msg == PetNative.WM_MOUSEACTIVATE)
            {
                handled = true;
                return new IntPtr(PetNative.MA_NOACTIVATE);
            }
            return IntPtr.Zero;
        }

        /// <summary>深浅色（与气泡/状态文字共用同一套调色板，不新增第三套配色真相）。</summary>
        public void ApplyTheme(bool dark)
        {
            _dark = dark;
            PetTheme.BubblePalette p = PetTheme.BubblePalette.For(dark);
            _chrome.Background = new SolidColorBrush(Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB));
            _chrome.BorderBrush = new SolidColorBrush(Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB));
            _text.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
        }

        /// <summary>字号/内边距随桌宠缩放（与气泡/状态文字同一模式，含下限保护）。</summary>
        public void SetScale(double scale)
        {
            _scale = scale <= 0 ? 1.0 : scale;
            UpdateMetrics();
            if (IsVisible) PlaceNearPet(_lastPetRect);
        }

        private void UpdateMetrics()
        {
            double s = _scale;
            _text.FontSize = Math.Max(MinFontSize, BaseFontSize * s);
            double px = Math.Max(2, BasePaddingX * s);
            double py = Math.Max(0.5, BasePaddingY * s);
            _chrome.Padding = new Thickness(px, py, px, py);
            _chrome.CornerRadius = new CornerRadius(Math.Max(2, BaseCornerRadius * s));
        }

        /// <summary>
        /// 统一入口：喂入当前该显示的文字 + 全部显隐依据。
        ///
        /// ⚠️ 与状态文字**关键差别**：`clickThrough` 时倒计时**照样显示**。
        /// 状态文字隐藏是因为"穿透后收不到悬停，`hint` 永远触发不了"；
        /// 而倒计时不依赖悬停 —— 它是用户主动开的计时器，穿透模式下藏起来
        /// 等于"开了点击穿透，番茄钟就瞎了"。
        /// </summary>
        /// <param name="text">要显示的文字（null/空 = 不显示）</param>
        /// <param name="wanted">Host 是否要求显示（`pomodoro.show`）</param>
        /// <param name="petVisible">本体是否可见（本体藏了它必须一起藏）</param>
        /// <param name="petRect">本体屏幕矩形（物理像素）[x,y,w,h]；null = 不知道，不定位</param>
        /// <param name="anchorRect">定位锚点矩形（通常是状态文字窗的矩形）；null = 贴本体</param>
        public void Update(string text, bool wanted, bool petVisible, int[] petRect, int[] anchorRect)
        {
            _text.Text = text ?? "";
            _wanted = wanted && petVisible && !string.IsNullOrEmpty(_text.Text);
            _lastPetRect = petRect;
            _anchorRect = anchorRect;
            ApplyVisibility();
        }

        private void ApplyVisibility()
        {
            if (_wanted)
            {
                if (!IsVisible) Show();
                PlaceNearPet(_lastPetRect);
            }
            else if (IsVisible)
            {
                Hide();
            }
        }

        /// <summary>
        /// 定位算法（**纯函数**）：算出贴在某矩形下方居中的目标位置（物理像素）。
        ///
        /// 与 `PetStatusLabel.ComputeTarget` **同一套算法**（含"下方放不下就转上方"
        /// 与 clamp 进工作区）。单独抽出来是为了让自检验证**真实逻辑**而不是副本 ——
        /// 状态文字那边正是踩过"两处各写一份算术、改坏真实逻辑自检仍绿"的坑。
        /// </summary>
        internal static void ComputeTarget(int px, int py, int pw, int ph,
                                           int bw, int bh, double dpi,
                                           out int x, out int y)
        {
            int gap = (int)Math.Round(GapBelowPet * dpi);
            PetNative.WorkArea scr = PetNative.NearestScreen(px + pw / 2, py + ph / 2);

            x = px + pw / 2 - bw / 2;          // 水平居中
            y = py + ph + gap;                  // 锚点**下方**
            if (y + bh > scr.Bottom - 4)
            {
                // 下方放不下 → 放到上方；上方也放不下 → 贴屏幕底
                y = py - bh - gap;
                if (y < scr.Y + 4) y = scr.Bottom - bh - 4;
            }
            int maxX = scr.Right - bw - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;
        }

        /// <summary>取当前窗口的物理尺寸与 DPI（定位用）。</summary>
        private void CurrentMetrics(out int bw, out int bh, out double dpi)
        {
            dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;
            // 用测量值而不是 ActualWidth：SizeToContent 的窗口尺寸有一帧滞后
            //（气泡那轮踩过：读旧尺寸会把位置算错）。
            double wDip = _chrome.DesiredSize.Width > 0 ? _chrome.DesiredSize.Width : ActualWidth;
            double hDip = _chrome.DesiredSize.Height > 0 ? _chrome.DesiredSize.Height : ActualHeight;
            bw = (int)Math.Round(wDip * dpi);
            bh = (int)Math.Round(hDip * dpi);
            if (bw <= 0) bw = 60;
            if (bh <= 0) bh = 20;
        }

        /// <summary>
        /// 定位：贴**锚点**下方居中（锚点默认是本体；状态文字可见时由 Program 传
        /// 状态文字的矩形，于是倒计时排在状态文字**上方**…… 等等 —— 见下方说明）。
        ///
        /// ⚠️ 实际的叠放顺序：**倒计时紧贴本体下方，状态文字在倒计时下方**。
        /// 所以这里锚点就是本体；状态文字那边由 Program 传"倒计时的矩形"当锚点。
        /// 谁在上取决于谁更"短时"：倒计时是主信息（在跑的时候最该看见），
        /// 状态文字是辅助。这样安排还有个好处：倒计时消失时状态文字自然上移，
        /// 不需要额外的"重排"逻辑。
        /// </summary>
        private void PlaceNearPet(int[] petRect)
        {
            int[] anchor = petRect ?? _anchorRect;
            if (anchor == null || anchor.Length < 4) return;
            if (!IsVisible) return;
            int bw, bh; double dpi;
            CurrentMetrics(out bw, out bh, out dpi);
            int x, y;
            ComputeTarget(anchor[0], anchor[1], anchor[2], anchor[3], bw, bh, dpi, out x, out y);
            Left = x / dpi;
            Top = y / dpi;
        }

        /// <summary>
        /// 自检诊断用：算出目标位置（物理像素）。**直接复用 `ComputeTarget`** ——
        /// 测的就是运行路径，不是它的副本。
        /// </summary>
        internal void DiagTargetFor(int petX, int petY, int petW, int petH,
                                    out double x, out double y, out int bw, out int bh)
        {
            double dpi;
            CurrentMetrics(out bw, out bh, out dpi);
            int ix, iy;
            ComputeTarget(petX, petY, petW, petH, bw, bh, dpi, out ix, out iy);
            x = ix;
            y = iy;
        }

        /// <summary>
        /// 自检诊断用：注入状态后重新评估显隐（不依赖真实快照）。
        /// </summary>
        internal void DiagSetState(string text, bool wanted, bool petVisible)
        {
            _text.Text = text ?? "";
            _wanted = wanted && petVisible && !string.IsNullOrEmpty(_text.Text);
        }

        /// <summary>
        /// 自检诊断用：当前窗口**物理**尺寸（不带 DIP 换算的原始测量）。
        /// </summary>
        internal void DiagMetrics(out int bw, out int bh)
        {
            double dpi;
            CurrentMetrics(out bw, out bh, out dpi);
        }
    }
}
