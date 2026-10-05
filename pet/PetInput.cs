using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// task-7：发消息输入窗（悬停 ✎ 打开）。
    /// 无边框/置顶/SizeToContent，出现在桌宠附近；Enter 发送、Esc 取消、失焦自动关闭。
    /// 失败**不关窗、不清输入**，就地显示错误；成功关闭并由 Program 用气泡提示「已发送」。
    /// 纯展示 + 单次发送，不做排队/打断（排队语义在 Host 侧 followup）。
    /// </summary>
    internal sealed class PetInput : Window
    {
        private readonly TextBox _box;
        private readonly TextBlock _hint;
        private readonly Border _chrome;

        private readonly PetHttp _http;
        private readonly Dispatcher _ui;

        private IntPtr _hwnd;
        private bool _sending;
        private bool _reallyClosing;

        /// <summary>发送成功（HTTP 2xx）后回调一次（Program 用气泡显示「已发送」）。</summary>
        public Action Sent = delegate { };
        /// <summary>窗关闭回调（Program 用来清 ✎ 的打开标记）。</summary>
        public Action Closed2 = delegate { };

        public PetInput(PetHttp http)
        {
            _http = http;
            _ui = Dispatcher.CurrentDispatcher;

            Title = "DSH 庄方宜桌宠-发送";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            ShowActivated = true;
            SizeToContent = SizeToContent.WidthAndHeight;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _box = new TextBox();
            _box.FontSize = 14;
            _box.MinWidth = 260;
            _box.Margin = new Thickness(12, 10, 12, 4);
            _box.VerticalContentAlignment = VerticalAlignment.Center;
            // 占位提示：无字时显示（TextBox 原生没有 placeholder，用 Tag+灰字绘制太重，这里用提示行+样式兜底）
            _box.KeyDown += OnBoxKeyDown;
            _box.TextChanged += delegate { SetHint(); };

            _hint = new TextBlock();
            _hint.Text = "Enter 发送 · Esc 取消";
            _hint.FontSize = 11;
            _hint.Foreground = new SolidColorBrush(Color.FromArgb(160, 90, 100, 120));
            _hint.Margin = new Thickness(14, 0, 14, 8);

            _chrome = new Border();
            _chrome.CornerRadius = new CornerRadius(10);
            _chrome.Padding = new Thickness(0);
            _chrome.Background = new SolidColorBrush(Color.FromArgb(246, 252, 252, 254));
            _chrome.BorderBrush = new SolidColorBrush(Color.FromArgb(200, 120, 160, 220));
            _chrome.BorderThickness = new Thickness(1);
            try
            {
                System.Windows.Media.Effects.DropShadowEffect sh = new System.Windows.Media.Effects.DropShadowEffect();
                sh.BlurRadius = 12;
                sh.ShadowDepth = 2;
                sh.Opacity = 0.4;
                sh.Color = Colors.Black;
                _chrome.Effect = sh;
            }
            catch { }
            StackPanel sp = new StackPanel();
            sp.Children.Add(_box);
            sp.Children.Add(_hint);
            _chrome.Child = sp;
            Content = _chrome;

            Loaded += OnLoaded;
            Deactivated += delegate { CloseSelf(); };
            Closed += delegate
            {
                _reallyClosing = true;
                Action c = Closed2;
                if (c != null) { try { c(); } catch { } }
            };
            PreviewKeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.Key == Key.Escape) { e.Handled = true; CloseSelf(); }
            };
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            if (_hwnd != IntPtr.Zero)
            {
                int ex = PetNative.GetWindowLong(_hwnd, PetNative.GWL_EXSTYLE);
                PetNative.SetWindowLong(_hwnd, PetNative.GWL_EXSTYLE, ex | PetNative.WS_EX_TOOLWINDOW);
            }
            _box.Focus();
            SetHint();
        }

        /// <summary>打开并定位到桌宠附近（默认桌宠上方，clamp 进工作区）。</summary>
        public void OpenNear(int petX, int petY, int petW, int petH)
        {
            if (IsVisible) { _box.Focus(); _box.SelectAll(); return; }
            _sending = false;
            _box.Clear();
            SetHint();
            Show();

            // 先 Show 出真实尺寸再定位（SizeToContent 之后 ActualWidth 才有值）
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
            {
                double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                int w = (int)Math.Round(ActualWidth * dpi);
                int h = (int)Math.Round(ActualHeight * dpi);
                if (w <= 0) w = 300;
                if (h <= 0) h = 70;

                // 默认贴在桌宠正上方 8px；放不下 → 桌宠下方；再 clamp 进工作区
                int x = petX + petW / 2 - w / 2;
                int y = petY - h - 8;
                PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
                if (y < scr.Y + 4) y = petY + petH + 8;
                int maxX = scr.Right - w - 4;
                if (maxX < scr.X + 4) maxX = scr.X + 4;
                if (x > maxX) x = maxX;
                if (x < scr.X + 4) x = scr.X + 4;
                if (y + h > scr.Bottom - 4) y = scr.Bottom - h - 4;

                Left = x / dpi;
                Top = y / dpi;
                _box.Focus();
            }));
        }

        private void SetHint()
        {
            int n = _box.Text == null ? 0 : _box.Text.Length;
            if (n > 0)
                _hint.Text = n.ToString(CultureInfo.InvariantCulture) + " / " +
                             PetHttp.SendTextMax.ToString(CultureInfo.InvariantCulture) + " · Enter 发送 · Esc 取消";
            else
                _hint.Text = "发给庄方宜…（Enter 发送 · Esc 取消）";
        }

        private void OnBoxKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Enter) return;
            e.Handled = true;
            SendNow();
        }

        private void SendNow()
        {
            if (_sending) return;
            string text = _box.Text;
            // exe 侧预校验（与 Host 准入一致）：空不发；超长就地提示（窗口不关、字不丢）
            string pre = PetHttp.ValidateSendText(text);
            if (pre != null)
            {
                _hint.Text = pre == "too-long"
                    ? "太长了（上限 " + PetHttp.SendTextMax.ToString(CultureInfo.InvariantCulture) + " 字）"
                    : "先写点内容再发";
                _hint.Foreground = new SolidColorBrush(Colors.IndianRed);
                return;
            }

            _sending = true;
            _hint.Foreground = new SolidColorBrush(Color.FromArgb(160, 90, 100, 120));
            _hint.Text = "发送中…";
            _box.IsEnabled = false;
            _http.PostSend(text, delegate(int status, string body)
            {
                // 线程池线程 → 切回 UI
                _ui.BeginInvoke(DispatcherPriority.Normal, new Action(delegate { OnSendDone(status, body); }));
            });
        }

        private void OnSendDone(int status, string body)
        {
            _sending = false;
            _box.IsEnabled = true;
            if (status >= 200 && status < 300)
            {
                CloseSelf();
                Action s = Sent;
                if (s != null) { try { s(); } catch { } }
                return;
            }
            // 失败：窗口不关、输入不清，就地报错
            _hint.Foreground = new SolidColorBrush(Colors.IndianRed);
            _hint.Text = DescribeSendError(status, body);
            _box.Focus();
        }

        /// <summary>纯函数：把 /pet/send 的失败响应翻成给用户看的一句话（SelfTest 断言）。</summary>
        public static string DescribeSendError(int status, string body)
        {
            if (status == 0) return "发不出去（连不上宿主）";
            if (status == 401 || status == 403) return "鉴权失败，请重开桌宠";
            if (status == 409) return "没有正在进行的会话";
            if (status == 503) return "宿主暂时不能收消息";
            if (status == 400)
            {
                if (!string.IsNullOrEmpty(body) && body.IndexOf("too-long", StringComparison.Ordinal) >= 0)
                    return "太长了（上限 " + PetHttp.SendTextMax.ToString(CultureInfo.InvariantCulture) + " 字）";
                return "内容不合法";
            }
            return "发送失败（HTTP " + status.ToString(CultureInfo.InvariantCulture) + "）";
        }

        private void CloseSelf()
        {
            if (_reallyClosing) return;
            try { Close(); } catch { }
        }
    }
}
