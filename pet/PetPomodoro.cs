using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;

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

        // ── v11：进度环 ──────────────────────────────────────────────────────
        /// <summary>环直径（scale=1 时的 DIP）。</summary>
        private const double BaseRingSize = 38;
        /// <summary>环的描边粗细（scale=1 时的 DIP）。</summary>
        private const double BaseRingThickness = 3;
        /// <summary>轨道色（未走完的部分）—— 两套主题各一个，见 ApplyTheme。</summary>
        private Color _trackColor = Color.FromArgb(60, 120, 160, 220);

        private readonly Border _chrome;
        /// <summary>环内的剩余时间文字（`24:59`）。</summary>
        private readonly TextBlock _text;
        /// <summary>环右侧的阶段文字（`专注 · 第 2/4 轮`）。</summary>
        private readonly TextBlock _phaseText;
        /// <summary>整个环（轨道 + 进度 + 环内文字）的容器；未知进度时整组隐藏。</summary>
        private readonly Grid _ringHost;
        private readonly Ellipse _ringTrack;
        private readonly Ellipse _ringProgress;
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

        // ── v11：呼吸引导（兑现设置页那句"随呼吸缩放的光环"）─────────────────
        //
        // ⚠️ 这个开关此前是一句**空承诺**：字段存了、快照带了、exe 解析了、
        // 还打了 diff 日志 —— 然后全仓没有任何地方渲染它（`_breathOn` 只出现在
        // 声明/默认值/diff/日志四处）。设置页写着"桌宠下方一个随呼吸缩放的光环
        // （4-7-8 节奏）"，用户打开却什么都不会发生。
        /// <summary>是否启用呼吸引导（由 Program 从 `settings.pomodoroBreath` 喂入）。</summary>
        private bool _breathOn;
        /// <summary>呼吸动画（4-7-8）挂在环上；关掉即停。</summary>
        private readonly ScaleTransform _breathScale;
        private bool _breathing;

        /// <summary>4-7-8 一轮的总时长（ms）：吸气 4s + 屏息 7s + 呼气 8s。</summary>
        internal const int BreathCycleMs = 19000;
        /// <summary>呼气到底时的缩放（**永远 ≤ 1.0**：超过 1.0 会溢出窗口被裁）。</summary>
        internal const double BreathMinScale = 0.85;

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
            // 环内的文字必须居中：用 Grid 的居中而不是 TextBlock 自己的对齐，
            // 这样环放大缩小时文字始终在圆心。
            _text.HorizontalAlignment = HorizontalAlignment.Center;
            _text.VerticalAlignment = VerticalAlignment.Center;

            // 轨道（整圈底）+ 进度（只画剩余那一段）。
            _ringTrack = new Ellipse();
            _ringTrack.Width = BaseRingSize;
            _ringTrack.Height = BaseRingSize;
            _ringTrack.StrokeThickness = BaseRingThickness;
            _ringTrack.Fill = Brushes.Transparent;
            _ringTrack.HorizontalAlignment = HorizontalAlignment.Center;
            _ringTrack.VerticalAlignment = VerticalAlignment.Center;

            _ringProgress = new Ellipse();
            _ringProgress.Width = BaseRingSize;
            _ringProgress.Height = BaseRingSize;
            _ringProgress.StrokeThickness = BaseRingThickness;
            _ringProgress.Fill = Brushes.Transparent;
            _ringProgress.StrokeStartLineCap = PenLineCap.Round;
            _ringProgress.StrokeEndLineCap = PenLineCap.Round;
            _ringProgress.HorizontalAlignment = HorizontalAlignment.Center;
            _ringProgress.VerticalAlignment = VerticalAlignment.Center;
            // ⭐ 从 12 点开始顺时针收干。
            //
            // WPF 的 Ellipse 描边路径从**3 点**（最右）起画，所以旋转 -90° 才落在
            // 12 点。旋转中心必须是元素中心 —— 用 (0.5,0.5) 而不是默认的 (0,0)。
            _ringProgress.RenderTransformOrigin = new Point(0.5, 0.5);
            _ringProgress.RenderTransform = new RotateTransform(-90);

            _ringHost = new Grid();
            _ringHost.Children.Add(_ringTrack);
            _ringHost.Children.Add(_ringProgress);
            _ringHost.Children.Add(_text);
            // 呼吸缩放挂在整个环上（文字跟着一起"呼吸"才像一个整体）。
            _breathScale = new ScaleTransform(1, 1);
            _ringHost.RenderTransformOrigin = new Point(0.5, 0.5);
            _ringHost.RenderTransform = _breathScale;

            _phaseText = new TextBlock();
            _phaseText.FontSize = BaseFontSize;
            _phaseText.TextWrapping = TextWrapping.NoWrap;
            _phaseText.VerticalAlignment = VerticalAlignment.Center;
            _phaseText.Margin = new Thickness(6, 0, 0, 0);

            StackPanel row = new StackPanel();
            row.Orientation = Orientation.Horizontal;
            row.Children.Add(_ringHost);
            row.Children.Add(_phaseText);

            _chrome = new Border();
            _chrome.CornerRadius = new CornerRadius(BaseCornerRadius);
            _chrome.Padding = new Thickness(BasePaddingX, BasePaddingY, BasePaddingX, BasePaddingY);
            _chrome.BorderThickness = new Thickness(1);
            _chrome.Child = row;
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

        /// <summary>自检诊断用：环右侧的阶段文字。</summary>
        internal string DiagPhaseText { get { return _phaseText == null ? "" : (_phaseText.Text ?? ""); } }

        /// <summary>自检诊断用：整个环是否可见（未知进度时应当隐藏）。</summary>
        internal bool DiagRingVisible
        {
            get { return _ringHost != null && _ringHost.Visibility == Visibility.Visible; }
        }

        /// <summary>自检诊断用：进度椭圆是否可见（占比 0 时应当隐藏）。</summary>
        internal bool DiagProgressVisible
        {
            get { return _ringProgress != null && _ringProgress.Visibility == Visibility.Visible; }
        }

        /// <summary>自检诊断用：当前进度弧的 StrokeDashArray（null = 整圈）。</summary>
        internal DoubleCollection DiagDashArray
        {
            get { return _ringProgress == null ? null : _ringProgress.StrokeDashArray; }
        }

        /// <summary>自检诊断用：进度椭圆的可见性 + dash（判断"弧长算对了没"）。</summary>
        internal double DiagDashFirst
        {
            get
            {
                DoubleCollection d = DiagDashArray;
                return d == null || d.Count == 0 ? -1 : d[0];
            }
        }

        /// <summary>自检诊断用：呼吸动画是否在跑。</summary>
        internal bool DiagBreathing { get { return _breathing; } }

        /// <summary>自检诊断用：当前呼吸缩放值。</summary>
        internal double DiagBreathScale { get { return _breathScale == null ? 1.0 : _breathScale.ScaleX; } }

        /// <summary>自检诊断用：当前字号。</summary>
        internal double DiagFontSize { get { return _text == null ? 0 : _text.FontSize; } }

        /// <summary>自检诊断用：当前是否处于可见态。</summary>
        internal bool DiagShouldShow { get { return _wanted; } }

        /// <summary>
        /// 窗口句柄（Program 算定位锚点时要用它取 DPI）。
        /// `Window` 不公开 `Handle`，所以自己转一次 —— 句柄在 Loaded 后才有值。
        /// </summary>
        internal IntPtr HandleOrZero
        {
            get
            {
                if (_hwnd != IntPtr.Zero) return _hwnd;
                try { return new WindowInteropHelper(this).Handle; } catch { return IntPtr.Zero; }
            }
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
            _phaseText.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
            // 环：进度用**强调色**（它在"告诉我还剩多久"，该比边框显眼），
            // 轨道用边框色降透明度 —— 深色下不能用浅色的淡蓝，会糊成一片。
            _ringProgress.Stroke = new SolidColorBrush(Color.FromRgb(p.AccR, p.AccG, p.AccB));
            _trackColor = dark
                ? Color.FromArgb(70, 120, 140, 175)
                : Color.FromArgb(60, 150, 175, 215);
            _ringTrack.Stroke = new SolidColorBrush(_trackColor);
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
            _phaseText.FontSize = Math.Max(MinFontSize, BaseFontSize * s);
            double px = Math.Max(2, BasePaddingX * s);
            double py = Math.Max(0.5, BasePaddingY * s);
            _chrome.Padding = new Thickness(px, py, px, py);
            _chrome.CornerRadius = new CornerRadius(Math.Max(2, BaseCornerRadius * s));
            UpdateRingSize();
        }

        /// <summary>
        /// 环直径：**必须装得下环内文字**，否则 `4:00:00`（自由计时上限 4 小时）
        /// 会从圆里溢出来 —— 7 个字符在 11px 下约 42px 宽，而基准环只有 38px。
        ///
        /// 算法：直径 d 的圆要装下 w×h 的矩形，需 `w² + h² ≤ d²`（对角相等），
        /// 再留 6px 视觉余量。取"基准尺寸"与"文字所需尺寸"的较大者。
        /// </summary>
        private void UpdateRingSize()
        {
            double s = _scale <= 0 ? 1.0 : _scale;
            double baseSize = Math.Max(16, BaseRingSize * s);
            double thick = Math.Max(1.5, BaseRingThickness * s);

            double d = baseSize;
            if (_text != null)
            {
                // 先量一次：DesiredSize 只有在 Measure 之后才是当前文字的真实尺寸。
                _text.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                double tw = _text.DesiredSize.Width, th = _text.DesiredSize.Height;
                if (tw > 0 && th > 0)
                {
                    double need = Math.Sqrt(tw * tw + th * th) + 6;
                    if (need > d) d = need;
                }
            }

            _ringTrack.Width = d; _ringTrack.Height = d;
            _ringTrack.StrokeThickness = thick;
            _ringProgress.Width = d; _ringProgress.Height = d;
            _ringProgress.StrokeThickness = thick;
        }

        /// <summary>
        /// 设置进度环的占比。
        ///
        /// ── 弧长怎么算（WPF 的 dash 单位是"描边宽度的倍数"）──────────────────
        ///
        /// `Ellipse` 的周长 C = π × 直径（用 `Width`，因为描边画在**半径中线**上，
        /// 直径取 Width 即可）。`StrokeDashArray` 的单位是**描边粗细 t**，
        /// 所以周长折成 dash 单位是 `C / t`。要画出占比 f 的弧：
        ///     dash = [ f × C/t , (1 − f) × C/t ]
        /// 第一段实、第二段空 —— 配合 `StrokeDashOffset = 0` 与 −90° 旋转，
        /// 弧就从 12 点顺时针铺开 f 圈。
        ///
        /// @param fraction 剩余占比 0..1；**&lt;0 = 未知**（环整组隐藏，不编假进度）
        /// </summary>
        private void SetRingFraction(double fraction)
        {
            if (fraction < 0)
            {
                // 未知进度（比如 Host 没给 totalMs）→ **不显示环**。
                // 编一个 50% 出来会让用户以为计时器坏了。
                _ringHost.Visibility = Visibility.Collapsed;
                return;
            }
            _ringHost.Visibility = Visibility.Visible;
            if (fraction > 1) fraction = 1;
            if (fraction <= 0)
            {
                // 占比 0：不画进度椭圆。dash 长度为 0 时 WPF 会画出一个斑点
                // （Round cap 让 0 长度也可见），所以直接隐藏更干净。
                _ringProgress.Visibility = Visibility.Collapsed;
                return;
            }
            _ringProgress.Visibility = Visibility.Visible;
            if (fraction >= 1)
            {
                // 整圈：不设 dash（比设一个"实线段刚好等于周长"更稳，
                // 避免浮点误差在起点留一道细缝）。
                _ringProgress.StrokeDashArray = null;
                return;
            }
            // ⚠️ 环的直径依赖环内文字的宽度（见 UpdateRingSize），所以改文字之后
            // 必须**先重算尺寸**再算 dash —— 否则会拿上一段文字的周长去铺弧，
            // 弧长与实际圆不符（`24:59` → `4:00:00` 时直径会变大）。
            UpdateRingSize();
            double t = _ringProgress.StrokeThickness;
            double d = _ringProgress.Width;
            if (t <= 0 || d <= 0) return;
            double circumferenceInDashes = Math.PI * d / t;
            DoubleCollection dash = new DoubleCollection();
            dash.Add(fraction * circumferenceInDashes);
            dash.Add((1.0 - fraction) * circumferenceInDashes);
            _ringProgress.StrokeDashArray = dash;
        }

        /// <summary>
        /// 呼吸引导（4-7-8）。
        ///
        /// ⚠️ 缩放**只从 1.0 缩到 <see cref="BreathMinScale"/>**（永远 ≤ 1.0）：
        /// 窗口是 `SizeToContent`，环放大就会把窗口撑大 —— 而窗口一变大，
        /// `ComputeTarget` 的定位与状态文字的让位都要重算，且环会溢出窗口被裁。
        /// "呼吸"的视觉本质是**收缩再回到原样**，不需要超过原尺寸。
        /// </summary>
        private void ApplyBreath()
        {
            bool want = _breathOn && _wanted && _ringHost.Visibility == Visibility.Visible;
            if (want == _breathing) return;      // 状态没变 → 不动（不重启动画）
            _breathing = want;
            try
            {
                if (!want)
                {
                    _breathScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                    _breathScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                    _breathScale.ScaleX = 1.0;
                    _breathScale.ScaleY = 1.0;
                    return;
                }
                DoubleAnimationUsingKeyFrames a = new DoubleAnimationUsingKeyFrames();
                a.Duration = new Duration(TimeSpan.FromMilliseconds(BreathCycleMs));
                a.RepeatBehavior = RepeatBehavior.Forever;
                // 4s 吸气（缩到最小）→ 7s 屏息（保持最小）→ 8s 呼气（回到 1.0）
                a.KeyFrames.Add(new LinearDoubleKeyFrame(BreathMinScale,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(4000))));
                a.KeyFrames.Add(new LinearDoubleKeyFrame(BreathMinScale,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(11000))));
                a.KeyFrames.Add(new LinearDoubleKeyFrame(1.0,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(19000))));
                _breathScale.BeginAnimation(ScaleTransform.ScaleXProperty, a);
                _breathScale.BeginAnimation(ScaleTransform.ScaleYProperty, a);
            }
            catch (Exception ex) { PetLog.Warn("呼吸引导动画失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>呼吸引导开关（Program 从 `settings.pomodoroBreath` 喂入）。</summary>
        public void SetBreath(bool on)
        {
            if (_breathOn == on) return;
            _breathOn = on;
            ApplyBreath();
        }

        /// <summary>自检诊断用：注入呼吸开关（不依赖 Program）。</summary>
        internal void DiagSetBreath(bool on) { SetBreath(on); }

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
            // 旧重载：没有进度信息 → 整圈（fraction=1），环只作装饰。
            // 保留它是因为既有调用点与自检都在用；语义与 v11 之前一致。
            Update(text, null, 1.0, wanted, petVisible, petRect, anchorRect);
        }

        /// <summary>
        /// v11 统一入口：环内剩余时间 + 环右侧阶段文字 + 剩余占比。
        ///
        /// @param ringText  环内文字（通常是 `24:59`）；null/空 = 不显示
        /// @param phaseText 环右侧文字（`专注 · 第 2/4 轮`）；null/空 = 只显示环
        /// @param fraction  剩余占比 0..1；**&lt;0 = 未知**（整环隐藏，不编假进度）
        /// </summary>
        public void Update(string ringText, string phaseText, double fraction, bool wanted,
                           bool petVisible, int[] petRect, int[] anchorRect)
        {
            _text.Text = ringText ?? "";
            _phaseText.Text = phaseText ?? "";
            // 显示判据用**两者之一**非空：只有阶段名（没有时间）也该显示，
            // 否则"计时器跑着但一个字都不显示"看起来就是坏了。
            bool hasContent = !string.IsNullOrEmpty(_text.Text) || !string.IsNullOrEmpty(_phaseText.Text);
            _wanted = wanted && petVisible && hasContent;
            _lastPetRect = petRect;
            _anchorRect = anchorRect;
            SetRingFraction(fraction);
            ApplyBreath();
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
        /// v11：同时把环置为"整圈"（旧断言的语义：有内容就显示）。
        /// </summary>
        internal void DiagSetState(string text, bool wanted, bool petVisible)
        {
            _text.Text = text ?? "";
            _wanted = wanted && petVisible && !string.IsNullOrEmpty(_text.Text);
            SetRingFraction(1.0);
        }

        /// <summary>自检诊断用：注入带进度的完整状态。</summary>
        internal void DiagSetFullState(string ringText, string phaseText, double fraction,
                                       bool wanted, bool petVisible)
        {
            _text.Text = ringText ?? "";
            _phaseText.Text = phaseText ?? "";
            bool hasContent = !string.IsNullOrEmpty(_text.Text) || !string.IsNullOrEmpty(_phaseText.Text);
            _wanted = wanted && petVisible && hasContent;
            SetRingFraction(fraction);
            ApplyBreath();
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
