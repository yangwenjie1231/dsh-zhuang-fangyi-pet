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
    /// 表情包画廊（右键桌宠 →「表情包…」打开）。
    ///
    /// ── 为什么需要 ────────────────────────────────────────────────────────────
    ///
    /// 用户反馈"为什么这些表情和气泡我这么久都没看全"——因为在此之前，
    /// 表情只能靠**状态变化时被动随机撒**：AI 不干活时不弹，弹出来 6 秒就换，
    /// 41 张里能看到几张全凭运气。这个窗口给它们一个**能主动看全**的入口。
    ///
    /// ── 交互 ──────────────────────────────────────────────────────────────────
    ///
    /// · 网格铺开全部表情（可滚动），每格是缩略图 + 语义名；
    /// · **点一下** → 立刻用它当气泡显示（Program 注入 `Pick` 回调）；
    /// · Esc / 关闭按钮 / 点空白 → 关闭。
    ///
    /// 缩略图直接用**内存里的字节**（Host 已提供 /pet/art/ 取图），不落盘、不缓存文件。
    /// </summary>
    internal sealed class PetGallery : Window
    {
        private const int ThumbMax = 96;          // 缩略图最大边长（DIP）

        private readonly WrapPanel _grid;
        private readonly TextBlock _status;
        private readonly Border _chrome;
        private readonly ScrollViewer _scroll;
        private readonly PetHttp _http;
        private readonly Dispatcher _ui = Dispatcher.CurrentDispatcher;

        private IntPtr _hwnd;
        private bool _reallyClosing;
        private bool _dark;

        /// <summary>用户点了某张表情（参数是相对 art/pet/ 的文件路径）。</summary>
        public Action<string> Pick = delegate { };
        /// <summary>窗口关闭回调（Program 用来清标记）。</summary>
        public Action Closed2 = delegate { };

        public PetGallery(PetHttp http)
        {
            _http = http;

            Title = "DSH 庄方宜桌宠-表情包";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.CanResizeWithGrip;
            ShowInTaskbar = false;
            Topmost = true;
            Width = 460;
            Height = 420;
            MinWidth = 300;
            MinHeight = 240;
            WindowStartupLocation = WindowStartupLocation.Manual;
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;

            _grid = new WrapPanel();
            _grid.Orientation = Orientation.Horizontal;
            _grid.Margin = new Thickness(8);

            _status = new TextBlock();
            _status.FontSize = 11;
            _status.Margin = new Thickness(10, 2, 10, 8);
            _status.Text = "正在读取表情清单…";

            _scroll = new ScrollViewer();
            _scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            _scroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
            _scroll.Content = _grid;

            StackPanel sp = new StackPanel();
            sp.Children.Add(_scroll);
            sp.Children.Add(_status);

            _chrome = new Border();
            _chrome.CornerRadius = new CornerRadius(10);
            _chrome.BorderThickness = new Thickness(1);
            try
            {
                System.Windows.Media.Effects.DropShadowEffect sh = new System.Windows.Media.Effects.DropShadowEffect();
                sh.BlurRadius = 14;
                sh.ShadowDepth = 3;
                sh.Opacity = 0.45;
                sh.Color = Colors.Black;
                _chrome.Effect = sh;
            }
            catch { }
            _chrome.Child = sp;
            Content = _chrome;

            ApplyTheme(false);
            Loaded += OnLoaded;
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
        }

        /// <summary>深/浅色（与气泡外壳同一套判定，Program 在主题变化时也会调）。</summary>
        public void ApplyTheme(bool dark)
        {
            _dark = dark;
            PetTheme.BubblePalette p = PetTheme.BubblePalette.For(dark);
            _chrome.Background = new SolidColorBrush(Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB));
            _chrome.BorderBrush = new SolidColorBrush(Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB));
            _status.Foreground = new SolidColorBrush(Color.FromRgb(p.FgR, p.FgG, p.FgB));
        }

        /// <summary>
        /// 打开并定位到桌宠附近（clamp 进工作区），然后异步拉清单。
        /// </summary>
        public void OpenNear(int petX, int petY, int petW, int petH)
        {
            if (IsVisible) { Activate(); return; }
            Show();
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(delegate
            {
                double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                int w = (int)Math.Round(ActualWidth * dpi);
                int h = (int)Math.Round(ActualHeight * dpi);
                PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
                int x = petX + petW / 2 - w / 2;
                int y = petY - h - 8;
                if (y < scr.Y + 4) y = petY + petH + 8;
                int maxX = scr.Right - w - 4;
                if (maxX < scr.X + 4) maxX = scr.X + 4;
                if (x > maxX) x = maxX;
                if (x < scr.X + 4) x = scr.X + 4;
                if (y + h > scr.Bottom - 4) y = scr.Bottom - h - 4;
                Left = x / dpi;
                Top = y / dpi;
            }));
            LoadItems();
        }

        /// <summary>拉清单（GET /pet/gallery）并铺格子。</summary>
        private void LoadItems()
        {
            _status.Text = "正在读取表情清单…";
            _http.GetGallery(delegate(List<PetGalleryItem> items, string error)
            {
                _ui.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                {
                    if (items == null)
                    {
                        _status.Text = "读取失败：" + (error ?? "未知原因");
                        return;
                    }
                    BuildGrid(items);
                }));
            });
        }

        private void BuildGrid(List<PetGalleryItem> items)
        {
            _grid.Children.Clear();
            if (items.Count == 0)
            {
                _status.Text = "清单里没有表情。";
                return;
            }
            for (int i = 0; i < items.Count; i++)
            {
                PetGalleryItem it = items[i];
                Border cell = new Border();
                cell.Width = ThumbMax + 18;
                cell.Margin = new Thickness(4);
                cell.CornerRadius = new CornerRadius(6);
                cell.BorderThickness = new Thickness(1);
                cell.Padding = new Thickness(4);
                cell.Cursor = Cursors.Hand;
                cell.ToolTip = it.File + (string.IsNullOrEmpty(it.Group) ? "" : "（" + it.Group + "）");
                cell.Background = new SolidColorBrush(_dark
                    ? Color.FromArgb(60, 255, 255, 255)
                    : Color.FromArgb(40, 0, 0, 0));
                cell.BorderBrush = new SolidColorBrush(_dark
                    ? Color.FromArgb(80, 200, 215, 245)
                    : Color.FromArgb(60, 90, 110, 150));

                StackPanel col = new StackPanel();
                Image img = new Image();
                img.Width = ThumbMax;
                img.Height = ThumbMax;
                img.Stretch = Stretch.Uniform;
                img.Source = LoadThumb(it);
                col.Children.Add(img);

                TextBlock cap = new TextBlock();
                // 语义名取文件名主干（`bubble/new/13-so-good.png` → `13-so-good`）
                cap.Text = ShortName(it.File);
                cap.FontSize = 10;
                cap.TextAlignment = TextAlignment.Center;
                cap.TextTrimming = TextTrimming.CharacterEllipsis;
                cap.MaxWidth = ThumbMax;
                cap.Margin = new Thickness(0, 3, 0, 0);
                cap.Foreground = new SolidColorBrush(_dark
                    ? Color.FromRgb(225, 230, 240)
                    : Color.FromRgb(40, 46, 60));
                col.Children.Add(cap);

                cell.Child = col;
                string file = it.File;
                cell.MouseLeftButtonUp += delegate(object s, MouseButtonEventArgs e)
                {
                    e.Handled = true;
                    Action<string> h = Pick;
                    if (h != null) { try { h(file); } catch { } }
                    CloseSelf();
                };
                _grid.Children.Add(cell);
            }
            _status.Text = "共 " + items.Count.ToString(CultureInfo.InvariantCulture) +
                           " 张 · 点一张立刻显示 · Esc 关闭";
        }

        /// <summary>`bubble/new/13-so-good.png` → `13-so-good`（去掉目录与扩展名）。</summary>
        internal static string ShortName(string file)
        {
            if (string.IsNullOrEmpty(file)) return "";
            string s = file.Replace('\\', '/');
            int slash = s.LastIndexOf('/');
            if (slash >= 0) s = s.Substring(slash + 1);
            int dot = s.LastIndexOf('.');
            if (dot > 0) s = s.Substring(0, dot);
            return s;
        }

        /// <summary>取缩略图（走内存字节，不落盘）。取不到就返回 null，格子仍可点。</summary>
        private BitmapSource LoadThumb(PetGalleryItem it)
        {
            try
            {
                string rel = _dark && !string.IsNullOrEmpty(it.FileDark) ? it.FileDark : it.File;
                byte[] bytes = _http.GetArtBytes(rel);
                if (bytes == null || bytes.Length == 0) return null;
                BitmapImage bi = new BitmapImage();
                bi.BeginInit();
                bi.CacheOption = BitmapCacheOption.OnLoad;
                bi.DecodePixelWidth = ThumbMax * 2;   // 高分屏留余量
                bi.StreamSource = new System.IO.MemoryStream(bytes);
                bi.EndInit();
                bi.Freeze();
                return bi;
            }
            catch { return null; }
        }

        private void CloseSelf()
        {
            if (_reallyClosing) return;
            try { Close(); } catch { }
        }
    }

    /// <summary>画廊里的一项（`/pet/gallery` 的 `items[]`）。</summary>
    internal sealed class PetGalleryItem
    {
        public string File;
        public bool HasText;
        public bool Opaque;
        public string FileDark;
        /// <summary>主要情境（与 `src/pet/emotes.js` 的分组同名）；未归类 = null。</summary>
        public string Group;
    }
}
