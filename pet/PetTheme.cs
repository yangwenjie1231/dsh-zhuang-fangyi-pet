using System;
using System.Globalization;
using Microsoft.Win32;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §4 `fileDark`：深色模式检测（由**渲染方**自行判断 —— 只有渲染方知道实际主题）。
    ///
    /// 数据源：HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme
    ///   * 0 → 系统应用用深色
    ///   * 1 或**读不到** → 浅色（安全侧：读不到按浅色，原始素材不丢信息）
    ///
    /// 铁律：**必须捕获全部异常**。注册表键不存在 / 无权限 / 值类型意外时绝不能崩，
    /// 一律按浅色处理。命令行 `--dark 0|1` 可强制覆盖（`auto` = 跟随注册表）。
    /// </summary>
    internal static class PetTheme
    {
        private const string PersonalizePath =
            @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
        private const string AppsUseLightTheme = "AppsUseLightTheme";

        /// <summary>
        /// 读注册表判断系统是否用深色应用模式。
        /// 任何异常 / 读不到 / 值非数值 → 返回 false（浅色，安全侧）。
        /// </summary>
        public static bool SystemPrefersDark()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(PersonalizePath))
                {
                    if (k == null) return false;           // 键不存在（老系统 / 策略限制）
                    object v = k.GetValue(AppsUseLightTheme, null);
                    if (v == null) return false;           // 值不存在
                    try
                    {
                        // REG_DWORD 装箱为 int；REG_SZ 数字串 Convert 也能吃；
                        // 其它类型（如 byte[]）抛异常 → 内层 catch → 浅色。
                        return Convert.ToInt32(v, CultureInfo.InvariantCulture) == 0;
                    }
                    catch
                    {
                        return false;
                    }
                }
            }
            catch
            {
                // 无权限 / 注册表不可用等一切意外：浅色，绝不崩。
                return false;
            }
        }

        /// <summary>
        /// 最终深色判定：forced 非空（--dark 1/0）用覆盖值；否则跟随注册表。
        /// </summary>
        public static bool IsDark(bool? forced)
        {
            if (forced.HasValue) return forced.Value;
            return SystemPrefersDark();
        }

        /// <summary>
        /// task-6：settings.theme 的优先级解析。
        /// **argv `--dark 0|1`（测试用，最高）&gt; settings.theme（'light'/'dark'）&gt; 注册表**。
        /// settingsTheme 为 null/'auto'/非法 → 跳过该级跟随注册表
        /// （NormalizeTheme 已把非法值归一为 auto，这里再兜一次底）。
        /// 纯函数，SelfTest 直接测优先级矩阵。
        /// </summary>
        public static bool ResolveIsDark(bool? argvOverride, string settingsTheme)
        {
            if (argvOverride.HasValue) return argvOverride.Value;
            if (settingsTheme == "dark") return true;
            if (settingsTheme == "light") return false;
            return SystemPrefersDark();
        }

        /// <summary>
        /// 契约 §4：气泡选图。深色且给了非空变体 → 用变体；否则用原图。
        /// 纯函数（无 IO），Program 与 SelfTest 共用，保证自检测的就是运行路径。
        /// </summary>
        public static string SelectBubbleImageRel(bool wantsImage, string image, string imageDark, bool dark)
        {
            if (!wantsImage) return null;
            if (dark && !string.IsNullOrEmpty(imageDark)) return imageDark;
            return string.IsNullOrEmpty(image) ? null : image;
        }

        /// <summary>
        /// 气泡外壳配色（深/浅两套）。
        ///
        /// **为什么需要**：气泡原来把颜色写死成浅色（白底 + 深灰字）。用户的桌面是深色时，
        /// 那个白框会非常刺眼 —— 而设置里明明有"贴纸深浅色"，它却只管贴纸图、不管气泡壳。
        /// 这里让气泡外壳也跟随同一个 `theme` 判定（argv &gt; settings.theme &gt; 注册表）。
        ///
        /// 深色用**深灰蓝**而不是纯黑：纯黑浮在深色桌面上会像一块洞，灰蓝更像"卡片"。
        /// </summary>
        internal sealed class BubblePalette
        {
            /// <summary>气泡底（浅色：近白；深色：深灰蓝）。</summary>
            public byte BgA, BgR, BgG, BgB;
            /// <summary>气泡边框。</summary>
            public byte BdA, BdR, BdG, BdB;
            /// <summary>正文颜色。</summary>
            public byte FgR, FgG, FgB;
            /// <summary>普通气泡用的强调描边（attention 另有专用橙色）。</summary>
            public byte AccR, AccG, AccB;

            public static BubblePalette For(bool dark)
            {
                BubblePalette p = new BubblePalette();
                if (dark)
                {
                    p.BgA = 238; p.BgR = 38; p.BgG = 44; p.BgB = 58;      // 深灰蓝卡片
                    p.BdA = 200; p.BdR = 86; p.BdG = 104; p.BdB = 140;    // 冷灰蓝边框
                    p.FgR = 232; p.FgG = 236; p.FgB = 244;                // 近白字
                    p.AccR = 120; p.AccG = 170; p.AccB = 255;
                }
                else
                {
                    p.BgA = 238; p.BgR = 255; p.BgG = 255; p.BgB = 255;   // 近白卡片
                    p.BdA = 210; p.BdR = 120; p.BdG = 160; p.BdB = 220;
                    p.FgR = 28; p.FgG = 34; p.FgB = 48;                   // 深灰字
                    p.AccR = 62; p.AccG = 108; p.AccB = 200;
                }
                return p;
            }
        }
    }
}
