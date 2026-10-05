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

        public Action ToggleVisible = delegate { };
        public Action<bool> SetClickThrough = delegate { };
        public Action<bool> SetTopmost = delegate { };
        public Action<double> SetScale = delegate { };
        public Action ResetPosition = delegate { };
        public Action FocusDsh = delegate { };
        public Action Quit = delegate { };
        public Func<bool> IsVisible = delegate { return true; };
        public Func<bool> GetClickThrough = delegate { return true; };
        public Func<double> GetScale = delegate { return 1.0; };
        /// <summary>深浅色主题（'auto' | 'light' | 'dark'）；贴纸与气泡外壳一起换。</summary>
        public Action<string> SetTheme = delegate { };
        public Func<string> GetTheme = delegate { return "auto"; };

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
                string th = GetTheme();
                for (int i = 0; i < _themeItems.Count; i++)
                {
                    string k = _themeItems[i].Tag as string;
                    _themeItems[i].Checked = string.Equals(k, th, StringComparison.Ordinal);
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