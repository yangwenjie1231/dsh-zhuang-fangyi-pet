using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 托盘图标 + 右键菜单：显示/隐藏、点击穿透开关、缩放档位、重置位置、退出。
    /// 图标是**运行时绘制**的（不依赖任何 .ico 资源文件，保证 exe 零资源依赖）。
    /// </summary>
    internal sealed class PetTray : IDisposable
    {
        private NotifyIcon _icon;
        private ContextMenuStrip _menu;
        private Icon _ownedIcon;
        private IntPtr _hicon = IntPtr.Zero;

        private ToolStripMenuItem _miVisible;
        private ToolStripMenuItem _miClickThrough;
        private ToolStripMenuItem _miTopmost;
        private ToolStripMenuItem _miBubble;
        private readonly List<ToolStripMenuItem> _scaleItems = new List<ToolStripMenuItem>();
        private readonly List<ToolStripMenuItem> _themeItems = new List<ToolStripMenuItem>();
        private readonly List<ToolStripMenuItem> _statusItems = new List<ToolStripMenuItem>();

        public Action ToggleVisible = delegate { };
        public Action<bool> SetClickThrough = delegate { };
        public Action<bool> SetTopmost = delegate { };
        public Action<double> SetScale = delegate { };
        public Action ResetPosition = delegate { };
        public Action FocusDsh = delegate { };
        /// <summary>打开表情包画廊（托盘入口）。</summary>
        public Action OpenGallery = delegate { };
        public Action Quit = delegate { };
        public Func<bool> IsVisible = delegate { return true; };
        public Func<bool> GetClickThrough = delegate { return true; };
        public Func<double> GetScale = delegate { return 1.0; };
        /// <summary>深浅色主题（'auto' | 'light' | 'dark'）；贴纸与气泡外壳一起换。</summary>
        public Action<string> SetTheme = delegate { };
        public Func<string> GetTheme = delegate { return "auto"; };
        /// <summary>状态显示模式：'hint'（悬停）| 'always'（常显）| 'off'。</summary>
        public Action<string> SetStatusMode = delegate { };
        public Func<string> GetStatusMode = delegate { return "hint"; };

        // ── 番茄钟（用户点名："增加番茄钟提醒我休息"）─────────────────────────
        //
        // 为什么番茄钟控制放托盘而不是只放设置页：设置页在 DSH 窗口里，
        // 而番茄钟是"我要专注了"这个瞬间的动作 —— 让用户切到 DSH 里点开关
        // 本身就是打断专注。托盘是桌面上随时可及的那个入口。
        /// <summary>开始/暂停切换。</summary>
        public Action TogglePomodoro = delegate { };
        /// <summary>跳过当前阶段。</summary>
        public Action SkipPomodoro = delegate { };
        /// <summary>重置回第一轮专注。</summary>
        public Action ResetPomodoro = delegate { };
        /// <summary>总开关（持久化到设置）。</summary>
        public Action<bool> SetPomodoroEnabled = delegate { };
        /// <summary>倒计时是否常显（持久化到设置）。</summary>
        public Action<bool> SetPomodoroCountdown = delegate { };
        /// <summary>取当前番茄钟状态摘要（菜单标题上显示"专注 24:59"）。</summary>
        public Func<string> GetPomodoroSummary = delegate { return ""; };
        public Func<bool> GetPomodoroRunning = delegate { return false; };
        public Func<bool> GetPomodoroEnabled = delegate { return false; };
        public Func<bool> GetPomodoroCountdown = delegate { return true; };

        private ToolStripMenuItem _miPomodoro;
        private ToolStripMenuItem _miPomodoroToggle;
        private ToolStripMenuItem _miPomodoroSkip;
        private ToolStripMenuItem _miPomodoroReset;
        private ToolStripMenuItem _miPomodoroEnabled;
        private ToolStripMenuItem _miPomodoroCountdown;

        public bool BubbleToggleEnabled = true;
        public Action<bool> SetBubble = delegate { };
        public Func<bool> GetBubble = delegate { return true; };

        public void Install()
        {
            _menu = new ContextMenuStrip();
            _menu.ShowImageMargin = false;

            _miVisible = new ToolStripMenuItem("隐藏桌宠(&H)");
            _miVisible.Click += delegate { ToggleVisible(); Refresh(); };
            _menu.Items.Add(_miVisible);

            _miClickThrough = new ToolStripMenuItem("点击穿透（透明处穿透）");
            _miClickThrough.Click += delegate
            {
                bool want = !GetClickThrough();
                SetClickThrough(want);
                Refresh();
            };
            _menu.Items.Add(_miClickThrough);

            _miTopmost = new ToolStripMenuItem("总在最前(&T)");
            _miTopmost.Click += delegate { SetTopmost(!_miTopmost.Checked); Refresh(); };
            _menu.Items.Add(_miTopmost);

            _miBubble = new ToolStripMenuItem("显示气泡(&B)");
            _miBubble.Click += delegate { SetBubble(!GetBubble()); Refresh(); };
            _menu.Items.Add(_miBubble);

            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem scale = new ToolStripMenuItem("缩放(&S)");
            double[] steps = new double[] { 0.5, 0.75, 1.0, 1.25, 1.5, 2.0 };
            for (int i = 0; i < steps.Length; i++)
            {
                double s = steps[i];
                ToolStripMenuItem it = new ToolStripMenuItem((int)Math.Round(s * 100) + "%");
                it.Tag = s;
                it.Click += delegate(object sender, EventArgs e)
                {
                    ToolStripMenuItem mi = sender as ToolStripMenuItem;
                    if (mi == null) return;
                    SetScale((double)mi.Tag);
                    Refresh();
                };
                _scaleItems.Add(it);
                scale.DropDownItems.Add(it);
            }
            _menu.Items.Add(scale);

            ToolStripMenuItem reset = new ToolStripMenuItem("重置位置(&R)");
            reset.Click += delegate { ResetPosition(); };
            _menu.Items.Add(reset);

            // 深浅色主题：贴纸 + **气泡外壳**一起换。
            // 为什么放托盘：开着"点击穿透"时桌宠收不到任何鼠标，托盘是唯一入口 ——
            // 换主题不该逼用户先去关穿透、再开设置页。
            ToolStripMenuItem theme = new ToolStripMenuItem("深浅色主题(&C)");
            string[] themeKeys = new string[] { "auto", "light", "dark" };
            string[] themeNames = new string[] { "自动跟随系统", "浅色（白底）", "深色（黑底）" };
            for (int i = 0; i < themeKeys.Length; i++)
            {
                string key = themeKeys[i];
                ToolStripMenuItem it = new ToolStripMenuItem(themeNames[i]);
                it.Tag = key;
                it.Click += delegate(object sender, EventArgs e)
                {
                    ToolStripMenuItem mi = sender as ToolStripMenuItem;
                    if (mi == null) return;
                    SetTheme((string)mi.Tag);
                    Refresh();
                };
                _themeItems.Add(it);
                theme.DropDownItems.Add(it);
            }
            _menu.Items.Add(theme);

            // 状态显示：自动（hint）/ 常显 / 关闭。
            // 放托盘的理由与主题一致：开着点击穿透时本体收不到鼠标，托盘是唯一入口。
            ToolStripMenuItem showStatus = new ToolStripMenuItem("显示状态(&S)");
            string[] statusKeys = new string[] { "hint", "always", "off" };
            string[] statusNames = new string[] { "悬停时显示", "一直显示（下方常驻）", "不显示" };
            for (int i = 0; i < statusKeys.Length; i++)
            {
                string key = statusKeys[i];
                ToolStripMenuItem it = new ToolStripMenuItem(statusNames[i]);
                it.Tag = key;
                it.Click += delegate(object sender, EventArgs e)
                {
                    ToolStripMenuItem mi = sender as ToolStripMenuItem;
                    if (mi == null) return;
                    SetStatusMode((string)mi.Tag);
                    Refresh();
                };
                _statusItems.Add(it);
                showStatus.DropDownItems.Add(it);
            }
            _menu.Items.Add(showStatus);

            ToolStripMenuItem gallery = new ToolStripMenuItem("表情包…(&G)");
            gallery.Click += delegate { OpenGallery(); };
            _menu.Items.Add(gallery);

            // ── 番茄钟 ──────────────────────────────────────────────────────
            //
            // 菜单**标题带实时倒计时**（"番茄钟 · 专注 24:59"），这样不打开子菜单
            // 也能一眼看到还剩多久 —— 用户开这个功能就是为了"知道还剩多久"。
            _miPomodoro = new ToolStripMenuItem("番茄钟(&P)");
            _miPomodoro.DropDownOpening += delegate { Refresh(); };

            _miPomodoroToggle = new ToolStripMenuItem("开始专注(&S)");
            _miPomodoroToggle.Click += delegate { TogglePomodoro(); Refresh(); };
            _miPomodoro.Add(_miPomodoroToggle);

            _miPomodoroSkip = new ToolStripMenuItem("跳过当前阶段(&K)");
            _miPomodoroSkip.Click += delegate { SkipPomodoro(); Refresh(); };
            _miPomodoro.Add(_miPomodoroSkip);

            _miPomodoroReset = new ToolStripMenuItem("重置(&R)");
            _miPomodoroReset.Click += delegate { ResetPomodoro(); Refresh(); };
            _miPomodoro.Add(_miPomodoroReset);

            _miPomodoro.DropDownItems.Add(new ToolStripSeparator());

            _miPomodoroEnabled = new ToolStripMenuItem("启用番茄钟");
            _miPomodoroEnabled.Click += delegate { SetPomodoroEnabled(!GetPomodoroEnabled()); Refresh(); };
            _miPomodoro.Add(_miPomodoroEnabled);

            _miPomodoroCountdown = new ToolStripMenuItem("显示倒计时");
            _miPomodoroCountdown.Click += delegate { SetPomodoroCountdown(!GetPomodoroCountdown()); Refresh(); };
            _miPomodoro.Add(_miPomodoroCountdown);

            _menu.Items.Add(_miPomodoro);

            ToolStripMenuItem focus = new ToolStripMenuItem("打开 DSH 窗口(&D)");
            focus.Click += delegate { FocusDsh(); };
            _menu.Items.Add(focus);

            _menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem quit = new ToolStripMenuItem("退出桌宠(&X)");
            quit.Click += delegate { Quit(); };
            _menu.Items.Add(quit);

            _icon = new NotifyIcon();
            _icon.Text = "DSH 庄方宜桌宠";
            try
            {
                _ownedIcon = BuildIcon();
                _icon.Icon = _ownedIcon;
            }
            catch (Exception ex)
            {
                PetLog.Warn("托盘图标生成失败: " + PetLog.Describe(ex));
            }
            _icon.ContextMenuStrip = _menu;
            _icon.Visible = true;
            _icon.DoubleClick += delegate { ToggleVisible(); Refresh(); };

            Refresh();
            PetLog.Startup("托盘图标已安装");
        }

        public void Refresh()
        {
            try
            {
                if (_miVisible != null) _miVisible.Text = IsVisible() ? "隐藏桌宠(&H)" : "显示桌宠(&H)";
                if (_miClickThrough != null) _miClickThrough.Checked = GetClickThrough();
                if (_miTopmost != null) _miTopmost.Checked = true; // 由 SetTopmost 的真实值覆盖于下
                if (_miBubble != null)
                {
                    _miBubble.Checked = GetBubble();
                    _miBubble.Enabled = BubbleToggleEnabled;
                }
                double cur = GetScale();
                for (int i = 0; i < _scaleItems.Count; i++)
                {
                    double s = (double)_scaleItems[i].Tag;
                    _scaleItems[i].Checked = Math.Abs(s - cur) < 0.001;
                }
                string sm = GetStatusMode();
                for (int i = 0; i < _statusItems.Count; i++)
                {
                    string k = _statusItems[i].Tag as string;
                    _statusItems[i].Checked = string.Equals(k, sm, StringComparison.Ordinal);
                }
                string th = GetTheme();
                for (int i = 0; i < _themeItems.Count; i++)
                {
                    string k = _themeItems[i].Tag as string;
                    _themeItems[i].Checked = string.Equals(k, th, StringComparison.Ordinal);
                }

                // 番茄钟：标题带实时摘要，勾选反映真实状态。
                //
                // ⚠️ 用 `GetPomodoroRunning()` 而不是"摘要非空"来判断 ——
                // 暂停时摘要仍然有内容（"专注 12:34（暂停）"），
                // 拿摘要判会把"暂停"显示成"暂停"按钮，点下去反而继续跑。
                if (_miPomodoro != null)
                {
                    string summary = GetPomodoroSummary();
                    bool enabled = GetPomodoroEnabled();
                    _miPomodoro.Text = string.IsNullOrEmpty(summary)
                        ? "番茄钟(&P)"
                        : ("番茄钟 · " + summary + "(&P)");
                    if (_miPomodoroToggle != null)
                    {
                        _miPomodoroToggle.Text = GetPomodoroRunning() ? "暂停(&S)" : "开始专注(&S)";
                        _miPomodoroToggle.Enabled = enabled;
                    }
                    if (_miPomodoroSkip != null) _miPomodoroSkip.Enabled = enabled;
                    if (_miPomodoroReset != null) _miPomodoroReset.Enabled = enabled;
                    if (_miPomodoroEnabled != null) _miPomodoroEnabled.Checked = enabled;
                    if (_miPomodoroCountdown != null)
                    {
                        _miPomodoroCountdown.Checked = GetPomodoroCountdown();
                        _miPomodoroCountdown.Enabled = enabled;
                    }
                }
            }
            catch { }
        }

        public void SetTopmostCheck(bool on)
        {
            if (_miTopmost != null) _miTopmost.Checked = on;
        }

        public void ShowBalloon(string title, string text)
        {
            try
            {
                if (_icon == null) return;
                _icon.BalloonTipTitle = title;
                _icon.BalloonTipText = text;
                _icon.ShowBalloonTip(3000);
            }
            catch { }
        }

        // ------------------------------------------------------------------
        // 运行时绘制托盘图标（蓝色圆 + 白色「宜」）
        // ------------------------------------------------------------------

        private static Icon BuildIcon()
        {
            int size = 32;
            using (Bitmap bmp = new Bitmap(size, size))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);

                    using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 62, 108, 200)))
                        g.FillEllipse(b, 1, 1, size - 3, size - 3);
                    using (Pen p = new Pen(Color.FromArgb(255, 190, 220, 255), 1.6f))
                        g.DrawEllipse(p, 1, 1, size - 3, size - 3);

                    using (Font f = new Font("Microsoft YaHei UI", 13.0f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (SolidBrush w = new SolidBrush(Color.White))
                    {
                        StringFormat sf = new StringFormat();
                        sf.Alignment = StringAlignment.Center;
                        sf.LineAlignment = StringAlignment.Center;
                        g.DrawString("宜", f, w, new RectangleF(0, 0, size, size), sf);
                    }
                }
                IntPtr h = bmp.GetHicon();
                Icon ic = (Icon)Icon.FromHandle(h).Clone();
                DestroyIcon(h);
                return ic;
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr hIcon);

        public void Dispose()
        {
            try { if (_icon != null) { _icon.Visible = false; _icon.Dispose(); } } catch { }
            try { if (_menu != null) _menu.Dispose(); } catch { }
            try { if (_ownedIcon != null) _ownedIcon.Dispose(); } catch { }
            _icon = null;
            _menu = null;
            _hicon = IntPtr.Zero;
        }
    }
}