using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 原生桌面窗的**状态文字**（「桌宠下方常显状态」/「悬停时显示状态」）。
    ///
    /// ── 为什么需要 ────────────────────────────────────────────────────────────
    ///
    /// 用户早先点名要"在底下显示一下状态"，但 `hint` / `statusAlways` 这两个设置
    /// **只被 overlay 用了** —— 快照里明明带着 `label`（`PetSnapshot.Label`），
    /// exe 也解析了，却全仓无人使用。于是桌面版桌宠一直没有状态文字。
    ///
    /// ── 为什么是独立窗口（关键设计决定）──────────────────────────────────────
    ///
    /// **绝不能把文字塞进本体窗**，那会破坏两条硬不变式：
    ///   ① `PetWindow.ApplyDipSizeFor` 用精灵帧尺寸定窗口大小，
    ///      自检断言"物理像素 1:1"（`dipOk`）—— 加文字就撑大了窗口；
    ///   ② `HitTestDip` 用 `ActualWidth/Height` 把鼠标坐标归一化后查 alpha 掩码
    ///      —— 窗口尺寸一变，命中位置整体算错。
    /// 所以照抄气泡窗的成熟做法：**独立窗口 + 纯展示 + 恒穿透**。
    ///
    /// ── 与 overlay 的语义对齐 ────────────────────────────────────────────────
    ///
    /// overlay（`client.js`）的规则是：
    ///   · `statusAlways` → 常显；`hint` → 仅悬停时露出；两个都关 → 不渲染；
    ///   · `clickThrough` → 不渲染（穿透时收不到鼠标，悬停无从触发）。
    /// 这里逐条对齐，避免两端表现不一致。
    /// </summary>
    internal sealed class PetStatusLabel : Window
    {
        /// <summary>基准字号（scale=1 时）；实际 = 基准 × scale，下限见 <see cref="MinFontSize"/>。</summary>
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
        private string _label = "";
        private bool _dark;
        /// <summary>本体是否被鼠标悬停（`hint` 用它决定显隐）。</summary>
        private bool _hovering;
        private bool _statusAlways;
        private bool _hint;
        private bool _clickThrough;

        public PetStatusLabel()
        {
            Title = "DSH 庄方宜桌宠-状态";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            // ShowActivated=false：状态文字绝不能把用户的编辑器焦点抢走。
            ShowActivated = false;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _text = new TextBlock();
            _text.FontSize = BaseFontSize;
            _text.TextAlignment = TextAlignment.Center;
            // 状态词很短（"待机中"/"正在思考…"），不换行、不设 MaxWidth。
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

        /// <summary>自检诊断用：是否处于"纯展示"（恒穿透、不吃焦点）。</summary>
        internal bool IsPureDisplay
        {
            get { return ShowActivated == false && Topmost; }
        }

        /// <summary>自检诊断用：当前字号。</summary>
        internal double DiagFontSize { get { return _text == null ? 0 : _text.FontSize; } }

        /// <summary>自检诊断用：当前内边距左值。</summary>
        internal double DiagPaddingLeft { get { return _chrome == null ? 0 : _chrome.Padding.Left; } }

        /// <summary>
        /// 自检诊断用：**内容**期望的尺寸（DIP）。
        /// 与窗口实际尺寸对比，就能发现"框比内容大一圈"这类问题
        ///（用户截图反馈的症状）。
        /// </summary>
        internal void DiagChromeSize(out double w, out double h)
        {
            if (_chrome == null) { w = 0; h = 0; return; }
            _chrome.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            w = _chrome.DesiredSize.Width;
            h = _chrome.DesiredSize.Height;
        }

        /// <summary>自检诊断用：窗口实际尺寸（DIP）。</summary>
        internal void DiagActualSize(out double w, out double h)
        {
            w = ActualWidth;
            h = ActualHeight;
        }

        /// <summary>
        /// 自检诊断用：尺寸链路每一环的原始值。
        ///
        /// "框比文字大"可能出在几处，必须**分别**看才能定位：
        ///   ① 文字自己的 DesiredSize（内容真实需求）
        ///   ② `_chrome.DesiredSize`（内容 + 内边距 + 边框）
        ///   ③ `SizeToContent` 之后窗口的 `ActualWidth/Height`
        ///   ④ 窗口是否真的可见（不可见时 ActualWidth 是未布局的占位值）
        /// </summary>
        internal string DiagSizeChain()
        {
            double tw = _text == null ? 0 : _text.DesiredSize.Width;
            double th = _text == null ? 0 : _text.DesiredSize.Height;
            double cw = _chrome == null ? 0 : _chrome.DesiredSize.Width;
            double ch = _chrome == null ? 0 : _chrome.DesiredSize.Height;
            return "textDesired=" + tw.ToString("0.#") + "x" + th.ToString("0.#") +
                   " chromeDesired=" + cw.ToString("0.#") + "x" + ch.ToString("0.#") +
                   " actual=" + ActualWidth.ToString("0.#") + "x" + ActualHeight.ToString("0.#") +
                   " visible=" + (IsVisible ? "1" : "0") +
                   " loaded=" + (IsLoaded ? "1" : "0") +
                   " padding=" + (_chrome == null ? "-" : _chrome.Padding.Left.ToString("0.#") + "/" + _chrome.Padding.Top.ToString("0.#")) +
                   " border=" + (_chrome == null ? "-" : _chrome.BorderThickness.Left.ToString("0.#")) +
                   " fontSize=" + (_text == null ? 0 : _text.FontSize).ToString("0.#");
        }

        /// <summary>自检诊断用：当前是否处于可见态（按显隐规则算出来的）。</summary>
        internal bool DiagShouldShow
        {
            get { return ShouldShow(); }
        }

        /// <summary>自检诊断用：注入状态后重新评估显隐。</summary>
        internal void DiagSetState(bool statusAlways, bool hint, bool clickThrough, bool hovering)
        {
            _statusAlways = statusAlways;
            _hint = hint;
            _clickThrough = clickThrough;
            _hovering = hovering;
            ApplyVisibility();
        }

        /// <summary>自检诊断用：直接设文字与缩放（不依赖快照）。</summary>
        internal void DiagSetLabel(string label, double scale, bool dark)
        {
            _label = label ?? "";
            _scale = scale <= 0 ? 1.0 : scale;
            _dark = dark;
            _text.Text = _label;
            UpdateMetrics();
            ApplyTheme(dark);
        }

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
            // ⭐ 首帧**强制重新量一次**，否则窗口停在初始尺寸上。
            //
            // 用户反馈："第一次启动的状态栏大小有问题"，并补充"只有在第一次启动
            // 就是刚启动的时候会这个样子"。自检 `DiagSizeChain` 量到的数据：
            //
            //     内容 chromeDesired = 88.7 x 18     ← 内容测量是对的
            //     窗口 actual        = 134.7 x 37.3  ← 但窗口停在这个**恒定**值上
            //
            // 关键证据是**它不随内容变化**：换文字、换字号（8 或 11）、换缩放，
            // actual 始终是 134.7x37.3。所以不是"尺寸算错"，而是这次布局里
            // **`SizeToContent` 没生效**，窗口留着初始尺寸。
            //
            // 为什么"过一会儿就好"：之后任何一次刷新（悬停/快照/缩放）都会走
            // `ApplyVisibility` → `UpdateLayout` + 重新定位，那时窗口才跟着缩。
            //
            // 修法：Loaded 之后再主动失效一次测量/排列，让 SizeToContent 重解析。
            try
            {
                InvalidateMeasure();
                InvalidateVisual();
                UpdateLayout();
            }
            catch (Exception ex2) { PetLog.Warn("状态文字首帧重排失败: " + PetLog.Describe(ex2)); }
            PetLog.Info("状态文字窗已创建 hwnd=0x" + _hwnd.ToInt64().ToString("X"));
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
        ///
        /// 与气泡窗同一做法：状态文字是说明，不该挡住桌面图标，也不该参与命中。
        /// 注意这与"本体窗"的处理相反（本体要不透明处可点/可拖）。
        /// </summary>
        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == PetNative.WM_NCHITTEST)
            {
                handled = true;
                return new IntPtr(PetNative.HTTRANSPARENT);
            }
            // 点它不要抢焦点（与气泡窗一致）。
            if (msg == PetNative.WM_MOUSEACTIVATE)
            {
                handled = true;
                return new IntPtr(PetNative.MA_NOACTIVATE);
            }
            return IntPtr.Zero;
        }

        /// <summary>深浅色（与气泡/画廊共用同一套调色板，不新增第三套配色真相）。</summary>
        public void ApplyTheme(bool dark)
        {
            _dark = dark;
            PetTheme.BubblePalette p = PetTheme.BubblePalette.For(dark);
            _chrome.Background = new SolidColorBrush(Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB));
            _chrome.BorderBrush = new SolidColorBrush(Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB));
            _text.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
        }

        /// <summary>字号/内边距随桌宠缩放（与气泡同一模式，含下限保护）。</summary>
        public void SetScale(double scale)
        {
            _scale = scale <= 0 ? 1.0 : scale;
            UpdateMetrics();
            if (IsVisible)
            {
                // 先让布局落地再定位：尺寸变了却用旧尺寸定位会歪（首帧那轮踩过）。
                try { UpdateLayout(); } catch { }
                PlaceNearPet(_lastPetRect);
            }
        }

        /// <summary>
        /// 状态文字的**独立字号倍率**（用户点名"我希望能够调整字的大小，
        /// 因为有的时候字太小了"）。
        ///
        /// 为什么要独立于 `SetScale`：`scale` 是"桌宠多大"，用户调小它是为了让
        /// 桌宠不占地方；状态文字是给人读的，跟着一起缩就本末倒置了。
        /// 两者**相乘**得到最终字号，所以"桌宠小 + 字大"可以共存。
        /// </summary>
        public void SetFontScale(double fontScale)
        {
            double fs = fontScale <= 0 ? 1.0 : fontScale;
            if (Math.Abs(fs - _fontScale) < 0.001) return;
            _fontScale = fs;
            UpdateMetrics();
            if (IsVisible)
            {
                try { UpdateLayout(); } catch { }
                PlaceNearPet(_lastPetRect);
            }
        }

        /// <summary>独立字号倍率（1.0 = 基准）。与 `_scale` 相乘。</summary>
        private double _fontScale = 1.0;

        private void UpdateMetrics()
        {
            double s = _scale;
            // 字号 = 基准 × 桌宠缩放 × 独立字号倍率。
            // `MinFontSize` 是**兜底**（防止极端缩放下变成读不了的 1px），
            // 不是可调项 —— 所以它夹的是最终值。
            _text.FontSize = Math.Max(MinFontSize, BaseFontSize * s * _fontScale);
            // ⚠️ 内边距必须跟**最终字号**成比例，不能用 `s` 单独算。
            //
            // 这里踩过：内边距按 `s` 走、字号按 `s × fontScale` 走 —— 用户把字号
            // 调到 3× 时字变大了、内边距没变，文字会贴边（上下几乎没留白）。
            // 用"最终字号 / 基准字号"这个比值，两边的比例才恒定。
            double ratio = _text.FontSize / BaseFontSize;
            double px = Math.Max(2, BasePaddingX * ratio);
            double py = Math.Max(0.5, BasePaddingY * ratio);
            _chrome.Padding = new Thickness(px, py, px, py);
            _chrome.CornerRadius = new CornerRadius(Math.Max(2, BaseCornerRadius * s));
        }

        /// <summary>
        /// 统一入口：喂入当前该显示的文字 + 全部显隐依据。
        ///
        /// Program 在每次快照/设置/悬停变化时调一次，本类自己决定显不显示与怎么摆 ——
        /// 把判定收在一处，两端（exe / overlay）才容易保持一致。
        /// </summary>
        /// <param name="label">状态文字（快照的 `label`）</param>
        /// <param name="statusAlways">常显</param>
        /// <param name="hint">悬停显示</param>
        /// <param name="clickThrough">整窗穿透（穿透时不显示）</param>
        /// <param name="hovering">本体当前是否被悬停</param>
        /// <param name="petRect">本体屏幕矩形（物理像素）[x,y,w,h]；null = 还不知道，不定位</param>
        public void Update(string label, bool statusAlways, bool hint, bool clickThrough,
                           bool hovering, int[] petRect)
        {
            _label = label ?? "";
            _statusAlways = statusAlways;
            _hint = hint;
            _clickThrough = clickThrough;
            _hovering = hovering;
            _text.Text = _label;
            _lastPetRect = petRect;
            ApplyVisibility();
        }

        /// <summary>最后一次已知的本体矩形（缩放/主题变化后要重新定位时用）。</summary>
        private int[] _lastPetRect;

        /// <summary>
        /// 显隐判定（**与 overlay 逐条对齐**）。
        ///
        /// `clickThrough` 时不显示：穿透模式下本体收不到鼠标，`hint` 的"悬停"永远
        /// 触发不了；此时还常挂一行文字，既突兀又和"纯装饰"的意图矛盾。
        /// </summary>
        private bool ShouldShow()
        {
            if (_clickThrough) return false;
            if (string.IsNullOrEmpty(_label)) return false;   // 没内容不显示空框
            return _statusAlways || (_hint && _hovering);
        }

        private void ApplyVisibility()
        {
            bool show = ShouldShow();
            if (show)
            {
                if (!IsVisible) Show();
                // ⭐ 首帧必须**先强制布局再定位**。
                //
                // `Update()` 设完文字就调 `PlaceNearPet()`，而它读 `_chrome.DesiredSize`
                // 算窗口尺寸 —— **首帧那次布局还没发生**，DesiredSize 还是旧内容
                //（空文字）的量，于是位置按错尺寸算一次。
                //
                // 为什么"过一会儿就好"：之后任何一次刷新（悬停/快照/缩放）都会重算，
                // 那时布局已完成 → 尺寸正确。所以这个 bug **只在启动瞬间可见**。
                try { UpdateLayout(); } catch { }
                PlaceNearPet(_lastPetRect);
            }
            else if (IsVisible)
            {
                Hide();
            }
        }

        /// <summary>
        /// 定位算法（**纯函数**）：算出贴在本体下方居中的目标位置（物理像素）。
        ///
        /// ⚠️ 单独抽出来的原因：自检必须验证**真实定位逻辑**，而不是它的副本。
        /// 之前 `PlaceNearPet` 与自检版 `DiagTargetFor` 各写了一份同样的算术 ——
        /// 结果是"把真实逻辑改坏，自检仍然绿"（实测：把下方改成上方，断言照样通过）。
        /// 现在两处都调这一个函数，测的就是运行路径。
        /// </summary>
        internal static void ComputeTarget(int px, int py, int pw, int ph,
                                           int bw, int bh, double dpi,
                                           out int x, out int y)
        {
            int gap = (int)Math.Round(GapBelowPet * dpi);
            PetNative.WorkArea scr = PetNative.NearestScreen(px + pw / 2, py + ph / 2);

            x = px + pw / 2 - bw / 2;          // 水平居中
            y = py + ph + gap;                  // 本体**下方**（与气泡相反：文字在下方更自然）
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
        /// 贴在本体**正下方居中**（主次与气泡相反：气泡优先头顶，文字在下方更自然）。
        /// 下方放不下 → 转上方；再 clamp 进工作区。算法见 <see cref="ComputeTarget"/>。
        /// </summary>
        private void PlaceNearPet(int[] petRect)
        {
            if (petRect == null || petRect.Length < 4) return;
            if (!IsVisible) return;
            int bw, bh; double dpi;
            CurrentMetrics(out bw, out bh, out dpi);
            int x, y;
            ComputeTarget(petRect[0], petRect[1], petRect[2], petRect[3], bw, bh, dpi, out x, out y);
            Left = x / dpi;
            Top = y / dpi;
        }

        /// <summary>
        /// 自检诊断用：算出"贴在下方居中"的目标位置（物理像素）。
        /// **直接复用 `ComputeTarget`** —— 测的就是运行路径，不是它的副本
        ///（副本曾导致"改坏真实逻辑、自检仍绿"）。
        /// 不写窗口属性是因为没 Show 过的窗口 Left/Top 是 NaN，断言无从比较（气泡那轮踩过）。
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
        /// <summary>本体键盘/鼠标状态变化时的悬停标记（Program 从 PetWindow 的回调喂入）。</summary>
        public void SetHovering(bool hovering)
        {
            if (_hovering == hovering) return;
            _hovering = hovering;
            ApplyVisibility();
        }
    }
}
