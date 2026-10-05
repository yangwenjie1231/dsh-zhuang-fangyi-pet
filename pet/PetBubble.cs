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

            _root = new Grid();
            _root.Background = Brushes.Transparent;
            _root.Children.Add(_border);
            Content = _root;

            _hideTimer = new DispatcherTimer(DispatcherPriority.Normal);
            _hideTimer.Tick += OnHideTick;

            Loaded += OnLoaded;
            Closing += OnClosing;
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
        /// </summary>
        public bool Show(PetBubbleInfo b, BitmapSource img)
        {
            if (b == null) return false;
            if (b.Id == _currentId && _currentId >= 0) return false;
            if (Showing && b.Priority < _currentPriority) return false;

            bool hasImg = b.WantsImage && img != null;
            bool hasText = b.WantsText && !string.IsNullOrEmpty(b.Text);
            if (!hasImg && !hasText)
            {
                if (b.WantsText && !string.IsNullOrEmpty(b.Text)) hasText = true;
                else return false;
            }

            _image.Source = hasImg ? img : null;
            _image.Visibility = hasImg ? Visibility.Visible : Visibility.Collapsed;
            _text.Text = hasText ? b.Text : "";
            _text.Visibility = hasText ? Visibility.Visible : Visibility.Collapsed;

            // 契约 §4 opaque：不透明满幅贴纸图本身就是一张卡片，
            // 再画气泡自己的底/边框/内边距会出现「白纸贴在浅色框里」的双层边框 → 全部去掉。
            // 透明抠图（缺省/显式 false）保持原有呈现不变。
            ApplyBubbleChrome(hasImg && b.Opaque);

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