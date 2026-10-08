using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §5 的 argv 解析结果。
    /// 退出码约定：0 正常；1 自检失败；2 互斥体被占；3 参数非法；4 素材缺失。
    /// </summary>
    internal sealed class PetOptions
    {
        public string Url;                 // --url  http://127.0.0.1:<port>   （可缺省，缺省=离线模式）
        public string Token;               // --token <48位hex>
        public string State = "waking";    // --state <petState>
        public double Scale = 1.0;         // --scale 0.3~3.0
        public double Opacity = 1.0;       // --opacity 0.3~1.0
        public bool HasPos;                // --x/--y 是否给出
        public int X;
        public int Y;
        public bool Topmost = true;        // --topmost 0|1
        public bool ClickThrough = true;   // --click-through 0|1
        public bool BubbleEnabled = true;  // --bubble 0|1
        public bool SelfTest;              // --selftest
        /// <summary>
        /// `--shots &lt;dir&gt;`：自检时把各窗口**离屏渲染**成 PNG（纯诊断，不改运行行为）。
        ///
        /// 为什么要它：视觉类改动（圆角、进度环、配色）光靠断言只能验"数值对不对"，
        /// 验不了"看起来对不对"。`RenderTargetBitmap` 渲染已排布的元素，
        /// 不需要窗口显示在屏幕上、也不抢焦点 —— 于是可以**亲眼看图**再交付。
        /// </summary>
        public string ShotsDir;
        public bool Verbose;               // --verbose（未在契约中，纯诊断；默认不额外输出）
        public bool Help;                  // --help

        /// <summary>
        /// --dark auto|0|1：深色模式覆盖（契约 §4 fileDark 的测试注入点）。
        /// null = auto（读注册表，见 PetTheme）；true/false = 强制深色/浅色。
        /// Host 不会传这个参数；只用于测试与排障。
        /// </summary>
        public bool? DarkOverride;

        // 未在契约 §5 中、但为「不依赖素材管线也能跑通」而设的本地兜底路径。
        // Host 永远不会传；只在 --url 缺省（离线）时有意义。
        public string ArtDir;
        public string ArtUrl;

        /// <summary>双击本体行为（task-6）：'focus-dsh'(默认) | 'emote' | 'none'。
        /// 实际生效值由 snapshot.settings.doubleClick 实时覆盖，本字段只是初始值。</summary>
        public string DoubleClick = "focus-dsh";

        /// <summary>
        /// 语音总开关（v8）：`--voice 0|1`。默认 **0（关）**。
        ///
        /// 为什么默认关：桌宠突然开口说话是**强打扰**，而用户点的是"加语音"
        /// 不是"一装就出声"。默认关 = 用户主动打开才生效，且设置页与托盘都能开。
        /// 实际生效值由 `snapshot.settings.voice` 实时覆盖，本字段只是初始值。
        /// </summary>
        public bool VoiceEnabled;

        // task-6：缩放范围统一 0.3~3.0（Host 侧 clamp 由 Lead 同步改）。
        public const double ScaleMin = 0.3;
        public const double ScaleMax = 3.0;
        public const double OpacityMin = 0.3;
        public const double OpacityMax = 1.0;

        /// <summary>滚轮/设置共用的缩放夹取。NaN/Infinity 一律回落 1.0（安全默认）。</summary>
        public static double ClampScale(double s)
        {
            if (double.IsNaN(s) || double.IsInfinity(s)) return 1.0;
            if (s < ScaleMin) s = ScaleMin;
            if (s > ScaleMax) s = ScaleMax;
            return s;
        }

        /// <summary>滚轮缩放一步：wheelDelta&gt;0 放大 / &lt;0 缩小 ±0.1，round 2 位消浮点漂移后夹取。
        /// 纯函数，PetWindow.OnMouseWheel 与 SelfTest 共用。</summary>
        public static double StepScale(double current, double wheelDelta)
        {
            if (wheelDelta > 0) return ClampScale(Math.Round(current + 0.1, 2));
            if (wheelDelta < 0) return ClampScale(Math.Round(current - 0.1, 2));
            return ClampScale(current);
        }

        /// <summary>透明度夹取（settings.opacity / argv 共用）。NaN/Infinity 回落 1.0。</summary>
        public static double ClampOpacity(double o)
        {
            if (double.IsNaN(o) || double.IsInfinity(o)) return 1.0;
            if (o < OpacityMin) o = OpacityMin;
            if (o > OpacityMax) o = OpacityMax;
            return o;
        }

        public static string Usage()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("dsh-zhuang-fangyi-pet — 庄方宜桌宠原生窗口");
            sb.AppendLine("用法: dsh-zhuang-fangyi-pet.exe [--url <base>] [--token <hex>] [--state <name>]");
            sb.AppendLine("        [--scale <0.3~3.0>] [--opacity <0.3~1.0>] [--x <int>] [--y <int>]");
            sb.AppendLine("        [--topmost 0|1] [--click-through 0|1] [--bubble 0|1] [--voice 0|1] [--dark auto|0|1]");
            sb.AppendLine("        [--art-dir <dir>] [--art-url <url>] [--selftest] [--verbose]");
            return sb.ToString();
        }

        /// <summary>解析失败时 out err 为人类可读原因，调用方应 exit(3)。</summary>
        public static PetOptions Parse(string[] args, out string err)
        {
            err = null;
            PetOptions o = new PetOptions();
            if (args == null) return o;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (string.IsNullOrEmpty(a)) continue;
                if (a == "--selftest") { o.SelfTest = true; continue; }
                if (a == "--shots" && i + 1 < args.Length)
                {
                    // 诊断选项：只与 --selftest 联用，不影响正常运行路径。
                    o.ShotsDir = args[++i];
                    continue;
                }
                if (a == "--verbose" || a == "-v") { o.Verbose = true; continue; }
                if (a == "--help" || a == "-h" || a == "/?") { o.Help = true; continue; }

                // 支持 --k=v 与 --k v 两种写法
                string key = a;
                string val = null;
                int eq = a.IndexOf('=');
                if (a.StartsWith("--", StringComparison.Ordinal) && eq > 2)
                {
                    key = a.Substring(0, eq);
                    val = a.Substring(eq + 1);
                }

                if (val == null)
                {
                    if (i + 1 >= args.Length)
                    {
                        err = "参数 " + key + " 缺少取值";
                        return null;
                    }
                    val = args[++i];
                }

                switch (key)
                {
                    case "--url":
                        o.Url = NormalizeBase(val);
                        if (o.Url == null) { err = "--url 不是合法 http(s) 地址: " + val; return null; }
                        break;
                    case "--token":
                        o.Token = (val == null ? "" : val.Trim());
                        break;
                    case "--state":
                        o.State = PetJson.NormalizeState(val == null ? null : val.Trim());
                        break;
                    case "--scale":
                        if (!TryDouble(val, out o.Scale)) { err = "--scale 不是数字: " + val; return null; }
                        if (o.Scale < ScaleMin || o.Scale > ScaleMax) { err = "--scale 必须在 " + ScaleMin + "~" + ScaleMax + " 之间: " + val; return null; }
                        break;
                    case "--opacity":
                        if (!TryDouble(val, out o.Opacity)) { err = "--opacity 不是数字: " + val; return null; }
                        if (o.Opacity < OpacityMin || o.Opacity > OpacityMax) { err = "--opacity 必须在 " + OpacityMin + "~" + OpacityMax + " 之间: " + val; return null; }
                        break;
                    case "--x":
                        if (!TryInt(val, out o.X)) { err = "--x 不是整数: " + val; return null; }
                        o.HasPos = true;
                        break;
                    case "--y":
                        if (!TryInt(val, out o.Y)) { err = "--y 不是整数: " + val; return null; }
                        o.HasPos = true;
                        break;
                    case "--topmost":
                        if (!TryBool(val, out o.Topmost)) { err = "--topmost 只能是 0/1: " + val; return null; }
                        break;
                    case "--click-through":
                        if (!TryBool(val, out o.ClickThrough)) { err = "--click-through 只能是 0/1: " + val; return null; }
                        break;
                    case "--bubble":
                        if (!TryBool(val, out o.BubbleEnabled)) { err = "--bubble 只能是 0/1: " + val; return null; }
                        break;
                    case "--voice":
                        if (!TryBool(val, out o.VoiceEnabled)) { err = "--voice 只能是 0/1: " + val; return null; }
                        break;
                    case "--dark":
                        if (!TryDark(val, out o.DarkOverride)) { err = "--dark 只能是 auto/0/1: " + val; return null; }
                        break;
                    case "--art-dir":
                        o.ArtDir = val;
                        break;
                    case "--art-url":
                        o.ArtUrl = NormalizeBase(val);
                        if (o.ArtUrl == null) { err = "--art-url 不是合法 http(s) 地址: " + val; return null; }
                        break;
                    default:
                        err = "未知参数: " + key;
                        return null;
                }
            }

            if (o.Url != null && string.IsNullOrEmpty(o.Token))
            {
                err = "给了 --url 就必须给 --token（契约 §3：除 hello 外所有请求都要 Bearer 令牌）";
                return null;
            }
            return o;
        }

        public static string NormalizeBase(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            s = s.Trim();
            if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return null;
            Uri u;
            if (!Uri.TryCreate(s, UriKind.Absolute, out u)) return null;
            string b = u.GetLeftPart(UriPartial.Authority);
            if (string.IsNullOrEmpty(b)) return null;
            return b;
        }

        private static bool TryDouble(string s, out double v)
        {
            v = 0;
            if (string.IsNullOrEmpty(s)) return false;
            return double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v) &&
                   !double.IsNaN(v) && !double.IsInfinity(v);
        }

        private static bool TryInt(string s, out int v)
        {
            v = 0;
            if (string.IsNullOrEmpty(s)) return false;
            return int.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
        }

        private static bool TryBool(string s, out bool v)
        {
            v = false;
            if (s == null) return false;
            switch (s.Trim())
            {
                case "1": v = true; return true;
                case "0": v = false; return true;
                default: return false;
            }
        }

        /// <summary>解析 --dark：auto → DarkOverride=null（跟随注册表）；0/1 → 强制浅色/深色。</summary>
        private static bool TryDark(string s, out bool? v)
        {
            v = null;
            if (s == null) return false;
            switch (s.Trim())
            {
                case "auto": return true;   // v 保持 null = auto
                case "1": v = true; return true;
                case "0": v = false; return true;
                default: return false;
            }
        }

        /// <summary>HTTP 基址下的完整 URL（契约 §3 前缀）。</summary>
        public string Route(string rel)
        {
            if (Url == null) return null;
            return Url + "/api/zhuang-fangyi/pet/" + rel;
        }

        public Dictionary<string, string> Describe()
        {
            Dictionary<string, string> d = new Dictionary<string, string>(StringComparer.Ordinal);
            d["url"] = Url == null ? "(offline)" : Url;
            d["token"] = string.IsNullOrEmpty(Token) ? "(none)" : ("<" + Token.Length + " chars>");
            d["state"] = State;
            d["scale"] = Scale.ToString("0.###", CultureInfo.InvariantCulture);
            d["opacity"] = Opacity.ToString("0.###", CultureInfo.InvariantCulture);
            d["pos"] = HasPos ? (X + "," + Y) : "(default)";
            d["topmost"] = Topmost ? "1" : "0";
            d["clickThrough"] = ClickThrough ? "1" : "0";
            d["bubble"] = BubbleEnabled ? "1" : "0";
            d["dark"] = DarkOverride == null ? "auto" : (DarkOverride.Value ? "1" : "0");
            d["selftest"] = SelfTest ? "1" : "0";
            return d;
        }
    }
}