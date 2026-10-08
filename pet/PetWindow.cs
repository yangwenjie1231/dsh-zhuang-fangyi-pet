using System;
using System.Collections.Generic;
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
                    // 摸头分级：越往上按得越深（1 级 0.6×、2 级 0.8×、3 级 1.0×）
                    double mul = level <= 1 ? 0.6 : (level == 2 ? 0.8 : 1.0);
                    depth *= mul;
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

        /// <summary>动画是否正在播（自检诊断用）。</summary>
        private bool _reactPlaying;

        /// <summary>自检诊断用：动画是否正在播。</summary>
        internal bool DiagReactPlaying { get { return _reactPlaying; } }

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
                e.Handled = true;
                return;
            }
            if (e.ClickCount == 2)
            {
                e.Handled = true;
                DoubleClickInvoked();   // task-6：行为由 settings.doubleClick 决定（Program 装配）
                return;
            }
            Point p = e.GetPosition(this);
            if (!HitTestDip(p)) return;

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

            // v10：手势采样与长按计时从这里开始。
            _pressClockMs = ClockMs();
            ResetSamples();
            PushSample(_pressClockMs, _pressScreen);
            _patLevelReported = 0;
            StartHoldTimer();

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
        /// 单调时钟（ms）。用 `Environment.TickCount` 而不是 `DateTime.Now`：
        /// 用户改系统时间 / NTP 校正时，后者会跳变，而速度是**差值** ——
        /// 跳变一次就能算出 ±10⁶ px/s 的荒唐速度，把一次普通点击判成抛掷。
        /// </summary>
        private static double ClockMs()
        {
            return (double)Environment.TickCount;
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

        /// <summary>起长按计时器（每次按下）。</summary>
        private void StartHoldTimer()
        {
            StopHoldTimer();
            // v10：用户关掉了长按摸头 → 根本不起计时器（见 LongPressEnabled 的说明）。
            if (!_longPressEnabled) return;
            _holdTimer = new DispatcherTimer(DispatcherPriority.Input);
            // 检查间隔取 PatStepMs 的一半：间隔等于步长时，抖动会让某一级
            // 被跳过（用户按住 1.2 秒只看到 1 级）。半速检查让每一级都稳。
            _holdTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(120, PetGesture.PatStepMs / 2));
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
        /// 长按检查：够 <see cref="PetGesture.PatMinMs"/> 就升一级。
        ///
        /// 只在**没移动过**（`_movedSincePress` 为 false）时才升级 —— 否则
        /// "按住慢慢挪"会一边挪位置一边刷摸头，那是两个手势叠在一起。
        /// </summary>
        private void OnHoldTick(object sender, EventArgs e)
        {
            if (!_dragging || _flinging || _movedSincePress)
            {
                // 已经不算"按住不动"了，计时器没必要继续跑。
                if (_movedSincePress) StopHoldTimer();
                return;
            }
            int level = PetGesture.PatLevel(HeldMs());
            if (level <= _patLevelReported) return;
            _patLevelReported = level;
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
        /// 300 与 350 之间那 50ms 是**故意的死区**：两个判据紧贴在一起时，
        /// 采样抖动会让同一次按下在两条路径里一会儿算点击、一会儿算长按。
        /// </summary>
        internal const double ClickMaxMovePx = PetGesture.ClickMaxMovePx;
        internal const int ClickMaxMs = PetGesture.ClickMaxMs;

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
                EndDrag();
                return;
            }
            try
            {
                Point screen = PointToScreen(e.GetPosition(this));
                // v10：每个移动都进速度样本（抛掷判据的唯一数据来源）。
                PushSample(ClockMs(), screen);
                // v9：记下"有没有真的移动过"（超过阈值就不算点击了）。
                if (!_movedSincePress &&
                    !double.IsNaN(_pressScreen.X) &&
                    IsClickGesture(screen.X - _pressScreen.X, screen.Y - _pressScreen.Y, 0) == false)
                {
                    _movedSincePress = true;
                }
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

        private void OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (!_dragging) return;
            // v9：先判定"这是点击还是拖动"，**再**结束拖动。
            // 顺序不能反：`EndDrag` 会清 `_dragging` 并 ReclampPosition，
            // 而点击判定要用按下时的坐标（不受 Reclamp 影响，但逻辑上先判更清楚）。
            bool isClick = false;
            double dx = double.NaN;
            double dy = double.NaN;
            int elapsed = 0;
            try
            {
                Point now = PointToScreen(e.GetPosition(this));
                dx = now.X - _pressScreen.X;
                dy = now.Y - _pressScreen.Y;
                elapsed = (int)(DateTime.UtcNow - _pressAt).TotalMilliseconds;
                isClick = !_movedSincePress && IsClickGesture(dx, dy, elapsed);
            }
            catch { isClick = false; }

            // v10：手势判定要在**样本还完整**的时候算 —— `EndDrag` 之后
            // 这些样本会被下一次按下清掉。
            double speed = ReleaseSpeed();
            PetGestureKind kind = PetGestureKind.Drag;
            try
            {
                kind = PetGesture.Classify(dx, dy, elapsed, speed);
            }
            catch { kind = PetGestureKind.Drag; }

            StopHoldTimer();
            _pressClockMs = 0;

            EndDrag();
            e.Handled = true;

            // 单击保持原有语义（`_movedSincePress` 已经把"拖过"排除了）。
            if (isClick || kind == PetGestureKind.Click)
            {
                try { ClickInvoked(); } catch { }
                return;
            }

            // v10：抛掷。**只有**在拖动真的发生过、且速度达标时才飞 ——
            // `Classify` 已经在坏数据上回落 Click/Drag，这里不再重复判断。
            //
            // ⚠️ `FlingEnabled` 为 false 时**什么都不做**（= 当作普通拖动，
            // 她停在松手的位置）。不是"飞了但不上报" —— 那会让用户看到
            // "关了开关她还在飞"，以为开关坏了。
            if (kind == PetGestureKind.Fling && FlingEnabled)
            {
                // 初速方向取样本算出来的那一段（与判据同一个窗口，不会"判定用
                // 这一段、飞行用另一段"）。
                double vx, vy;
                ReleaseVelocity(out vx, out vy);
                PetLog.Info("抛掷 v=" + speed.ToString("0", CultureInfo.InvariantCulture) +
                            "px/s 方向=(" + vx.ToString("0", CultureInfo.InvariantCulture) + "," +
                            vy.ToString("0", CultureInfo.InvariantCulture) + ")");
                try { StartFling(vx, vy); } catch (Exception ex) { PetLog.Warn("抛掷失败: " + PetLog.Describe(ex)); }
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