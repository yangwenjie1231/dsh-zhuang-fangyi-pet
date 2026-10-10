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
        /// <summary>当前是否为不透明满幅贴纸呈现（缩放重铺时要用同一分支）。</summary>
        private bool _opaquePresentation;

        /// <summary>
        /// 气泡**动图**的帧推进器（静态气泡永不启动）。
        ///
        /// 与精灵动画（`PetWindow`）同一套做法：一只 DispatcherTimer + 帧号递增 + 换
        /// `_image.Source`。气泡这边更简单 —— 帧是 decoder 逐帧解好的，不用切条带。
        /// </summary>
        private readonly DispatcherTimer _animTimer;
        private BitmapSource[] _animFrames;
        private int _animIndex;
        /// <summary>自检用：Tick 实际触发次数（只增不减，StartBubbleAnim 里清零）。</summary>
        private int _animTicks;

        private readonly DispatcherTimer _hideTimer;
        private IntPtr _hwnd;
        private HwndSource _source;
        private bool _reallyClosing;

        private long _currentId = -1;
        /// <summary>当前显示的气泡类型（attention 换主题时只换底/字，保留橙色描边）。</summary>
        private string _currentKind;
        private int _currentPriority = int.MinValue;

        // 透明抠图气泡的默认外观（契约 §4 opaque=false 的呈现）。
        //
        // ⚠️ 这些值**随桌宠缩放同比变化**：气泡是独立窗口，过去尺寸/字号写死，
        // 桌宠缩到 0.5× 时气泡还是原尺寸（比例崩掉）。基准值是 scale=1 时的取值，
        // 实际值 = 基准 × scale（见 UpdateMetrics）。
        private const double BasePaddingX = 10;
        private const double BasePaddingY = 7;
        private const double BaseBorderWidth = 1;
        // ⭐ 气泡大小按**桌宠的比例**定，不再写死绝对像素。
        //
        // 原先写死 160/200/240 DIP 再乘 scale —— 但**漏了 DPI 换算**：
        // 在 150% 缩放下桌宠窗口是 256 × scale × (96/144) ≈ 136 DIP，
        // 而气泡上限仍有 192 DIP（满幅贴纸）= 桌宠的 **141%** —— 比桌宠还大。
        // 用户反馈"气泡相对于桌宠太大了"就是这个。
        //
        // 改成比例后，任何 DPI / 缩放档位下"气泡 : 桌宠"都恒定。
        private const double BaseImageMaxH = 160;
        private const double BaseImageMaxW = 200;
        /// <summary>气泡（含透明抠图）相对桌宠**显示宽度**的上限比例。</summary>
        private const double BubbleToPetRatio = 0.70;
        private const double BaseTextMaxW = 240;
        private const double BaseFontSize = 13;
        private const double BaseBadgeFontSize = 11;
        private const double BaseGoFontSize = 12;
        private const double BaseCornerRadius = 9;

        /// <summary>当前缩放（0.3~3.0，与本体一致）。</summary>
        private double _scale = 1.0;

        /// <summary>
        /// 对话正文的**独立字号倍率**（1.0 = 基准）。
        ///
        /// 用户点名："你对话里面的文字大小也需要可调呀"。
        /// 与状态栏同一个道理：字号原先只乘 `_scale`（桌宠大小），用户把桌宠调到
        /// 0.5 是为了不占地，正文却被一起缩到 6.5px（下限兜底值）—— 读不了。
        /// 独立成项后可以"桌宠小、正文清楚"。
        /// </summary>
        private double _fontScale = 1.0;

        // ⚠️ **必须有初值**（= scale 1.0 时的基准值）。
        // 踩过：把常量改成字段时漏了初值，字段默认全 0 → 图片上限 0（图片被压成 0 高，
        // 表现为"气泡里什么都没有"）、内边距/边框 0（没有底色）——
        // 而**图片解码日志全是成功的**，光看日志根本看不出来。
        // 另一个坑：`UpdateMetrics()` 原先只在 `SetScale()` 里调用，构造函数从不调用，
        // 所以"从没缩放过"的气泡一直用着这份 0 值。构造末尾已补一次 UpdateMetrics()。
        private Thickness DefaultPadding = new Thickness(BasePaddingX, BasePaddingY, BasePaddingX, BasePaddingY);
        private Thickness DefaultBorderWidth = new Thickness(BaseBorderWidth);
        private double DefaultImageMaxH = BaseImageMaxH;
        private double DefaultImageMaxW = BaseImageMaxW;
        private Brush _defaultBackground;
        private Brush _defaultBorderBrush;
        // 注：原先这里还有一个 `_palette` 字段（ApplyTheme 里赋值），
        // 但**全仓从未读取过它** —— 死的。v11 清理时删掉。
        // 配色经由 `_defaultBackground` / `_defaultBorderBrush` / `_text.Foreground`
        // 三条路径生效，不需要再存一份。

        // 契约 §4 opaque=true：不透明满幅贴纸本身就是整张卡片（含文字），
        // 160px 高度下 baked-in 中文读不清 → 放宽到 240（窗口 SizeToContent 自适应）。
        private double OpaqueImageMaxH = 240;
        /// <summary>满幅贴纸的圆角半径（基准 × scale）。实测那批图四角 alpha=255（方形硬边），必须裁。</summary>
        private const double BaseOpaqueCornerRadius = 10;
        private double OpaqueCornerRadius = BaseOpaqueCornerRadius;
        private double OpaqueImageMaxW = 240;

        /// <summary>取本体窗的屏幕矩形（物理像素），由 Program 注入。</summary>
        public Func<int[]> PetRectProvider;

        public long CurrentId { get { return _currentId; } }

        /// <summary>自检诊断用：正文当前字号（缩放断言用）。</summary>
        internal double DiagTextFontSize { get { return _text == null ? 0 : _text.FontSize; } }

        /// <summary>
        /// 自检诊断用：正文当前 MaxWidth。
        /// 字号放大时它必须跟着放大，否则文字会挤成又窄又高的竖条。
        /// </summary>
        internal double DiagTextMaxWidth { get { return _text == null ? 0 : _text.MaxWidth; } }
        /// <summary>
        /// 自检诊断用：窗口屏幕矩形（物理像素）[x,y,w,h]。
        /// 用 WPF 的 Left/Top/ActualWidth（不引 P/Invoke），DPI 换算后返回。
        /// </summary>
        internal int[] DiagWindowRect()
        {
            try
            {
                double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                double w = ActualWidth > 0 ? ActualWidth : _root.DesiredSize.Width;
                double h = ActualHeight > 0 ? ActualHeight : _root.DesiredSize.Height;
                return new int[]
                {
                    (int)Math.Round(Left * dpi), (int)Math.Round(Top * dpi),
                    (int)Math.Round(w * dpi), (int)Math.Round(h * dpi)
                };
            }
            catch { return null; }
        }
        /// <summary>自检诊断用：当前气泡图上限（DIP）。用于断言"相对桌宠的比例"。</summary>
        internal double DiagImageCap { get { return _image == null ? 0 : _image.MaxHeight; } }
        /// <summary>自检诊断用：满幅贴纸是否挂了圆角裁剪。</summary>
        internal bool DiagOpaqueClipped
        {
            get
            {
                RectangleGeometry rg = _border == null ? null : _border.Clip as RectangleGeometry;
                return rg != null && rg.RadiusX > 0.5;
            }
        }
        /// <summary>
        /// 自检诊断用：人为把 Border 撑大（模拟投影/内边距造成的外扩）。
        /// 用途：验证"裁剪跟着图片走"—— 自检窗口没有真实投影，
        /// `ActualWidth` 恰好等于图片尺寸，不制造差异就区分不出 bug。
        /// </summary>
        internal void DiagSpreadBorder(double pad)
        {
            try
            {
                _border.Padding = new Thickness(pad, pad, pad, pad);
                _border.UpdateLayout();
            }
            catch { }
        }
        /// <summary>自检诊断用：图片元素的实际渲染尺寸（裁剪基准应当是它）。</summary>
        internal void DiagImageSize(out double w, out double h)
        {
            w = _image == null ? 0 : _image.ActualWidth;
            h = _image == null ? 0 : _image.ActualHeight;
            if (w <= 0 || h <= 0)
            {
                Size d = _image == null ? new Size(0, 0) : _image.DesiredSize;
                w = d.Width; h = d.Height;
            }
        }
        /// <summary>自检诊断用：当前圆角裁剪的尺寸与半径（判断裁剪是否真的按有效尺寸落下）。</summary>
        internal void DiagClipGeometry(out double w, out double h, out double r)
        {
            w = 0; h = 0; r = 0;
            RectangleGeometry rg = _border == null ? null : _border.Clip as RectangleGeometry;
            if (rg == null) return;
            w = rg.Rect.Width; h = rg.Rect.Height; r = rg.RadiusX;
        }

        /// <summary>
        /// 自检诊断用：图片元素在 **`_border` 坐标系**里的位置与尺寸。
        ///
        /// ⚠️ 为什么需要它（用户反馈"气泡表情有概率显示不全"）：
        /// 圆角裁剪是 `_border.Clip = Rect(0, 0, 图片宽, 图片高)` —— 它以
        /// **Border 左上角**为原点；而 `_image.HorizontalAlignment = Center`，
        /// 一旦 Border 比图片宽，图片会被**居中**（左偏移 `dx &gt; 0`），
        /// 于是裁剪矩形 `[0, 图片宽]` 切掉的是图片右侧 `[图片宽, dx+图片宽]` 那一条。
        /// 只看 `clip == img` 是发现不了的（两者确实相等），**必须看偏移**。
        /// </summary>
        internal void DiagImageOffsetInBorder(out double dx, out double dy,
                                              out double imgW, out double imgH)
        {
            dx = -1; dy = -1; imgW = 0; imgH = 0;
            if (_image == null || _border == null) return;
            try
            {
                System.Windows.Point p = _image.TranslatePoint(new System.Windows.Point(0, 0), _border);
                dx = p.X; dy = p.Y;
                imgW = _image.ActualWidth;
                imgH = _image.ActualHeight;
            }
            catch { }
        }

        /// <summary>自检诊断用：当前裁剪矩形的**原点**（判断它有没有跟着图片挪）。</summary>
        internal void DiagClipOrigin(out double x, out double y)
        {
            x = 0; y = 0;
            RectangleGeometry rg = _border == null ? null : _border.Clip as RectangleGeometry;
            if (rg == null) return;
            x = rg.Rect.X; y = rg.Rect.Y;
        }

        /// <summary>自检诊断用：立刻按当前尺寸重刷一次圆角裁剪（模拟 SizeChanged 的那条路）。</summary>
        internal void DiagRefreshClip()
        {
            if (_opaquePresentation) UpdateOpaqueClip();
        }
        /// <summary>自检诊断用：喂入本体尺寸后按比例算出的上限。</summary>
        internal double DiagCapForPet(int frameW, int frameH, double dpi, double scale)
        {
            SetPetMetrics(frameW, frameH, dpi);
            SetScale(scale);
            return _image == null ? 0 : _image.MaxHeight;
        }
        /// <summary>
        /// 自检诊断用：算出气泡目标位置（物理像素）。与 `PlaceNearPet` 同一套规则
        /// （**上方优先**），但不写窗口属性（没 Show 过的窗口 Left/Top 是 NaN）。
        /// 用途：验证"气泡在上 / 输入窗在下"两侧分工，不重叠。
        /// </summary>
        internal void DiagTargetFor(int px, int py, int pw, int ph, out int x, out int y)
        {
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;
            double wDip = _border != null && _border.DesiredSize.Width > 0 ? _border.DesiredSize.Width : 120;
            double hDip = _border != null && _border.DesiredSize.Height > 0 ? _border.DesiredSize.Height : 48;
            int bw = (int)Math.Round(wDip * dpi);
            int bh = (int)Math.Round(hDip * dpi);
            if (bw <= 0) bw = 200;
            if (bh <= 0) bh = 48;
            // **复用运行路径的算法**（不手抄副本 —— 上一轮的教训：副本让测试变成假绿）
            ComputeBubbleTarget(px, py, pw, ph, bw, bh, out x, out y);
        }
        /// <summary>自检诊断用：气泡内边距左值（判断"外观是否初始化过"）。</summary>
        internal double DiagPaddingLeft { get { return _border == null ? 0 : _border.Padding.Left; } }
        /// <summary>自检诊断用：图片上限高度（缩放断言用）。</summary>
        internal double DiagImageMaxH { get { return _image == null ? 0 : _image.MaxHeight; } }

        /// <summary>自检用：动图是否在推进（静态气泡恒 false）。</summary>
        internal bool DiagAnimRunning { get { return _animTimer != null && _animTimer.IsEnabled; } }

        /// <summary>自检用：当前帧号。</summary>
        internal int DiagAnimFrame { get { return _animIndex; } }

        /// <summary>自检用：本次装载的帧数（静态气泡为 0）。</summary>
        internal int DiagAnimFrameCount { get { return _animFrames == null ? 0 : _animFrames.Length; } }

        /// <summary>自检用：Tick 实际触发次数（区分"没启动"与"启动了但没跑"）。</summary>
        internal int DiagAnimTicks { get { return _animTicks; } }
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

            // 构造期就挂上尺寸监听：`SizeToContent` 的窗口会在后续布局中改尺寸，
            // 满幅贴纸的圆角裁剪必须跟着重算（只在 opaque 模式下生效，见回调）。
            _border.SizeChanged += OnChromeSizeChanged;

            // 用基准值把外观尺寸初始化好（见字段处的注释：漏了这步会让图片上限停在 0）。
            UpdateMetrics();

            _hideTimer = new DispatcherTimer(DispatcherPriority.Normal);
            _hideTimer.Tick += OnHideTick;

            // 动图帧推进：优先级 Render，与精灵动画一致（跟得上就不必抢更高）。
            _animTimer = new DispatcherTimer(DispatcherPriority.Render);
            _animTimer.Tick += OnAnimTick;

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
        /// 显示一条气泡（**静态**重载，保持旧调用点不变：自检、画廊兜底、回放）。
        /// </summary>
        public bool Show(PetBubbleInfo b, BitmapSource img)
        {
            return Show(b, img, null, 0);
        }

        /// <summary>
        /// 显示一条气泡。b 的 id 单调递增：同 id 不重复弹（契约 §2）。
        /// priority 更低的、在当前气泡还在展示期内时被忽略。
        /// task-8：kind==='attention' → 恒亮（不启动 hideTimer），存续由 attention 块决定。
        ///
        /// @param frames 动图帧（清单声明 `frames &gt; 1` 时由渲染方解好传入）。
        ///        传 null / 长度 ≤ 1 = 静态（**每次 Show 都会重置动画器**，
        ///        否则上一条动图会接着播到新气泡上 —— 明显的串台 bug）。
        /// @param frameMs 帧间隔；与精灵条带同一套约定（统一值，不读 GIF 每帧延时）。
        /// </summary>
        public bool Show(PetBubbleInfo b, BitmapSource img, BitmapSource[] frames, int frameMs)
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

            // 动图：帧优先于单张图（同一张图的第 0 帧，只是按显示尺寸缩过 → 更省内存）。
            // 放在这里（而不是 Show 末尾）是因为它要改 `_image.Source`，
            // 而后面 ApplyBubbleChrome/测量都依赖当前内容已经就位。
            StartBubbleAnim(hasImg ? frames : null, frameMs);
            _text.Text = hasText ? b.Text : "";
            _text.Visibility = hasText ? Visibility.Visible : Visibility.Collapsed;

            // 气泡外壳怎么画 —— **按"内容"决定，不按图片的 alpha 决定**。
            //
            // 用户问过一句很到位的话："表情做气泡内容的时候，为什么一定要加个白底？
            // 白底可以去掉啊"。答案是对的，白底的**唯一用途是让文字可读**：
            //   · 有文字 → 需要卡片承载（否则字直接飘在桌面上，深色壁纸下看不清）；
            //   · 纯图片（贴纸/动图/满幅） → 图片自己就是内容，垫一层白卡只会多出
            //     「白纸贴在浅色框里」的双层边框，还白占一圈内边距。
            //
            // 所以这里不再用 `b.Opaque` 一个开关兼管两件事：
            //   · `_opaquePresentation` 现在表示**"不画任何外壳"**；
            //   · 触发条件是 `opaque（满幅贴纸）` **或** `有图但无文字（纯表情）`。
            // 契约字段 `opaque` 的语义保持不变（渲染方不得再套气泡底），
            // 这里只是把"纯图片也不必套"这个更一般的规则实现出来。
            // task-8：attention 恒走默认底（它有自己的描边/头部条，贴纸语义不适用）。
            bool imageOnly = hasImg && !hasText;
            _opaquePresentation = (b.Opaque || imageOnly) && !attention;
            ApplyBubbleChrome(_opaquePresentation);

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


            _currentKind = b.Kind;
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
            // ⚠️ 排布完成后必须**按真实尺寸重刷一次圆角裁剪**。
            //
            // `ApplyBubbleChrome` 在 `UpdateLayout` **之前**执行（443 行），
            // 那时 `_border.ActualWidth` 还是 0，只能用 `DesiredSize` 兜底；
            // 而 `SizeToContent` 的窗口尺寸要到这一轮布局后才真正确定 ——
            // 少了这一步，满幅贴纸的圆角裁剪会按错误尺寸落下，
            // 表现就是"第一次启动那张图没有圆角"（用户实测反馈）。
            if (_opaquePresentation) UpdateOpaqueClip();
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
        /// 启停气泡动图。
        ///
        /// **每次 Show 都必须调用**（哪怕传 null）：动画状态是窗级的，
        /// 而气泡窗是长生命周期对象 —— 不重置就会出现"上一条动图继续播在新气泡上"。
        /// </summary>
        private void StartBubbleAnim(BitmapSource[] frames, int frameMs)
        {
            _animTimer.Stop();
            _animFrames = null;
            _animIndex = 0;
            _animTicks = 0;
            if (frames == null || frames.Length <= 1) return;

            _animFrames = frames;
            int ms = frameMs < 20 ? 20 : frameMs;      // 防呆：清单给了 0/负数也不至于疯转
            _animTimer.Interval = TimeSpan.FromMilliseconds(ms);
            _image.Source = frames[0];
            _animTimer.Start();
        }

        private void OnAnimTick(object sender, EventArgs e)
        {
            _animTicks++;
            if (_animFrames == null || _animFrames.Length <= 1)
            {
                _animTimer.Stop();
                return;
            }
            _animIndex = (_animIndex + 1) % _animFrames.Length;
            _image.Source = _animFrames[_animIndex];
        }

        /// <summary>
        /// 按 opaque 切换气泡外壳。每次 Show 都会调用（气泡窗复用，
        /// 上一条 opaque 贴纸留下的样式必须能完全恢复）。
        /// 投影（_border.Effect）两种模式共用，不在切换范围。
        /// </summary>
        /// <summary>
        /// 气泡外壳。
        ///
        /// `bare=true`（= 不画外壳）：用于**纯图片**气泡（满幅贴纸 / 动图 / 透明抠图贴纸）。
        /// 图片自己就是内容，再垫白底会出现双层边框、还白占内边距。
        /// `bare=false`：**有文字**的气泡需要卡片承载（否则字飘在桌面上看不清）。
        ///
        /// 注意：**没有外壳 ≠ 没有投影**。`_border.Effect` 两种模式都保留 ——
        /// 表情图直接贴在壁纸上时，靠投影才能"浮起来"、不至于糊在背景里
        ///（白卡原本顺带提供了这层边界感，去掉卡就得让投影承担）。
        /// </summary>
        private void ApplyBubbleChrome(bool bare)
        {
            if (bare)
            {
                _border.Background = Brushes.Transparent;
                _border.BorderBrush = Brushes.Transparent;
                _border.BorderThickness = new Thickness(0);
                _border.Padding = new Thickness(0);
                _border.CornerRadius = new CornerRadius(0);
                _image.MaxHeight = OpaqueImageMaxH;
                _image.MaxWidth = OpaqueImageMaxW;
                // ⭐ 满幅贴纸要**裁圆角**。
                //
                // 这批 F4 贴纸是**方形硬边**（实测四角 alpha 全 255），
                // 原先 `CornerRadius(0)` + 无裁剪 → 一个直角方块直接贴在桌面上，
                // 用户反馈"有的气泡没有圆角"。
                // 注意：`Border.CornerRadius` 对 `Image` **不生效**（它只裁自己的
                // 背景/边框），所以必须用 `Clip` 裁图片本身。
                ApplyOpaqueCornerClip();
            }
            else
            {
                // ⚠️ 必须**先撤掉**贴纸的圆角裁剪：气泡窗是复用的，
                // 上一条满幅贴纸留下的 Clip 会继续切普通气泡的四角
                //（实测踩过：漏了这步，普通气泡的直角被切掉一块）。
                ClearOpaqueCornerClip();
                ApplyDefaultChrome();
            }
        }

        /// <summary>
        /// 给满幅贴纸裁圆角。
        ///
        /// **为什么裁 `_border` 而不是 `_image`**：`Border.CornerRadius` 只影响它自己的
        /// 背景与边框，**不会裁剪子元素**；而这批贴纸是「图片铺满整窗」，所以要给
        /// 容纳它的 `_border` 挂一个圆角矩形 `Clip`，把图片四角切掉。
        ///
        /// 尺寸随实际排布走（`SizeChanged` 同步），不写死像素 ——
        /// 写死的话缩放后圆角会被拉变形。
        /// </summary>
        private void ApplyOpaqueCornerClip()
        {
            try
            {
                _border.SizeChanged -= OnChromeSizeChanged;
                _border.SizeChanged += OnChromeSizeChanged;
                UpdateOpaqueClip();
            }
            catch (Exception ex) { PetLog.Warn("贴纸圆角裁剪失败: " + PetLog.Describe(ex)); }
        }

        private void OnChromeSizeChanged(object sender, SizeChangedEventArgs e)
        {
            // 只在满幅贴纸模式下重刷 —— 普通气泡的尺寸变化不该给它加裁剪。
            if (_opaquePresentation) UpdateOpaqueClip();
        }

        /// <summary>按当前实际尺寸刷新圆角裁剪矩形。</summary>
        private void UpdateOpaqueClip()
        {
            // ⚠️ 裁剪矩形必须用**图片的实际渲染尺寸**，不能用 `_border.ActualWidth`。
            //
            // 实测（日志）：`_border.ActualWidth=134.7`，而贴纸只有 `119.3` 宽 ——
            // 因为 `_border` 上挂了 `DropShadowEffect`，`ActualWidth` 把**投影的
            // 外扩量**也算进去了。用 134.7 去裁 119.3 的图，圆角就落在图片**外面**，
            // 四角仍是直角 —— 这正是"第一次启动那张图没有圆角"的真因
            //（我先前误判成时序问题，加了"布局后重刷"其实治不了它）。
            //
            // `_image` 是真正承载贴纸的元素，用它的尺寸才准。
            double w = 0, h = 0;
            if (_image != null)
            {
                w = _image.ActualWidth; h = _image.ActualHeight;
                if (w <= 0 || h <= 0)
                {
                    Size wantImg = _image.DesiredSize;
                    w = wantImg.Width; h = wantImg.Height;
                }
            }
            if (w <= 0 || h <= 0)
            {
                // 图片还没排布：退回 Border 的期望尺寸（不含投影，比 ActualWidth 准）
                Size want = _border.DesiredSize;
                w = want.Width; h = want.Height;
            }
            if (w <= 0 || h <= 0) return;   // 真的还没有尺寸，等 SizeChanged
            double r = Math.Max(1, OpaqueCornerRadius);
            // 圆角不能超过短边的一半，否则会画成诡异形状
            double limit = Math.Min(w, h) / 2;
            if (r > limit) r = limit;

            // ⚠️⚠️ 裁剪矩形必须落在**图片自己的位置**上，不能写死 `(0, 0)`。
            //
            // 用户反馈："气泡表情有概率显示不全（之前一直也有，但是是偶发情况）"。
            // 实测（探针，见 `.scratch/probe-clip2.py`）：
            //   · 壳比图宽 0.7px 时 → 图片右边界 179.3、裁剪右边界 178.7 → 切 0.7px；
            //   · 人为把壳撑宽 40px 时 → 图片右边界 219.3、裁剪右边界 178.7
            //     → **右侧被切掉 40.7px**（截图里那道竖直切口就是这个）。
            //
            // 真因：`_image.HorizontalAlignment = Center` —— 一旦 `_border` 比图片宽，
            // 图片会被**居中**（左偏移 `dx > 0`），而裁剪矩形 `Rect(0, 0, w, h)`
            // 是以 **Border 左上角**为原点的。于是裁剪窗口停在左边，
            // 把图片**右侧**多出来的那一条切掉。
            //
            // 为什么"偶发"：多数时候壳与图一样宽（`dx≈0`，只差亚像素）；
            // 只有壳比图宽时才切得肉眼可见 —— 而壳变宽发生在
            // "上一条气泡更宽（如长文字）→ 这一条是图"的窗口收缩过程中：
            // 此时 `_border.ActualWidth` 还是旧的较大值，而图片已是新的较小尺寸。
            // 更要命的是裁剪**只在 `SizeChanged` 时重算** —— 若尺寸随后不再变化，
            // 这个错位的裁剪就**一直留着**，于是表现为"随机某几次显示不全"。
            //
            // ⚠️ 修法必须是"把裁剪**挪到图片的位置**"，不能是"把裁剪扩到整个壳"：
            // 后者虽然也不切图，但圆角会落在**壳的四角**上 —— 壳比图宽时，
            // 图片自己的四角就变回直角了（那正是用户先前反馈过的"气泡没有圆角"）。
            // 所以这里保持"裁剪尺寸 = 图片尺寸"，只补上**位置**。
            //
            // 判据教训：只验 `clip == img`（尺寸相等）**发现不了**它 ——
            // 尺寸确实相等，错的是**位置**。断言必须一起验偏移。
            double dx = 0, dy = 0;
            try
            {
                Point p = _image.TranslatePoint(new Point(0, 0), _border);
                if (!double.IsNaN(p.X) && !double.IsInfinity(p.X)) dx = p.X;
                if (!double.IsNaN(p.Y) && !double.IsInfinity(p.Y)) dy = p.Y;
            }
            catch { }
            _border.Clip = new RectangleGeometry(new Rect(dx, dy, w, h), r, r);
            // 保留一行精简日志：圆角失效这类问题**只有运行期真值能定位**
            //（我先前靠读代码推理，误判成时序问题，白改一轮）。
            // v13.5 起连**偏移**一起记 —— 只记宽度是查不出"右侧被切"的。
            // ⚠️ v13.7：这行是**高频过程日志**（实测 1310 条，占整份日志的 28%）——
            // 每次气泡尺寸变化都记一行，把用户真正想看的 `[手势]` 面包屑淹掉了。
            // 降级到 `Debug`（调试开关打开才落盘）。
            // ⚠️ 但**失败路径**（上面的 `Warn`）保持永远落盘 —— 降噪不能把"出错了"藏起来。
            PetLog.Debug("贴纸圆角裁剪 w=" + w.ToString("0.#") + " r=" + r.ToString("0.#") +
                        " offset=" + dx.ToString("0.#") + "," + dy.ToString("0.#") +
                        " 壳=" + _border.ActualWidth.ToString("0.#") + "x" +
                        _border.ActualHeight.ToString("0.#"));
        }

        /// <summary>清掉满幅贴纸的裁剪（回到透明抠图气泡时要还原，气泡窗是复用的）。</summary>
        private void ClearOpaqueCornerClip()
        {
            try
            {
                _border.SizeChanged -= OnChromeSizeChanged;
                _border.Clip = null;
            }
            catch { }
        }
        /// <summary>
        /// 按当前缩放重算所有外观尺寸（字号/内边距/图片上限/圆角/徽标/按钮）。
        ///
        /// **为什么要整体重算**：气泡是独立窗口，尺寸来自 `SizeToContent`，
        /// 而字号与图片上限是布局的输入。只改窗口大小是没用的 ——
        /// 必须改这些"内容尺寸"，窗口才会跟着缩。
        /// </summary>
        /// <summary>桌宠本体单帧宽度（物理像素）；由 Program 在素材就绪时喂入。</summary>
        private int _petFrameW;
        /// <summary>桌宠本体单帧高度（物理像素）。</summary>
        private int _petFrameH = 256;
        private double _petDpi = 96;

        /// <summary>Program 喂入桌宠帧尺寸与 DPI（气泡按它算比例）。</summary>
        public void SetPetMetrics(int frameW, int frameH, double dpi)
        {
            if (frameW > 0) _petFrameW = frameW;
            if (frameH > 0) _petFrameH = frameH;
            if (dpi > 0) _petDpi = dpi;
            UpdateMetrics();
            if (IsVisible) PlaceNearPet();
        }

        /// <summary>
        /// 桌宠在当前 DPI 下的**显示宽度**（DIP）。
        /// 与 `PetWindow.ApplyDipSizeFor` 同一套换算：物理像素 × scale × (96/dpi)。
        /// 拿不到帧尺寸时回落到一个保守默认值，避免比例失真成 0。
        /// </summary>
        private double PetDisplayWidthDip()
        {
            double frameW = _petFrameW > 0 ? _petFrameW : 256;
            double dpi = _petDpi > 0 ? _petDpi : 96.0;
            return frameW * _scale * (96.0 / dpi);
        }
        private void UpdateMetrics()
        {
            double s = _scale;
            if (s <= 0) s = 1.0;
            // 字号 = 基准 × 桌宠缩放 × **独立字号倍率**（用户点名要能单独调大）。
            //
            // 下限保护：字太小会糊成一团。注意它夹的是**最终值** ——
            // 所以"scale 很小 + fontScale 很大"时，字照样能大到可读
            //（这正是用户要的：桌宠小、正文清楚）。
            double fs = Math.Max(6.5, BaseFontSize * s * _fontScale);
            _text.FontSize = fs;
            // ⚠️ MaxWidth 也必须跟着字号走，否则字放大了却还挤在旧宽度里，
            // 会变成又窄又高的竖条。用"最终字号 / 基准字号"这个比值最直观。
            double textRatio = fs / BaseFontSize;
            _text.MaxWidth = Math.Max(120, BaseTextMaxW * textRatio);
            // 徽标/按钮字号同比例放大（它们是气泡的一部分，只放大正文会显得割裂）。
            _badgeText.FontSize = Math.Max(7, BaseBadgeFontSize * s * _fontScale);
            _goText.FontSize = Math.Max(7, BaseGoFontSize * s * _fontScale);

            // 内边距同理按最终字号比例走 —— 否则正文放大后会贴着气泡边缘。
            DefaultPadding = new Thickness(BasePaddingX * textRatio, BasePaddingY * textRatio,
                                           BasePaddingX * textRatio, BasePaddingY * textRatio);
            DefaultBorderWidth = new Thickness(Math.Max(0.5, BaseBorderWidth * s));
            // 气泡上限 = 桌宠显示尺寸 × 比例（见 BubbleToPetRatio 的注释：
            // 写死绝对像素会在高 DPI 下反超桌宠）。
            double petDip = PetDisplayWidthDip();
            double cap = petDip * BubbleToPetRatio;
            if (cap < 48) cap = 48;                 // 下限：太小看不清表情
            DefaultImageMaxH = cap;
            DefaultImageMaxW = cap;
            OpaqueImageMaxH = cap;
            OpaqueImageMaxW = cap;
            OpaqueCornerRadius = Math.Max(3, BaseOpaqueCornerRadius * s);
            _badge.CornerRadius = new CornerRadius(Math.Max(2, 8 * s));
            _goBtn.CornerRadius = new CornerRadius(Math.Max(2, 6 * s));
        }

        /// <summary>
        /// 对话正文的独立字号倍率（0.5~3.0，与状态栏同一口径）。
        ///
        /// 正在显示的气泡会立即重排 —— 用户拖滑杆时应该马上看到效果，
        /// 而不是等下一个气泡（与 `SetScale` 同一处理：先铺外壳再测量再定位）。
        /// </summary>
        public void SetFontScale(double fontScale)
        {
            double fs = fontScale <= 0 ? 1.0 : fontScale;
            if (Math.Abs(fs - _fontScale) < 0.001) return;
            _fontScale = fs;
            UpdateMetrics();
            try
            {
                ApplyCurrentChrome();
                _root.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                UpdateLayout();
                PlaceNearPet();
            }
            catch (Exception ex) { PetLog.Warn("气泡字号应用失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>
        /// 跟随桌宠缩放（由 Program 在 SetScale / 快照 settings.scale 变化时调用）。
        ///
        /// 正在显示的气泡会**立即**按新尺寸重排并重新贴到本体旁边，
        /// 不必等下一个气泡 —— 否则用户滚轮缩放时，气泡会僵在原尺寸上很突兀。
        /// </summary>
        public void SetScale(double scale)
        {
            _scale = scale <= 0 ? 1.0 : scale;
            UpdateMetrics();
            try
            {
                // 顺序很关键：
                //   ① 先按新尺寸重铺外壳（内边距/圆角/图片上限都是布局输入）
                //   ② 再 Measure —— 用**改完之后**的尺寸算 DesiredSize
                //   ③ 定位
                // 曾经写成"先 UpdateLayout 再铺外壳"，等于用旧内边距排完版才改样式。
                ApplyCurrentChrome();
                _root.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                UpdateLayout();
                PlaceNearPet();

                // 兜底：SizeToContent 的窗口尺寸要到这一轮布局之后才真正落定，
                // 此时再贴一次，保证位置与最终尺寸一致。
                //
                // 注意：**真正修好"坐标不变"的不是这里，而是上面的顺序**（先铺外壳再测量）。
                // 顺序错了的话 DesiredSize 就是按旧内边距算的，位置必然错 ——
                // 实测（回退顺序）右边会错开 19~52px，而这条延迟重贴救不回来。
                Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
                {
                    try { PlaceNearPet(); } catch { }
                }));
            }
            catch (Exception ex) { PetLog.Warn("气泡缩放重排失败: " + PetLog.Describe(ex)); }
        }
        /// <summary>
        /// 按**当前呈现方式**重铺外壳（缩放后必须重铺：内边距/圆角/图片上限都变了）。
        /// opaque 满幅贴纸不套气泡底；普通气泡走默认外壳。
        /// </summary>
        private void ApplyCurrentChrome()
        {
            if (_currentKind == "attention")
            {
                // attention：保留自己的橙色描边与加粗，只同步内边距/图片上限
                _border.Padding = DefaultPadding;
                _image.MaxHeight = DefaultImageMaxH;
                _image.MaxWidth = DefaultImageMaxW;
                return;
            }
            ApplyBubbleChrome(_opaquePresentation);
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

        /// <summary>
        /// 套用深/浅配色（契约 §4 `theme`：argv &gt; settings.theme &gt; 注册表）。
        ///
        /// 气泡外壳原来把颜色写死成浅色，深色桌面上会是一块刺眼的白框；
        /// 这里让外壳跟随同一个主题判定。已经显示中的气泡也会立即换色
        ///（换主题不该等下一次弹气泡才生效）。
        /// </summary>
        public void ApplyTheme(bool dark)
        {
            PetTheme.BubblePalette p = PetTheme.BubblePalette.For(dark);
            _defaultBackground = new SolidColorBrush(Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB));
            _defaultBorderBrush = new SolidColorBrush(Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB));
            _text.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
            // 正在显示的普通气泡立即换色；attention 有自己的橙色描边（只换底与字）。
            if (Showing)
            {
                if (_currentKind == "attention")
                {
                    _border.Background = _defaultBackground;
                    _text.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
                }
                else
                {
                    ApplyDefaultChrome();
                }
            }
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
            // 收起必须停帧推进：气泡窗不销毁，动画不停会在后台空转（白烧 CPU），
            // 而且下次 Show 之前 `_image` 已经不可见了 —— 停掉语义更干净。
            _animTimer.Stop();
            _animFrames = null;
            _animIndex = 0;
            Showing = false;
            _currentId = -1;
            _currentPriority = int.MinValue;
            if (IsVisible) Hide();
            Opacity = 0;
        }

        // ------------------------------------------------------------------
        // 定位（跟随本体窗，clamp 进工作区）
        // ------------------------------------------------------------------

        /// <summary>
        /// 气泡定位算法（**纯函数**，运行路径与自检共用）。
        ///
        /// ⚠️ 单独抽出来的原因（上一轮的血泪）：`DiagTargetFor` 曾经是 `PlaceNearPet`
        /// 的**手抄副本**，结果"把真实逻辑改坏、自检照样绿" ——
        /// 测试必须打**运行路径**，复制一份实现等于没测。
        ///
        /// 规则：气泡贴本体**左上角**（右下角对着本体左上角，像对话框的尾巴）；
        /// 左边放不下翻到右侧；再统一 clamp 进工作区。
        /// </summary>
        internal static void ComputeBubbleTarget(int px, int py, int pw, int ph,
                                                 int bw, int bh, out int x, out int y)
        {
            PetNative.WorkArea scr = PetNative.NearestScreen(px + pw / 2, py + ph / 2);
            const int gap = 6;                            // 与本体留缝，不糊在一起
            x = px - bw - gap;                            // 气泡右边缘 = 本体左边缘 - gap
            if (x < scr.X + 4)
            {
                x = px + pw + gap;                        // 左侧放不下 → 翻到右侧
            }
            // 垂直：气泡底边略低于本体顶边（视觉上像"从左上角探出"）
            y = py - bh + (int)Math.Round(bh * 0.25);
            if (y < scr.Y + 4) y = scr.Y + 4;
            if (y + bh > scr.Bottom - 4) y = scr.Bottom - bh - 4;

            int maxX = scr.Right - bw - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;
        }
        public void PlaceNearPet()
        {
            if (!IsVisible && !Showing) return;
            int[] pet = PetRectProvider == null ? null : PetRectProvider();
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;

            // ⚠️ 尺寸取**刚测量出来的 DesiredSize**，不是 ActualWidth/ActualHeight。
            //
            // 原因：气泡窗是 `SizeToContent`，ActualWidth 要等**下一次布局**才更新。
            // 缩放时"改字号 → 立刻定位"读到的是**旧尺寸**，于是气泡虽然缩小了、
            // 位置却还按旧尺寸算（贴得不对/留一大块空）。
            // DesiredSize 是 Measure 之后立刻可用的真实需求尺寸，不存在这个滞后。
            double wDip = _root.DesiredSize.Width;
            double hDip = _root.DesiredSize.Height;
            if (wDip <= 0 || double.IsNaN(wDip)) wDip = ActualWidth;
            if (hDip <= 0 || double.IsNaN(hDip)) hDip = ActualHeight;
            int bw = (int)Math.Round(wDip * dpi);
            int bh = (int)Math.Round(hDip * dpi);
            if (bw <= 0) bw = 200;
            if (bh <= 0) bh = 48;

            int px, py, pw, ph;
            if (pet != null && pet.Length >= 4) { px = pet[0]; py = pet[1]; pw = pet[2]; ph = pet[3]; }
            else
            {
                PetNative.DefaultPosition(bw, bh, out px, out py);
                pw = bw; ph = bh;
            }

            // ⭐ 贴在本体**左上角**（规则见 ComputeBubbleTarget 的说明）。
            // 为什么不是"正上方"：气泡压在头顶会**遮住角色的头**，用户明确要求挪开。
            int x, y;
            ComputeBubbleTarget(px, py, pw, ph, bw, bh, out x, out y);

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