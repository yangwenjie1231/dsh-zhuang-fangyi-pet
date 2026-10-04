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
        public double Scale = 1.0;         // --scale 0.5~2.0
        public double Opacity = 1.0;       // --opacity 0.3~1.0
        public bool HasPos;                // --x/--y 是否给出
        public int X;
        public int Y;
        public bool Topmost = true;        // --topmost 0|1
        public bool ClickThrough = true;   // --click-through 0|1
        public bool BubbleEnabled = true;  // --bubble 0|1
        public bool SelfTest;              // --selftest
        public bool Verbose;               // --verbose（未在契约中，纯诊断；默认不额外输出）
        public bool Help;                  // --help

        // 未在契约 §5 中、但为「不依赖素材管线也能跑通」而设的本地兜底路径。
        // Host 永远不会传；只在 --url 缺省（离线）时有意义。
        public string ArtDir;
        public string ArtUrl;

        public const double ScaleMin = 0.5;
        public const double ScaleMax = 2.0;
        public const double OpacityMin = 0.3;
        public const double OpacityMax = 1.0;

        public static string Usage()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("dsh-zhuang-fangyi-pet — 庄方宜桌宠原生窗口");
            sb.AppendLine("用法: dsh-zhuang-fangyi-pet.exe [--url <base>] [--token <hex>] [--state <name>]");
            sb.AppendLine("        [--scale <0.5~2.0>] [--opacity <0.3~1.0>] [--x <int>] [--y <int>]");
            sb.AppendLine("        [--topmost 0|1] [--click-through 0|1] [--bubble 0|1]");
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
            d["selftest"] = SelfTest ? "1" : "0";
            return d;
        }
    }
}