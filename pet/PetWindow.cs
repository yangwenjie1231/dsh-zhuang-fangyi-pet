using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 本体窗：无边框 / 透明 / 置顶 / 不占任务栏，alpha 命中测试（透明处穿透、不透明处可点可拖）。
    /// 拖动结束 POST /pet/position（契约 §3）。
    /// </summary>
    internal sealed class PetWindow : Window
    {
        private readonly PetOptions _opt;
        private readonly PetHttp _http;
        private readonly PetSpriteStore _store;

        private readonly Grid _root;
        private readonly Image _image;
        private readonly DispatcherTimer _timer;

        private IntPtr _hwnd;
        private HwndSource _source;

        private SpriteSheet _sheet;
        private int _frame;
        private string _state;
        private bool _clickThrough;
        private bool _topmost;
        private bool _dragging;
        private Point _dragOffsetDip;
        private bool _reallyClosing;

        /// <summary>素材缺失时用的兜底图形（纯色圆角块 + 文字），保证窗口始终可见。</summary>
        private readonly Border _fallback;
        private readonly TextBlock _fallbackText;

        // ── v11：互动反馈动画 ────────────────────────────────────────────────
        /// <summary>缩放（≤1.0 = 只缩不放，见 <see cref="PlayReact"/> 的说明）。</summary>
        private readonly ScaleTransform _reactScale;
        /// <summary>位移（像素级轻微上下弹）。</summary>
        private readonly TranslateTransform _reactShift;

        // task-7：悬停 ✎ 发消息入口（默认隐藏；鼠标进入桌宠出现，离开后**延迟**隐藏）
        private readonly Border _sendBtn;
        private bool _sendAvailable;
        private bool _sendOpen;
        /// <summary>延迟隐藏计时器：让用户有时间把鼠标从精灵移到按钮上。</summary>
        private DispatcherTimer _sendHideTimer;

        /// <summary>
        /// 位置上报回调（物理像素 x,y）。回响环修复：**不含 scale** —— 缩放走
        /// /pet/settings 专用通道；且 ReportPosition 内部按"值没变就不发"去重。
        /// </summary>
        public Action<int, int> PositionReported = delegate { };

        public PetWindow(PetOptions opt, PetHttp http, PetSpriteStore store)
        {
            _opt = opt;
            _http = http;
            _store = store;
            _state = PetJson.NormalizeState(opt.State);
            _clickThrough = opt.ClickThrough;
            _topmost = opt.Topmost;

            Title = "DSH 庄方宜桌宠";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = opt.Topmost;
            SizeToContent = SizeToContent.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            WindowStartupLocation = WindowStartupLocation.Manual;
            Opacity = opt.Opacity;

            _root = new Grid();
            _root.Background = Brushes.Transparent;
            _root.ClipToBounds = false;

            _image = new Image();
            _image.Stretch = Stretch.Fill;
            _image.HorizontalAlignment = HorizontalAlignment.Stretch;
            _image.VerticalAlignment = VerticalAlignment.Stretch;
            // 150% DPI 下必须高质量缩放，否则糊
            RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.HighQuality);
            RenderOptions.SetEdgeMode(_image, EdgeMode.Unspecified);
            // v11：互动反馈动画的变换（点击/摸头时"她抖一下"）。
            //
            // ⚠️ 用 `RenderTransform` 而不是改 `Width/Height/Left/Top`：
            // 前者是**布局之后**的视觉变换，不参与窗口尺寸计算 ——
            // 「窗口尺寸 == 精灵帧尺寸」是冻结不变量（自检 `dipOk` 断言
            // 物理像素 1:1），改尺寸会让命中测试整体错位（`HitTestDip`
            // 用 `ActualWidth/Height` 把鼠标坐标归一化）。
            //
            // 轴心放在**底部中心**（0.5, 1.0）：缩放看起来像"蹲了一下"，
            // 而不是"从中间胀大"。
            _reactScale = new ScaleTransform(1, 1);
            _reactShift = new TranslateTransform(0, 0);
            TransformGroup react = new TransformGroup();
            react.Children.Add(_reactScale);
            react.Children.Add(_reactShift);
            _image.RenderTransformOrigin = new Point(0.5, 1.0);
            _image.RenderTransform = react;
            _root.Children.Add(_image);

            // v13.2：**残影层**（换素材的过渡）。
            //
            // 用户："切换的时候就一下子消失，又出现一个新的，能不能有点过渡"。
            // 原先是硬切（直接换 `_image.Source`）—— 旧图瞬间没了、新图瞬间出现。
            //
            // 所以这里加一层：换素材时把**旧图**放上来淡出，新图同时在下面
            // 立刻可见。全程两张都在，**中间不出现空白**。
            //
            // ⚠️ 为什么不是"先淡出再淡入"：那正是用户抱怨的那个现象
            // （中间有一段什么都没有）。交叉淡出才是"过渡"。
            //
            // 放在 `_image` **之后** → z 序在新图之上（残影盖着新图淡走），
            // 但在 `_fallback` / `_sendBtn` 之前 → 不会盖住兜底块与 ✎ 按钮。
            _ghost = new Image();
            _ghost.Stretch = Stretch.Fill;
            _ghost.HorizontalAlignment = HorizontalAlignment.Stretch;
            _ghost.VerticalAlignment = VerticalAlignment.Stretch;
            _ghost.IsHitTestVisible = false;      // 纯视觉层，绝不抢鼠标
            _ghost.Opacity = 0;
            RenderOptions.SetBitmapScalingMode(_ghost, BitmapScalingMode.HighQuality);
            // 与 `_image` **共用同一个变换实例**：反应动画（点击/摸头的抖动）
            // 播放期间换素材时，残影与新图必须一起抖，否则会看到两层错位。
            _ghost.RenderTransformOrigin = new Point(0.5, 1.0);
            _ghost.RenderTransform = react;
            // 残影的圆角按**它自己**的尺寸算（见 `UpdateGhostClip` 的说明：
            // 换素材时窗口尺寸会变，照抄旧 Clip 会切错位置）。
            _ghost.SizeChanged += OnGhostSizeChanged;
            _root.Children.Add(_ghost);

            _fallbackText = new TextBlock();
            _fallbackText.Text = "庄方宜\n(素材加载中)";
            _fallbackText.Foreground = Brushes.White;
            _fallbackText.FontSize = 14;
            _fallbackText.TextAlignment = TextAlignment.Center;
            _fallbackText.HorizontalAlignment = HorizontalAlignment.Center;
            _fallbackText.VerticalAlignment = VerticalAlignment.Center;

            _fallback = new Border();
            _fallback.CornerRadius = new CornerRadius(10);
            _fallback.Background = new SolidColorBrush(Color.FromArgb(210, 40, 60, 110));
            _fallback.BorderBrush = new SolidColorBrush(Color.FromArgb(230, 120, 170, 255));
            _fallback.BorderThickness = new Thickness(1);
            _fallback.Child = _fallbackText;
            _fallback.Visibility = Visibility.Collapsed;
            _root.Children.Add(_fallback);

            // task-7：悬停 ✎ 按钮。
            //
            // ⚠️ 两个曾让按钮"点不到"的坑（都踩过）：
            //  1. **绝不能放到窗口外**。原先用负 Margin（-7,-7）把按钮往右上角外伸，
            //     而 Windows 只把鼠标消息投给**窗口矩形之内**的像素 —— 伸出去的那部分
            //     看得见、点不着。现在完全放在窗口内（右上角内缩）。
            //  2. **移开桌宠不能立刻隐藏**。原先 MouseLeave 立刻 Collapsed，
            //     而鼠标要移到按钮必然先离开精灵 → 按钮在手到达之前就消失了。
            //     现在留一个宽限期（见 HideSendBtnSoon）。
            TextBlock pen = new TextBlock();
            pen.Text = "✎";
            pen.FontSize = 13;
            pen.Foreground = Brushes.White;
            pen.TextAlignment = TextAlignment.Center;
            _sendBtn = new Border();
            _sendBtn.Child = pen;
            _sendBtn.CornerRadius = new CornerRadius(9);
            _sendBtn.Width = 22;
            _sendBtn.Height = 22;
            _sendBtn.HorizontalAlignment = HorizontalAlignment.Right;
            _sendBtn.VerticalAlignment = VerticalAlignment.Top;
            // 贴右上角但**整体留在窗口内**（内缩 1px，避免被裁掉半个像素）
            _sendBtn.Margin = new Thickness(0, 1, 1, 0);
            _sendBtn.Background = new SolidColorBrush(Color.FromArgb(190, 60, 90, 150));
            _sendBtn.BorderBrush = new SolidColorBrush(Color.FromArgb(220, 190, 215, 250));
            _sendBtn.BorderThickness = new Thickness(1);
            _sendBtn.Cursor = Cursors.Hand;
            _sendBtn.Visibility = Visibility.Collapsed;
            _sendBtn.MouseDown += delegate(object s, MouseButtonEventArgs e)
            {
                // 只吃掉事件：不进拖动，也不进双击分派
                e.Handled = true;
            };
            _sendBtn.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
            {
                e.Handled = true;
                CancelSendBtnHide();          // 已经点到按钮了，别再安排隐藏
                Action h = SendButtonClicked;
                if (h != null) h();
            };
            _sendBtn.MouseEnter += delegate
            {
                CancelSendBtnHide();          // 手进到按钮上 → 取消隐藏，保证点得稳
                _sendBtn.Opacity = 1;
            };
            _sendBtn.MouseLeave += delegate { _sendBtn.Opacity = 0.85; };
            _root.Children.Add(_sendBtn);

            Content = _root;

            _timer = new DispatcherTimer(DispatcherPriority.Render);
            _timer.Tick += OnTick;

            // 隐藏宽限期计时器（一次性）
            _sendHideTimer = new DispatcherTimer(DispatcherPriority.Background);
            _sendHideTimer.Interval = TimeSpan.FromMilliseconds(450);
            _sendHideTimer.Tick += delegate
            {
                _sendHideTimer.Stop();
                UpdateSendBtnVisibility(IsMouseOver);
            };

            MouseLeftButtonDown += OnMouseLeftButtonDown;
            MouseMove += OnMouseMove;
            MouseLeftButtonUp += OnMouseLeftButtonUp;
            MouseRightButtonUp += OnMouseRightButtonUp;
            MouseWheel += OnMouseWheel;   // task-6：悬停滚轮缩放
            MouseEnter += delegate(object s, MouseEventArgs e)
            {
                CancelSendBtnHide();
                UpdateSendBtnVisibility(true);
                try { HoverChanged(true); } catch { }   // hint：悬停显示状态文字
            };
            MouseLeave += delegate(object s, MouseEventArgs e)
            {
                // 不立刻隐藏：给用户把手移到按钮上的时间（450ms 宽限）。
                HideSendBtnSoon();
                // 悬停标记立即撤销（状态文字不参与交互，不需要宽限期）
                try { HoverChanged(false); } catch { }
            };

            Loaded += OnLoaded;
            Closing += OnClosing;
        }

        /// <summary>task-7：✎ 被点击（Program 装配成打开输入窗）。</summary>
        public Action SendButtonClicked = delegate { };

        /// <summary>task-7：snapshot.send 能力位变化时由 Program 调（false → 隐藏按钮）。</summary>
        public void SetSendAvailable(bool available)
        {
            _sendAvailable = available;
            if (!available) UpdateSendBtnVisibility(false);
        }

        /// <summary>task-7：输入窗打开期间按钮保持可见（鼠标会离开本体去输入窗）。</summary>
        public void SetSendOpen(bool open)
        {
            _sendOpen = open;
            UpdateSendBtnVisibility(open);
        }

        /// <summary>悬停显隐：能力可用 + （鼠标在本体上 或 输入窗开着 或 鼠标在按钮上）→ 显示。</summary>
        private void UpdateSendBtnVisibility(bool overPet)
        {
            bool show = _sendAvailable && (overPet || _sendOpen || _sendBtn.IsMouseOver);
            // 尺寸随 scale 缩放（22 DIP 基准，最小 16、最大 40，别在大尺寸下成小点）
            double s = PetOptions.ClampScale(_opt.Scale);
            double sz = Math.Max(16, Math.Min(40, 22 * s));
            _sendBtn.Width = sz;
            _sendBtn.Height = sz;
            TextBlock tb = _sendBtn.Child as TextBlock;
            if (tb != null) tb.FontSize = Math.Max(10, Math.Min(26, 13 * s));
            _sendBtn.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        }

        /// <summary>安排一次延迟隐藏（鼠标离开桌宠后给用户移动到按钮的时间）。</summary>
        private void HideSendBtnSoon()
        {
            if (_sendHideTimer == null) return;
            _sendHideTimer.Stop();
            _sendHideTimer.Start();
        }

        /// <summary>取消待执行的隐藏（手回到桌宠/按钮上）。</summary>
        private void CancelSendBtnHide()
        {
            if (_sendHideTimer != null) _sendHideTimer.Stop();
        }

        public string CurrentState { get { return _state; } }
        public bool HasSprite { get { return _sheet != null; } }

        /// <summary>
        /// 当前精灵帧的物理像素尺寸 + 窗口 DPI（气泡按它算"相对桌宠的比例"）。
        ///
        /// 气泡尺寸必须**跟着桌宠的实际显示大小**走 —— 写死绝对像素会在高 DPI 下
        /// 反超桌宠（用户反馈过"气泡相对于桌宠太大"）。
        /// 没有素材时返回 false，调用方保持上次的值。
        /// </summary>
        public bool FrameMetrics(out int frameW, out int frameH, out double dpi)
        {
            frameW = 0; frameH = 0; dpi = 96;
            if (_sheet == null) return false;
            frameW = _sheet.FrameW;
            frameH = _sheet.FrameH;
            try
            {
                double d = _hwnd == IntPtr.Zero ? 96.0 : PetNative.GetDpiForWindowSafe(_hwnd);
                if (d > 0) dpi = d;
            }
            catch { }
            return frameW > 0 && frameH > 0;
        }

        /// <summary>
        /// 最近一次的状态文字（快照的 `label`，已按 locale 本地化）。
        ///
        /// 状态文字窗是**独立窗口**，它拿不到快照 —— 由 Program 把 label 存进来，
        /// 窗口只负责画。这样"文字从哪来"只有一处真相（状态机）。
        /// </summary>
        private string _visibleLabel = "";
        public string VisibleLabel() { return _visibleLabel; }
        public void SetVisibleLabel(string label) { _visibleLabel = label ?? ""; }
        public double Scale { get { return _opt.Scale; } }
        public bool ClickThrough { get { return _clickThrough; } }
        public IntPtr Handle { get { return _hwnd; } }

        /// <summary>本体显示区域在屏幕上的物理像素矩形（气泡定位用）。</summary>
        public void GetScreenRect(out int x, out int y, out int w, out int h)
        {
            x = y = w = h = 0;
            if (_hwnd == IntPtr.Zero) return;
            try
            {
                double dpi = PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                int px = (int)Math.Round(Left * dpi);
                int py = (int)Math.Round(Top * dpi);
                int pw = (int)Math.Round(ActualWidth * dpi);
                int ph = (int)Math.Round(ActualHeight * dpi);
                x = px; y = py; w = pw; h = ph;
            }
            catch { }
        }

        // ------------------------------------------------------------------
        // 生命周期
        // ------------------------------------------------------------------

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            if (_hwnd != IntPtr.Zero)
            {
                _source = HwndSource.FromHwnd(_hwnd);
                if (_source != null) _source.AddHook(WndProc);
                // 不抢任务栏、不抢焦点
                int ex = PetNative.GetWindowLong(_hwnd, PetNative.GWL_EXSTYLE);
                PetNative.SetWindowLong(_hwnd, PetNative.GWL_EXSTYLE,
                    ex | PetNative.WS_EX_TOOLWINDOW | PetNative.WS_EX_NOACTIVATE);
            }

            ApplyTopmost(_topmost);
            ReloadSprite();
            ApplyInitialPosition();
            PetLog.Startup("本体窗已创建 hwnd=0x" + _hwnd.ToInt64().ToString("X") +
                           " dpi=" + PetNative.GetDpiForWindowSafe(_hwnd) +
                           " size=" + ActualWidth.ToString("0") + "x" + ActualHeight.ToString("0") + "dip");
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!_reallyClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            _timer.Stop();
            // v10：抛掷/长按计时器也要停 —— 它们每 16ms 醒一次并写 Left/Top，
            // 窗口都关了还在写的话，WPF 会抛 `InvalidOperationException`
            // （"调用线程无法访问此对象"），而那条异常在计时器回调里**没人接**。
            CancelFling();
            StopHoldTimer();
            // v11：反应动画也要停（动画时钟挂在已关闭窗口的元素上没意义）。
            ResetReact();
            if (_source != null)
            {
                _source.RemoveHook(WndProc);
                _source = null;
            }
        }

        /// <summary>真正关闭（退出流程）。</summary>
        public void ForceClose()
        {
            _reallyClosing = true;
            try { Close(); } catch { }
        }

        // ------------------------------------------------------------------
        // 素材
        // ------------------------------------------------------------------

        public void ReloadSprite()
        {
            string want = _state;

            // v13.2：换素材前先把**当前这张**留成残影（见 `_ghost` 的说明）。
            BeginSpriteCrossFade();

            // 契约 §4：清单若已给出 frameWidth/frameHeight，先把窗口摆到目标尺寸再解码，
            // 避免「先兜底尺寸、解码后再跳一下」的首帧闪动。
            int dw, dh;
            if (_store.TryGetDeclaredSize(want, out dw, out dh) && dw > 0 && dh > 0)
            {
                ApplyDipSizeFor(dw, dh);
            }

            SpriteSheet sh = _store.GetSheet(want);
            if (sh == null && want != "idle") sh = _store.GetSheet("idle");

            if (sh == null)
            {
                ShowFallback("素材不可用\n(宿主离线且无缓存)");
                PetLog.Warn("状态 " + want + " 无可用条带");
                return;
            }

            _sheet = sh;
            _frame = 0;
            HideFallback();
            ApplySizeForSheet();
            ShowFrame(0);
            // v11：换素材必须重算圆角 —— 上一条满幅图的裁剪会继续切下一张抠图
            //（气泡那边踩过同一个坑：普通气泡的四角被贴纸的 Clip 切掉一块）。
            // 顺序放在 ApplySizeForSheet 之后：半径按**新**显示宽度算。
            ApplyPlatedClip();
            // 换素材时复位互动动画：上一张图的抖动不该跟到新状态上。
            ResetReact();
            RestartTimer();
        }

        // ------------------------------------------------------------------
        // v13.2：换素材的交叉淡出
        // ------------------------------------------------------------------

        /// <summary>残影层（上一张素材）。见构造函数里的说明。</summary>
        private Image _ghost;

        /// <summary>交叉淡出的时长（ms）。</summary>
        ///
        /// 180 的取法：与气泡的 `FadeIn`(180) 同一量级 —— 短到"切换跟手"，
        /// 长到眼睛能看出是渐变而不是硬切。再长（>300ms）会显得拖沓，
        /// 状态频繁切换时（idle↔thinking）还会叠着看不清。
        internal const int SpriteFadeMs = 180;

        /// <summary>残影淡出的**代次**：防止旧动画的 `Completed` 清掉新残影。</summary>
        private int _ghostGen;

        /// <summary>残影是否要圆角（= 旧图是不是满幅卡片）。</summary>
        private bool _ghostPlated;

        private void OnGhostSizeChanged(object sender, SizeChangedEventArgs e)
        {
            if (_ghostPlated) UpdateGhostClip();
        }

        /// <summary>
        /// 按**残影自己的**渲染尺寸刷新圆角（与 `UpdatePlatedClip` 同一套做法）。
        ///
        /// ⚠️ 为什么不直接抄 `_image.Clip`：`Clip` 是**元素局部坐标**里的几何，
        /// 而残影铺满的是换素材**之后**的窗口尺寸。实测 `working-writing` 是
        /// 266×256、其余是 256×256 —— 尺寸一变，照抄的矩形就对不上，
        /// 圆角会切在错的位置（切不到角，或切进画面里）。
        /// </summary>
        private void UpdateGhostClip()
        {
            try
            {
                if (_ghost == null) return;
                if (!_ghostPlated) { _ghost.Clip = null; return; }
                double w = _ghost.ActualWidth, h = _ghost.ActualHeight;
                if (w <= 0 || h <= 0)
                {
                    Size want = _ghost.DesiredSize;
                    w = want.Width; h = want.Height;
                }
                if (w <= 0 || h <= 0) return;   // 还没排布，等 SizeChanged
                double r = SpriteSheet.PlatedCornerRadiusDip(w);
                double limit = Math.Min(w, h) / 2;
                if (r > limit) r = limit;
                _ghost.Clip = new RectangleGeometry(new Rect(0, 0, w, h), r, r);
            }
            catch { }
        }

        /// <summary>诊断用：残影是否挂着圆角裁剪。</summary>
        internal bool DiagGhostHasClip
        {
            get
            {
                RectangleGeometry rg = _ghost == null ? null : _ghost.Clip as RectangleGeometry;
                return rg != null && rg.RadiusX > 0.5;
            }
        }

        /// <summary>是否正在淡出（诊断用；`Completed` 后归 false）。</summary>
        private bool _ghostFading;

        /// <summary>残影被**真正清除**过几次（诊断用；过期回调不算）。</summary>
        private int _ghostClearedCount;

        /// <summary>
        /// 诊断用：残影被真正清除过几次。
        ///
        /// 一次"换素材抖动"里应当只清 **1** 次（最后那次动画的 `Completed`）。
        /// 若过期的 `Completed` 也生效，就会提前多清一次 ——
        /// 用户看到的是"残影淡到一半突然没了"。
        /// </summary>
        internal int DiagGhostClearedCount { get { return _ghostClearedCount; } }

        /// <summary>
        /// 把当前显示的图留成残影并淡出（v13.2）。
        ///
        /// ⚠️ 连续快速换素材（状态抖动）时必须**重启**而不是叠加：
        /// 残影只有一层，新的换素材直接把它换成"刚刚那张"并重新计时，
        /// 更早的残影丢弃 —— 否则会攒出一串越拖越久的旧图。
        /// </summary>
        private void BeginSpriteCrossFade()
        {
            try
            {
                if (_ghost == null) return;
                // 没有可淡出的旧图（首次加载 / 兜底态）→ 不需要过渡。
                if (_image == null || _image.Source == null) return;

                // 代次 +1：上一次淡出的 `Completed` 会看到自己过期而直接返回，
                // 不会把这一张刚设好的残影清掉（这是我第一版会踩的竞态）。
                _ghostGen++;
                int gen = _ghostGen;

                _ghost.BeginAnimation(OpacityProperty, null);
                _ghost.Source = _image.Source;
                // 圆角裁剪要**跟着残影走**：旧图若是满幅卡片，淡出时四角仍应是圆的；
                // 旧图若是抠图，则不能带裁剪（否则会切到她的头发）。
                // ⚠️ 这里记的是**布尔**（旧图要不要圆角），不是 `_image.Clip` 那个
                // 几何 —— 几何是局部坐标的，而残影铺满的是**新**窗口尺寸，
                // 两者对不上就会切错位置（见 `UpdateGhostClip`）。
                _ghostPlated = (_sheet != null && _sheet.IsPlated);
                UpdateGhostClip();
                _ghost.Opacity = 1.0;

                DoubleAnimation a = new DoubleAnimation(1.0, 0.0,
                    TimeSpan.FromMilliseconds(SpriteFadeMs));
                a.FillBehavior = FillBehavior.HoldEnd;
                a.Completed += delegate(object s2, EventArgs e2)
                {
                    if (gen != _ghostGen) return;   // 已被更新的换素材接管
                    try
                    {
                        _ghost.BeginAnimation(OpacityProperty, null);
                        _ghost.Opacity = 0;
                        _ghost.Source = null;       // 清掉，别攥着旧图不放
                        _ghost.Clip = null;
                        _ghostPlated = false;
                        // ⚠️ 只有**真正执行了清除**才 +1（过期回调在上面就 return 了）。
                        // 自检靠它区分"过期回调被挡住"与"过期回调也生效了" ——
                        // 只看最终状态是区分不出来的（两者最终都是清空的）。
                        _ghostClearedCount++;
                    }
                    catch { }
                    _ghostFading = false;
                };
                _ghost.BeginAnimation(OpacityProperty, a);
                _ghostFading = true;
            }
            catch (Exception ex) { PetLog.Warn("换素材过渡失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>诊断用：残影当前挂着的图（null = 没有残影）。</summary>
        internal object DiagGhostSource { get { return _ghost == null ? null : _ghost.Source; } }
        /// <summary>诊断用：残影不透明度。</summary>
        internal double DiagGhostOpacity { get { return _ghost == null ? 0.0 : _ghost.Opacity; } }
        /// <summary>诊断用：残影是否在淡出中。</summary>
        internal bool DiagGhostFading { get { return _ghostFading; } }
        /// <summary>诊断用：残影是否参与命中测试（必须为 false）。</summary>
        internal bool DiagGhostHitTestVisible { get { return _ghost != null && _ghost.IsHitTestVisible; } }
        /// <summary>诊断用：新图是否已可见（换素材后必须立刻为 true，不能有空白）。</summary>
        internal bool DiagImageSourcePresent { get { return _image != null && _image.Source != null; } }

        private void ShowFallback(string text)
        {
            _sheet = null;
            _image.Source = null;
            _image.Visibility = Visibility.Collapsed;
            // 兜底块不是素材，不该带圆角裁剪（留着会切掉兜底 Border 的四角）。
            ClearPlatedClip();
            _fallbackText.Text = text;
            _fallback.Visibility = Visibility.Visible;
            _timer.Stop();
            SetDipSize(200, 120);
        }

        private void HideFallback()
        {
            _fallback.Visibility = Visibility.Collapsed;
            _image.Visibility = Visibility.Visible;
        }

        private void ApplySizeForSheet()
        {
            if (_sheet == null) return;
            ApplyDipSizeFor(_sheet.FrameW, _sheet.FrameH);
        }

        /// <summary>按物理像素帧尺寸 × 缩放，换算成当前 DPI 下的 DIP 尺寸。</summary>
        private void ApplyDipSizeFor(int frameWpx, int frameHpx)
        {
            if (frameWpx <= 0 || frameHpx <= 0) return;
            double dpi = _hwnd == IntPtr.Zero ? 96.0 : PetNative.GetDpiForWindowSafe(_hwnd);
            double k = 96.0 / dpi;   // 物理像素 → DIP
            SetDipSize(frameWpx * _opt.Scale * k, frameHpx * _opt.Scale * k);
        }

        private void SetDipSize(double w, double h)
        {
            if (w < 16) w = 16;
            if (h < 16) h = 16;
            Width = w;
            Height = h;
        }

        private void RestartTimer()
        {
            _timer.Stop();
            if (_sheet == null) return;
            int ms = _sheet.FrameMs;
            if (ms < 16) ms = 16;
            if (ms > 5000) ms = 5000;
            _timer.Interval = TimeSpan.FromMilliseconds(ms);
            _timer.Start();
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (_sheet == null || !IsVisible) return;
            _frame++;
            ShowFrame(_frame);
        }

        private void ShowFrame(int index)
        {
            if (_sheet == null) return;
            CroppedBitmap c = _sheet.Frame(index);
            if (c == null) return;
            _image.Source = c;
        }

        // ------------------------------------------------------------------
        // v11：满幅素材的圆角（把"硬边方块"变成"有意的卡片"）
        // ------------------------------------------------------------------

        /// <summary>
        /// 按当前素材重算圆角裁剪。
        ///
        /// 判据与理由见 `SpriteSheet.IsPlated`（满幅背景板会让桌宠显示成一个
        /// 直角方块 —— `thinking-starry-formula.png` 的完全透明像素是 0.0%）。
        ///
        /// ⚠️ **非满幅素材绝不裁**：`happy-heart-eyes`(中位透明 0.100)、
        /// `error-sunglasses`(0.090) 都有多帧三个甚至四个实心角 —— 它们是抠图，
        /// 无条件裁圆角会切到她的头发/发饰。
        ///
        /// ⚠️ 窗口是**复用**的：每次换素材都要先清裁剪，否则上一张满幅图的
        /// 圆角会继续切下一张（气泡那边踩过）。
        /// </summary>
        private void ApplyPlatedClip()
        {
            try
            {
                if (_sheet == null || !_sheet.IsPlated)
                {
                    ClearPlatedClip();
                    return;
                }
                _image.SizeChanged -= OnImageSizeChanged;
                _image.SizeChanged += OnImageSizeChanged;
                UpdatePlatedClip();
            }
            catch (Exception ex) { PetLog.Warn("满幅圆角裁剪失败: " + PetLog.Describe(ex)); }
        }

        private void ClearPlatedClip()
        {
            try
            {
                _image.SizeChanged -= OnImageSizeChanged;
                _image.Clip = null;
            }
            catch { }
        }

        private void OnImageSizeChanged(object sender, SizeChangedEventArgs e)
        {
            // 只在满幅模式下重刷（与气泡的 OnChromeSizeChanged 同一道闸）。
            if (_sheet != null && _sheet.IsPlated) UpdatePlatedClip();
        }

        /// <summary>
        /// 按**图片实际渲染尺寸**刷新圆角矩形。
        ///
        /// ⚠️ 尺寸源必须是 `_image.ActualWidth/Height`，不能拿 `ActualWidth`
        /// （窗口）—— 气泡那边实测过：窗口 `ActualWidth` 会把投影的外扩量算进去，
        /// 用 134.7 去裁 119.3 的图，圆角落在图片**外面**，四角仍是直角。
        /// 本体窗没有投影，但同一个坑没必要再踩一次。
        /// </summary>
        private void UpdatePlatedClip()
        {
            if (_sheet == null || !_sheet.IsPlated) return;
            double w = _image.ActualWidth, h = _image.ActualHeight;
            if (w <= 0 || h <= 0)
            {
                Size want = _image.DesiredSize;
                w = want.Width; h = want.Height;
            }
            if (w <= 0 || h <= 0) return;   // 还没排布，等 SizeChanged

            double r = SpriteSheet.PlatedCornerRadiusDip(w);
            // 圆角不能超过短边的一半，否则会画成诡异形状（气泡那边同一条保护）。
            double limit = Math.Min(w, h) / 2;
            if (r > limit) r = limit;
            _image.Clip = new RectangleGeometry(new Rect(0, 0, w, h), r, r);
        }

        /// <summary>
        /// 自检诊断用：当前是否挂着圆角裁剪。
        /// </summary>
        internal bool DiagHasPlatedClip
        {
            get
            {
                RectangleGeometry rg = _image == null ? null : _image.Clip as RectangleGeometry;
                return rg != null && rg.RadiusX > 0.5;
            }
        }

        /// <summary>自检诊断用：当前圆角半径（0 = 没裁）。</summary>
        internal double DiagPlatedRadius
        {
            get
            {
                RectangleGeometry rg = _image == null ? null : _image.Clip as RectangleGeometry;
                return rg == null ? 0 : rg.RadiusX;
            }
        }

        /// <summary>自检诊断用：当前素材是否被判为满幅背景板。</summary>
        internal bool DiagSheetIsPlated { get { return _sheet != null && _sheet.IsPlated; } }

        /// <summary>自检诊断用：当前素材文件名（null = 没素材）。定位"素材被谁换掉了"用。</summary>
        internal string DiagSheetFile { get { return _sheet == null ? "(null)" : _sheet.File; } }

        /// <summary>自检诊断用：图片元素当前是否可见 + 尺寸（圆角裁剪依赖它）。</summary>
        internal string DiagImageState
        {
            get
            {
                return "vis=" + (_image == null ? "?" : _image.Visibility.ToString()) +
                       " actual=" + (_image == null ? 0 : _image.ActualWidth).ToString("0.#") +
                       "x" + (_image == null ? 0 : _image.ActualHeight).ToString("0.#") +
                       " desired=" + (_image == null ? 0 : _image.DesiredSize.Width).ToString("0.#") +
                       "x" + (_image == null ? 0 : _image.DesiredSize.Height).ToString("0.#");
            }
        }

        /// <summary>离屏截图用：窗口内容根元素（`--shots` 直接渲染它，不必真显示窗口）。</summary>
        internal FrameworkElement DiagRoot { get { return _root; } }

        /// <summary>
        /// 自检诊断用：直接塞一张条带并走**真实的**换素材路径。
        ///
        /// ⚠️ 为什么需要它：要验证的核心 bug 是「窗口复用 → 上一张满幅图的圆角
        /// 继续切下一张抠图」，而那必须**连续换两次素材**才能暴露。走
        /// `SetState`/`ReloadSprite` 需要真实的 store 与两张不同状态的图，
        /// 在无头自检里既慢又脆。这里直接把 `_sheet` 换成给定条带，然后调用
        /// 与生产路径**同一个** `ApplyPlatedClip()` —— 测的仍是运行路径。
        /// </summary>
        internal void DiagForceSheet(SpriteSheet sh)
        {
            // v13.2：过渡也是"真实换素材路径"的一部分，这里必须一起走 ——
            // 否则自检测不到它（"断言测拷贝、产品走原件"是这个项目踩过三次的坑）。
            BeginSpriteCrossFade();
            _sheet = sh;
            _frame = 0;
            if (sh != null)
            {
                // ⚠️ 必须**先撤兜底块**，否则 `_image` 还是 Collapsed 状态：
                // 一个 Collapsed 元素的 `ActualWidth`/`DesiredSize` 都是 0，
                // 于是 `UpdatePlatedClip` 会早退、圆角永远落不下来。
                // 生产路径里 `ReloadSprite` 的顺序正是
                // `HideFallback()` → `ApplySizeForSheet()` → `ApplyPlatedClip()`，
                // 这里必须照做，否则测的就不是运行路径（第一版就漏了这步，
                // 于是断言报"裁剪=False"，而那是**测试脚手架**的问题，不是实现的）。
                HideFallback();
                CroppedBitmap c = sh.Frame(0);
                if (c != null) _image.Source = c;
                ApplySizeForSheet();
            }
            ApplyPlatedClip();
        }

        /// <summary>
        /// 自检诊断用：某个 DIP 点是否算"可点"（直接复用运行路径的
        /// `HitTestDip`，不是副本 —— 副本会让"改坏真实逻辑、自检仍绿"）。
        /// </summary>
        internal bool DiagHitTestDip(double x, double y)
        {
            return HitTestDip(new Point(x, y));
        }

        /// <summary>
        /// 自检诊断用：`InClippedCorner` 的纯几何入口（不依赖窗口是否已排布）。
        /// 自检拿它验证"圆角切掉区不可点"，与 `HitTestDip` 用的是同一函数。
        /// </summary>
        internal static bool DiagInClippedCorner(double px, double py, double w, double h)
        {
            if (w <= 0 || h <= 0) return false;
            double r = SpriteSheet.PlatedCornerRadiusDip(w);
            double limit = Math.Min(w, h) / 2;
            if (r > limit) r = limit;
            if (r <= 0) return false;
            bool nearLeft = px < r;
            bool nearRight = px > w - r;
            if (!nearLeft && !nearRight) return false;
            bool nearTop = py < r;
            bool nearBottom = py > h - r;
            if (!nearTop && !nearBottom) return false;
            double cx = nearLeft ? r : w - r;
            double cy = nearTop ? r : h - r;
            double dx = px - cx, dy = py - cy;
            return (dx * dx + dy * dy) > (r * r);
        }

        // ------------------------------------------------------------------
        // v11：互动反馈动画（点击 / 摸头 / 抛掷落地）
        // ------------------------------------------------------------------

        /// <summary>
        /// 反应动画的时长（ms）。260ms 的取法：短到"点一下就回"，
        /// 长到能被眼睛捕捉（150ms 以下在 60Hz 屏上只有 ~9 帧，几乎看不见）。
        /// </summary>
        internal const int ReactMs = 260;

        /// <summary>
        /// 单次反应的最大缩放**下压**量（1.0 - 该值 = 最小缩放）。
        /// 分级用：level 越高压得越深。
        /// </summary>
        internal const double ReactMaxSquash = 0.14;

        /// <summary>位移幅度占帧高的比例（上限）。</summary>
        internal const double ReactMaxShiftRatio = 0.08;

        /// <summary>
        /// 播一次"她抖了一下"。
        ///
        /// ── 两条硬约束（都不是审美，是会出错的）────────────────────────────
        ///
        /// ① **缩放只许 ≤ 1.0（只缩不放）**。本体的精灵帧是**满幅**的
        ///    （实测 `idle-smile.png` 的内容包围盒 = 整帧 256×256），
        ///    窗口尺寸又**恰好等于帧尺寸**（冻结不变量）—— 放大一点点，
        ///    图就会超出窗口被裁掉（表现为"边缘缺一块"）。
        ///    所以这里只做"压扁 + 回弹到 1.0"，永远不越界。
        ///
        /// ② **不做横向压扁**（ScaleX ≠ ScaleY）：那需要图在水平方向有留白，
        ///    而这些素材没有（`working-writing.png` 内容占帧 100%）。均匀缩放才安全。
        ///
        /// @param kind  反应种类：'click' | 'pat' | 'land'
        /// @param level 长按级数（1..3，仅 'pat' 用）；0/1 = 最轻
        /// </summary>
        public void PlayReact(string kind, int level)
        {
            try
            {
                // 抛掷飞行期间不播：飞行本身就是反馈，而且它每 16ms 写 Left/Top，
                // 再叠一个变换只会看起来像在抽搐。
                if (_flinging) return;
                if (_sheet == null) return;

                double depth = ReactMaxSquash;
                if (kind == "pat")
                {
                    // ⚠️ v13.1：摸头分级**已经搬走**到 `PlayPatHold`/`PlayPatPoke`
                    // （见那两个方法的说明）。这里**转发**过去，不再留第二套
                    // 分级实现 —— 留着的下场是"产品走 A、自检测 B"：
                    // 本次改动前，`PlayReact("pat")` 已**只剩自检在调**。
                    PlayPatPoke(level);
                    return;
                }
                else if (kind == "land")
                {
                    // 落地：飞了那么远，落地该比点击更明显
                    depth *= 1.0;
                }
                else
                {
                    depth *= 0.7;      // 点击最轻（它也是最高频的）
                }

                double minScale = 1.0 - depth;
                double h = _image.ActualHeight > 0 ? _image.ActualHeight : ActualHeight;
                double shift = h * ReactMaxShiftRatio * (kind == "land" ? 1.0 : 0.5);

                // 复位后再起动画（连续点击时不能叠加，否则会越缩越小）。
                ResetReact();

                // 缩放：1 → min → 1（用 KeyFrames 精确控制，C#5 安全）
                DoubleAnimationUsingKeyFrames sc = new DoubleAnimationUsingKeyFrames();
                sc.Duration = new Duration(TimeSpan.FromMilliseconds(ReactMs));
                sc.FillBehavior = FillBehavior.Stop;
                sc.KeyFrames.Add(new LinearDoubleKeyFrame(minScale,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs * 0.35))));
                sc.KeyFrames.Add(new LinearDoubleKeyFrame(1.0,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs))));
                _reactScale.BeginAnimation(ScaleTransform.ScaleXProperty, sc);
                _reactScale.BeginAnimation(ScaleTransform.ScaleYProperty, sc);

                // 位移：0 → -shift → 0（先被"压下去"再弹回）
                DoubleAnimationUsingKeyFrames tr = new DoubleAnimationUsingKeyFrames();
                tr.Duration = new Duration(TimeSpan.FromMilliseconds(ReactMs));
                tr.FillBehavior = FillBehavior.Stop;
                tr.KeyFrames.Add(new LinearDoubleKeyFrame(-shift,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs * 0.35))));
                tr.KeyFrames.Add(new LinearDoubleKeyFrame(0.0,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs))));
                _reactShift.BeginAnimation(TranslateTransform.YProperty, tr);

                _reactPlaying = true;
            }
            catch (Exception ex) { PetLog.Warn("反应动画失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>
        /// 按住摸头的**持续压扁**（v13.1，用户："摸头的逐级反应太快了"+
        /// "记得加上过渡动画"）。
        ///
        /// ── 为什么不能复用 `PlayReact` ────────────────────────────────────────
        ///
        /// `PlayReact` 是"戳一下 → 弹回"的**瞬时**动画：它先 `ResetReact()`
        /// 回到 1.0，再压到最深、再弹回 1.0。用来做**分级**时有个致命问题：
        /// 每升一级都要**先弹回原尺寸**，于是 1/2/3 级看起来是**三次一模一样的戳**
        /// —— 用户根本看不出"越摸越深"，只看到"被连戳了三下"。
        ///
        /// 所以摸头需要的是另一种动画：**按住期间持续压着，逐级平滑加深，
        /// 松手才弹回**。这正是"过渡动画"要解决的问题 ——
        /// 不是给每一级配个动画，而是让级与级之间**连起来**。
        ///
        /// ── 实现要点 ─────────────────────────────────────────────────────────
        ///
        /// · **从当前值起算**（`From = 当前 scale`），不是从 1.0 起算 ——
        ///   这是"平滑过渡"的全部秘密。从 1.0 起算就会看到每一级都弹回去一次。
        /// · **只加深、不回浅**：抖动导致的浅目标不许让她回弹。
        /// · `FillBehavior.HoldEnd`：动画结束后**保持在目标深度**（按住的状态），
        ///   而不是像 `PlayReact` 那样回到 1.0。
        ///
        /// ⚠️ 仍然只缩不放（scale ≤ 1.0）：本体的精灵帧是满幅的，放大一点点
        /// 就会超出窗口被裁掉（见 `PlayReact` 的说明，那是冻结约束）。
        /// </summary>
        /// <param name="level">长按级数（1..3）。越往上按得越深。</param>
        public void PlayPatHold(int level)
        {
            try
            {
                if (_flinging) return;      // 飞行期间不播（与 PlayReact 同一条）
                if (_sheet == null) return;

                // 级数 → 目标深度。比 PlayReact 的 0.6/0.8/1.0 **更浅的起点**
                // (0.5) 是刻意的：按住是"持续压着"，起点太深会让第 1 级就很重，
                // 后面两级反而没有加深的余地。
                double mul = PatDepthMul(level);
                double targetScale = 1.0 - ReactMaxSquash * mul;

                double h = _image.ActualHeight > 0 ? _image.ActualHeight : ActualHeight;
                double targetShift = -(h * ReactMaxShiftRatio * 0.5 * mul);

                // ⚠️ 从**当前**值起算 —— 见方法头"平滑过渡的全部秘密"。
                double fromScale = _reactScale.ScaleX;
                double fromShift = _reactShift.Y;
                if (double.IsNaN(fromScale) || fromScale > 1.0) fromScale = 1.0;
                if (double.IsNaN(fromShift)) fromShift = 0.0;

                // 按住期间只加深、不回浅（抖动给出的浅目标不该让手弹回来）。
                if (_patHolding)
                {
                    if (targetScale > fromScale) targetScale = fromScale;
                    if (targetShift > fromShift) targetShift = fromShift;
                }

                DoubleAnimation sc = new DoubleAnimation();
                sc.From = fromScale;
                sc.To = targetScale;
                sc.Duration = new Duration(TimeSpan.FromMilliseconds(PatPressMs));
                sc.FillBehavior = FillBehavior.HoldEnd;   // 按住 → 停在目标深度
                _reactScale.BeginAnimation(ScaleTransform.ScaleXProperty, sc);
                _reactScale.BeginAnimation(ScaleTransform.ScaleYProperty, sc);

                DoubleAnimation tr = new DoubleAnimation();
                tr.From = fromShift;
                tr.To = targetShift;
                tr.Duration = new Duration(TimeSpan.FromMilliseconds(PatPressMs));
                tr.FillBehavior = FillBehavior.HoldEnd;
                _reactShift.BeginAnimation(TranslateTransform.YProperty, tr);

                _patHolding = true;
                _patDepth = 1.0 - targetScale;
                _reactPlaying = true;
            }
            catch (Exception ex) { PetLog.Warn("摸头过渡动画失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>
        /// 摸头级数 → 深度系数（**唯一**的分级表）。
        ///
        /// 两个入口共用它：`PlayPatHold`（按住时持续加深）与 `PlayPatPoke`
        /// （松手兜底时补一次瞬时反应）。分两张表的话，
        /// "1 级看起来多重"会按走哪条路径而不一样 —— 那正是 v12/v13
        /// 反复踩的"两份判据互相掩护"。
        /// </summary>
        internal static double PatDepthMul(int level)
        {
            return level <= 1 ? 0.5 : (level == 2 ? 0.75 : 1.0);
        }

        /// <summary>
        /// 摸头**瞬时**反应（v13.1）：压到该级深度再弹回，用于松手兜底。
        ///
        /// ── 为什么需要它（这是我本轮差点漏掉的一条真实路径）──────────────
        ///
        /// `PlayPatHold` + `EndPatHold` 是**配对**的：按住 → 加深 → 松手弹回。
        /// 但"松手兜底"（计时器没走成、松手时才补报第 1 级）里，
        /// 按下阶段**根本没播过动画**，而 `finally` 会紧接着调 `EndPatHold` ——
        /// 于是 `PlayPatHold` 刚起一个 1.0→0.95 的动画，同一轮就被 `EndPatHold`
        /// 按当前值（还是 1.0）收掉 → **动画变成 1.0→1.0，用户什么都看不到**。
        ///
        /// 旧代码在这条路径上是**看得到**反应的（`PlayReact` 的瞬时戳），
        /// 所以直接换成 `PlayPatHold` 会是一次**静默的功能退化**：
        /// 手势照旧上报、好感照旧增加，只是她不动了。
        ///
        /// 所以兜底路径用这个"一次性戳"：压到该级深度再弹回，
        /// 与按住路径共用 `PatDepthMul`（同一口径），但不进入"按住"状态。
        /// </summary>
        public void PlayPatPoke(int level)
        {
            try
            {
                if (_flinging) return;
                if (_sheet == null) return;

                double mul = PatDepthMul(level);
                double minScale = 1.0 - ReactMaxSquash * mul;
                double h = _image.ActualHeight > 0 ? _image.ActualHeight : ActualHeight;
                double shift = h * ReactMaxShiftRatio * 0.5 * mul;

                // 入口计数（自检判"走的是瞬时戳还是按住"的唯一可靠判据）。
                _pokeCount++;

                // 一次性动画：先复位（避免与上一次叠加越缩越小），再压 → 弹回。
                ResetReact();

                DoubleAnimationUsingKeyFrames sc = new DoubleAnimationUsingKeyFrames();
                sc.Duration = new Duration(TimeSpan.FromMilliseconds(ReactMs));
                sc.FillBehavior = FillBehavior.Stop;
                sc.KeyFrames.Add(new LinearDoubleKeyFrame(minScale,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs * 0.35))));
                sc.KeyFrames.Add(new LinearDoubleKeyFrame(1.0,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs))));
                _reactScale.BeginAnimation(ScaleTransform.ScaleXProperty, sc);
                _reactScale.BeginAnimation(ScaleTransform.ScaleYProperty, sc);

                DoubleAnimationUsingKeyFrames tr = new DoubleAnimationUsingKeyFrames();
                tr.Duration = new Duration(TimeSpan.FromMilliseconds(ReactMs));
                tr.FillBehavior = FillBehavior.Stop;
                tr.KeyFrames.Add(new LinearDoubleKeyFrame(-shift,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs * 0.35))));
                tr.KeyFrames.Add(new LinearDoubleKeyFrame(0.0,
                    KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(ReactMs))));
                _reactShift.BeginAnimation(TranslateTransform.YProperty, tr);

                _reactPlaying = true;
            }
            catch (Exception ex) { PetLog.Warn("摸头瞬时反应失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>
        /// 结束"按住"：平滑弹回原尺寸（v13.1）。
        ///
        /// `FillBehavior.Stop` + 基准值 1.0：动画结束后自动回到单位变换，
        /// 不需要 `Completed` 回调去清理（回调在窗口已关闭时还会跑，容易出岔子）。
        /// </summary>
        public void EndPatHold()
        {
            if (!_patHolding) return;
            _patHolding = false;
            try
            {
                double fromScale = _reactScale.ScaleX;
                double fromShift = _reactShift.Y;
                if (double.IsNaN(fromScale) || fromScale > 1.0) fromScale = 1.0;
                if (double.IsNaN(fromShift)) fromShift = 0.0;

                DoubleAnimation sc = new DoubleAnimation();
                sc.From = fromScale;
                sc.To = 1.0;
                sc.Duration = new Duration(TimeSpan.FromMilliseconds(PatReleaseMs));
                sc.FillBehavior = FillBehavior.Stop;   // 结束后由基准值 1.0 接管
                _reactScale.BeginAnimation(ScaleTransform.ScaleXProperty, sc);
                _reactScale.BeginAnimation(ScaleTransform.ScaleYProperty, sc);

                DoubleAnimation tr = new DoubleAnimation();
                tr.From = fromShift;
                tr.To = 0.0;
                tr.Duration = new Duration(TimeSpan.FromMilliseconds(PatReleaseMs));
                tr.FillBehavior = FillBehavior.Stop;
                _reactShift.BeginAnimation(TranslateTransform.YProperty, tr);

                _patDepth = 0.0;
                _reactPlaying = true;
            }
            catch { }
        }

        /// <summary>按住摸头进行中（松手要据此弹回）。</summary>
        private bool _patHolding;
        /// <summary>本次按住已达到的深度（诊断用）。</summary>
        private double _patDepth;

        /// <summary>逐级加深的过渡时长（ms）。比瞬时动画(260)略短，让加深跟手。</summary>
        internal const int PatPressMs = 220;
        /// <summary>松手弹回的时长（ms）。比加深略长，收尾更柔和。</summary>
        internal const int PatReleaseMs = 300;

        /// <summary>自检诊断用：是否处于"按住"状态。</summary>
        internal bool DiagPatHolding { get { return _patHolding; } }
        /// <summary>自检诊断用：当前按住的深度（1.0 - scale）。</summary>
        internal double DiagPatDepth { get { return _patDepth; } }

        /// <summary>
        /// 自检诊断用：`PlayPatPoke` 被调用了几次。
        ///
        /// ⚠️ 为什么需要计数（回滚验证 R7/R10 都因此变绿过）：
        /// 我原先用"动画深度"间接判"走的是哪条路"，而深度是**结果** ——
        /// 两条路都能压出同样的深度，判据分不开。
        /// 计数直接看**入口**，才真正区分"瞬时戳"与"按住"。
        /// </summary>
        internal int DiagPokeCount { get { return _pokeCount; } }
        private int _pokeCount;

        /// <summary>
        /// 自检用：驱动**真实的松手分发**（`DispatchRelease` 薄壳）。
        ///
        /// ⚠️ 存在的理由（回滚验证 R10 抓到过）：分发原先长在
        /// `OnMouseLeftButtonUp` 里，无头自检造不出鼠标事件 → 兜底走哪条路
        /// **没有任何断言能发现**。有了它，"兜底必须用瞬时戳"才测得到。
        /// </summary>
        internal void DiagDispatchRelease(string action, int patLevel)
        {
            ReleaseAction a = ReleaseAction.None;
            if (action == "click") a = ReleaseAction.Click;
            else if (action == "fling") a = ReleaseAction.Fling;
            else if (action == "pat") a = ReleaseAction.Pat;
            DispatchRelease(a, patLevel, 0.0);
        }

        /// <summary>动画是否正在播（自检诊断用）。</summary>
        private bool _reactPlaying;

        /// <summary>自检诊断用：动画是否正在播。</summary>
        internal bool DiagReactPlaying { get { return _reactPlaying; } }

        /// <summary>
        /// 自检诊断用：缩放上是否挂着**活动的动画时钟**。
        ///
        /// ⚠️ 为什么需要它（v13.1 的断言在这里翻过车）：验证"松手是平滑弹回"
        /// 时我靠 `Pump(150)` 取动画中点，而 `Pump` 是**墙钟**计时 ——
        /// 调度器一忙，150ms 的泵可能实际跑了 400ms，动画早结束并归位到 1.0，
        /// 于是断言**偶发变红**（实测出现过一次 300/1，重跑两次又全绿）。
        /// 一个会随机变红的断言比没有断言更糟：它会训练人忽略红色。
        ///
        /// `HasAnimatedProperties` 是**确定性**的：动画一挂上就为 true，
        /// 不需要卡时间点去采样。
        /// </summary>
        internal bool DiagReactAnimating
        {
            get { return _reactScale != null && _reactScale.HasAnimatedProperties; }
        }

        /// <summary>自检诊断用：当前缩放值（静止时应当是 1.0）。</summary>
        internal double DiagReactScaleX { get { return _reactScale == null ? 1.0 : _reactScale.ScaleX; } }
        internal double DiagReactScaleY { get { return _reactScale == null ? 1.0 : _reactScale.ScaleY; } }
        /// <summary>自检诊断用：当前 Y 位移。</summary>
        internal double DiagReactShiftY { get { return _reactShift == null ? 0.0 : _reactShift.Y; } }

        /// <summary>
        /// 清掉进行中的动画并复位到单位变换。
        ///
        /// `BeginAnimation(prop, null)` 是**必须的**：只设 `ScaleX = 1` 的话，
        /// 动画仍然持有该属性的动画时钟（`FillBehavior.Stop` 只是让它在结束后
        /// 回到基准值，动画对象本身还在），下一次设基准值会被动画覆盖。
        /// </summary>
        internal void ResetReact()
        {
            try
            {
                if (_reactScale != null)
                {
                    _reactScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                    _reactScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                    _reactScale.ScaleX = 1.0;
                    _reactScale.ScaleY = 1.0;
                }
                if (_reactShift != null)
                {
                    _reactShift.BeginAnimation(TranslateTransform.YProperty, null);
                    _reactShift.Y = 0.0;
                }
                // v13.1：按住状态一并清掉。不清的话，下一次按下会以为
                // "还在按住"→ 走"只加深不回浅"的分支 → 目标被夹到当前值，
                // 她**再也不会压下去**（拖动/抛掷/点击后残留就是这种表现）。
                _patHolding = false;
                _patDepth = 0.0;
                _reactPlaying = false;
            }
            catch { }
        }

        // ------------------------------------------------------------------
        // 状态
        // ------------------------------------------------------------------

        public void SetState(string state)
        {
            string s = PetJson.NormalizeState(state);
            if (s == _state && _sheet != null) return;
            _state = s;
            ReloadSprite();
        }

        public void ApplySnapshot(PetSnapshot snap)
        {
            if (snap == null) return;
            SetState(snap.EffectiveState());
        }

        // ------------------------------------------------------------------
        // 位置 / 多屏 / DPI
        // ------------------------------------------------------------------

        private void ApplyInitialPosition()
        {
            double dpi = _hwnd == IntPtr.Zero ? 96.0 : PetNative.GetDpiForWindowSafe(_hwnd);
            double k = 96.0 / dpi;
            int wpx = (int)Math.Round(Width * dpi / 96.0);
            int hpx = (int)Math.Round(Height * dpi / 96.0);

            int x, y;
            if (_opt.HasPos) { x = _opt.X; y = _opt.Y; }
            else PetNative.DefaultPosition(wpx, hpx, out x, out y);

            int cx, cy;
            PetNative.ClampToWorkspace(x, y, wpx, hpx, out cx, out cy);
            Left = cx * k;
            Top = cy * k;
            PetLog.Startup("本体位置 " + cx + "," + cy + " (" + wpx + "x" + hpx + "px)");
        }

        /// <summary>把窗口重新 clamp 回可见工作区（屏幕变化 / DPI 变化 / 托盘重置）。</summary>
        public void ReclampPosition(bool forceDefault)
        {
            if (_hwnd == IntPtr.Zero) return;
            double dpi = PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            int wpx = (int)Math.Round(Width * dpi);
            int hpx = (int)Math.Round(Height * dpi);
            int x, y;
            if (forceDefault)
            {
                PetNative.DefaultPosition(wpx, hpx, out x, out y);
            }
            else
            {
                x = (int)Math.Round(Left * dpi);
                y = (int)Math.Round(Top * dpi);
            }
            int cx, cy;
            PetNative.ClampToWorkspace(x, y, wpx, hpx, out cx, out cy);
            Left = cx / dpi;
            Top = cy / dpi;
            ReportPosition();
        }

        // 上次已上报的位置（物理像素）；int.MinValue = 尚未上报过，首次必发。
        private int _lastReportedX = int.MinValue;
        private int _lastReportedY = int.MinValue;

        /// <summary>
        /// 上报当前所在位置。**值没变就不发**（回响环修复）：
        /// ReclampPosition 在 SetScale / 显示器变化 / DPI 变化时都会走到这里，
        /// 若位置实际没动就静默返回，避免设置应用路径反复 POST（风暴/回响）。
        /// 只在位置真正变化时（拖动结束、clamp 把窗口推回屏内、滚轮放大到边缘）上报一次。
        /// </summary>
        private void ReportPosition()
        {
            int x, y, w, h;
            GetScreenRect(out x, out y, out w, out h);
            if (x == _lastReportedX && y == _lastReportedY) return;
            _lastReportedX = x;
            _lastReportedY = y;
            Action<int, int> h2 = PositionReported;
            if (h2 != null) h2(x, y);
        }

        public void SetScale(double scale)
        {
            scale = PetOptions.ClampScale(scale);   // task-6：0.3~3.0，settings/滚轮共用
            _opt.Scale = scale;
            if (_sheet != null) ApplySizeForSheet();
            // v11：圆角半径按**显示宽度**算，缩放后必须重算（否则 0.5× 时
            // 一个 90px 的小图还挂着 20px 圆角，看起来是个圆球）。
            ApplyPlatedClip();
            ReclampPosition(false);
            UpdateSendBtnVisibility(IsMouseOver);   // task-7：✎ 尺寸随 scale 即时重算
        }

        public void SetOpacity(double opacity)
        {
            opacity = PetOptions.ClampOpacity(opacity);
            _opt.Opacity = opacity;
            Opacity = opacity;
        }

        public void SetTopmost(bool on)
        {
            _topmost = on;
            ApplyTopmost(on);
        }

        private void ApplyTopmost(bool on)
        {
            Topmost = on;
            if (_hwnd == IntPtr.Zero) return;
            try
            {
                PetNative.SetWindowPos(_hwnd, on ? PetNative.HWND_TOPMOST : PetNative.HWND_NOTOPMOST,
                    0, 0, 0, 0,
                    PetNative.SWP_NOMOVE | PetNative.SWP_NOSIZE | PetNative.SWP_NOACTIVATE);
            }
            catch { }
        }

        public void SetClickThrough(bool on)
        {
            _clickThrough = on;
            PetLog.Info("点击穿透 = " + (on ? "开（透明处穿透）" : "关（整窗可点可拖）"));
        }

        /// <summary>
        /// 本体显隐变化（true=显示 / false=隐藏）。
        ///
        /// **为什么需要**：气泡是**另一个窗口**，本体 Hide() 不会带走它 ——
        /// 结果就是"隐藏了桌宠，旁边还挂着一个气泡"。Program 用它联动气泡的显隐。
        /// </summary>
        public Action<bool> VisibilityChanged = delegate { };

        /// <summary>
        /// 拖动**过程中**每次移动都触发（不是拖动结束）。
        ///
        /// 用途：让气泡窗与输入窗实时跟随。`PositionReported` 只在拖动结束时发一次
        /// （它要 POST 给 Host，不能每帧发），所以拖动中的跟随必须走这条轻量回调。
        /// </summary>
        public Action DragMoved = delegate { };

        /// <summary>
        /// 本体被鼠标悬停/移出（true=进入 / false=离开）。
        ///
        /// 用途：`hint`（悬停时显示状态）—— 状态文字窗是独立窗口，本体不知道它存在，
        /// 必须把悬停事实播出去。与 ✎ 按钮共用同一个 MouseEnter/MouseLeave 时机。
        /// </summary>
        public Action<bool> HoverChanged = delegate { };

        public void SetBubbleVisibleState(bool visible)
        {
            if (visible) ShowPet(); else HidePet();
        }

        public void HidePet()
        {
            Hide();
            _timer.Stop();
            // 联动：本体藏了，气泡必须一起藏（它是独立窗口，不会自动跟随）。
            // 通知放在最后：先让本体真正进入隐藏态，订阅方读 IsVisible 才是对的。
            try { VisibilityChanged(false); } catch { }
        }

        public void ShowPet()
        {
            Show();
            RestartTimer();
            try { VisibilityChanged(true); } catch { }
        }

        public void ToggleVisible()
        {
            if (IsVisible) HidePet(); else ShowPet();
        }

        // ------------------------------------------------------------------
        // 命中测试 / 拖动
        // ------------------------------------------------------------------

        /// <summary>
        /// ✎ 按钮在窗口内的 DIP 矩形（用于 WM_NCHITTEST 放行）。
        ///
        /// 按钮现在**完全在窗口内**（右上角内缩 1px）。给一点容差（2 DIP）让边缘更好点，
        /// 但**不能超出窗口矩形** —— 窗口外的像素收不到鼠标消息，放行也没用。
        /// </summary>
        private bool IsOverSendButton(Point dip)
        {
            if (_sendBtn == null || _sendBtn.Visibility != Visibility.Visible) return false;
            double bw = _sendBtn.Width, bh = _sendBtn.Height;
            if (bw <= 0 || bh <= 0) return false;
            double right = ActualWidth - _sendBtn.Margin.Right;
            double top = _sendBtn.Margin.Top;
            double left = right - bw;
            double bottom = top + bh;
            const double pad = 2;
            return dip.X >= left - pad && dip.X <= right + pad &&
                   dip.Y >= top - pad && dip.Y <= bottom + pad;
        }

        /// <summary>自检诊断用：当前缩放。</summary>
        public double DiagScale { get { return _opt.Scale; } }

        /// <summary>自检诊断用：直接走一次滚轮缩放逻辑（不经窗口消息）。</summary>
        public void DiagApplyWheel(int delta)
        {
            double ns = PetOptions.StepScale(_opt.Scale, delta);
            if (Math.Abs(ns - _opt.Scale) < 0.001) return;
            SetScale(ns);
            ScaleAdjusted(ns);
        }
        /// <summary>自检诊断用：✎ 按钮矩形是否完全落在窗口内（越界就点不到）。</summary>
        public bool DiagSendBtnInsideWindow()
        {
            if (_sendBtn == null) return false;
            double bw = _sendBtn.Width, bh = _sendBtn.Height;
            double right = ActualWidth - _sendBtn.Margin.Right;
            double top = _sendBtn.Margin.Top;
            return top >= 0 && right <= ActualWidth + 0.01 &&
                   right - bw >= -0.01 && top + bh <= ActualHeight + 0.01;
        }

        /// <summary>自检诊断用：鼠标离开后是否存在隐藏宽限期（而不是立即隐藏）。</summary>
        public bool DiagSendBtnLingers()
        {
            if (_sendHideTimer == null) return false;
            // 触发一次"离开"路径，看它是否只是**安排**隐藏（计时器在跑）而不是马上收起。
            _sendAvailable = true;
            UpdateSendBtnVisibility(true);
            bool visibleBefore = _sendBtn.Visibility == Visibility.Visible;
            HideSendBtnSoon();
            bool timerArmed = _sendHideTimer.IsEnabled;
            bool stillVisible = _sendBtn.Visibility == Visibility.Visible;
            _sendHideTimer.Stop();
            UpdateSendBtnVisibility(false);
            return visibleBefore && timerArmed && stillVisible;
        }

        private bool HitTestDip(Point p)
        {            // ✎ 按钮区永远算实体（桌宠透明角落是 HTTRANSPARENT，按钮必须点得到）
            if (IsOverSendButton(p)) return true;
            // v11：满幅素材被裁掉的圆角**不算实体**。
            //
            // 不挡的话会出现"看得见桌面、点得着"的隐形可点角 —— 视觉上那里是
            // 空的（被 Clip 切掉了），鼠标却落在她身上（alpha 掩码仍是不透明的
            // 方形素材）。这是最容易漏的一处：裁剪是**渲染**层的，命中测试是
            // 另一条路径，两边必须显式对齐。
            if (_sheet != null && _sheet.IsPlated && InClippedCorner(p)) return false;
            // 逐像素 alpha 命中：**与 clickThrough 无关**。
            // 透明处必须穿透（鼠标落到身后的桌面图标/窗口），否则桌宠会挡住一整块矩形。
            if (_sheet == null)
            {
                // 兜底块（还没加载素材）：整个矩形都算实体，否则没法拖动
                return p.X >= 0 && p.Y >= 0 && p.X <= ActualWidth && p.Y <= ActualHeight;
            }
            double u = ActualWidth <= 0 ? 0 : p.X / ActualWidth;
            double v = ActualHeight <= 0 ? 0 : p.Y / ActualHeight;
            // 容错半径：150% DPI 下给 2 物理像素 ≈ 1.33 DIP
            return _sheet.HitTest(_frame, u, v, 2);
        }

        /// <summary>
        /// 点是否落在被圆角裁掉的四个角里。
        ///
        /// 只负责取当前尺寸，几何判定转发给 `DiagInClippedCorner` ——
        /// **单一实现**。这个项目吃过"两处各写一份算术、改坏真实逻辑自检仍绿"
        /// 的亏（状态文字与气泡定位都踩过），所以宁可让运行路径调一个名字带
        /// `Diag` 的纯函数，也不复制一份。
        /// </summary>
        private bool InClippedCorner(Point p)
        {
            double w = _image.ActualWidth, h = _image.ActualHeight;
            if (w <= 0 || h <= 0) { w = ActualWidth; h = ActualHeight; }
            return DiagInClippedCorner(p.X, p.Y, w, h);
        }

        private void OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            // 抛掷动画期间吞掉一切鼠标输入。
            //
            // 不吞的话会出两种荒唐情形：① 飞到一半又被"抓住"，`_dragOffsetDip`
            // 是按下点算的，窗口会瞬移到鼠标位置；② 动画结束后那次抬起被算成
            // 一次点击 —— 用户明明只是甩了她一下，却收到"打招呼"的互动。
            if (_flinging)
            {
                // ⚠️ 面包屑：这条路径原先**什么都不记**。用户"甩出去之后又想点她"
                // 时会发现"点了没反应"，而日志里一片空白 —— 无从判断。
                PetBreadcrumb.Trace("按下被吞：抛掷动画进行中（动画结束前不收鼠标输入）");
                e.Handled = true;
                return;
            }
            if (e.ClickCount == 2)
            {
                PetBreadcrumb.Trace("双击（ClickCount=2）→ 交给双击行为，不进入手势判定");
                e.Handled = true;
                DoubleClickInvoked();   // task-6：行为由 settings.doubleClick 决定（Program 装配）
                return;
            }
            Point p = e.GetPosition(this);
            if (!HitTestDip(p))
            {
                // ⚠️⚠️ 这是**最要紧**的一条：点在透明像素上时原来完全静默。
                // 而"我明明点了她"与"点在了她旁边的透明处"在日志里长得一模一样
                //（都是一片空白）—— 这正是"手势判定很奇怪"最常见的真因之一。
                PetBreadcrumb.Trace("按下落在**透明像素**上 → 不接收（她没有吃掉这次点击）" +
                                    " dip=(" + Fmt(p.X) + "," + Fmt(p.Y) + ")" +
                                    " 窗口=" + Fmt(ActualWidth) + "x" + Fmt(ActualHeight) +
                                    " 素材=" + (_sheet == null ? "(未加载)" : _sheet.File));
                return;
            }

            _dragging = true;
            _dragOffsetDip = p;
            // v11：拖动开始时复位反应动画 —— 她正在被拖，残留的"抖一下"
            // 会与拖动叠在一起（看起来像抽搐）。
            ResetReact();
            // v9：记下按下时的**屏幕坐标与时刻**，用来区分"点击"与"拖动"。
            // 判据是"位移够小 **且** 时间够短"，两个都要 —— 只看位移的话，
            // 慢慢拖 3 像素也会被当成点击；只看时间的话，快速拖一大段也是"点击"。
            _pressAt = DateTime.UtcNow;
            try { _pressScreen = PointToScreen(p); } catch { _pressScreen = new Point(double.NaN, double.NaN); }
            _movedSincePress = false;
            _holdStill = true;   // v13：新一次按下 → 手视为"还没动"

            // v10：手势采样与长按计时从这里开始。
            _pressClockMs = ClockMs();
            ResetSamples();
            PushSample(_pressClockMs, _pressScreen);
            _patLevelReported = 0;
            StartHoldTimer();

            PetBreadcrumb.Trace("按下 pos=(" + Fmt(_pressScreen.X) + "," + Fmt(_pressScreen.Y) +
                                ") 容差[" + _tolerance.Describe() + "]");

            try { CaptureMouse(); } catch { }
            e.Handled = true;
        }

        // ------------------------------------------------------------------
        // v9：单击（与拖动区分）
        // ------------------------------------------------------------------

        /// <summary>按下时刻（判断"是不是点击"用）。</summary>
        private DateTime _pressAt = DateTime.MinValue;
        /// <summary>按下时的屏幕坐标。</summary>
        private Point _pressScreen = new Point(double.NaN, double.NaN);
        /// <summary>按下之后是否移动超过阈值（超过就不是点击）。</summary>
        private bool _movedSincePress;

        /// <summary>
        /// v13：**当前**这次移动之后，手是否仍在"按住不动"的容差内。
        ///
        /// ⚠️ 与 `_movedSincePress` 的差别是**它可恢复**，这正是修 bug 的关键。
        /// `_movedSincePress` 一旦置位就永久为真，而 `OnHoldTick` 原先靠它
        /// **停掉**长按计时器 —— 于是高指针增益下（用户实测 1.5×）手一抖越过
        /// 容差，摸头就在这次按下里**永久失效**，哪怕手立刻回到原位。
        /// 现在改成"看当前位置"：抖出去时不报级，稳回来继续报。
        /// </summary>
        private bool _holdStill = true;

        /// <summary>
        /// v13：本次手势判定使用的容差（随指针增益 × 用户灵敏度放大）。
        ///
        /// 默认 = 增益 1.0，也就是 v12 的行为**逐位不变**（旧断言继续有效）。
        /// </summary>
        private GestureTolerance _tolerance = GestureTolerance.Default();

        /// <summary>
        /// v13：设置容差。Program 在启动与设置变更时调用。
        ///
        /// `gain` 来自 `PetNative.GetPointerGainSafe()`（系统鼠标速度），
        /// `sensitivity` 来自用户设置 `gestureSensitivity` —— 后者是必需的，
        /// 因为**鼠标硬件 DPI 读不到**，而用户说的"我 DPI 开得高"正在那一半。
        /// </summary>
        public void SetGestureTolerance(double gain, double sensitivity)
        {
            _tolerance = GestureTolerance.FromGain(gain, sensitivity);
        }

        /// <summary>v13：当前容差（诊断/自检用）。</summary>
        internal GestureTolerance DiagTolerance
        {
            get { return _tolerance; }
        }

        /// <summary>
        /// 按下之后的位移**记账**（唯一入口）。
        ///
        /// 容差用 <see cref="PetGesture.IsPatMove"/>（摸头的口径），
        /// **不是** <see cref="ClickMaxMovePx"/>（点击的 4px）—— 见调用点那段注释里
        /// 记的真 bug（4~6px 漂移会永久掐死长按计时器）。
        ///
        /// v13：容差不再是常量，而是 `_tolerance`（随指针增益 × 用户灵敏度放大）；
        /// 并且"是否还在容差内"变成**可恢复**的 `_holdStill`。
        ///
        /// ⚠️ 时刻必须由调用方给（**故意没有**读真实时钟的重载）：
        /// 自检用的是手工构造的时刻（`DiagPressAt(x, y, 0)` 从 0 开始），
        /// 若这里偷偷读 `ClockMs()`，自检里"按下时刻 0"与"真实时刻 5e6"
        /// 会混在一起，`PatLevel` 算出巨大负数 → 断言恒假。真实处理器与自检
        /// 必须走**同一条**路径，所以时刻只能从外面进来。
        ///
        /// 抽成方法是为了**可测**：它原先内联在 `OnMouseMove` 里，而无头自检
        /// 造不出真的 MouseMove 事件，所以"这里用错了阈值"没有任何断言能抓
        /// （回滚验证实测：改回 4px 仍然 264 全绿）。
        /// </summary>
        /// <param name="nowMs">本次移动的时刻。</param>
        private void TrackMove(double dx, double dy, double nowMs)
        {
            if (double.IsNaN(_pressScreen.X)) return;
            bool still = PetGesture.IsPatMove(dx, dy, _tolerance);

            // ── v13：容差是**可恢复**的，而不是一次性作废 ──────────────────────
            //
            // ⚠️⚠️ 这里修的是用户报的那个 bug 的另一半。
            //
            // 原先 `_movedSincePress` 一旦置位就永久为真，`OnHoldTick` 靠它
            // **停掉**长按计时器 —— 于是"手抖一下"等于"这次按住彻底作废"，
            // 哪怕手立刻回到原位。高指针增益（用户实测 1.5×）下容差只剩
            // 4px，一次正常的手抖就能触发，所以摸头大面积失灵。
            //
            // 现在分两种情形：
            //   · 手**刚回到**容差内（越界 → 稳回来）：把静止计时**从这一刻**
            //     重新起算。不重算的话，拖着桌宠走 3 秒再一停手会**立刻**跳到
            //     第 3 级 —— 那是"拖完顺手摸一把"，不是"按住不动"的本意。
            //   · 手一直在容差内：什么都不做，静止计时**继续累积**。
            //     ⚠️ 这一条不能少：若每次移动都重置，500Hz 鼠标下永远攒不满
            //     `PatMinMs`，摸头会从"偶尔不灵"变成"完全不可能触发"。
            if (still)
            {
                if (!_holdStill)
                {
                    _pressClockMs = nowMs;
                    // 面包屑：手**稳回来**了 —— 静止计时从这一刻重算（会推迟摸头）
                    PetBreadcrumb.Trace("移动回到容差内（位移 " + Fmt(Math.Sqrt(dx * dx + dy * dy)) +
                                        "px ≤ " + Fmt(_tolerance.PatMaxPx) +
                                        "px）→ 静止计时**从这一刻重算**（摸头会晚 " +
                                        "PatMinMs 才可能触发）");
                }
                _holdStill = true;
                return;
            }

            if (_holdStill)
            {
                // 面包屑：**刚越界**这一下（只记跳变，不是每次都记 —— 拖动时 125~500 次/秒）
                PetBreadcrumb.Trace("移动**越出**容差（位移 " + Fmt(Math.Sqrt(dx * dx + dy * dy)) +
                                    "px > " + Fmt(_tolerance.PatMaxPx) +
                                    "px）→ 手不在容差内，长按计时器暂停报级" +
                                    "（但仍继续跑，稳回来可恢复）");
            }
            _holdStill = false;
            // `_movedSincePress` 仍然是**一次性**的：它只用来排除"单击"，
            // 而"这次按下动过没有"这个事实不该因为手抖回来而消失
            //（否则拖了一大圈再松手会被算成一次打招呼）。
            if (!_movedSincePress) _movedSincePress = true;
            // ⚠️ `_patLevelReported` **故意不重置**：否则来回抖动就能反复刷级，
            // "一次按住最多 3 级"这条上限会被绕过。
        }

        // ------------------------------------------------------------------
        // v10：手势采样（抛掷速度）与长按计时（摸头）
        // ------------------------------------------------------------------

        /// <summary>
        /// 松手前的位置样本环形缓冲。
        ///
        /// 为什么需要它：抛掷的判据是**松手那一刻还在不在动**，而"位移 / 总时长"
        /// 算出来的是**整段平均速度** —— 慢慢拖了 3 秒、最后猛地一甩，平均速度
        /// 很低，该飞的时候飞不起来。反过来，快速拖到底再停住，平均速度很高，
        /// 不该飞的时候反而飞出去。只有"最近 100ms"才符合用户对"甩"的直觉。
        ///
        /// 8 个样本 × 约 16ms 一次 MouseMove ≈ 130ms 的覆盖，够装下
        /// `FlingWindowMs`(100) 那一窗。
        /// </summary>
        private readonly GestureSample[] _samples = new GestureSample[8];
        /// <summary>当前有效样本数（0..8；环形写入，满了就整体前移一位）。</summary>
        private int _sampleCount;

        /// <summary>按下时刻的**单调时钟**读数（ms）。用它而不是 `DateTime` 是为了不受系统时间调整影响。</summary>
        private double _pressClockMs;

        /// <summary>长按摸头：每 <see cref="PetGesture.PatStepMs"/> 检查一次是否该升级。</summary>
        private DispatcherTimer _holdTimer;
        /// <summary>本次按下**已经报过**的最高级（避免同一级重复上报）。</summary>
        private int _patLevelReported;

        /// <summary>抛掷动画进行中（期间吞掉鼠标输入，见 OnMouseLeftButtonDown）。</summary>
        private bool _flinging;
        /// <summary>抛掷回放用的帧计时器。</summary>
        private DispatcherTimer _flingTimer;
        /// <summary>当前回放的轨迹与游标。</summary>
        private FlingPlan _flingPlan;
        private int _flingIndex;

        /// <summary>
        /// 单调时钟（ms）。**高精度**，不是 `Environment.TickCount`。
        ///
        /// ⚠️ 为什么换掉 `TickCount`（实测证据）：它的粒度是 **15.625ms**
        /// （实测：连续读 1 秒只变化 64 次）。而抛掷判据要在
        /// `FlingWindowMs`(100ms) 窗口里算速度，窗口内的样本可能**全部落在
        /// 同一个 tick** → `dt == 0` → `FlingVelocity` 直接 return 0 →
        /// **判不出抛掷**。500Hz 以上的鼠标（8 个样本只跨 14ms）必然踩中；
        /// 125Hz 也会被量化成"跳着走"的锯齿速度。
        ///
        /// 这正是"日志里抛掷次数为 0"而自检全绿的原因：自检喂的是
        /// **手工构造的时间戳**（间隔 100ms），完全绕过了真实时钟的粒度 ——
        /// 纯函数测得再全，也测不出"喂给它的时钟本身是坏的"。
        ///
        /// `Stopwatch` 基于 QPC（实测 `IsHighResolution=True`，频率 10MHz
        /// = 亚微秒分辨率），且**同样是单调的**（保持原注释要的语义：
        /// 用户改系统时间 / NTP 校正不会让速度算出 ±10⁶ px/s 的荒唐值）。
        /// </summary>
        private static double ClockMs()
        {
            return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency;
        }

        /// <summary>清空速度样本（每次按下时调）。</summary>
        private void ResetSamples()
        {
            _sampleCount = 0;
        }

        /// <summary>追加一个位置样本（满了丢最旧的）。</summary>
        private void PushSample(double t, Point screen)
        {
            if (_sampleCount < _samples.Length)
            {
                _samples[_sampleCount] = new GestureSample(t, screen.X, screen.Y);
                _sampleCount++;
                return;
            }
            // 满了：整体前移一位，末尾放新样本（8 个元素，开销可忽略）。
            for (int i = 1; i < _samples.Length; i++) _samples[i - 1] = _samples[i];
            _samples[_samples.Length - 1] = new GestureSample(t, screen.X, screen.Y);
        }

        /// <summary>当前按下已持续多久（ms）；没在按下时返回 0。</summary>
        private int HeldMs()
        {
            if (_pressClockMs <= 0) return 0;
            return (int)(ClockMs() - _pressClockMs);
        }

        /// <summary>
        /// 长按检查的间隔（ms）。
        ///
        /// 取 `PatStepMs` 的**八分之一**（1200ms → 150ms，下限 120ms）。
        ///
        /// ⚠️ v13.1：原先取"一半"（步长 600ms 时是 300ms）。那时够用；
        /// 但步长拉到 1200ms 之后，"一半"变成 600ms，于是每一级都最多
        /// **晚 600ms** 才报（第 2 级 1550ms 的门槛要到 1800ms 才被发现）——
        /// 手感上就是"我按住不动，她过一会儿才反应"。
        ///
        /// 检查本身只是几次整数运算，150ms 一次的开销可以忽略；
        /// 换来的是"每一级都在该到的时刻附近到"。
        /// 取 1/8 而不是更细：更细没有额外收益（人眼分辨不出 <100ms 的差异），
        /// 只是白白多醒几次。
        ///
        /// ⚠️ 抽成方法（而不是写在 `StartHoldTimer` 里）是为了让自检能断言
        /// **真实的那个值** —— 抄一份到断言里的话，改坏了照样全绿。
        /// </summary>
        internal static int HoldTickIntervalMs()
        {
            int step = PetGesture.PatStepMs / 8;
            if (step < 120) step = 120;
            return step;
        }

        /// <summary>起长按计时器（每次按下）。</summary>
        private void StartHoldTimer()
        {
            StopHoldTimer();
            // v10：用户关掉了长按摸头 → 根本不起计时器（见 LongPressEnabled 的说明）。
            if (!_longPressEnabled) return;
            _holdTimer = new DispatcherTimer(DispatcherPriority.Input);
            _holdTimer.Interval = TimeSpan.FromMilliseconds(HoldTickIntervalMs());
            _holdTimer.Tick += OnHoldTick;
            _holdTimer.Start();
        }

        private void StopHoldTimer()
        {
            if (_holdTimer == null) return;
            try { _holdTimer.Stop(); } catch { }
            _holdTimer = null;
        }

        /// <summary>
        /// 长按检查的**唯一实现**（真实计时器与自检共用，**不是两份拷贝**）。
        ///
        /// ⚠️ 为什么必须抽出来（回滚验证 R4 抓到的真问题）：
        /// 我第一版让 `DiagHoldTick` 自己抄了一遍判定（`if (!_dragging ||
        /// _flinging || !_holdStill) return false; ...`），于是断言测的是**拷贝**、
        /// 产品走的是原件。回滚验证把 `OnHoldTick` 改回 `_movedSincePress`
        /// （= 手抖一次就停表，正是要修的 bug），自检**依然 279 全绿** ——
        /// 因为断言只驱动了那份拷贝。
        ///
        /// 这与 v12 的 `ResolveRelease` 是同一个教训：**两份判据可以互相掩护，
        /// 漂移了也看不出来**。所以长按判定只能有一份。
        /// </summary>
        /// <returns>该上报的级数；0 = 这次不上报。</returns>
        private int HoldTickCore(double nowMs)
        {
            if (!_dragging || _flinging) return 0;
            // 此刻手不在容差内（正在拖动/抖动）→ 这一轮不报级，但计时器继续跑。
            if (!_holdStill) return 0;
            int level = PetGesture.PatLevel((int)(nowMs - _pressClockMs));
            if (level <= _patLevelReported) return 0;
            _patLevelReported = level;
            return level;
        }

        /// <summary>
        /// 长按检查：够 <see cref="PetGesture.PatMinMs"/> 就升一级。
        ///
        /// ⚠️ v13 改了两处，都是为了修"高 DPI 下摸头失灵"：
        ///
        /// 1. 判据从 `_movedSincePress`（**一旦置位永久为真**）换成
        ///    `_holdStill`（**可恢复**）。原先手抖一下就把计时器**停掉**，
        ///    这次按住就彻底作废了；现在手抖只是把静止计时清零，稳回来继续。
        /// 2. 越界时**不再 `StopHoldTimer()`** —— 停了就永远醒不过来了，
        ///    而"手抖一下"在高增益鼠标上是常态。计时器空转的成本是每 300ms
        ///    一次空判断，远低于"摸头再也不灵"。
        /// </summary>
        private void OnHoldTick(object sender, EventArgs e)
        {
            int level = HoldTickCore(ClockMs());
            if (level <= 0) return;
            PetBreadcrumb.Trace("长按计时器报级 → 第 " + level + " 级摸头");
            try { PatInvoked(level); } catch { }
        }

        /// <summary>长按到第 <paramref name="level"/> 级（Program 装配成上报一次互动）。</summary>
        public Action<int> PatInvoked = delegate { };

        /// <summary>
        /// 长按摸头总开关（v10，来自 `settings.longPress`）。
        ///
        /// ⚠️ 关掉时**必须停掉计时器**，不能只是"上报前判一下"：
        /// 计时器每 300ms 醒一次、什么都不做是纯粹的耗电，而且
        /// "关掉开关后她还在后台数着级数"这种事一旦被发现就很难解释。
        /// </summary>
        private bool _longPressEnabled = true;
        public bool LongPressEnabled
        {
            get { return _longPressEnabled; }
            set
            {
                _longPressEnabled = value;
                if (!value) StopHoldTimer();
            }
        }

        /// <summary>
        /// 抛掷总开关（v10，来自 `settings.flingEnabled`）。
        ///
        /// 关掉之后**甩动会被当成普通拖动** —— 她直接停在松手的位置。
        /// 这正是"关掉"该有的语义：不是"甩了没反应"，而是"根本没有这个动作"。
        /// </summary>
        public bool FlingEnabled = true;

        // ------------------------------------------------------------------
        // v10：抛掷（预先算轨迹 → 回放）
        // ------------------------------------------------------------------

        /// <summary>
        /// 松手时的速度（px/s）。**纯计算**，阈值判定在 `PetGesture.Classify`。
        /// </summary>
        private double ReleaseSpeed()
        {
            return PetGesture.FlingSpeed(_samples, _sampleCount, ClockMs());
        }

        /// <summary>允许窗口左上角出现的范围（物理像素）。来自工作区，已扣除任务栏。</summary>
        private void WorkspaceBounds(out int minX, out int minY, out int maxX, out int maxY)
        {
            int w = (int)Math.Round(Width);
            int h = (int)Math.Round(Height);
            if (w <= 0) w = 1;
            if (h <= 0) h = 1;
            PetNative.WorkArea wa = PetNative.NearestScreen((int)Math.Round(Left), (int)Math.Round(Top));
            if (wa == null)
            {
                // 拿不到工作区（显示器拔了/枚举失败）→ 用"原地不动"这一格，
                // 保证 PlanFling 不会因为荒唐边界算出荒唐落点。
                int cx = (int)Math.Round(Left);
                int cy = (int)Math.Round(Top);
                minX = cx; minY = cy; maxX = cx; maxY = cy;
                return;
            }
            minX = wa.X;
            minY = wa.Y;
            maxX = wa.X + wa.W - w;
            maxY = wa.Y + wa.H - h;
        }

        /// <summary>
        /// 开始抛掷回放。
        ///
        /// @param vx,vy 初速（px/s，屏幕坐标系，y 向下为正）
        /// @returns 轨迹；调用方据 `HitEdge` 决定要不要额外给一次"撞墙"反应。
        /// </summary>
        private FlingPlan StartFling(double vx, double vy)
        {
            int minX, minY, maxX, maxY;
            WorkspaceBounds(out minX, out minY, out maxX, out maxY);

            FlingPlan plan = PetGesture.PlanFling(Left, Top, vx, vy, minX, minY, maxX, maxY);
            _flingPlan = plan;
            _flingIndex = 0;
            _flingHitEdge = plan.HitEdge;

            if (plan.Points.Count <= 1)
            {
                // 轨迹只有一个点（速度不够 / 数据坏）→ 不启动动画。
                // 这里**必须**返回而不是起一个空计时器：空计时器每 16ms 醒一次、
                // 什么都不做，是纯粹的耗电。
                return plan;
            }

            _flinging = true;
            StopHoldTimer();       // 飞行期间不该再有摸头计时
            ResetReact();          // 飞行期间不做抖动（与拖动同理）
            _flingTimer = new DispatcherTimer(DispatcherPriority.Render);
            _flingTimer.Interval = TimeSpan.FromMilliseconds(PetGesture.FlingStepMs);
            _flingTimer.Tick += OnFlingTick;
            _flingTimer.Start();
            return plan;
        }

        private void OnFlingTick(object sender, EventArgs e)
        {
            FlingPlan plan = _flingPlan;
            if (plan == null)
            {
                EndFling();
                return;
            }
            _flingIndex++;
            if (_flingIndex >= plan.Points.Count)
            {
                EndFling();
                return;
            }
            // 只改 Left/Top：窗口尺寸 == 精灵帧尺寸是**冻结不变量**，
            // 动画期间绝不碰 Width/Height/图像，否则会撕帧。
            ScreenPoint p = plan.Points[_flingIndex];
            try
            {
                Left = p.X;
                Top = p.Y;
                try { DragMoved(); } catch { }   // 气泡/输入窗跟着飞（与拖动同一条）
            }
            catch { EndFling(); }
        }

        /// <summary>
        /// 结束抛掷：停表、解锁、夹回工作区、上报最终位置。
        ///
        /// ⚠️ 顺序：先解锁 `_flinging` 再 `ReclampPosition` —— 反过来时
        /// `ReclampPosition` 内部若有任何"等鼠标"的分支会被闩锁挡住，
        /// 而那种失败是静默的（窗口停在屏幕外，用户只看到桌宠不见了）。
        /// </summary>
        private void EndFling()
        {
            _flinging = false;
            if (_flingTimer != null)
            {
                try { _flingTimer.Stop(); } catch { }
                _flingTimer = null;
            }
            _flingPlan = null;
            _flingIndex = 0;
            try { ReclampPosition(false); } catch { }
            try { FlingFinished(_flingHitEdge); } catch { }
            _flingHitEdge = false;
        }

        /// <summary>本次抛掷是否撞过边界（EndFling 上报时用）。</summary>
        private bool _flingHitEdge;

        /// <summary>抛掷结束（Program 装配成上报一次 `fling` 互动）。</summary>
        public Action<bool> FlingFinished = delegate { };

        /// <summary>取消进行中的抛掷（关闭/重载素材时用，避免计时器打到已释放的窗口）。</summary>
        private void CancelFling()
        {
            _flinging = false;
            if (_flingTimer != null)
            {
                try { _flingTimer.Stop(); } catch { }
                _flingTimer = null;
            }
            _flingPlan = null;
            _flingIndex = 0;
        }

        /// <summary>自检诊断：直接跑一次手势判定（与运行时同一实现）。</summary>
        internal static string DiagClassifyGesture(double dx, double dy, int ms, double speed)
        {
            return PetGesture.DiagClassify(dx, dy, ms, speed);
        }

        /// <summary>自检诊断：长按分级。</summary>
        internal static int DiagPatLevel(int heldMs)
        {
            return PetGesture.DiagPatLevel(heldMs);
        }

        /// <summary>
        /// 单击判定的两个阈值（**单位：物理像素 / 毫秒**）。
        ///
        /// v10 起真正的值在 `PetGesture`（手势判定的唯一真相），这里只留
        /// **同名别名**：窗口内部与 `SelfTest` 都在用这两个名字，而"两处各写
        /// 一份常量、靠人工同步"正是这类代码最容易腐烂的地方。
        ///
        /// 4px 的来历：手在按键时几乎必然有 1~2px 的抖动，阈值太小会把
        /// "点一下"判成"拖了一下"（用户会觉得点了没反应）。4px 在 150% DPI
        /// 下约 2.7 DIP，足够容纳抖动而不误判真拖动。
        ///
        /// ⚠️ 300ms 这条 v10 起**语义变了**：以前"按住超过 300ms"什么都不触发，
        /// 现在它是**长按摸头**的下界（`PetGesture.PatMinMs` = 350）。
        ///
        /// ⚠️⚠️ v12 修正：300~350 之间那 50ms 原先被写成"**故意的死区**"，
        /// 说"两个判据紧贴在一起时采样抖动会让人一会儿算点击、一会儿算长按"。
        /// **那个理由站不住**：这里两条判据本来就不冲突 —— 位移小 + 时间短 = 点击，
        /// 位移小 + 时间长 = 摸头，是**互斥且连续**的两段，中间留空只会造成
        /// "按了没反应"。用户实测踩中（按住 320ms 松手 → 什么都不发生）。
        /// 现在这 50ms 明确归入**单击**（见 `PetGesture.ClosesGapAsClick`），
        /// 两个常量本身不动（语义与既有断言都保留）。
        /// </summary>
        internal const double ClickMaxMovePx = PetGesture.ClickMaxMovePx;
        internal const int ClickMaxMs = PetGesture.ClickMaxMs;
        /// <summary>
        /// 摸头（长按）允许的最大位移。**必须严格宽于 `ClickMaxMovePx`** ——
        /// 见 `PetGesture.IsPatMove` 里记的那个真 bug（4~6px 漂移曾掐死摸头）。
        /// </summary>
        internal const double PatMaxMovePx = PetGesture.PatMaxMovePx;
        /// <summary>`Stopwatch` 是否是高精度计时源（自检用）。</summary>
        internal static bool DiagClockHighRes
        {
            get { return Stopwatch.IsHighResolution; }
        }

        /// <summary>读一次手势时钟（ms）。自检直接断言它的精度（见 `ClockMs`）。</summary>
        internal static double DiagClockMs()
        {
            return ClockMs();
        }

        // ── v12：把**真实接线**暴露给自检 ────────────────────────────────────
        //
        // 为什么需要这几个：回滚验证揭穿了一个尴尬事实 —— 我新加的断言
        // 测的全是**纯函数与常量**（`IsPatMove` / `ClosesGapAsClick` /
        // `PatLevelOnRelease`）。把**调用点**改回旧行为（错误的阈值、没有兜底、
        // 退回 TickCount），自检**依然 264 全绿**。也就是说那些断言能证明
        // "零件是对的"，却证明不了"零件被装上了"。
        //
        // 这几个 hook 直接驱动事件处理器用的**同一条代码路径**（不是平行副本），
        // 于是"装没装上"变成可断言的。

        /// <summary>
        /// 自检用：模拟按下（只做记账，不碰鼠标捕获 / 计时器）。
        /// 顺序与 <see cref="OnMouseLeftButtonDown"/> 一致。
        /// </summary>
        internal void DiagPressAt(double screenX, double screenY, double clockMs)
        {
            _dragging = true;
            _pressScreen = new Point(screenX, screenY);
            _movedSincePress = false;
            _holdStill = true;
            _patLevelReported = 0;
            _pressClockMs = clockMs;
            ResetSamples();
            PushSample(clockMs, _pressScreen);
        }

        /// <summary>自检用：喂一次鼠标移动的位移（走 `OnMouseMove` 的同一条记账）。</summary>
        internal void DiagMoveBy(double dx, double dy)
        {
            // 传 `_pressClockMs`（而不是真实时钟）：这个重载的语义是"位移发生了，
            // 但**不关心时刻**"。若传真实时钟，自检里"按下时刻 0"会被换成
            // 5e6 量级的真值，`PatLevel` 立刻算出负数 → 断言恒假。
            TrackMove(dx, dy, _pressClockMs);
        }

        /// <summary>
        /// v13 自检用：喂一次鼠标移动，并指定**本次移动的时刻**。
        ///
        /// 用它与 `DiagPressAt(x, y, t)` 配对，才能断言"越界清零静止计时、
        /// 稳回来继续报级"这条可恢复语义（见 `TrackMove` 的说明）。
        /// </summary>
        internal void DiagMoveAt(double dx, double dy, double nowMs)
        {
            TrackMove(dx, dy, nowMs);
        }

        /// <summary>自检用：位移是否已被记为"真的移动过"。</summary>
        internal bool DiagMovedSincePress
        {
            get { return _movedSincePress; }
        }

        /// <summary>
        /// 自检用：模拟一次长按计时器到期（走 `HoldTickCore` 的**同一条**判定）。
        ///
        /// ⚠️ 这里**必须**是薄壳，不能抄一份判定 —— 见 `HoldTickCore` 的说明
        /// （回滚验证 R4 抓到过：抄一份的后果是断言全绿而产品是坏的）。
        /// </summary>
        internal bool DiagHoldTick(double nowMs)
        {
            return HoldTickCore(nowMs) > 0;
        }

        /// <summary>v13 自检用：手此刻是否仍在"按住不动"的容差内。</summary>
        internal bool DiagHoldStill
        {
            get { return _holdStill; }
        }

        /// <summary>v13 自检用：设置容差（走与 Program 同一条 `SetGestureTolerance`）。</summary>
        internal void DiagSetTolerance(double gain, double sensitivity)
        {
            SetGestureTolerance(gain, sensitivity);
        }

        /// <summary>自检用：已上报到第几级。</summary>
        internal int DiagPatLevelReported
        {
            get { return _patLevelReported; }
        }

        /// <summary>松手时要做的动作（`ResolveRelease` 的返回值）。</summary>
        internal enum ReleaseAction { None, Click, Fling, Pat }

        /// <summary>
        /// 松手判定的**唯一实现**（事件处理器与自检共用，**不是两份拷贝**）。
        ///
        /// 为什么必须抽出来：我最初把自检用的 `DiagRelease` 写成了**平行拷贝**
        /// （又抄一遍判定链）。那正是本项目最贵的一类 bug —— 断言测拷贝、
        /// 产品走原件，两者一漂移就回到"测试全绿但功能坏"。回滚验证已经
        /// 证实过这个风险：4 条新断言里 3 条把调用点改回旧行为后仍然全绿。
        ///
        /// 现在两边都调这个函数，**没有第二份判据可以漂移**。
        /// </summary>
        internal ReleaseAction ResolveRelease(double dx, double dy, int elapsedMs,
                                              out int patLevel, out double speed)
        {
            patLevel = 0;
            speed = ReleaseSpeed();

            // ⚠️ 这里**故意不重复** `ClosesGapAsClick` —— 那条规则归 `Classify`
            // 独家所有（它是"手势判定的唯一真相"）。
            //
            // 我第一版在两层都写了一遍，回滚验证立刻暴露了代价：
            // 单独拆掉**任何一层**，另一层仍然把它判成 Click → 断言**不会变红**
            // → 回滚验证失效（B 与 B2 两条都 GREEN）。两份判据互相掩护，
            // 表面"纵深防御"，实际是"漂移了也看不出来"。
            //
            // 这里保留 `IsClickGesture` 只为一件事：`Classify` 在**坏数据**上
            // 会 try/catch 回落 Drag，而点击判定要能独立兜住那次异常。
            // 两者口径相同（同一个 `PetGesture.IsClick`），不构成第二套判据。
            bool isClick = !_movedSincePress && IsClickGesture(dx, dy, elapsedMs, _tolerance);

            PetGestureKind kind = PetGestureKind.Drag;
            try { kind = PetGesture.Classify(dx, dy, elapsedMs, speed, _tolerance); }
            catch { kind = PetGestureKind.Drag; }

            if (isClick || kind == PetGestureKind.Click) return ReleaseAction.Click;

            // v10：抛掷。`FlingEnabled` 为 false 时**什么都不做**（= 当作普通
            // 拖动，她停在松手的位置）。不是"飞了但不上报"—— 那会让用户看到
            // "关了开关她还在飞"，以为开关坏了。
            if (kind == PetGestureKind.Fling && FlingEnabled) return ReleaseAction.Fling;

            // v12：**摸头的松手兜底**。
            //
            // 原先摸头**完全**由长按计时器驱动（`OnHoldTick`），而松手路径只处理
            // Click 与 Fling —— **没有 Pat 分支**。于是只要计时器没走成（被漂移
            // 掐死、UI 线程被卡、消息循环刚好忙），`Classify` 明确判出 `Pat`，
            // 却**没有任何人响应**，用户松开手指什么都没有。
            //
            // 兜底规则：已经报过级就不重复（否则一次按住会上报两次），
            // 一级都没报过且时长够了就补第 1 级。
            if (kind == PetGestureKind.Pat && LongPressEnabled)
            {
                int back = PetGesture.PatLevelOnRelease(_patLevelReported, elapsedMs);
                if (back > 0) { patLevel = back; return ReleaseAction.Pat; }
            }

            return ReleaseAction.None;
        }

        /// <summary>
        /// 自检用：走**"移动消息发现左键已抬起"那条路径**的判定核心（v13.7 薄壳）。
        ///
        /// ⚠️ 必须是薄壳、不能抄判定 —— 这条路径原先**根本不判定**（直接 EndDrag），
        /// 而用户"鼠标拖触发不了"就是它。
        ///
        /// ⚠️⚠️ 而且**返回值不能是"回放算出来的应该是什么"**：我第一版这么做，
        /// 结果产品那条路径整个不判定（= 回到坏的行为）时，回放照样算出 "click"
        /// → 断言**依然全绿**（回滚 L1 就是这么绿的）。
        ///
        /// 所以这里**什么都不返回**，断言改为观察产品路径的**真实副作用**：
        ///   · 单击 → `DiagClickCount` 自增（`DispatchRelease` 里数的）
        ///   · 摸头 → `DiagPatCount` 自增
        ///   · 拖动 → 两个都不增，且 `_dragging` 被清
        /// 判据：**断言必须观察副作用，不能观察"我以为它会做什么"**。
        /// </summary>
        internal void DiagLostRelease(double dx, double dy, int elapsedMs)
        {
            OnLostReleaseCore(dx, dy, elapsedMs);
        }

        /// <summary>自检用：已上报的摸头次数（验"补判定真的报了摸头"）。</summary>
        internal int DiagPatCount { get { return _diagPatCount; } }

        private int _diagPatCount;

        /// <summary>自检用：当前是否还在拖动中（验"补判定真的收尾了"）。</summary>
        internal bool DiagDragging { get { return _dragging; } }

        /// <summary>自检用：本次会话已上报的点击次数（验"两条路径只结算一次"）。</summary>
        internal int DiagClickCount { get { return _diagClickCount; } }

        private int _diagClickCount;

        /// <summary>
        /// 自检用：走**事件处理器同款**的松手判定（`ResolveRelease` 薄壳）。
        /// 返回 `"click"` / `"fling"` / `"pat:N"` / `"none"`。
        ///
        /// `"none"` 就是用户看到的"点了/按了没反应"。
        /// </summary>
        internal string DiagRelease(double dx, double dy, int elapsedMs)
        {
            int patLevel;
            double speed;
            ReleaseAction a = ResolveRelease(dx, dy, elapsedMs, out patLevel, out speed);
            if (a == ReleaseAction.Pat) return "pat:" + patLevel;
            if (a == ReleaseAction.Click) return "click";
            if (a == ReleaseAction.Fling) return "fling";
            return "none";
        }

        /// <summary>
        /// 判定一次按下-抬起是否算"单击"。**纯函数**（自检直接断言，
        /// 不必真的模拟鼠标 —— 那在无头自检里做不到）。
        ///
        /// ⚠️ `double.IsNaN` 那行**不是冗余的**。
        /// 我一度以为它是（"NaN 参与比较都是 false，`<= 4` 本身就拒了"），
        /// 但那只对**当前**的写法成立。回退验证证明：把它删掉、同时把比较
        /// 写成 `!(dist > 4)`（一个看起来很自然的等价变形），NaN 就会**通过**
        /// —— 自检立刻失败 2 条。
        ///
        /// 所以这行的真正作用是把"算不出坐标时保守处理"这条**语义**写死，
        /// 而不是依赖某个具体比较运算符的 NaN 行为。
        /// `+Inf`/`-Inf` 同理：距离算出来是 Inf，`<= 4` 为 false，也走拒绝。
        /// </summary>
        internal static bool IsClickGesture(double dx, double dy, int elapsedMs)
        {
            // 单一真相在 `PetGesture.IsClick`（v10 起）—— 这里只转发。
            // 窗口里**不该**再出现第二套判据：手势从"只有一个"变成"四种"之后，
            // 抄一份的下场是"点一下"在抬起路径里算点击、在移动路径里算拖动。
            return PetGesture.IsClick(dx, dy, elapsedMs);
        }

        /// <summary>v13：同上，但用**指定的容差**（事件处理器走这一条）。</summary>
        internal static bool IsClickGesture(double dx, double dy, int elapsedMs, GestureTolerance tol)
        {
            return PetGesture.IsClick(dx, dy, elapsedMs, tol);
        }

        /// <summary>面包屑里格式化数字（C#5 没有字符串插值，统一走这里）。</summary>
        private static string Fmt(double v)
        {
            if (double.IsNaN(v)) return "NaN";
            if (double.IsInfinity(v)) return "Inf";
            return v.ToString("0.#", CultureInfo.InvariantCulture);
        }

        /// <summary>自检诊断用：直接跑一次判定。</summary>
        internal static bool DiagIsClick(double dx, double dy, int ms)
        {
            return IsClickGesture(dx, dy, ms);
        }

        // ------------------------------------------------------------------
        // task-6：滚轮缩放（悬停在桌宠本体上）
        // ------------------------------------------------------------------

        /// <summary>滚轮调整缩放后触发（UI 线程）；Program 挂接去抖上报 /pet/settings 与托盘刷新。</summary>
        public Action<double> ScaleAdjusted = delegate { };

        private void OnMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (e.Delta == 0) return;
            double ns = PetOptions.StepScale(_opt.Scale, e.Delta);
            e.Handled = true;
            if (Math.Abs(ns - _opt.Scale) < 0.001) return;   // 已到边界，不再动
            SetScale(ns);   // 内部：ApplySizeForSheet + ReclampPosition
            ScaleAdjusted(ns);
            PetLog.Info("滚轮缩放 → " + ns.ToString("0.##", CultureInfo.InvariantCulture));
        }

        private void OnMouseMove(object sender, MouseEventArgs e)
        {
            if (!_dragging) return;
            if (e.LeftButton != MouseButtonState.Pressed)
            {
                // v13.1：这条路径**绕过** `OnMouseLeftButtonUp`（鼠标在窗口外松开、
                // 或捕获丢失时，抬起事件根本不来，只能由移动事件发现"键已经不在了"）。
                // 摸头的压扁动画在这里也必须收尾，否则她会一直扁着 ——
                // 用户看到的是"她卡住了"，而不是"松手没反应"。
                //
                // ⚠️⚠️ v13.7：**这里必须补一次手势判定**，不能直接 `EndDrag()`。
                //
                // 用户实测（面包屑日志）：
                //   "我用触控板拖就能触发，鼠标拖基本上触发不了。"
                //
                // 日志把机制写得很清楚 —— 同一次按下，两种输入设备的**事件顺序不同**：
                //
                //   鼠标（失败）：
                //     21:40:57.299 按下 pos=(2224,444)
                //     21:40:57.400 移动越出容差（位移 10px > 9px）
                //     21:40:57.502 拖动结束 → 634,291     ← **这条路径**先跑
                //     21:40:57.504 松手但没有按下记录      ← 抬起事件白跑一趟
                //
                //   触控板（成功）：
                //     21:41:02.049 按下 pos=(1844,563)
                //     21:41:02.762 松手 dx=-711 dy=-104 ms=710 v=15720 → Fling
                //     21:41:02.763 拖动结束                ← 判定先跑，结束在后
                //
                // 鼠标抬起时，**移动消息先到**（`LeftButton` 已是 Released），
                // 于是这一支抢先 `EndDrag()` 并清掉 `_dragging`；
                // 紧接着真正的抬起消息到达，`OnMouseLeftButtonUp` 看到
                // `_dragging == false` 就**直接 return** —— 判定从来没跑过。
                // 触控板抬起时顺序相反（抬起消息先到），所以一直"能用"。
                //
                // 也就是说：**这条"兜底"路径把正常路径的活抢了，却不会判定手势** ——
                // 用户看到的是"拖一下没反应"（连拖动都不算，互动更是没有）。
                //
                // 修法：先按**与 `OnMouseLeftButtonUp` 完全相同**的判定链走一遍
                //（`ResolveRelease` 是单一真相，这里不重写判据），再收尾。
                ResolveAndDispatchOnLostRelease(e);
                e.Handled = true;
                return;
            }
            try
            {
                Point screen = PointToScreen(e.GetPosition(this));
                // v13：时刻**只读一次**，同时喂给速度样本与静止计时。
                // 读两次的话"样本时间"与"静止起点"会差一点点，而摸头的
                // 判级完全建立在后者上 —— 两个时刻来自同一次移动才自洽。
                double now = ClockMs();
                // v10：每个移动都进速度样本（抛掷判据的唯一数据来源）。
                PushSample(now, screen);
                // v12：**"按住不动"的容差必须与手势判定一致**。
                //
                // 这里原先调 `IsClickGesture(..., 0)`，也就是用**单击**的
                // `ClickMaxMovePx`(4px) 判"有没有动过"。而 `Classify` 判摸头用的
                // 是 `PatMaxMovePx`(6px) —— 两边不一致，4~6px 的漂移会让
                // `OnHoldTick` 永久停表（`if (_movedSincePress) StopHoldTimer()`），
                // 于是**明明判出摸头，却没人上报**。按住鼠标时手漂 4~6px 是常态，
                // 所以用户感觉"摸头大部分时候不灵"。
                //
                // 现在改调 `IsPatMove`（同一个 6px），并把"真的移动了"（用于
                // 排除单击）单独记为 `_movedSincePress`。
                //
                // ⚠️ 抽成 `TrackMove` 不是为了好看：这段判据**长在事件处理器里**
                // 时，无头自检根本造不出真的 MouseMove 事件 —— 于是"阈值用错了"
                // **没有任何断言能发现**。回滚验证证实了这点：我把这行改回
                // `IsClickGesture(..., 0)`，自检照样 264 全绿。抽出来之后，
                // 自检能直接驱动这段**真实接线**（见 `SelfTest` 的 v12 接线断言）。
                TrackMove(screen.X - _pressScreen.X, screen.Y - _pressScreen.Y, now);
                double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                Left = screen.X / dpi - _dragOffsetDip.X;
                Top = screen.Y / dpi - _dragOffsetDip.Y;
                // ⭐ 拖动**过程中**就通知（用户反馈"移动桌宠时气泡和输入框不跟着走"）。
                // 原先只有"拖动结束"（PositionReported → POST /pet/position）才通知，
                // 于是气泡/输入窗在整个拖动期间都杵在原地，松手才跳一下。
                try { DragMoved(); } catch { }
            }
            catch { }
            e.Handled = true;
        }

        /// <summary>
        /// v13.7：**在"移动消息发现左键已抬起"这条路径上补一次完整的手势判定**。
        ///
        /// 背景见 `OnMouseMove` 里那段注释：鼠标抬起时移动消息先到，于是
        /// `OnMouseMove` 的"键已松开"分支抢先 `EndDrag()`，把 `_dragging` 清掉；
        /// 真正的抬起消息随后到达时 `OnMouseLeftButtonUp` 直接 return ——
        /// **判定从来没跑过**。表现就是"鼠标拖基本上触发不了"。
        ///
        /// ⚠️ 这里**不重写判据**，而是走与 `OnMouseLeftButtonUp` **完全同一条**
        /// `FinishRelease`。本项目已经四次踩过"两份判据互相掩护、改坏一份仍全绿"
        ///（v12 `ResolveRelease`、v13 `HoldTickCore`、v13.1 `DispatchRelease`、
        ///  v13.6 面包屑接线），所以宁可把公共尾巴抽成方法，也不复制一段。
        ///
        /// 与抬起路径的唯一差别是**坐标来源**：
        /// 抬起路径有 `MouseButtonEventArgs`，这里只有 `MouseEventArgs`
        ///（`e.GetPosition(this)` 两者都有，所以用同一个取法）。
        /// </summary>
        private void ResolveAndDispatchOnLostRelease(MouseEventArgs e)
        {
            double dx = double.NaN;
            double dy = double.NaN;
            int elapsed = 0;
            try
            {
                Point now = PointToScreen(e.GetPosition(this));
                dx = now.X - _pressScreen.X;
                dy = now.Y - _pressScreen.Y;
                elapsed = (int)(DateTime.UtcNow - _pressAt).TotalMilliseconds;
            }
            catch { dx = double.NaN; dy = double.NaN; }

            // ⚠️ v13.7：真正的判定走 `OnLostReleaseCore`（可从三个数驱动、能被自检覆盖）。
            // 这里只负责**从事件里取坐标** —— 而"取坐标"是自检造不出来的部分
            //（`MouseEventArgs` 没有公开构造）。
            //
            // ⚠️⚠️ 但"移动消息发现键已抬起时该做什么"这个**决策**不能长在这里：
            // 回滚 L1（把这一行换回 `EndDrag()`、不判定 = 用户报的坏行为）
            // 曾经**全绿** —— 因为自检直接调 `OnLostReleaseCore`，绕过了本方法，
            // 于是"产品那条路径改坏了"根本没人测。
            // 现在决策收进 `LostReleaseDecision()`（纯函数），自检直接断言它 ——
            // 改坏这里必红。这是本项目第五次踩"判据长在事件处理器里"。
            if (LostReleaseDecision() == LostReleaseAction.JudgeGesture)
                OnLostReleaseCore(dx, dy, elapsed);
            else
                AbandonRelease();
        }

        /// <summary>"移动消息发现左键已抬起"时该做什么（v13.7）。</summary>
        internal enum LostReleaseAction
        {
            /// <summary>按完整手势链判定（v13.7 的正确行为）。</summary>
            JudgeGesture,
            /// <summary>只收尾、不判定（v13.1 的旧行为 = 用户报的"鼠标拖不动"）。</summary>
            Abandon
        }

        /// <summary>
        /// **决策**：移动消息发现左键已抬起时，是"判定手势"还是"只收尾"。
        ///
        /// ⚠️ 抽成纯函数是为了**能被自检钉住**（见 `ResolveAndDispatchOnLostRelease`
        /// 里回滚 L1 的说明）：判据长在事件处理器里 = 自检只能测拷贝。
        ///
        /// 必须判定，理由见 `OnMouseMove` 里那段日志分析：鼠标抬起时移动消息先到，
        /// 这条路径若只收尾，这次按下**永远不会被算成任何手势**。
        /// </summary>
        internal static LostReleaseAction LostReleaseDecision()
        {
            return LostReleaseAction.JudgeGesture;
        }

        /// <summary>只收尾、不判定（旧行为，保留给决策函数的另一支）。</summary>
        private void AbandonRelease()
        {
            try { PatEndInvoked(); } catch { }
            EndDrag();
        }

        /// <summary>
        /// "移动消息发现左键已抬起"的**判定核心**（v13.7）。
        ///
        /// ⚠️ 为什么要把坐标提取与判定分开：自检**造不出真的 MouseMove 事件**
        ///（`MouseEventArgs` 没有公开构造），所以判定必须能从"三个数"驱动，
        /// 否则断言只能测一份拷贝。
        ///
        /// 这与 v12 `ResolveRelease`、v13 `HoldTickCore`、v13.1 `DispatchRelease`、
        /// v13.6 `PetBreadcrumb.SetSink` 是同一个教训（第五次）：
        /// **判据长在事件处理器里 = 自检只能测拷贝 = 回滚验证失效**。
        /// </summary>
        private void OnLostReleaseCore(double dx, double dy, int elapsed)
        {
            PetBreadcrumb.Trace("移动消息发现**左键已抬起** → 走与抬起同一条判定链" +
                                "（鼠标抬起时移动消息先到，这条路径必须自己判定，" +
                                "否则这次按下永远不算手势）");
            FinishRelease(dx, dy, elapsed);
        }

        private void OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (!_dragging)
            {
                // 面包屑：抬起时**没有按下记录**（按下被吞了，或按下根本没落到她身上）
                PetBreadcrumb.Trace("松手但**没有按下记录**（_dragging=false）→ 不判定手势。" +
                                    "常见原因：按下时落在透明像素上 / 抛掷动画中 / 双击被吞");
                return;
            }
            // v9：先判定"这是点击还是拖动"，**再**结束拖动。
            // 顺序不能反：`EndDrag` 会清 `_dragging` 并 ReclampPosition，
            // 而点击判定要用按下时的坐标（不受 Reclamp 影响，但逻辑上先判更清楚）。
            double dx = double.NaN;
            double dy = double.NaN;
            int elapsed = 0;
            try
            {
                Point now = PointToScreen(e.GetPosition(this));
                dx = now.X - _pressScreen.X;
                dy = now.Y - _pressScreen.Y;
                elapsed = (int)(DateTime.UtcNow - _pressAt).TotalMilliseconds;
            }
            catch { dx = double.NaN; dy = double.NaN; }

            FinishRelease(dx, dy, elapsed);
            e.Handled = true;
        }

        /// <summary>
        /// 松手后的**公共尾巴**（v13.7 抽出）：判定 → 记录 → 收尾 → 分发。
        ///
        /// ⚠️ 必须**唯一**。原先这段长在 `OnMouseLeftButtonUp` 里，
        /// 而 v13.7 发现 `OnMouseMove` 那条"键已抬起"的路径也需要它 ——
        /// 那时如果抄一份，就会出现"两条路径判据漂移了也看不出来"
        ///（本项目已经四次踩过，见 `ResolveAndDispatchOnLostRelease` 的说明）。
        /// </summary>
        /// <param name="dx">按下到松手的屏幕位移（物理像素）</param>
        /// <param name="dy">同上（纵向）</param>
        /// <param name="elapsed">按下到松手的时长（ms）</param>
        private void FinishRelease(double dx, double dy, int elapsed)
        {
            // ⚠️ 幂等护栏：两条路径（抬起消息 / 移动消息发现键已抬起）**都可能**触发，
            // 而 `EndDrag()` 会把 `_dragging` 置 false —— 所以第二次进来时直接退出。
            //
            // 没有这道护栏的话，一次按下会**上报两次互动**（好感度也多算一次）。
            // 判据放在这里而不是各个调用点：这是"公共尾巴"，护栏也该只有一份。
            if (!_dragging)
            {
                PetBreadcrumb.Trace("松手判定被跳过：本次按下**已经结算过**（另一条路径先跑）");
                return;
            }

            // v10/v12：判定链收敛在 `ResolveRelease`（事件处理器与自检**同一份**）。
            // 速度必须在 `EndDrag` 之前取 —— 之后样本会被下一次按下清掉。
            int patLevel;
            double speed;
            ReleaseAction action = ResolveRelease(dx, dy, elapsed, out patLevel, out speed);

            // v13：**每一次松手都记一行真实数据**。
            //
            // ⚠️ 为什么必须加（这是本次诊断最大的障碍）：原先只有**成功**的手势
            // 才留日志（"单击桌宠" / "长按摸头" / "抛掷 v="），失败的那一次
            // 只有 `EndDrag` 那句"拖动结束 → x,y" —— **没有任何 dx/dy/时长**。
            // 于是"用户按了 54 次、只认了 4 次点击"这件事，在日志里完全看不出来：
            // 54 条"拖动结束"看起来就像 54 次正常的挪位置。
            //
            // 现在每次松手都带上真实位移/时长/速度/判定结果/当时用的容差，
            // 下次再有人报"手势不灵"，可以直接从数据读出阈值该定在哪，
            // 而不是像我这次一样靠猜。
            PetLog.Info("松手 dx=" + dx.ToString("0.#", CultureInfo.InvariantCulture) +
                        " dy=" + dy.ToString("0.#", CultureInfo.InvariantCulture) +
                        " ms=" + elapsed +
                        " v=" + speed.ToString("0", CultureInfo.InvariantCulture) +
                        " → " + action +
                        " [" + _tolerance.Describe() + "]");

            // v13.6：面包屑 —— **为什么**是这个结果（用户要的是这个，不是数字）。
            //
            // ⚠️ 解释必须在 `EndDrag()` **之前**算：`EndDrag` 会清 `_dragging`，
            // 而这里的 `_holdStill` / `_patLevelReported` 还是本次按下的真值。
            PetBreadcrumb.Trace("松手 dx=" + dx.ToString("0.#", CultureInfo.InvariantCulture) +
                                " dy=" + dy.ToString("0.#", CultureInfo.InvariantCulture) +
                                " ms=" + elapsed +
                                " v=" + speed.ToString("0", CultureInfo.InvariantCulture) +
                                " → " + action + "｜" +
                                PetBreadcrumb.Explain(dx, dy, elapsed, speed, _tolerance,
                                    _movedSincePress, _holdStill, _patLevelReported,
                                    LongPressEnabled, FlingEnabled));

            StopHoldTimer();
            _pressClockMs = 0;

            EndDrag();

            // ⚠️ v13.1：摸头的收尾放在 `finally` 里，**不是**放在 Pat 分支里。
            //
            // 三个理由，每一个都是会出错的具体路径：
            // ① 松手兜底（下面的 Pat 分支）会调 `PatInvoked` → `PlayPatHold`，
            //    也就是说"手已经抬起来了，却又开始一次按住"。收尾必须排在它**之后**，
            //    否则动画刚起就被收掉、或者反过来她一直扁着。
            // ② Click / Fling 两个分支都是 `return`，收尾写在后面就永远不执行。
            // ③ 用户可能"按住摸到 1 级 → 又拖走了"，那一按的 action 是 Drag，
            //    但压扁动画已经在播了。
            try
            {
                DispatchRelease(action, patLevel, speed);
            }
            finally
            {
                // `EndPatHold` 自己判"没在按住就直接返回"，所以无条件调用是安全的。
                try { PatEndInvoked(); } catch { }
            }
        }

        /// <summary>
        /// 松手后的动作分发（v13.1 抽出，**事件处理器与自检同一条路径**）。
        ///
        /// ⚠️ 为什么必须抽出来（回滚验证 R10 抓到过）：
        /// 原先这段逻辑**长在 `OnMouseLeftButtonUp` 里面**，而无头自检
        /// 造不出真的鼠标抬起事件 —— 于是"兜底走的是瞬时戳还是按住"
        /// **没有任何断言能发现**。我把兜底改回 `PatInvoked`（按住路径），
        /// 自检**照样全绿**，而真机上那次反应会**完全看不见**
        /// （动画刚起就被 `finally` 的 `EndPatHold` 按 1.0 收掉）。
        ///
        /// 这与 v12 的 `ResolveRelease`、v13 的 `HoldTickCore` 是同一个教训：
        /// **判据/分发长在事件处理器里 = 无法被自检覆盖**。
        /// </summary>
        private void DispatchRelease(ReleaseAction action, int patLevel, double speed)
        {
            if (action == ReleaseAction.Click)
            {
                _diagClickCount++;   // 自检用：验"两条松手路径只结算一次"
                try { ClickInvoked(); } catch { }
                return;
            }

            if (action == ReleaseAction.Fling)
            {
                // 初速方向取样本算出来的那一段（与判据同一个窗口，不会"判定用
                // 这一段、飞行用另一段"）。
                double vx, vy;
                ReleaseVelocity(out vx, out vy);
                PetLog.Info("抛掷 v=" + speed.ToString("0", CultureInfo.InvariantCulture) +
                            "px/s 方向=(" + vx.ToString("0", CultureInfo.InvariantCulture) + "," +
                            vy.ToString("0", CultureInfo.InvariantCulture) + ")");
                try { StartFling(vx, vy); } catch (Exception ex) { PetLog.Warn("抛掷失败: " + PetLog.Describe(ex)); }
                return;
            }

            // v12：**摸头的松手兜底**。
            //
            // 原先摸头**完全**由长按计时器驱动（`OnHoldTick`），而松手路径
            // 只处理 Click 与 Fling —— **没有 Pat 分支**。于是只要计时器没走成
            // （被漂移掐死、UI 线程被卡、消息循环刚好忙），`Classify` 明确判出
            // `Pat`，却**没有任何人响应**，用户松开手指什么都没有。
            //
            // 这不是理论风险：`d6c5bbe` 加的引导气泡在教"按住"，
            // 而用户报"手势没法正常触发"里最先被验证的就是这条。
            //
            // 兜底规则（`PatLevelOnRelease`）：已经报过级就不重复（否则一次
            // 按住会上报两次），一级都没报过且时长够了就补第 1 级。
            if (action == ReleaseAction.Pat)
            {
                _diagPatCount++;   // 自检用：验"补判定真的报了摸头"
                PetLog.Info("长按摸头 → 第 " + patLevel + " 级（松手兜底：计时器未上报）");
                // ⚠️ v13.1：兜底走 `PatBackstopInvoked`（瞬时戳），**不是**
                // `PatInvoked`（按住加深）。差别是实打实的：
                // 按下阶段根本没播过动画，而 `finally` 会立刻 `EndPatHold` ——
                // 走"按住"那条路的话，动画刚起就被按当前值（还是 1.0）收掉
                // → **用户什么都看不到**。旧代码在这条路径上是看得到的，
                // 所以这是防一次静默退化。
                try { PatBackstopInvoked(patLevel); } catch { }
            }
        }

        /// <summary>松手速度的**向量**（px/s）。与 <see cref="ReleaseSpeed"/> 同一个窗口。</summary>
        private void ReleaseVelocity(out double vx, out double vy)
        {
            vx = 0; vy = 0;
            PetGesture.FlingVelocity(_samples, _sampleCount, ClockMs(), out vx, out vy);
        }

        private void EndDrag()
        {
            _dragging = false;
            try { ReleaseMouseCapture(); } catch { }
            ReclampPosition(false);
            PetLog.Info("拖动结束 → " + (int)Math.Round(Left) + "," + (int)Math.Round(Top));
        }

        private void OnMouseRightButtonUp(object sender, MouseButtonEventArgs e)
        {
            PetBreadcrumb.Trace("右键抬起 → 弹菜单（左键手势与它无关，但排障时要知道这次按下是被右键吃掉的）");
            e.Handled = true;
            PetContextMenuRequested(this, e);
        }

        // ------------------------------------------------------------------
        // 供 Program 挂接的回调（托盘菜单复用）
        // ------------------------------------------------------------------

        public Action<PetWindow, MouseButtonEventArgs> PetContextMenuRequested =
            delegate(PetWindow w, MouseButtonEventArgs e) { };
        public Action FocusDshRequested = delegate { };
        /// <summary>task-6：双击本体（行为由 snapshot.settings.doubleClick 决定，Program 装配）。</summary>
        public Action DoubleClickInvoked = delegate { };
        /// <summary>
        /// v13.1：摸头**松手**（`PlayPatHold` 的配对收尾）。
        ///
        /// 与 `PatInvoked` 是两件事，**必须分开**：
        /// · `PatInvoked` = "摸到了第几级" → 上报互动（有冷却、有日上限、只报一次）
        /// · `PatEndInvoked` = "手抬起来了" → **纯动画收尾**（不上报、不计次）
        ///
        /// 合在一起的话，松手会被当成一次新的互动上报 ——
        /// 而 `pat` 与 `pet-head` 共用冷却与递减（见 Host 的 `interactions.js`），
        /// 一次按住就会把冷却刷两遍。
        /// </summary>
        public Action PatEndInvoked = delegate { };
        /// <summary>
        /// v13.1：摸头**松手兜底**（计时器没走成、松手时才补报）→ 瞬时戳一下。
        ///
        /// 与 `PatInvoked` 分开是必须的：那条路径按下期间没播过动画，
        /// 用"按住加深"会被随后的 `EndPatHold` 立刻收掉（见 `PlayPatPoke`）。
        /// </summary>
        public Action<int> PatBackstopInvoked = delegate { };
        /// <summary>
        /// v9：**单击**本体（与拖动区分开）。
        ///
        /// Program 装配成"记一次互动"（`POST /pet/interact {kind:'click'}`）。
        /// 判据见 `IsClickGesture`：位移 ≤4px **且** 时长 ≤300ms。
        /// </summary>
        public Action ClickInvoked = delegate { };

        // ------------------------------------------------------------------
        // 窗口消息
        // ------------------------------------------------------------------

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            switch (msg)
            {
                case PetNative.WM_NCHITTEST:
                    {
                        int sx = unchecked((short)(lParam.ToInt64() & 0xFFFF));
                        int sy = unchecked((short)((lParam.ToInt64() >> 16) & 0xFFFF));
                        Point client = PointFromScreen(new Point(sx, sy));
                        Point dip = new Point(client.X, client.Y);

                        // ⚠️ 这里**绝不能返回 HTCAPTION**（曾经这么干过，后果严重）：
                        // HTCAPTION 把整窗伪装成"标题栏"，Windows 便按标题栏语义处理鼠标 ——
                        // 拖动确实能用（系统帮着拖），但**滚轮消息不再派发给 WPF**，
                        // 于是 MouseWheel 永不触发（"大小调不了"），
                        // 点击/双击/悬停也一并被标题栏语义吞掉（"没法交互"）。
                        //
                        // 正确做法：返回 HTCLIENT 让 WPF 收到正常鼠标消息，
                        // 拖动由 OnMouseLeftButtonDown + CaptureMouse + OnMouseMove 自己做
                        //（那套逻辑本来就在，只是过去被 HTCAPTION 架空、从未执行）。
                        //
                        // 穿透语义分两层：
                        //   · **透明像素始终穿透**（HTTRANSPARENT）—— 核心体验，与设置无关；
                        //   · `clickThrough: true` = **连不透明处也穿透**（整窗纯装饰，不接收任何鼠标）。
                        // 两者都不能靠 HTCAPTION 实现（那会吞掉滚轮与点击，见上面的说明）。
                        //
                        // ⭐ 穿透时的**逃生门**：按住 Ctrl 悬停 → 临时恢复交互（可拖/可点/可滚轮）。
                        // 没有它，开了穿透就只能去托盘里改设置，用户会觉得自己被锁在外面。
                        bool escaped = _clickThrough && PetNative.IsCtrlDown();
                        bool solid = (!_clickThrough || escaped) && HitTestDip(dip);
                        if (solid)
                        {
                            handled = true;
                            return new IntPtr(PetNative.HTCLIENT);
                        }
                        handled = true;
                        return new IntPtr(PetNative.HTTRANSPARENT);
                    }

                case PetNative.WM_MOUSEACTIVATE:
                    // 点桌宠/按钮不要把用户的编辑器焦点抢走（按钮用 MouseLeftButtonUp 触发，仍能收到点击）
                    handled = true;
                    return new IntPtr(PetNative.MA_NOACTIVATE);

                case PetNative.WM_DISPLAYCHANGE:
                    Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate
                    {
                        ReclampPosition(false);
                        OnDisplayChanged();
                    }));
                    break;

                case PetNative.WM_DPICHANGED:
                    Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
                    {
                        // WPF 已按建议矩形处理；这里按新 DPI 重算逻辑尺寸与位置
                        if (_sheet != null) ApplySizeForSheet();
                        ReclampPosition(false);
                        OnDisplayChanged();
                    }));
                    break;

                case PetNative.WM_EXITSIZEMOVE:
                    Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(delegate
                    {
                        ReclampPosition(false);
                        ReportPosition();
                        OnDisplayChanged();
                    }));
                    break;
            }
            return IntPtr.Zero;
        }

        public Action OnDisplayChanged = delegate { };
    }
}