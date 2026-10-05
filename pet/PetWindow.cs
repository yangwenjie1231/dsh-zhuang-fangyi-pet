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

            Content = _root;

            _timer = new DispatcherTimer(DispatcherPriority.Render);
            _timer.Tick += OnTick;

            MouseLeftButtonDown += OnMouseLeftButtonDown;
            MouseMove += OnMouseMove;
            MouseLeftButtonUp += OnMouseLeftButtonUp;
            MouseRightButtonUp += OnMouseRightButtonUp;
            MouseWheel += OnMouseWheel;   // task-6：悬停滚轮缩放

            Loaded += OnLoaded;
            Closing += OnClosing;
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

        private bool HitTestDip(Point p)
        {
            if (!_clickThrough) return true;
            if (_sheet == null)
            {
                // 兜底块：整个矩形都算实体
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
                        double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                        if (dpi <= 0) dpi = 1.0;
                        Point dip = new Point(client.X, client.Y);

                        if (!_clickThrough)
                        {
                            // 穿透关闭：整窗可点可拖（无边框窗用 HTCAPTION 换取系统拖动）
                            handled = true;
                            return new IntPtr(PetNative.HTCAPTION);
                        }

                        if (HitTestDip(dip))
                        {
                            handled = true;
                            return new IntPtr(PetNative.HTCLIENT);
                        }
                        handled = true;
                        return new IntPtr(PetNative.HTTRANSPARENT);
                    }

                case PetNative.WM_MOUSEACTIVATE:
                    // 点桌宠不要把用户的编辑器焦点抢走
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