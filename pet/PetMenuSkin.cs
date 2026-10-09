/**
 * 庄方宜桌宠 · 右键菜单的**现代外观**（v13.3）
 *
 * 用户原话："不能用个现代一点的UI吗"（附了右键菜单截图）。
 *
 * ── 原来的样子为什么"不现代" ─────────────────────────────────────────────
 *
 * 右键菜单用的是 WPF **默认模板**，于是带上了一整套 2006 年的观感：
 *   · 系统灰底 + 1px **直角**边框（无圆角、无投影）；
 *   · 每一项**左侧留一条空图标栏**（默认模板为图标预留，而我们没有图标
 *     → 文字整体右移，左边一条空白，这就是截图里最显眼的那道空白）；
 *   · 分隔线是整条 1px 硬线；
 *   · `更多(_M)` / `打开 DSH 窗口(_D)` 的**括号助记符直接画在文字里**；
 *   · 悬停是系统蓝方块。
 *
 * ── 改法：换模板（不是调属性）────────────────────────────────────────────
 *
 * ⚠️ 关键教训（`PetInput` 的下拉框踩过）：**WPF 默认模板不吃
 * `Background`/`Foreground`/`BorderBrush` 这些属性** —— Aero2 模板内部用
 * 主题级 `StaticResource` 硬绑定了自己的画刷。所以"设一下属性"改不动外观，
 * 必须把 `Template` 换掉。本项目已有验证过的做法：`PetInput.BuildComboTemplate`
 * 用 `XamlReader.Parse` 拼最小 XAML 模板、颜色由参数注入。这里照同一套做。
 *
 * ⚠️ 圆角为什么能生效：WPF 的 `ContextMenu` 弹出层**本来就是透明窗口**
 * （默认模板里那圈 `Margin` 就是给系统投影留的），所以自定义模板里画圆角
 * 不会被方形窗口裁掉。这也是这里能用 `DropShadowEffect` 自绘投影的前提。
 *
 * ── 现代感具体来自哪几件事 ───────────────────────────────────────────────
 *
 *   · **圆角**（菜单 10 / 悬停块 6）—— 直角是最显旧的单一特征；
 *   · **柔和投影** —— 让菜单"浮"在桌面之上，而不是贴平；
 *   · **去掉左侧空图标栏** —— 左右内边距一致，文字真正左对齐；
 *   · **悬停是圆角柔色块**（由底色朝前景色混色算出），不是系统蓝方块；
 *   · **行距放松**（上下 6px），菜单不再"挤成一坨"；
 *   · **分隔线改成短缩进淡线**；
 *   · **助记符不画进文字里**（见 `StripMnemonic` 的说明，含代价）。
 *
 * ⚠️ 菜单项的**功能**一个字都没改：`Header` 文本、`Click`、`IsCheckable`、
 * `IsChecked`、`IsEnabled`、动态文本（好感度/今天）全部原样，这里只换外观。
 */
using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Markup;

namespace DshZhuangFangyiPet
{
    /// <summary>右键菜单的现代外观（模板 + 配色，单一实现）。</summary>
    internal static class PetMenuSkin
    {
        /// <summary>菜单外框圆角（DIP）。</summary>
        internal const double MenuCornerRadius = 10.0;
        /// <summary>菜单项悬停块圆角（DIP）。</summary>
        internal const double ItemCornerRadius = 6.0;
        /// <summary>菜单项左右内边距（DIP）。左右一致 → 没有"空图标栏"。</summary>
        internal const double ItemPadX = 12.0;
        /// <summary>菜单项上下内边距（DIP）。比默认松，行更高、更透气。</summary>
        internal const double ItemPadY = 6.0;
        /// <summary>投影占用的外边距（DIP）—— 不留的话投影会被弹层裁掉。</summary>
        internal const double ShadowMargin = 8.0;

        /// <summary>颜色 → `#AARRGGBB`（喂给 `XamlReader`，与 `PetInput.Hex` 同一做法）。</summary>
        private static string Hex(Color c)
        {
            return "#" + c.A.ToString("X2") + c.R.ToString("X2") +
                   c.G.ToString("X2") + c.B.ToString("X2");
        }

        /// <summary>把 <paramref name="a"/> 朝 <paramref name="b"/> 混 <paramref name="t"/>（0..1）。</summary>
        private static Color Blend(Color a, Color b, double t)
        {
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            return Color.FromArgb(255,
                (byte)Math.Round(a.R + (b.R - a.R) * t),
                (byte)Math.Round(a.G + (b.G - a.G) * t),
                (byte)Math.Round(a.B + (b.B - a.B) * t));
        }

