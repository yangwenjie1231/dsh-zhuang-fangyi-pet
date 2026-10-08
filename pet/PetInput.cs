using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
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
    /// 无边框/置顶/SizeToContent，出现在桌宠附近；**Ctrl+Enter 发送**（Enter 换行）、Esc 关闭。`r`n        /// 桌宠移动时跟着走（FollowPet）；失焦不再自动关闭（多行输入时误关很恼人，改为显式关闭）。
    /// 失败**不关窗、不清输入**，就地显示错误；成功关闭并由 Program 用气泡提示「已发送」。
    /// 纯展示 + 单次发送，不做排队/打断（排队语义在 Host 侧 followup）。
    /// </summary>
    internal sealed class PetInput : Window
    {
        private readonly TextBox _box;
        private readonly TextBlock _hint;
        private readonly Border _chrome;
        /// <summary>「发给哪个对话」选择器（会话列表由 Host 通过快照提供）。</summary>
        private readonly ComboBox _target;
        /// <summary>项目（文件夹）下拉 —— 折叠层，减少一次性铺开的条目。</summary>
        private readonly ComboBox _projectBox;
        /// <summary>true = 正在程序化重建条目，忽略 SelectionChanged（防止重置用户选择）。</summary>
        private bool _syncing;
        /// <summary>按项目分组的会话（保持 Host 给的顺序，Host 已按项目聚拢）。</summary>
        private List<SessionGroup> _groups = new List<SessionGroup>();
        private readonly TextBlock _targetLabel;
        private readonly StackPanel _targetRow;
        /// <summary>当前可选的会话（与 ComboBox 项一一对应）。</summary>
        private List<PetSessionChoice> _choices = new List<PetSessionChoice>();

        private readonly PetHttp _http;        private readonly Dispatcher _ui;

        // ── v3：聊天模式 ────────────────────────────────────────────────────
        /// <summary>投递目标选择器（"聊天" / "指定对话"）。</summary>
        private ComboBox _modeBox;
        private TextBlock _modeLabel;
        /// <summary>true = 发给专用聊天会话（`/pet/chat`），false = 发到指定对话。</summary>
        private bool ChatMode
        {
            get { return _modeBox != null && _modeBox.SelectedIndex == 0; }
        }
        /// <summary>宿主是否装配了聊天（false 时只留"指定对话"，不给一个必失败的选项）。</summary>
        private bool _chatAvailable;
        /// <summary>设置里是否允许在气泡里聊天（关掉时同样隐藏聊天选项）。</summary>
        private bool _chatEnabled = true;

        private IntPtr _hwnd;
        private bool _sending;
        private bool _reallyClosing;

        // ── v11：深浅色 ──────────────────────────────────────────────────────
        //
        // ⚠️ 输入窗此前是**五个窗口里唯一不跟主题的**：底色硬编码成近白
        // `246,252,252,254`，Program 给 `_bubble`/`_status`/`_pomo`/`_gallery`
        // 都调了换色、唯独漏了它 —— 深色主题下它是一块刺眼的白卡。
        /// <summary>当前是否深色（`SetHint` 的"提示色"要用它）。</summary>
        private bool _dark;
        /// <summary>提示行的**正常**前景色（错误时会临时换成红色，再换回来）。</summary>
        private Color _hintNormal = Color.FromArgb(160, 90, 100, 120);

        /// <summary>
        /// 自检诊断用：算出输入窗的目标位置（物理像素）。
        /// 与 `OpenNear` 同一套规则（**下方优先**），但不写窗口属性 ——
        /// 没 Show 过的窗口 Left/Top 是 NaN，断言无从比较。
        /// </summary>
        public void DiagTargetFor(int petX, int petY, int petW, int petH, out double x, out double y)
        {
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;
            int w = (int)Math.Round(DiagWidth * dpi);
            int h = 60;
            x = petX + petW / 2 - w / 2;
            y = petY + petH + 8;
            PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
            if (y + h > scr.Bottom - 4)
            {
                y = petY - h - 8;
                if (y < scr.Y + 4) y = scr.Y + 4;
            }
            int maxX = scr.Right - w - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;
        }
        /// <summary>自检诊断用：窗口宽度（DIP；未 Show 时用测量值）。</summary>
        public double DiagWidth
        {
            get
            {
                if (ActualWidth > 0) return ActualWidth;
                try { return _chrome.DesiredSize.Width; } catch { return 300; }
            }
        }

        /// <summary>
        /// 自检诊断用：算出"跟随桌宠"的目标位置（物理像素）。与 FollowPet 同一套规则，
        /// 但不写窗口属性 —— 没 Show 过的窗口 Left/Top 是 NaN，断言无从比较。
        /// </summary>
        public void DiagFollowTarget(int petX, int petY, int petW, int petH, out double x, out double y)
        {
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;
            int w = (int)Math.Round(DiagWidth * dpi);
            int h = 60;
            x = petX + petW / 2 - w / 2;
            y = petY - h - 8;
            PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
            if (y < scr.Y + 4) y = petY + petH + 8;
            int maxX = scr.Right - w - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;
            if (y + h > scr.Bottom - 4) y = scr.Bottom - h - 4;
        }
        /// <summary>自检诊断用：是否支持多行（AcceptsReturn）。</summary>
        public bool DiagAcceptsReturn { get { return _box != null && _box.AcceptsReturn; } }
        /// <summary>自检诊断用：最大行数。</summary>
        public int DiagMaxLines { get { return _box == null ? 0 : _box.MaxLines; } }
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

            // ── 发给哪个对话（选择器）────────────────────────────────────────
            //
            // 为什么需要：`/pet/send` 一直支持指定 sessionId，但界面上没得选 ——
            // 只能由 Host 挑"最近活跃"的那个。多开对话时经常发错地方。
            // 名字由 Host 提供（快照 sessions[].title），这里只负责显示与回传 id。
            _targetLabel = new TextBlock();
            _targetLabel.Text = "发给";
            _targetLabel.FontSize = 11;
            _targetLabel.VerticalAlignment = VerticalAlignment.Center;
            _targetLabel.Margin = new Thickness(0, 0, 6, 0);

            // ⭐ 两级选择器：先挑**文件夹**（项目），再挑该项目下的对话。
            //
            // 为什么必须折叠：真机上同一个项目下能有十几个对话
            //（用户截图里一整列 `demac-e2e-cef · session-`），
            // 平铺一个下拉根本翻不到 —— 用户原话"对话一多，根本翻不到"。
            // 项目这一层就是"折叠"：先把 N 个对话收敛成 M 个项目（M << N）。
            _projectBox = new ComboBox();
            _projectBox.FontSize = 12;
            _projectBox.MinWidth = 96;
            _projectBox.MaxWidth = 150;
            _projectBox.Margin = new Thickness(0, 0, 6, 0);
            _projectBox.SelectionChanged += delegate
            {
                // 切项目 → 只重填"对话"那一级（不改变已选项目的会话选择逻辑）
                if (_syncing) return;
                RebuildSessionItems();
            };

            _target = new ComboBox();
            _target.FontSize = 12;
            _target.MinWidth = 130;
            _target.Margin = new Thickness(0, 0, 0, 0);
            _target.SelectionChanged += delegate { SetHint(); };

            // ── v3：聊天模式（用户点名"可以与桌宠聊天"）─────────────────────
            //
            // 两种投递目标的差别（用户必须能看懂，否则会发错地方）：
            //   · **聊天**   → 发到**专用聊天会话**（工作区「庄方宜」，
            //                  人设由 AGENTS.md 决定，回复会进气泡）；
            //   · **某个对话** → 发到你选的那个已有会话（原来的行为）。
            //
            // 为什么放在同一个窗口而不是两个窗口：用户的心智是"我要说句话"，
            // 具体发去哪是次要选择 —— 多开一个窗口只会让他困惑该用哪个。
            _modeLabel = new TextBlock();
            _modeLabel.Text = "发给";
            _modeLabel.FontSize = 11;
            _modeLabel.VerticalAlignment = VerticalAlignment.Center;
            _modeLabel.Margin = new Thickness(0, 0, 6, 0);

            _modeBox = new ComboBox();
            _modeBox.FontSize = 12;
            _modeBox.MinWidth = 88;
            _modeBox.Margin = new Thickness(0, 0, 6, 0);
            _modeBox.Items.Add("聊天");
            _modeBox.Items.Add("指定对话");
            _modeBox.SelectedIndex = 0;   // 默认聊天（那是用户点名的功能）
            _modeBox.SelectionChanged += delegate
            {
                if (_syncing) return;
                UpdateModeVisibility();
                SetHint();
            };

            _targetRow = new StackPanel();
            _targetRow.Orientation = Orientation.Horizontal;
            _targetRow.Margin = new Thickness(12, 10, 12, 0);
            _targetRow.Children.Add(_modeLabel);
            _targetRow.Children.Add(_modeBox);
            _targetRow.Children.Add(_targetLabel);
            _targetRow.Children.Add(_projectBox);
            _targetRow.Children.Add(_target);

            _box = new TextBox();
            _box.FontSize = 14;
            _box.MinWidth = 260;
            _box.Margin = new Thickness(12, 4, 12, 4);
            _box.VerticalContentAlignment = VerticalAlignment.Center;
            // 多行输入（用户反馈"不支持多行"）：
            //   · AcceptsReturn=true → Enter 换行，不再被当成"发送"
            //   · Ctrl+Enter 发送（下方 KeyDown 处理），Esc 关闭
            //   · 高度随内容长到 6 行，超过则内部滚动（不无限撑高挡住桌面）
            _box.AcceptsReturn = true;
            _box.TextWrapping = TextWrapping.Wrap;
            _box.MinLines = 1;
            _box.MaxLines = 6;
            _box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            // 占位提示：无字时显示（TextBox 原生没有 placeholder，用 Tag+灰字绘制太重，这里用提示行+样式兜底）
            _box.KeyDown += OnBoxKeyDown;
            _box.TextChanged += delegate { SetHint(); };

            _hint = new TextBlock();
            _hint.Text = "Ctrl+Enter 发送 · Esc 关闭";
            _hint.FontSize = 11;
            _hint.Margin = new Thickness(14, 0, 14, 8);

            _chrome = new Border();
            _chrome.CornerRadius = new CornerRadius(10);
            _chrome.Padding = new Thickness(0);
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
            sp.Children.Add(_targetRow);
            sp.Children.Add(_box);
            sp.Children.Add(_hint);
            _chrome.Child = sp;
            Content = _chrome;

            // v11：构造末尾先套一次浅色。
            //
            // ⚠️ 这行是**必须的**，不能只靠 Program 在首帧调 —— 踩过的坑：
            // 气泡当初把配色留在构造期的硬编码默认值上，而 `ApplySettings` 的
            // diff 判定"值没变"把首帧跳过了，于是**一直用着浅色**。
            // 颜色只有一个来源（`ApplyTheme`），构造期就必须走一次。
            ApplyTheme(false);

            Loaded += OnLoaded;
            // ⚠️ **不再"失焦自动关闭"**。
            // 单行时代它还行，现在有三处会误关：① 多行输入时点别处看资料；
            // ② 点「发给」下拉（焦点离开 TextBox）；③ 桌宠跟随途中焦点抖动。
            // 改为显式关闭：Esc、✕ 按钮、或发送成功后自动关。
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

        /// <summary>
        /// 深浅色（与气泡/状态文字/番茄钟/画廊**共用同一套调色板** ——
        /// 不新增第五套配色真相）。
        ///
        /// ⚠️ `ComboBox`/`TextBox` 的 WPF 默认模板**不会**自动跟随外层背景，
        /// 必须显式设前景/背景/边框 —— 只改 `_chrome` 的话，深色下会出现
        /// "深色卡片里嵌着两个白色下拉框"这种更糟的效果。
        /// </summary>
        public void ApplyTheme(bool dark)
        {
            _dark = dark;
            PetTheme.BubblePalette p = PetTheme.BubblePalette.For(dark);
            Color fg = Color.FromRgb(p.FgR, p.FgG, p.FgB);
            Color bg = Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB);
            Color bd = Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB);
            // 输入框底比卡片略深/略浅一档，才看得出"这里能打字"。
            Color boxBg = dark
                ? Color.FromArgb(255, 28, 33, 44)
                : Color.FromArgb(255, 255, 255, 255);
            Color boxBd = dark
                ? Color.FromArgb(180, 90, 108, 140)
                : Color.FromArgb(160, 170, 185, 210);
            // 次要文字（"发给"标签、提示行）：在各自底色上都要能读。
            _hintNormal = dark
                ? Color.FromArgb(170, 170, 185, 210)
                : Color.FromArgb(160, 90, 100, 120);
            Color sub = _hintNormal;

            _chrome.Background = new SolidColorBrush(bg);
            _chrome.BorderBrush = new SolidColorBrush(bd);
            ApplyColorsToChildren(fg, boxBg, boxBd, sub);
        }

        /// <summary>把颜色铺到所有子控件上（`ApplyTheme` 的实现细节，抽出来只是为了让上面那段读起来是一份"配色表"）。</summary>
        private void ApplyColorsToChildren(Color fg, Color boxBg, Color boxBd, Color sub)
        {
            _box.Foreground = new SolidColorBrush(fg);
            _box.Background = new SolidColorBrush(boxBg);
            _box.BorderBrush = new SolidColorBrush(boxBd);
            _box.CaretBrush = new SolidColorBrush(fg);
            _hint.Foreground = new SolidColorBrush(sub);
            _targetLabel.Foreground = new SolidColorBrush(sub);
            _modeLabel.Foreground = new SolidColorBrush(sub);
            ApplyComboTheme(_target, fg, boxBg, boxBd);
            ApplyComboTheme(_projectBox, fg, boxBg, boxBd);
            ApplyComboTheme(_modeBox, fg, boxBg, boxBd);
        }

        /// <summary>
        /// 给一个 ComboBox 上色。
        ///
        /// ⚠️⚠️ **这个函数绕了两圈才写对，两个坑都留在这里**：
        ///
        /// **坑一：设属性没用。** Aero2 的 ComboBox 模板不是
        /// `{TemplateBinding Background}`，而是引用**主题级资源**
        /// （`{StaticResource ComboBox.Static.Background}` 一类）。
        /// 于是 `box.Background = 深色` 设了、`box.Resources[...]` 也覆盖了，
        /// 属性读出来是 `#FF1C212C`、**截图里依然是白的**。
        ///
        /// **坑二：连可视树都看不出来。** Aero2 用它自己的
        /// `Microsoft.Windows.Themes.ButtonChrome` 画那个框，而它是
        /// `Decorator` 的子类 —— 遍历可视树找 `Control`/`Border`/`Panel`/`Shape`
        /// 时**根本不会碰到它**。所以"属性全对、树里全暗、渲染全白"。
        ///
        /// **结论：Aero2 的 ComboBox 不吃外部配色，只能换模板。**
        /// 下面用一份最小模板（ToggleButton + 箭头 + Popup + 列表）替掉它 ——
        /// 比逐个猜资源键可靠，而且以后换系统主题也不会再变白。
        ///
        /// 失败时**静默保留原模板**（宁可下拉框丑，也不能让它点不开）。
        /// </summary>
        private static void ApplyComboTheme(ComboBox box, Color fg, Color bg, Color bd)
        {
            if (box == null) return;
            box.Foreground = new SolidColorBrush(fg);
            box.Background = new SolidColorBrush(bg);
            box.BorderBrush = new SolidColorBrush(bd);
            try
            {
                box.Template = BuildComboTemplate(fg, bg, bd);
                box.ItemContainerStyle = BuildComboItemStyle(fg, bg, bd);
            }
            catch (Exception ex) { PetLog.Warn("ComboBox 换模板失败（保留默认外观）: " + PetLog.Describe(ex)); }
        }

        /// <summary>颜色 → `#AARRGGBB`（喂给 XamlReader）。</summary>
        private static string Hex(Color c)
        {
            return "#" + c.A.ToString("X2") + c.R.ToString("X2") +
                   c.G.ToString("X2") + c.B.ToString("X2");
        }

        /// <summary>
        /// 最小 ComboBox 模板。
        ///
        /// 两个必须保留的契约：
        ///   · `Popup` 必须叫 **`PART_Popup`** —— ComboBox 靠这个名字找下拉层，
        ///     改名会让键盘/定位逻辑失效（能点开但行为怪异）；
        ///   · 收起态用 `ToggleButton` + `IsChecked` 双向绑到 `IsDropDownOpen`，
        ///     这是 ComboBox 认的交互方式。
        ///
        /// 颜色全部由参数注入，**不再引用任何主题资源** —— 这是它能生效的原因。
        /// </summary>
        private static ControlTemplate BuildComboTemplate(Color fg, Color bg, Color bd)
        {
            Color hover = Blend(bg, fg, 0.16);
            string xaml =
                "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' " +
                "xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ComboBox'>" +
                "<Grid>" +
                  "<ToggleButton Focusable='False' ClickMode='Press' " +
                    "Background='" + Hex(bg) + "' BorderBrush='" + Hex(bd) + "' Foreground='" + Hex(fg) + "' " +
                    "IsChecked=\"{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}\">" +
                    "<ToggleButton.Template>" +
                      "<ControlTemplate TargetType='ToggleButton'>" +
                        "<Border x:Name='Bd' Background='{TemplateBinding Background}' " +
                          "BorderBrush='{TemplateBinding BorderBrush}' BorderThickness='1' CornerRadius='4'>" +
                          "<Grid>" +
                            "<Grid.ColumnDefinitions>" +
                              "<ColumnDefinition Width='*'/><ColumnDefinition Width='14'/>" +
                            "</Grid.ColumnDefinitions>" +
                            "<ContentPresenter Grid.Column='0' Margin='6,2,2,2' VerticalAlignment='Center' " +
                              "HorizontalAlignment='Left' " +
                              "Content=\"{Binding SelectionBoxItem, RelativeSource={RelativeSource AncestorType=ComboBox}}\" " +
                              "ContentTemplate=\"{Binding SelectionBoxItemTemplate, RelativeSource={RelativeSource AncestorType=ComboBox}}\"/>" +
                            "<Path Grid.Column='1' HorizontalAlignment='Center' VerticalAlignment='Center' " +
                              "Data='M 0 0 L 4 4 L 8 0 Z' Fill='{TemplateBinding Foreground}'/>" +
                          "</Grid>" +
                        "</Border>" +
                        "<ControlTemplate.Triggers>" +
                          "<Trigger Property='IsMouseOver' Value='True'>" +
                            "<Setter TargetName='Bd' Property='Background' Value='" + Hex(hover) + "'/>" +
                          "</Trigger>" +
                        "</ControlTemplate.Triggers>" +
                      "</ControlTemplate>" +
                    "</ToggleButton.Template>" +
                  "</ToggleButton>" +
                  "<Popup x:Name='PART_Popup' AllowsTransparency='True' Placement='Bottom' Focusable='False' " +
                    "IsOpen='{TemplateBinding IsDropDownOpen}' MaxHeight='{TemplateBinding MaxDropDownHeight}'>" +
                    "<Border Background='" + Hex(bg) + "' BorderBrush='" + Hex(bd) + "' " +
                      "BorderThickness='1' CornerRadius='4' MinWidth='{Binding ActualWidth, RelativeSource={RelativeSource AncestorType=ComboBox}}'>" +
                      "<ScrollViewer VerticalScrollBarVisibility='Auto'><ItemsPresenter/></ScrollViewer>" +
                    "</Border>" +
                  "</Popup>" +
                "</Grid>" +
                "</ControlTemplate>";
            return (ControlTemplate)System.Windows.Markup.XamlReader.Parse(xaml);
        }

        /// <summary>下拉项模板（默认模板同样不吃外部配色，一并换掉）。</summary>
        private static Style BuildComboItemStyle(Color fg, Color bg, Color bd)
        {
            Color hover = Blend(bg, fg, 0.16);
            string xaml =
                "<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' " +
                "xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ComboBoxItem'>" +
                  "<Setter Property='Foreground' Value='" + Hex(fg) + "'/>" +
                  "<Setter Property='Background' Value='" + Hex(bg) + "'/>" +
                  "<Setter Property='Padding' Value='6,3'/>" +
                  "<Setter Property='Template'>" +
                    "<Setter.Value>" +
                      "<ControlTemplate TargetType='ComboBoxItem'>" +
                        "<Border x:Name='Bd' Background='{TemplateBinding Background}' Padding='{TemplateBinding Padding}'>" +
                          "<ContentPresenter/>" +
                        "</Border>" +
                        "<ControlTemplate.Triggers>" +
                          "<Trigger Property='IsHighlighted' Value='True'>" +
                            "<Setter TargetName='Bd' Property='Background' Value='" + Hex(hover) + "'/>" +
                          "</Trigger>" +
                        "</ControlTemplate.Triggers>" +
                      "</ControlTemplate>" +
                    "</Setter.Value>" +
                  "</Setter>" +
                "</Style>";
            return (Style)System.Windows.Markup.XamlReader.Parse(xaml);
        }

        /// <summary>
        /// 把 <paramref name="a"/> 朝 <paramref name="b"/> 混 <paramref name="t"/>（0..1）。
        /// 用来从"底色 + 前景色"推出悬停色，不必再手写一组魔数
        /// （深色与浅色共用同一段逻辑，两套主题各自动算出合适的深浅）。
        /// </summary>
        private static Color Blend(Color a, Color b, double t)
        {
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            return Color.FromArgb(255,
                (byte)Math.Round(a.R + (b.R - a.R) * t),
                (byte)Math.Round(a.G + (b.G - a.G) * t),
                (byte)Math.Round(a.B + (b.B - a.B) * t));
        }

        /// <summary>自检诊断用：第一个下拉框（验证"真的不白了"要拿它渲染取像素）。</summary>
        internal ComboBox DiagModeBox { get { return _modeBox; } }

        /// <summary>自检诊断用：当前是否深色。</summary>
        internal bool DiagDark { get { return _dark; } }

        /// <summary>自检诊断用：输入框底色（判断"跟主题了没"）。</summary>
        internal Color DiagBoxBackground
        {
            get
            {
                SolidColorBrush b = _box == null ? null : _box.Background as SolidColorBrush;
                return b == null ? Colors.Transparent : b.Color;
            }
        }

        /// <summary>自检诊断用：窗口卡片底色。</summary>
        internal Color DiagChromeBackground
        {
            get
            {
                SolidColorBrush b = _chrome == null ? null : _chrome.Background as SolidColorBrush;
                return b == null ? Colors.Transparent : b.Color;
            }
        }

        /// <summary>自检诊断用：提示行前景色。</summary>
        internal Color DiagHintForeground
        {
            get
            {
                SolidColorBrush b = _hint == null ? null : _hint.Foreground as SolidColorBrush;
                return b == null ? Colors.Transparent : b.Color;
            }
        }

        /// <summary>
        /// 桌宠移动时把输入窗跟着挪过去（用户反馈"输入框不跟随移动"）。
        ///
        /// **只挪位置、不重排**：输入窗尺寸由内容决定，跟随途中重算尺寸会闪烁。
        /// 走的是与 OpenNear 同一套"贴桌宠上方、放不下就下方、再 clamp 进工作区"的规则。
        /// </summary>
        public void FollowPet(int petX, int petY, int petW, int petH)
        {
            if (!IsVisible) return;
            double dpi = _hwnd == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(_hwnd) / 96.0;
            if (dpi <= 0) dpi = 1.0;
            int w = (int)Math.Round(ActualWidth * dpi);
            int h = (int)Math.Round(ActualHeight * dpi);
            if (w <= 0 || h <= 0) return;

            // 与 OpenNear 同一套规则（否则拖动时窗口会跳到另一个方位）。
            int x = petX + petW / 2 - w / 2;
            int y = petY + petH + 8;
            PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
            if (y + h > scr.Bottom - 4)
            {
                y = petY - h - 8;
                if (y < scr.Y + 4) y = scr.Y + 4;
            }
            int maxX = scr.Right - w - 4;
            if (maxX < scr.X + 4) maxX = scr.X + 4;
            if (x > maxX) x = maxX;
            if (x < scr.X + 4) x = scr.X + 4;
            if (y + h > scr.Bottom - 4) y = scr.Bottom - h - 4;

            Left = x / dpi;
            Top = y / dpi;
        }
        /// <summary>打开并定位到桌宠附近（默认桌宠上方，clamp 进工作区）。</summary>
        public void OpenNear(int petX, int petY, int petW, int petH)
        {
            if (IsVisible) { _box.Focus(); _box.SelectAll(); return; }
            _sending = false;
            _box.Clear();
            UpdateModeVisibility();
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

                // ⚠️ **优先放桌宠下方**，不是上方。
                //
                // 踩过：气泡（`PetBubble`）优先贴**头顶**，而输入窗原本也贴上方 ——
                // 两个独立窗口互不知情，同时出现时直接叠在一起（用户反馈"输入框会和气泡重叠"）。
                // 现在分工明确：**气泡占上方、输入窗占下方**，从布局上就不会撞。
                // 下方放不下才退回上方（此时气泡若也在上方，宁可让输入窗尽量下移）。
                int x = petX + petW / 2 - w / 2;
                int y = petY + petH + 8;
                PetNative.WorkArea scr = PetNative.NearestScreen(petX + petW / 2, petY + petH / 2);
                if (y + h > scr.Bottom - 4)
                {
                    y = petY - h - 8;                  // 下方放不下 → 退回上方
                    if (y < scr.Y + 4) y = scr.Y + 4;
                }
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

        /// <summary>
        /// 更新选择器（由 Program 在快照变化时喂进来）。
        ///
        /// **两级结构**：项目（文件夹）→ 该项目的对话。
        /// 用户反馈"对话一多根本翻不到"，所以先把 N 个对话折叠成 M 个项目。
        ///
        /// 两个都必须**保持用户当前选择**（会话结束时才回落）——
        /// 否则 ComboBox 会悄悄跳回第一项，消息就发去了别处。
        /// </summary>
        public void SetChoices(List<PetSessionChoice> choices)
        {
            _choices = choices ?? new List<PetSessionChoice>();
            // ⚠️ 必须**在重建 _groups 之前**读旧选择，但读的时候旧 _groups 与
            // ComboBox 的 SelectedIndex 可能已经不同步（列表刚被换掉）——
            // `SelectedSessionId` 内部已做越界保护，这里保持顺序即可。
            string keep = SelectedSessionId();

            // 按项目分组（Host 已按项目聚拢，这里只需顺序切分）
            _groups = new List<SessionGroup>();
            for (int i = 0; i < _choices.Count; i++)
            {
                PetSessionChoice c = _choices[i];
                string key = string.IsNullOrEmpty(c.Project) ? "（其他）" : c.Project;
                SessionGroup g = _groups.Count > 0 ? _groups[_groups.Count - 1] : null;
                if (g == null || g.Name != key)
                {
                    g = new SessionGroup();
                    g.Name = key;
                    _groups.Add(g);
                }
                g.Items.Add(i);   // 存**全局下标**，选中后直接回查 _choices
            }

            _syncing = true;
            try
            {
                _projectBox.Items.Clear();
                for (int i = 0; i < _groups.Count; i++)
                {
                    _projectBox.Items.Add(_groups[i].Name + "（" +
                        _groups[i].Items.Count.ToString(CultureInfo.InvariantCulture) + "）");
                }

                if (_choices.Count == 0)
                {
                    _projectBox.IsEnabled = false;
                    _target.IsEnabled = false;
                    _target.Items.Clear();
                    _target.Items.Add("（没有可发的对话）");
                    _target.SelectedIndex = 0;
                    _projectBox.SelectedIndex = -1;
                    return;
                }

                _projectBox.IsEnabled = _groups.Count > 1;
                _target.IsEnabled = true;

                // 优先落在"包含上次选中会话"的那个项目上
                int wantGroup = 0;
                if (!string.IsNullOrEmpty(keep))
                {
                    for (int gi = 0; gi < _groups.Count; gi++)
                    {
                        if (_groups[gi].Items.Exists(idx => _choices[idx].SessionId == keep))
                        {
                            wantGroup = gi;
                            break;
                        }
                    }
                }
                _projectBox.SelectedIndex = wantGroup;
            }
            finally
            {
                _syncing = false;
            }
            // 再填对话级（它在 _syncing=false 之后做，保证 SelectedIndex 生效）
            RebuildSessionItems(keep);
            SetHint();
        }

        /// <summary>
        /// 按当前选中的项目重填"对话"下拉。
        /// @param keep 尽量保持选中的会话 id；null = 保持当前选择
        /// </summary>
        private void RebuildSessionItems(string keep = null)
        {
            if (keep == null) keep = SelectedSessionId();
            int gi = _projectBox.SelectedIndex;
            _syncing = true;
            try
            {
                _target.Items.Clear();
                if (gi < 0 || gi >= _groups.Count) return;
                SessionGroup g = _groups[gi];
                for (int k = 0; k < g.Items.Count; k++)
                {
                    _target.Items.Add(_choices[g.Items[k]].ShortDisplay);
                }
                int sel = 0;
                if (!string.IsNullOrEmpty(keep))
                {
                    for (int k = 0; k < g.Items.Count; k++)
                    {
                        if (_choices[g.Items[k]].SessionId == keep) { sel = k; break; }
                    }
                }
                _target.SelectedIndex = sel;
            }
            finally
            {
                _syncing = false;
            }
        }

        /// <summary>当前选中的会话 id；没有可选项时返回 null（Host 会自己挑最近活跃的）。</summary>
        public string SelectedSessionId()
        {
            // 全程**越界保护**：`_groups` 会在 SetChoices 里被整体替换，
            // 而 ComboBox 的 SelectedIndex 可能还指向旧列表的下标 ——
            // 直接索引会抛 ArgumentOutOfRangeException（实测踩过）。
            int gi = _projectBox == null ? -1 : _projectBox.SelectedIndex;
            int si = _target == null ? -1 : _target.SelectedIndex;
            if (gi < 0 || gi >= _groups.Count) return null;
            SessionGroup g = _groups[gi];
            if (si < 0 || si >= g.Items.Count) return null;
            int globalIdx = g.Items[si];
            if (globalIdx < 0 || globalIdx >= _choices.Count) return null;
            return _choices[globalIdx].SessionId;
        }

        /// <summary>自检诊断用：当前项目下拉的条目（折叠后的项目名列表）。</summary>
        internal List<string> DiagProjectItems()
        {
            List<string> r = new List<string>();
            if (_projectBox == null) return r;
            for (int i = 0; i < _projectBox.Items.Count; i++) r.Add(Convert.ToString(_projectBox.Items[i]));
            return r;
        }

        /// <summary>自检诊断用：当前"对话"下拉的条目。</summary>
        internal List<string> DiagSessionItems()
        {
            List<string> r = new List<string>();
            if (_target == null) return r;
            for (int i = 0; i < _target.Items.Count; i++) r.Add(Convert.ToString(_target.Items[i]));
            return r;
        }

        // ── v3：聊天模式 ────────────────────────────────────────────────────

        /// <summary>
        /// 告诉输入窗"聊天能不能用"（宿主能力位 + 用户设置）。
        ///
        /// ⚠️ 不可用时**把选项藏起来**（而不是留着让你点了报错）：
        /// "给了入口但点了必失败"是最糟的交互 —— 发消息那个 ✎ 按钮
        /// 当初就是为此才用 `available` 位控制的。
        /// </summary>
        public void SetChatAvailability(bool available, bool enabled)
        {
            _chatAvailable = available;
            _chatEnabled = enabled;
            UpdateModeVisibility();
        }

        /// <summary>按可用性重建"投递目标"下拉的选项，并保证选中项合法。</summary>
        private void UpdateModeVisibility()
        {
            if (_modeBox == null) return;
            bool canChat = _chatAvailable && _chatEnabled;
            _syncing = true;
            try
            {
                int want = _modeBox.SelectedIndex;
                _modeBox.Items.Clear();
                if (canChat) _modeBox.Items.Add("聊天");
                _modeBox.Items.Add("指定对话");
                // 默认选聊天（用户点名的功能）；不能聊就只能是"指定对话"。
                _modeBox.SelectedIndex = canChat ? Math.Max(0, Math.Min(want < 0 ? 0 : want, _modeBox.Items.Count - 1)) : 0;
            }
            finally { _syncing = false; }

            // 只有"指定对话"模式才需要那三个选择器 —— 聊天模式下它们是噪音，
            // 而且会让人以为"聊天还要挑对话"。
            Visibility vis = ChatMode ? Visibility.Collapsed : Visibility.Visible;
            if (_targetLabel != null) _targetLabel.Visibility = vis;
            if (_projectBox != null) _projectBox.Visibility = vis;
            if (_target != null) _target.Visibility = vis;
        }

        /// <summary>自检诊断用：当前投递目标下拉的条目。</summary>
        internal List<string> DiagModeItems()
        {
            List<string> r = new List<string>();
            if (_modeBox == null) return r;
            for (int i = 0; i < _modeBox.Items.Count; i++) r.Add(Convert.ToString(_modeBox.Items[i]));
            return r;
        }

        /// <summary>自检诊断用：当前是不是聊天模式。</summary>
        internal bool DiagChatMode { get { return ChatMode; } }

        /// <summary>自检诊断用：设置可用性并读回选项（不起窗口）。</summary>
        internal List<string> DiagSetChatAvailability(bool available, bool enabled)
        {
            SetChatAvailability(available, enabled);
            return DiagModeItems();
        }

        /// <summary>自检诊断用：切到第 n 个项目并返回该项目的对话条目。</summary>
        internal List<string> DiagSwitchProject(int n)
        {
            // 越界就返回当前状态，不抛 —— 自检里列表可能已被清空。
            if (_projectBox != null && n >= 0 && n < _projectBox.Items.Count)
            {
                _projectBox.SelectedIndex = n;
            }
            return DiagSessionItems();
        }
        private void SetHint()
        {
            int n = _box.Text == null ? 0 : _box.Text.Length;
            // 提示语随模式变 —— 用户要一眼知道这条会发到哪去（发错地方比发不出去更糟）。
            string where = ChatMode ? "和庄方宜聊天" : "发给指定对话";
            if (n > 0)
                _hint.Text = n.ToString(CultureInfo.InvariantCulture) + " / " +
                             PetHttp.SendTextMax.ToString(CultureInfo.InvariantCulture) +
                             " · " + where + " · Ctrl+Enter 发送 · Esc 关闭";
            else
                _hint.Text = where + "…（Ctrl+Enter 发送 · Esc 关闭）";
        }

        private void OnBoxKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Enter) return;
            // 多行语义：Enter 换行，**Ctrl+Enter 发送**（与多数聊天框一致）。
            // 单行时代的"Enter 直接发送"会让用户没法写第二行。
            bool ctrl = (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control;
            if (ctrl)
            {
                e.Handled = true;
                SendNow();
            }
            // 不按 Ctrl 时：放行给 TextBox，由 AcceptsReturn 插入换行
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
            _hint.Foreground = new SolidColorBrush(_hintNormal);
            _hint.Text = "发送中…";
            _box.IsEnabled = false;

            // ── v3：按模式分流 ──────────────────────────────────────────────
            //
            // 两条路都回同一个回调形状 `(status, body)`，所以 `OnSendDone`
            // 与错误文案映射完全复用 —— 不为了"聊天"再写一套失败提示。
            if (ChatMode)
            {
                _http.PostChat(text, delegate(int status, string body)
                {
                    _ui.BeginInvoke(DispatcherPriority.Normal, new Action(delegate { OnSendDone(status, body); }));
                });
                return;
            }
            _http.PostSend(text, SelectedSessionId(), delegate(int status, string body)
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
            // 失败：窗口不关、输入不清，就地报错。
            //
            // ⚠️ **同时写日志**：原先失败只在界面上显示一句，日志里一个字都没有 ——
            // 结果"发送失败"变成了只能靠猜的现象。诊断信息必须落盘，
            // 否则用户描述问题时（"就一句发送失败"）谁都无法定位。
            string reason = DescribeSendError(status, body);
            PetLog.Warn("send 失败 status=" + status.ToString(CultureInfo.InvariantCulture) +
                        " body=" + (body ?? "(null)") + " → 显示为：" + reason);
            _hint.Foreground = new SolidColorBrush(Colors.IndianRed);
            _hint.Text = reason;
            _box.Focus();
        }

        /// <summary>纯函数：把 /pet/send 的失败响应翻成给用户看的一句话（SelfTest 断言）。</summary>
        /// <remarks>
        /// ⚠️ **必须把宿主给的原因带上**，这是被真机事故逼出来的。
        ///
        /// 原先 502 只返回 `"发送失败（HTTP 502）"`，把响应体里的 `message`
        /// **整段丢掉** —— 于是用户只看到一句"发送失败"，**无从判断为什么**，
        /// 而排查的人也拿不到任何线索（exe 的 PostSend 又不写日志）。
        ///
        /// 真实代价：一个"漏传 `signal` 实参"的 bug 因此拖了两轮才定位 ——
        /// 宿主明明在响应体里回了
        /// `Cannot read properties of undefined (reading 'throwIfAborted')`，
        /// 却被这一行吞掉了。**兜底文案不该吃掉原始原因。**
        /// </remarks>
        public static string DescribeSendError(int status, string body)
        {
            // 先从响应体里取出可读原因（Host 的形状是
            // `{"error":"send-failed","message":"…"}` 或 `{"error":"…","reason":"…"}`）。
            string detail = ExtractReason(body);
            string suffix = string.IsNullOrEmpty(detail) ? "" : "：" + detail;
            if (status == 0) return "发不出去（连不上宿主）" + suffix;
            if (status == 401 || status == 403) return "鉴权失败，请重开桌宠" + suffix;
            if (status == 409) return "没有正在进行的会话" + suffix;
            if (status == 503) return "宿主暂时不能收消息" + suffix;
            if (status == 400)
            {
                if (!string.IsNullOrEmpty(body) && body.IndexOf("too-long", StringComparison.Ordinal) >= 0)
                    return "太长了（上限 " + PetHttp.SendTextMax.ToString(CultureInfo.InvariantCulture) + " 字）";
                return "内容不合法" + suffix;
            }
            return "发送失败（HTTP " + status.ToString(CultureInfo.InvariantCulture) + "）" + suffix;
        }

        /// <summary>
        /// 从 `/pet/send` 的响应体里抠出人类可读的原因。
        ///
        /// 优先级：`message`（502 用）→ `reason`（503 用）→ `error`（兜底）。
        /// 纯手工扫描而**不引 JSON 库**：这里只要一个字符串，且必须
        /// **绝不抛异常**（诊断路径上的代码自己崩掉是最糟的）。
        /// 解析不出来就返回 null，由调用方退回通用文案。
        /// </summary>
        public static string ExtractReason(string body)
        {
            if (string.IsNullOrEmpty(body)) return null;
            string v = ExtractJsonString(body, "message") ?? ExtractJsonString(body, "reason");
            // `error` 是机器码（no-session / unavailable…），只在没有更可读的字段时用。
            if (string.IsNullOrEmpty(v)) v = ExtractJsonString(body, "error");
            return v;
        }

        /// <summary>取 JSON 对象里某个字符串字段的值；找不到返回 null。绝不打乱引号/转义。</summary>
        private static string ExtractJsonString(string json, string key)
        {
            string needle = "\"" + key + "\"";
            int i = json.IndexOf(needle, StringComparison.Ordinal);
            while (i >= 0)
            {
                int c = json.IndexOf(':', i + needle.Length);
                if (c < 0) return null;
                int q = json.IndexOf('"', c + 1);
                if (q < 0) return null;
                // 冒号与引号之间只允许空白，否则说明匹配到的是**值**里出现的同名字串。
                bool onlySpace = true;
                for (int k = c + 1; k < q; k++)
                {
                    if (!char.IsWhiteSpace(json[k])) { onlySpace = false; break; }
                }
                if (onlySpace)
                {
                    StringBuilder sb = new StringBuilder();
                    for (int k = q + 1; k < json.Length; k++)
                    {
                        char ch = json[k];
                        if (ch == '\\' && k + 1 < json.Length)
                        {
                            char nx = json[k + 1];
                            if (nx == 'n') sb.Append('\n');
                            else if (nx == 't') sb.Append('\t');
                            else sb.Append(nx);   // \" \\ \/ \uXXXX 的常见情形
                            k++;
                            continue;
                        }
                        if (ch == '"') return sb.ToString();
                        sb.Append(ch);
                    }
                    return null;
                }
                i = json.IndexOf(needle, i + needle.Length, StringComparison.Ordinal);
            }
            return null;
        }

        private void CloseSelf()
        {
            if (_reallyClosing) return;
            try { Close(); } catch { }
        }
    }

    /// <summary>一个可选的发送目标（契约 §2 sessions[] 的子集）。</summary>
    internal sealed class PetSessionChoice
    {
        public string SessionId;
        /// <summary>给用户看的名字（Host 已回退过：标题 → 目录名 → id 前缀）。</summary>
        public string Title;
        public bool Running;
        /// <summary>对话级显示（项目已在上一级下拉里，这里不再重复前缀）。</summary>
        public string ShortDisplay
        {
            get { return (Running ? "● " : "") + (string.IsNullOrEmpty(Title) ? SessionId : Title); }
        }

        /// <summary>所属项目（会话的工作目录名）。用于在下拉里做层级分组。</summary>
        public string Project;

        /// <summary>
        /// 下拉里显示的文字。
        ///
        /// 用户反馈"选择对话的时候没有层级" —— 真机上 385 个会话大量同名，
        /// 平铺一串根本选不出来。所以带上**项目前缀**形成层级观感：
        ///   `[demac-e2e-cef] ● 精确中文画面文字转录（OCR） · s-dup-aa`
        /// 在跑的用圆点标记，一眼看出哪个在忙。
        /// </summary>
        public string Display
        {
            get
            {
                string name = string.IsNullOrEmpty(Title) ? SessionId : Title;
                string prefix = string.IsNullOrEmpty(Project) ? "" : "[" + Project + "] ";
                return prefix + (Running ? "● " : "") + name;
            }
        }
    }

    /// <summary>
    /// 一个项目（文件夹）下的会话分组 —— 「折叠」的实现载体。
    /// `Items` 存 `_choices` 的**全局下标**，选中后直接回查，避免复制对象。
    /// </summary>
    internal sealed class SessionGroup
    {
        public string Name;
        public List<int> Items = new List<int>();
    }
}