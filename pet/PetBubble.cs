using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 气泡窗：**纯展示，永不交互** —— HwndSourceHook 对 WM_NCHITTEST 恒返回 HTTRANSPARENT(-1)，
    /// 所以鼠标事件永远穿过去，气泡上点不到任何东西，也不会挡住底下的窗口。
    /// 自适应大小（图片/文字任意组合）、自动淡出、跟随本体窗定位。
    /// </summary>
    internal sealed class PetBubble : Window
    {
        private readonly Grid _root;
        private readonly Border _border;
        private readonly StackPanel _stack;
        private readonly Image _image;
        private readonly TextBlock _text;

        // task-8：attention 常亮提醒的头部条（左：红色计数徽标；右：去处理按钮）
        private readonly DockPanel _attentionBar;
        private readonly Border _badge;
        private readonly TextBlock _badgeText;
        private readonly Border _goBtn;
        private readonly TextBlock _goText;
        private readonly DispatcherTimer _pulseTimer;
        private bool _pulseOn;
        private bool _attentionMode;

        private readonly DispatcherTimer _hideTimer;
        private IntPtr _hwnd;
        private HwndSource _source;
        private bool _reallyClosing;

        private long _currentId = -1;
        private int _currentPriority = int.MinValue;

        // 透明抠图气泡的默认外观（契约 §4 opaque=false 的呈现，保持历史值不动）
        private static readonly Thickness DefaultPadding = new Thickness(10, 7, 10, 7);
        private static readonly Thickness DefaultBorderWidth = new Thickness(1);
        private const double DefaultImageMaxH = 160;
        private const double DefaultImageMaxW = 200;
        private readonly Brush _defaultBackground;
        private readonly Brush _defaultBorderBrush;

        // 契约 §4 opaque=true：不透明满幅贴纸本身就是整张卡片（含文字），
        // 160px 高度下 baked-in 中文读不清 → 放宽到 240（窗口 SizeToContent 自适应）。
        private const double OpaqueImageMaxH = 240;
        private const double OpaqueImageMaxW = 240;

        /// <summary>取本体窗的屏幕矩形（物理像素），由 Program 注入。</summary>
        public Func<int[]> PetRectProvider;

        public long CurrentId { get { return _currentId; } }
        public bool Showing { get; private set; }

        /// <summary>
        /// 自检用：当前是否处于「不透明满幅」呈现
        /// （背景透明 / 边框厚 0 / 无内边距 / 图片上限放宽到 240）。
        /// </summary>
        internal bool IsOpaquePresentation
        {
            get
            {
                return _border != null
                    && object.ReferenceEquals(_border.Background, Brushes.Transparent)
                    && _border.BorderThickness.Left == 0
                    && _border.Padding.Left == 0
                    && _image.MaxHeight == OpaqueImageMaxH
                    && _image.MaxWidth == OpaqueImageMaxW;
            }
        }

        // ------------------------------------------------------------------
        // task-8：attention 常亮呈现（自检断言的观察面）
        // ------------------------------------------------------------------

        /// <summary>当前是否为 attention 呈现（描边加粗 + 强调色 + 脉动 + 头部条可见）。</summary>
        internal bool IsAttentionPresentation
        {
            get
            {
                return _attentionMode
                    && _attentionBar != null && _attentionBar.Visibility == Visibility.Visible
                    && _border.BorderThickness.Left == AttentionBorderWidth
                    && _pulseTimer != null && _pulseTimer.IsEnabled;
            }
        }

        /// <summary>计数徽标当前文本；null = 隐藏（attentionCount &lt; 2）。</summary>
        internal string BadgeText
        {
            get
            {
                return _badge != null && _badge.Visibility == Visibility.Visible
                    ? _badgeText.Text : null;
            }
        }

        /// <summary>「去处理」按钮是否可见。</summary>
        internal bool GoButtonVisible
        {
            get { return _goBtn != null && _goBtn.Visibility == Visibility.Visible; }
        }

        public PetBubble()
        {
            Title = "DSH 庄方宜桌宠-气泡";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            ShowActivated = false;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            Opacity = 0;

            _text = new TextBlock();
            _text.TextWrapping = TextWrapping.Wrap;
            _text.MaxWidth = 240;
            _text.FontSize = 13;
            _text.Foreground = new SolidColorBrush(Color.FromRgb(28, 34, 48));
            _text.LineHeight = 18;
            _text.Visibility = Visibility.Collapsed;

            _image = new Image();
            _image.Stretch = Stretch.Uniform;
            _image.MaxHeight = DefaultImageMaxH;
            _image.MaxWidth = DefaultImageMaxW;
            _image.HorizontalAlignment = HorizontalAlignment.Center;
            RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.HighQuality);
            _image.Visibility = Visibility.Collapsed;

            _stack = new StackPanel();
            _stack.Orientation = Orientation.Vertical;
            _stack.Children.Add(_image);
            _stack.Children.Add(_text);

            // 默认外观值先留底（opaque 呈现后要能恢复回去；气泡窗是长生命周期对象）
            _defaultBackground = new SolidColorBrush(Color.FromArgb(238, 255, 255, 255));
            _defaultBorderBrush = new SolidColorBrush(Color.FromArgb(210, 120, 160, 220));

            _border = new Border();
            _border.CornerRadius = new CornerRadius(9);
            ApplyDefaultChrome();
            try
            {
                DropShadowEffect sh = new DropShadowEffect();
                sh.BlurRadius = 10;
                sh.ShadowDepth = 2;
                sh.Opacity = 0.35;
                sh.Color = Colors.Black;
                _border.Effect = sh;      // 投影两种模式都保留（opaque 贴纸要从桌面浮起来）
            }
            catch { }
            _border.Child = _stack;

            // task-8：attention 头部条 —— 左徽标 + 右「去处理」按钮，放 _stack 顶部。
            // 普通气泡整条 Collapsed；attention 时 Visible。
            _badgeText = new TextBlock();
            _badgeText.Text = "2";
            _badgeText.FontSize = 11;
            _badgeText.FontWeight = FontWeights.Bold;
            _badgeText.Foreground = Brushes.White;
            _badgeText.HorizontalAlignment = HorizontalAlignment.Center;
            _badgeText.VerticalAlignment = VerticalAlignment.Center;
            _badge = new Border();
            _badge.Child = _badgeText;
            _badge.CornerRadius = new CornerRadius(8);
            _badge.Background = new SolidColorBrush(Color.FromRgb(226, 74, 74));   // 红色徽标
            _badge.MinWidth = 18;
            _badge.Height = 18;
            _badge.Margin = new Thickness(2, 0, 6, 0);
            _badge.Visibility = Visibility.Collapsed;

            _goText = new TextBlock();
            _goText.Text = "去处理";
            _goText.FontSize = 12;
            _goText.Foreground = Brushes.White;
            _goText.Margin = new Thickness(8, 2, 8, 3);
            _goBtn = new Border();
            _goBtn.Child = _goText;
            _goBtn.CornerRadius = new CornerRadius(6);
            _goBtn.Background = new SolidColorBrush(Color.FromRgb(62, 108, 200));  // 强调色小按钮
            _goBtn.Cursor = Cursors.Hand;
            _goBtn.VerticalAlignment = VerticalAlignment.Center;
            _goBtn.Visibility = Visibility.Collapsed;
            // 去处理 → 复用双击已实现的 focus-dsh 链路（Program 装配 GoAction）
            _goBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                Action h = GoAction;
                if (h != null) h();
            };

            _attentionBar = new DockPanel();
            _attentionBar.LastChildFill = false;
            _attentionBar.Margin = new Thickness(2, 0, 2, 6);
            _attentionBar.Children.Add(_goBtn);
            DockPanel.SetDock(_goBtn, Dock.Right);
            _attentionBar.Children.Add(_badge);
            DockPanel.SetDock(_badge, Dock.Left);
            _attentionBar.Visibility = Visibility.Collapsed;
            _stack.Children.Insert(0, _attentionBar);

            _root = new Grid();
            _root.Background = Brushes.Transparent;
            _root.Children.Add(_border);
            Content = _root;

            _hideTimer = new DispatcherTimer(DispatcherPriority.Normal);
            _hideTimer.Tick += OnHideTick;

            // task-8：脉动 —— 只调描边/投影亮度（_pulseOn 翻转两档），不做位移/缩放，
            // 否则会跟 PlaceNearPet 与拖动定位打架。
            _pulseTimer = new DispatcherTimer(DispatcherPriority.Background);
            _pulseTimer.Interval = TimeSpan.FromMilliseconds(650);
            _pulseTimer.Tick += delegate(object s, EventArgs e)
            {
                if (!_attentionMode) return;
                _pulseOn = !_pulseOn;
                ApplyAttentionPulse(_pulseOn);
            };

            Loaded += OnLoaded;
            Closing += OnClosing;
        }

        /// <summary>task-8：「去处理」点击回调（Program 装配成 focus-dsh 链路）。</summary>
        public Action GoAction = delegate { };

        /// <summary>自检专用：模拟「去处理」点击（触发与真实 MouseLeftButtonUp 相同的回调路径）。</summary>
        internal void RaiseGoForTest()
        {
            Action h = GoAction;
            if (h != null) h();
        }

        /// <summary>attention 描边宽度（普通气泡是 1；attention 加粗到 2.5）。</summary>
        private const double AttentionBorderWidth = 2.5;

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
            PetLog.Info("气泡窗已创建 hwnd=0x" + _hwnd.ToInt64().ToString("X"));
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!_reallyClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            _hideTimer.Stop();
            if (_source != null)
            {
                _source.RemoveHook(WndProc);
                _source = null;
            }
        }

        public void ForceClose()
        {
            _reallyClosing = true;
            try { Close(); } catch { }
        }

        // ------------------------------------------------------------------
        // 展示
        // ------------------------------------------------------------------

        /// <summary>
        /// 显示一条气泡。b 的 id 单调递增：同 id 不重复弹（契约 §2）。
        /// priority 更低的、在当前气泡还在展示期内时被忽略。
        /// task-8：kind==='attention' → 恒亮（不启动 hideTimer），存续由 attention 块决定。
        /// </summary>
        public bool Show(PetBubbleInfo b, BitmapSource img)
        {
            if (b == null) return false;
            if (b.Id == _currentId && _currentId >= 0) return false;
            if (Showing && b.Priority < _currentPriority) return false;

            // task-8：attention 是第四种 kind —— 纯文本提醒（WantsText 覆盖不到它）。
            bool attention = b.Kind == "attention";
            bool hasImg = b.WantsImage && img != null;
            bool hasText = (b.WantsText || attention) && !string.IsNullOrEmpty(b.Text);
            if (!hasImg && !hasText)
            {
                if ((b.WantsText || attention) && !string.IsNullOrEmpty(b.Text)) hasText = true;
                else return false;
            }

            _image.Source = hasImg ? img : null;
            _image.Visibility = hasImg ? Visibility.Visible : Visibility.Collapsed;
            _text.Text = hasText ? b.Text : "";
            _text.Visibility = hasText ? Visibility.Visible : Visibility.Collapsed;

            // 契约 §4 opaque：不透明满幅贴纸图本身就是一张卡片，
            // 再画气泡自己的底/边框/内边距会出现「白纸贴在浅色框里」的双层边框 → 全部去掉。
            // 透明抠图（缺省/显式 false）保持原有呈现不变。
            // task-8：attention 气泡恒走默认底（attention 有自己的描边/头部条，满幅贴纸语义不适用）。
            ApplyBubbleChrome(hasImg && b.Opaque && !attention);

            // task-8：attention 头部条 —— 徽标（count>=2）与「去处理」按钮
            _attentionMode = attention;
            _attentionBar.Visibility = attention ? Visibility.Visible : Visibility.Collapsed;
            _goBtn.Visibility = attention ? Visibility.Visible : Visibility.Collapsed;
            bool wantBadge = attention && b.AttentionCount >= 2;
            _badge.Visibility = wantBadge ? Visibility.Visible : Visibility.Collapsed;
            if (wantBadge) _badgeText.Text = b.AttentionCount.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (attention)
            {
                ApplyAttentionBase();
                _pulseOn = true;
                ApplyAttentionPulse(true);
                _pulseTimer.Start();       // 恒亮：脉动持续，直到收起/换普通
            }
            else
            {
                _pulseTimer.Stop();
            }

            _currentId = b.Id;
            _currentPriority = b.Priority;
            Showing = true;

            // 先按新内容测量，再定位（SizeToContent 在 Show 之后才生效，用 Measure 预排）
            try
            {
                _root.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            }
            catch { }

            if (!IsVisible) Show();
            UpdateLayout();
            PlaceNearPet();

            FadeIn();

            // task-8：attention 恒亮 —— **忽略 durationMs 不启动收起定时器**，
            // 存续完全由快照 attention 块决定（null → Program 调 HideAttention）。
            // 兜底上限 30 分钟在 Host 状态机里，exe 绝不自算超时（两侧口径一致才不打架）。
            if (attention)
            {
                _hideTimer.Stop();
                PetLog.Info("attention 气泡恒亮 count=" +
                            b.AttentionCount.ToString(System.Globalization.CultureInfo.InvariantCulture));
                return true;
            }

            int ms = b.DurationMs;
            if (ms < 500) ms = 500;
            _hideTimer.Stop();
            _hideTimer.Interval = TimeSpan.FromMilliseconds(ms);
            _hideTimer.Start();
            return true;
        }

        private void OnHideTick(object sender, EventArgs e)
        {
            _hideTimer.Stop();
            FadeOut();
        }

        /// <summary>
        /// 按 opaque 切换气泡外壳。每次 Show 都会调用（气泡窗复用，
        /// 上一条 opaque 贴纸留下的样式必须能完全恢复）。
        /// 投影（_border.Effect）两种模式共用，不在切换范围。
        /// </summary>
        private void ApplyBubbleChrome(bool opaque)
        {
            if (opaque)
            {
                _border.Background = Brushes.Transparent;
                _border.BorderBrush = Brushes.Transparent;
                _border.BorderThickness = new Thickness(0);
                _border.Padding = new Thickness(0);
                _border.CornerRadius = new CornerRadius(0);
                _image.MaxHeight = OpaqueImageMaxH;
                _image.MaxWidth = OpaqueImageMaxW;
            }
            else
            {
                ApplyDefaultChrome();
            }
        }

        /// <summary>透明抠图气泡的默认外壳（背景/边框/圆角 9/内边距/图片上限 160x200）。</summary>
        private void ApplyDefaultChrome()
        {
            _border.Background = _defaultBackground;
            _border.BorderBrush = _defaultBorderBrush;
            _border.BorderThickness = DefaultBorderWidth;
            _border.Padding = DefaultPadding;
            _border.CornerRadius = new CornerRadius(9);
            _image.MaxHeight = DefaultImageMaxH;
            _image.MaxWidth = DefaultImageMaxW;
        }

        // ------------------------------------------------------------------
        // task-8：attention 常亮呈现（描边加粗 + 主题强调色 + 轻微脉动，零位移）
        // ------------------------------------------------------------------

        /// <summary>attention 基础外壳：默认底之上加粗描边为强调色、稍厚投影。</summary>
        private void ApplyAttentionBase()
        {
            _border.BorderThickness = new Thickness(AttentionBorderWidth);
            _border.BorderBrush = new SolidColorBrush(Color.FromRgb(232, 118, 62));   // 主题强调色（暖橙，醒目不刺眼）
        }

        /// <summary>脉动两档：只改描边/投影亮度（On=亮），绝不改位置/尺寸。</summary>
        private void ApplyAttentionPulse(bool bright)
        {
            if (!_attentionMode) return;
            byte a = bright ? (byte)255 : (byte)150;
            _border.BorderBrush = new SolidColorBrush(Color.FromArgb(a, 232, 118, 62));
            try
            {
                System.Windows.Media.Effects.DropShadowEffect sh = _border.Effect as System.Windows.Media.Effects.DropShadowEffect;
                if (sh != null) sh.Opacity = bright ? 0.55 : 0.3;
            }
            catch { }
        }

        /// <summary>
        /// task-8：attention 结束（快照 attention=null 或 Host 收气泡）→ 立刻收起。
        /// 不走淡出（恒亮提醒消失应当干脆）；停脉动并复位头部条。
        /// </summary>
        public void HideAttention()
        {
            _pulseTimer.Stop();
            _attentionMode = false;
            _attentionBar.Visibility = Visibility.Collapsed;
            _goBtn.Visibility = Visibility.Collapsed;
            _badge.Visibility = Visibility.Collapsed;
            if (Showing || IsVisible)
            {
                PetLog.Info("attention 解除 → 收起气泡");
                HideNow();
            }
        }

        public void HideNow()
        {
            _hideTimer.Stop();
            Showing = false;
            _currentId = -1;
            _currentPriority = int.MinValue;
            if (IsVisible) Hide();
            Opacity = 0;
        }

        // ------------------------------------------------------------------
        // 定位（跟随本体窗，clamp 进工作区）
        // ------------------------------------------------------------------

        public void PlaceNearPet()
        {
            if (!IsVisible && !Showing) return;
            int[] pet = PetRectProvider == null ? null : PetRectProvider();
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;

            int bw = (int)Math.Round(ActualWidth * dpi);
            int bh = (int)Math.Round(ActualHeight * dpi);
            if (bw <= 0) bw = 200;
            if (bh <= 0) bh = 48;

            int px, py, pw, ph;
            if (pet != null && pet.Length >= 4) { px = pet[0]; py = pet[1]; pw = pet[2]; ph = pet[3]; }
            else
            {
                PetNative.DefaultPosition(bw, bh, out px, out py);
                pw = bw; ph = bh;
            }

            // 优先：贴在头顶，右对齐
            int x = px + pw - bw;
            int y = py - bh - 10;
            PetNative.WorkArea scr = PetNative.NearestScreen(px + pw / 2, py + ph / 2);
            if (y < scr.Y + 4)
            {
                // 头顶放不下 → 放到脚下
                y = py + ph + 10;
                if (y + bh > scr.Bottom - 4) y = scr.Y + 4;
            }
            int maxX = scr.Right - bw - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;

            Left = x / dpi;
            Top = y / dpi;
        }

        // ------------------------------------------------------------------
        // 淡入淡出
        // ------------------------------------------------------------------

        private void FadeIn()
        {
            try
            {
                BeginAnimation(OpacityProperty, null);
                Opacity = 0;
                DoubleAnimation a = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180));
                a.FillBehavior = FillBehavior.HoldEnd;
                BeginAnimation(OpacityProperty, a);
            }
            catch { Opacity = 1; }
        }

        private void FadeOut()
        {
            try
            {
                DoubleAnimation a = new DoubleAnimation(Opacity, 0, TimeSpan.FromMilliseconds(260));
                a.FillBehavior = FillBehavior.HoldEnd;
                a.Completed += delegate(object s, EventArgs e)
                {
                    try
                    {
                        Hide();
                        BeginAnimation(OpacityProperty, null);
                        Opacity = 0;
                    }
                    catch { }
                    Showing = false;
                    _currentId = -1;
                    _currentPriority = int.MinValue;
                };
                BeginAnimation(OpacityProperty, a);
            }
            catch
            {
                HideNow();
            }
        }

        // ------------------------------------------------------------------
        // 窗口消息：恒穿透
        // ------------------------------------------------------------------

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            switch (msg)
            {
                case PetNative.WM_NCHITTEST:
                    // task-8：「去处理」按钮必须可点 —— 按钮矩形内返回 HTCLIENT，
                    // 其余区域仍恒 HTTRANSPARENT（气泡主体纯展示不变）。
                    if (_goBtn != null && _goBtn.Visibility == Visibility.Visible)
                    {
                        try
                        {
                            int sx = unchecked((short)(lParam.ToInt64() & 0xFFFF));
                            int sy = unchecked((short)((lParam.ToInt64() >> 16) & 0xFFFF));
                            Point client = PointFromScreen(new Point(sx, sy));
                            Point rel = _goBtn.TransformToAncestor(this).Transform(new Point(0, 0));
                            Rect r = new Rect(rel.X, rel.Y, _goBtn.ActualWidth, _goBtn.ActualHeight);
                            r.Inflate(2, 2);   // 小目标给 2 DIP 容差
                            if (r.Contains(client))
                            {
                                handled = true;
                                return new IntPtr(PetNative.HTCLIENT);
                            }
                        }
                        catch { }
                    }
                    // 纯展示：整窗恒 HTTRANSPARENT，鼠标永远穿过去
                    handled = true;
                    return new IntPtr(PetNative.HTTRANSPARENT);

                case PetNative.WM_MOUSEACTIVATE:
                    handled = true;
                    return new IntPtr(PetNative.MA_NOACTIVATE);
            }
            return IntPtr.Zero;
        }
    }
}