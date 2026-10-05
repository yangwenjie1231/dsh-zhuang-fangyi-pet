using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
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
            };
            MouseLeave += delegate(object s, MouseEventArgs e)
            {
                // 不立刻隐藏：给用户把手移到按钮上的时间（450ms 宽限）。
                HideSendBtnSoon();
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
            RestartTimer();
        }

        private void ShowFallback(string text)
        {
            _sheet = null;
            _image.Source = null;
            _image.Visibility = Visibility.Collapsed;
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

        public void SetBubbleVisibleState(bool visible)
        {
            if (visible) ShowPet(); else HidePet();
        }

        public void HidePet()
        {
            Hide();
            _timer.Stop();
        }

        public void ShowPet()
        {
            Show();
            RestartTimer();
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

        private void OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
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
            try { CaptureMouse(); } catch { }
            e.Handled = true;
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
                double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                Left = screen.X / dpi - _dragOffsetDip.X;
                Top = screen.Y / dpi - _dragOffsetDip.Y;
            }
            catch { }
            e.Handled = true;
        }

        private void OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (!_dragging) return;
            EndDrag();
            e.Handled = true;
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