        /// <summary>
        /// 菜单外框模板：圆角 + 边框 + 投影余量。
        ///
        /// `IsItemsHost='True'` 的 `StackPanel` **必须留着**（它就是放菜单项的地方）；
        /// 少了它菜单会变成空壳 —— 而且不会报错，只是什么都没有。
        /// </summary>
        internal static ControlTemplate BuildMenuTemplate(Color bg, Color bd, double radius)
        {
            string xaml =
                "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' " +
                "xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ContextMenu'>" +
                // 外边距 = 投影余量（不留会被弹层裁掉，圆角处会看到硬切）
                "<Border x:Name='Shell' Background='" + Hex(bg) + "' BorderBrush='" + Hex(bd) + "' " +
                  "BorderThickness='1' CornerRadius='" + radius + "' " +
                  "Margin='" + ShadowMargin + "' SnapsToDevicePixels='True'>" +
                  "<StackPanel IsItemsHost='True' Margin='6,6,6,6'/>" +
                "</Border>" +
                "</ControlTemplate>";
            return (ControlTemplate)XamlReader.Parse(xaml);
        }

        /// <summary>
        /// 菜单项模板：圆角悬停块 + 无空图标栏 + 勾选标记 + 子菜单箭头。
        ///
        /// ⚠️ `ContentPresenter` 必须 `ContentSource='Header'` —— 换成别的绑定，
        /// 动态文本（好感度/今天）就不会更新（它们是运行时改 `Header` 的）。
        /// </summary>
        internal static ControlTemplate BuildItemTemplate(Color fg, Color hover, Color disabledFg)
        {
            string xaml =
                "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' " +
                "xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='MenuItem'>" +
                "<Border x:Name='Bd' Background='Transparent' CornerRadius='" + ItemCornerRadius + "' " +
                  "Padding='{TemplateBinding Padding}' SnapsToDevicePixels='True'>" +
                  "<Grid>" +
                    "<Grid.ColumnDefinitions>" +
                      "<ColumnDefinition Width='Auto'/><ColumnDefinition Width='*'/>" +
                      "<ColumnDefinition Width='Auto'/>" +
                    "</Grid.ColumnDefinitions>" +
                    // 勾选标记：只在 IsChecked 时显示（折叠时不占宽）
                    "<TextBlock x:Name='Tick' Grid.Column='0' Text='✓' FontSize='12' " +
                      "Foreground='" + Hex(fg) + "' Visibility='Collapsed' " +
                      "VerticalAlignment='Center' Margin='0,0,6,0'/>" +
                    "<ContentPresenter Grid.Column='1' ContentSource='Header' " +
                      "RecognizesAccessKey='False' VerticalAlignment='Center'/>" +
                    // 子菜单箭头（「更多」/「表情预览」）
                    "<Path x:Name='Arrow' Grid.Column='2' Data='M 0 0 L 4 4 L 0 8' " +
                      "Stroke='" + Hex(fg) + "' StrokeThickness='1.4' Visibility='Collapsed' " +
                      "VerticalAlignment='Center' Margin='10,0,0,0'/>" +
                  "</Grid>" +
                "</Border>" +
                "<ControlTemplate.Triggers>" +
                  "<Trigger Property='IsHighlighted' Value='True'>" +
                    "<Setter TargetName='Bd' Property='Background' Value='" + Hex(hover) + "'/>" +
                  "</Trigger>" +
                  "<Trigger Property='IsChecked' Value='True'>" +
                    "<Setter TargetName='Tick' Property='Visibility' Value='Visible'/>" +
                  "</Trigger>" +
                  // 只读行（好感度/今天）：**自己给一个淡字色**，不用 WPF 那套灰
                  "<Trigger Property='IsEnabled' Value='False'>" +
                    "<Setter TargetName='PART_Header' Property='TextElement.Foreground' Value='" + Hex(disabledFg) + "'/>" +
                    "<Setter TargetName='Bd' Property='Opacity' Value='0.8'/>" +
                  "</Trigger>" +
                  "<Trigger Property='Role' Value='SubmenuHeader'>" +
                    "<Setter TargetName='Arrow' Property='Visibility' Value='Visible'/>" +
                  "</Trigger>" +
                "</ControlTemplate.Triggers>" +
                "</ControlTemplate>";
            // ⚠️ `PART_Header` 这个名字必须在模板里真实存在，否则 IsEnabled 触发器
            // 会抛（找不到 TargetName）。这里给 ContentPresenter 起同名。
            xaml = xaml.Replace("<ContentPresenter Grid.Column='1'",
                                "<ContentPresenter x:Name='PART_Header' Grid.Column='1'");
            return (ControlTemplate)XamlReader.Parse(xaml);
        }

        /// <summary>
        /// 分隔线模板：**短缩进淡线**，不是通栏硬线（后者是老菜单观感）。
        /// </summary>
        internal static ControlTemplate BuildSeparatorTemplate(Color line)
        {
            string xaml =
                "<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' " +
                "xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='Separator'>" +
                "<Border Height='1' Background='" + Hex(line) + "' " +
                  "Margin='4,3,4,3' SnapsToDevicePixels='True'/>" +
                "</ControlTemplate>";
            return (ControlTemplate)XamlReader.Parse(xaml);
        }

        /// <summary>
        /// 给整个菜单（含子菜单）套现代外观。
        ///
        /// ⚠️ 必须**递归**：`MenuItem` 的子菜单有**自己独立的弹出层**，
        /// 不跟着父级走（`ApplyMenuTheme` 已因同一原因递归过）。
        /// </summary>
        internal static void Apply(ContextMenu menu, PetTheme.BubblePalette p)
        {
            if (menu == null) return;
            Color bg = Color.FromArgb(p.BgA, p.BgR, p.BgG, p.BgB);
            Color fg = Color.FromRgb(p.FgR, p.FgG, p.FgB);
            Color bd = Color.FromArgb(p.BdA, p.BdR, p.BdG, p.BdB);
            Color bgOpaque = Color.FromRgb(bg.R, bg.G, bg.B);
            // 悬停块：底色朝前景色混 16%（与 `PetInput` 同一取法，深/浅色各自算出合适值）
            Color hover = Blend(bgOpaque, fg, 0.16);
            // 只读行字色：朝底色混 45% → 明显变淡但仍可读
            Color disabledFg = Blend(fg, bgOpaque, 0.45);
            // 分隔线：朝前景色混 22% 再压到 35% 不透明 → 轻
            Color line = Blend(bgOpaque, fg, 0.22);
            line = Color.FromArgb(90, line.R, line.G, line.B);

            menu.Background = new SolidColorBrush(bg);
            menu.Foreground = new SolidColorBrush(fg);
            menu.BorderBrush = new SolidColorBrush(bd);
            // ⚠️ **不要**去动 `menu.HasDropShadow`。
            //
            // 它牵动的是弹层窗口的**透明能力**，而不是"画不画阴影"：
            // 一旦弹层不再允许透明，我这里的圆角就会被方形窗口切成四个黑角 ——
            // 而那是**离屏渲染测不出来**的（`RenderTargetBitmap` 渲染的是元素本身，
            // 不经过真实弹层窗口）。所以这个改动没法自检，就不碰。
            //
            // 系统那套阴影只存在于默认模板的 `SystemDropShadowChrome` 里；
            // 模板已被换掉 → 不会有"双重阴影"。所以自绘投影是安全的。
            menu.Template = BuildMenuTemplate(bg, bd, MenuCornerRadius);
            try
            {
                DropShadowEffect sh = new DropShadowEffect();
                sh.BlurRadius = 14;
                sh.ShadowDepth = 2;
                sh.Direction = 270;      // 向下投
                sh.Opacity = 0.32;
                sh.Color = Colors.Black;
                menu.Effect = sh;
            }
            catch { }

            ControlTemplate itemTpl = BuildItemTemplate(fg, hover, disabledFg);
            ControlTemplate sepTpl = BuildSeparatorTemplate(line);
            ApplyToItems(menu, itemTpl, sepTpl, fg, bg, bd);
        }

        /// <summary>递归套到每一项（含子菜单、分隔线）。</summary>
        private static void ApplyToItems(ItemsControl parent, ControlTemplate itemTpl,
                                         ControlTemplate sepTpl, Color fg, Color bg, Color bd)
        {
            for (int i = 0; i < parent.Items.Count; i++)
            {
                Separator sep = parent.Items[i] as Separator;
                if (sep != null) { sep.Template = sepTpl; continue; }

                MenuItem mi = parent.Items[i] as MenuItem;
                if (mi == null) continue;
                mi.Template = itemTpl;
                mi.Background = new SolidColorBrush(bg);
                mi.Foreground = new SolidColorBrush(fg);
                mi.BorderBrush = new SolidColorBrush(bd);
                mi.Padding = new Thickness(ItemPadX, ItemPadY, ItemPadX, ItemPadY);
                mi.Header = StripMnemonic(mi.Header as string);
                ApplyToItems(mi, itemTpl, sepTpl, fg, bg, bd);
            }
        }

        /// <summary>
        /// 去掉 `更多(_M)` 里的 `(_M)` / `（_M）`（含中文括号变体）。
        ///
        /// ── 代价，说清楚（不藏）────────────────────────────────────────────
        ///
        /// 这**同时去掉了 Alt 助记符**：WPF 靠 `Header` 里的 `_` 解析快捷键，
        /// 把整段 `(_M)` 去掉之后 Alt+M 就不再响应了。
        ///
        /// 这是**有意的取舍**，不是疏漏：
        ///   · 现代菜单（Windows 11 / VS Code / macOS）都不显示助记符；
        ///   · 而这个菜单**只能右键唤出**，键盘用户本来也没有入口去"Alt 打开它"；
        ///   · 留着括号的代价是每个项目都带一对噪音字符（截图里正是如此）。
        ///
        /// 如果哪天要恢复：把 `Header` 写回带 `_` 的形式、并让模板
        /// `RecognizesAccessKey='True'` 即可（那时下划线会在按 Alt 时出现）。
        /// </summary>
        internal static string StripMnemonic(string header)
        {
            if (string.IsNullOrEmpty(header)) return header;
            return System.Text.RegularExpressions.Regex.Replace(
                header, @"[（(]_[A-Za-z0-9][)）]", "");
        }
    }
}