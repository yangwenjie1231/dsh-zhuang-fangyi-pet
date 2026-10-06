using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §4：素材清单 art/pet/pet.json 的极简解析器（手写，不依赖任何 JSON 库）。
    /// 只解析需要的字段，容错优先：任何字段缺失/类型不符都不抛异常，退化为 null/默认值。
    /// </summary>
    internal static class PetJson
    {
        /// <summary>契约 §1 的九个合法状态名。</summary>
        public static readonly string[] AllStates = new string[]
        {
            "waking", "idle", "listening", "thinking", "working",
            "waiting", "happy", "error", "sleeping"
        };

        private static readonly HashSet<string> StateSet = BuildStateSet();

        private static HashSet<string> BuildStateSet()
        {
            HashSet<string> s = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < AllStates.Length; i++) s.Add(AllStates[i]);
            return s;
        }

        public static bool IsKnownState(string name)
        {
            return name != null && StateSet.Contains(name);
        }

        // ------------------------------------------------------------------
        // 最小 JSON 模型
        // ------------------------------------------------------------------

        public sealed class JVal
        {
            public const int TNull = 0;
            public const int TBool = 1;
            public const int TNum = 2;
            public const int TStr = 3;
            public const int TArr = 4;
            public const int TObj = 5;

            public int Kind = TNull;
            public bool BoolVal;
            public double NumVal;
            public string StrVal;
            public List<JVal> Arr = new List<JVal>();
            public Dictionary<string, JVal> Obj = new Dictionary<string, JVal>(StringComparer.Ordinal);

            public bool IsNull { get { return Kind == TNull; } }
            public bool IsObj { get { return Kind == TObj; } }
            public bool IsArr { get { return Kind == TArr; } }
            public bool IsStr { get { return Kind == TStr; } }

            public JVal Get(string key)
            {
                if (Kind != TObj || key == null) return null;
                JVal v;
                if (Obj.TryGetValue(key, out v)) return v;
                return null;
            }

            public string Str(string key, string dflt)
            {
                JVal v = Get(key);
                if (v == null || !v.IsStr) return dflt;
                return v.StrVal;
            }

            public double Num(string key, double dflt)
            {
                JVal v = Get(key);
                if (v == null) return dflt;
                if (v.Kind == TNum) return v.NumVal;
                if (v.Kind == TBool) return v.BoolVal ? 1 : 0;
                return dflt;
            }

            public int Int(string key, int dflt)
            {
                double d = Num(key, double.NaN);
                if (double.IsNaN(d)) return dflt;
                if (d > int.MaxValue) return int.MaxValue;
                if (d < int.MinValue) return int.MinValue;
                return (int)Math.Round(d);
            }

            public bool Bool(string key, bool dflt)
            {
                JVal v = Get(key);
                if (v == null) return dflt;
                if (v.Kind == TBool) return v.BoolVal;
                if (v.Kind == TNum) return v.NumVal != 0;
                return dflt;
            }
        }

        public static JVal Parse(string text)
        {
            if (text == null) return null;
            int i = 0;
            // 去掉 UTF-8 BOM 与前置空白
            if (text.Length > 0 && text[0] == '\uFEFF') i = 1;
            JVal v = ParseValue(text, ref i, 0);
            return v;
        }

        private const int MaxDepth = 48;

        private static JVal ParseValue(string s, ref int i, int depth)
        {
            if (depth > MaxDepth) return null;
            SkipWs(s, ref i);
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i, depth);
            if (c == '[') return ParseArray(s, ref i, depth);
            if (c == '"')
            {
                JVal v = new JVal();
                v.Kind = JVal.TStr;
                v.StrVal = ParseString(s, ref i);
                return v;
            }
            if (c == 't' && Match(s, i, "true"))
            {
                i += 4; JVal v = new JVal(); v.Kind = JVal.TBool; v.BoolVal = true; return v;
            }
            if (c == 'f' && Match(s, i, "false"))
            {
                i += 5; JVal v = new JVal(); v.Kind = JVal.TBool; v.BoolVal = false; return v;
            }
            if (c == 'n' && Match(s, i, "null"))
            {
                i += 4; return new JVal();
            }
            return ParseNumber(s, ref i);
        }

        private static bool Match(string s, int i, string lit)
        {
            if (i + lit.Length > s.Length) return false;
            return string.CompareOrdinal(s, i, lit, 0, lit.Length) == 0;
        }

        private static JVal ParseObject(string s, ref int i, int depth)
        {
            JVal v = new JVal();
            v.Kind = JVal.TObj;
            i++; // '{'
            while (true)
            {
                SkipWs(s, ref i);
                if (i >= s.Length) return v;
                if (s[i] == '}') { i++; return v; }
                if (s[i] == ',') { i++; continue; }
                if (s[i] != '"') { i++; continue; }
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i < s.Length && s[i] == ':') i++;
                JVal val = ParseValue(s, ref i, depth + 1);
                if (key != null && val != null && !v.Obj.ContainsKey(key)) v.Obj[key] = val;
            }
        }

        private static JVal ParseArray(string s, ref int i, int depth)
        {
            JVal v = new JVal();
            v.Kind = JVal.TArr;
            i++; // '['
            while (true)
            {
                SkipWs(s, ref i);
                if (i >= s.Length) return v;
                if (s[i] == ']') { i++; return v; }
                if (s[i] == ',') { i++; continue; }
                JVal val = ParseValue(s, ref i, depth + 1);
                if (val == null)
                {
                    i++;
                    continue;
                }
                v.Arr.Add(val);
            }
        }

        private static string ParseString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '"') { i++; return sb.ToString(); }
                if (c == '\\')
                {
                    i++;
                    if (i >= s.Length) break;
                    char e = s[i];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            {
                                int code = 0;
                                bool ok = true;
                                for (int k = 1; k <= 4; k++)
                                {
                                    if (i + k >= s.Length) { ok = false; break; }
                                    int d = HexVal(s[i + k]);
                                    if (d < 0) { ok = false; break; }
                                    code = code * 16 + d;
                                }
                                if (ok) { sb.Append((char)code); i += 4; }
                                else { sb.Append('u'); }
                                break;
                            }
                        default: sb.Append(e); break;
                    }
                    i++;
                    continue;
                }
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }

        private static int HexVal(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        private static JVal ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length)
            {
                char c = s[i];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' ||
                    c == 'e' || c == 'E') i++;
                else break;
            }
            JVal v = new JVal();
            if (i == start)
            {
                v.Kind = JVal.TNull;
                i++;
                return v;
            }
            double d;
            string raw = s.Substring(start, i - start);
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
            {
                v.Kind = JVal.TNum;
                v.NumVal = d;
            }
            return v;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length)
            {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') i++;
                else break;
            }
        }

        // ------------------------------------------------------------------
        // 契约 §4 结构
        // ------------------------------------------------------------------

        public sealed class StateEntry
        {
            public string State;
            public string File;
            public int Frames = 1;
            public int FrameMs = 100;
            public double AnchorY = 1.0;
            /// <summary>
            /// 契约 §4：每状态单帧像素宽。0 = 清单未给（用图片实测推导）。
            /// 用途：图片加载前即可算出正确窗口占位尺寸（避免首帧尺寸闪动），
            /// 以及做自洽性校验（见 PetSprite.GetSheet）。
            /// 注意：frameHeight 是**帧高**，不是帧宽——单帧非方形，条带宽 = frames × frameWidth。
            /// </summary>
            public int FrameWidth;
        }

        public sealed class BubbleEntry
        {
            public string File;
            public int W;
            public int H;

            /// <summary>
            /// 契约 §4 v-next：气泡**动图**的帧数。缺省 1 = 静态（旧清单零改动）。
            /// 帧由渲染方从 GIF 文件里解（`PetSpriteStore.GetBubbleFrames`）——
            /// 这里只声明"应该有几帧"，用来决定要不要启动动画。
            /// </summary>
            public int Frames = 1;

            /// <summary>
            /// 帧间隔（ms）。**统一值**，与精灵条带的 `frameMs` 同一套约定：
            /// 不去读 GIF 每帧自己的延时（元数据查询可能返回 null，多一处不确定性；
            /// 实际素材是 30/60ms 交错，取中位数 30ms 的视觉节奏已经对）。
            /// </summary>
            public int FrameMs = 100;
        }

        /// <summary>
        /// 契约 §4 新增：顶层 `files` 映射里**单个文件自己**的几何。
        /// 这是解决「variants 里的文件与 states 声明几何不符」的正解：
        /// 变体各有各的 frames/frameWidth，不再套用 canonical 的声明。
        /// </summary>
        public sealed class FileGeom
        {
            /// <summary>0 = 清单未给该文件的帧数（此时回落到 states 声明）。</summary>
            public int Frames;
            /// <summary>0 = 清单未给该文件的单帧宽（此时回落 states 声明，再回落图片实测）。</summary>
            public int FrameWidth;
            /// <summary>0 = 清单未给该文件的帧间隔（此时回落 states 声明）。</summary>
            public int FrameMs;

            public bool HasFrames { get { return Frames > 0; } }
            public bool HasFrameWidth { get { return FrameWidth > 0; } }
            public bool HasFrameMs { get { return FrameMs > 0; } }
        }

        public sealed class MissingEntry
        {
            public string Name;
            public string Reason;
        }

        public sealed class Atlas
        {
            public int Version = 1;
            public string GeneratedAt;
            public int FrameHeight = 256;
            public Dictionary<string, StateEntry> States = new Dictionary<string, StateEntry>(StringComparer.Ordinal);
            public Dictionary<string, List<string>> Variants = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            /// <summary>
            /// 契约 §4 新增（附加字段，向后兼容）：每个条带文件**自己**的几何。
            /// 键是相对 art/pet 的文件名（与 states.file / variants 里的写法一致）。
            /// 旧清单没有这个字段 → 字典为空，一切照旧走 states 声明 + 图片实测。
            /// </summary>
            public Dictionary<string, FileGeom> Files = new Dictionary<string, FileGeom>(StringComparer.OrdinalIgnoreCase);
            public List<BubbleEntry> Bubble = new List<BubbleEntry>();
            public List<MissingEntry> Missing = new List<MissingEntry>();

            /// <summary>states、variants、files 中所有引用到的文件名（用于校验/缓存清单）。</summary>
            public List<string> AllReferencedFiles()
            {
                List<string> list = new List<string>();
                HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (KeyValuePair<string, StateEntry> kv in States)
                {
                    if (kv.Value != null && !string.IsNullOrEmpty(kv.Value.File) && seen.Add(kv.Value.File))
                        list.Add(kv.Value.File);
                }
                foreach (KeyValuePair<string, List<string>> kv in Variants)
                {
                    if (kv.Value == null) continue;
                    for (int i = 0; i < kv.Value.Count; i++)
                    {
                        string f = kv.Value[i];
                        if (!string.IsNullOrEmpty(f) && seen.Add(f)) list.Add(f);
                    }
                }
                foreach (KeyValuePair<string, FileGeom> kv in Files)
                {
                    if (!string.IsNullOrEmpty(kv.Key) && seen.Add(kv.Key)) list.Add(kv.Key);
                }
                for (int i = 0; i < Bubble.Count; i++)
                {
                    if (Bubble[i] != null && !string.IsNullOrEmpty(Bubble[i].File) && seen.Add(Bubble[i].File))
                        list.Add(Bubble[i].File);
                }
                return list;
            }

            /// <summary>查某个文件自己的几何；没有则返回 null。</summary>
            public FileGeom GeomFor(string file)
            {
                if (string.IsNullOrEmpty(file)) return null;
                FileGeom g;
                if (Files.TryGetValue(file, out g)) return g;
                return null;
            }
        }

        /// <summary>解析 pet.json。返回 null 表示不是合法 JSON 对象。</summary>
        /// <summary>
        /// 解析 `GET /pet/gallery` 的响应 → 表情清单。
        ///
        /// **绝不抛**：任何异常/形状不符都返回 null，由调用方显示"清单不合法"。
        /// 画廊是浏览入口，宁可少显示也不能崩。
        /// </summary>
        public static List<PetGalleryItem> ParseGallery(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try
            {
                JVal root = Parse(text);
                if (root == null || !root.IsObj) return null;
                JVal arr = root.Get("items");
                if (arr == null || !arr.IsArr) return null;
                List<PetGalleryItem> list = new List<PetGalleryItem>();
                for (int i = 0; i < arr.Arr.Count; i++)
                {
                    JVal v = arr.Arr[i];
                    if (v == null || !v.IsObj) continue;
                    string file = v.Str("file", null);
                    if (string.IsNullOrEmpty(file)) continue;
                    PetGalleryItem it = new PetGalleryItem();
                    it.File = file;
                    it.HasText = v.Bool("hasText", false);
                    it.Opaque = v.Bool("opaque", false);
                    it.FileDark = v.Str("fileDark", null);
                    it.Group = v.Str("group", null);
                    list.Add(it);
                }
                return list;
            }
            catch { return null; }
        }
        public static Atlas ParseAtlas(string text)
        {
            JVal root = Parse(text);
            if (root == null || !root.IsObj) return null;

            Atlas a = new Atlas();
            a.Version = root.Int("version", 1);
            a.GeneratedAt = root.Str("generatedAt", null);
            int fh = root.Int("frameHeight", 256);
            if (fh <= 0) fh = 256;
            a.FrameHeight = fh;

            JVal states = root.Get("states");
            if (states != null && states.IsObj)
            {
                foreach (KeyValuePair<string, JVal> kv in states.Obj)
                {
                    if (!IsKnownState(kv.Key)) continue; // 契约 §1：键只能是九个状态名
                    JVal sv = kv.Value;
                    if (sv == null || !sv.IsObj) continue;
                    StateEntry e = new StateEntry();
                    e.State = kv.Key;
                    e.File = sv.Str("file", null);
                    if (string.IsNullOrEmpty(e.File)) continue;
                    e.Frames = sv.Int("frames", 1);
                    if (e.Frames < 1) e.Frames = 1;
                    if (e.Frames > 4096) e.Frames = 4096;
                    e.FrameMs = sv.Int("frameMs", 100);
                    if (e.FrameMs < 1) e.FrameMs = 100;
                    e.AnchorY = sv.Num("anchorY", 1.0);
                    if (e.AnchorY < 0) e.AnchorY = 0;
                    if (e.AnchorY > 1) e.AnchorY = 1;
                    // 契约 §4 新增：每状态单帧像素宽。0 = 未给，由图片实测推导。
                    e.FrameWidth = sv.Int("frameWidth", 0);
                    if (e.FrameWidth < 0) e.FrameWidth = 0;
                    if (e.FrameWidth > 8192) e.FrameWidth = 8192;
                    a.States[kv.Key] = e;
                }
            }

            JVal variants = root.Get("variants");
            if (variants != null && variants.IsObj)
            {
                foreach (KeyValuePair<string, JVal> kv in variants.Obj)
                {
                    if (!IsKnownState(kv.Key)) continue;
                    JVal arr = kv.Value;
                    if (arr == null || !arr.IsArr) continue;
                    List<string> files = new List<string>();
                    for (int i = 0; i < arr.Arr.Count; i++)
                    {
                        JVal f = arr.Arr[i];
                        if (f != null && f.IsStr && !string.IsNullOrEmpty(f.StrVal)) files.Add(f.StrVal);
                    }
                    if (files.Count > 0) a.Variants[kv.Key] = files;
                }
            }

            // 契约 §4 新增（附加字段，向后兼容）：顶层 files → 每个文件自己的几何。
            // 旧清单没有这个键 → 跳过，Files 保持空字典。
            JVal filesMap = root.Get("files");
            if (filesMap != null && filesMap.IsObj)
            {
                foreach (KeyValuePair<string, JVal> kv in filesMap.Obj)
                {
                    string name = kv.Key;
                    if (string.IsNullOrEmpty(name)) continue;
                    JVal fv = kv.Value;
                    if (fv == null || !fv.IsObj) continue;
                    FileGeom g = new FileGeom();
                    g.Frames = fv.Int("frames", 0);
                    if (g.Frames < 0) g.Frames = 0;
                    if (g.Frames > 4096) g.Frames = 4096;
                    g.FrameWidth = fv.Int("frameWidth", 0);
                    if (g.FrameWidth < 0) g.FrameWidth = 0;
                    if (g.FrameWidth > 8192) g.FrameWidth = 8192;
                    g.FrameMs = fv.Int("frameMs", 0);
                    if (g.FrameMs < 0) g.FrameMs = 0;
                    if (g.FrameMs > 600000) g.FrameMs = 600000;
                    a.Files[name] = g;
                }
            }

            JVal bubble = root.Get("bubble");
            if (bubble != null && bubble.IsArr)
            {
                for (int i = 0; i < bubble.Arr.Count; i++)
                {
                    JVal b = bubble.Arr[i];
                    if (b == null || !b.IsObj) continue;
                    BubbleEntry e = new BubbleEntry();
                    e.File = b.Str("file", null);
                    if (string.IsNullOrEmpty(e.File)) continue;
                    e.W = b.Int("w", 0);
                    e.H = b.Int("h", 0);
                    // 动图字段（契约 §4 v-next）：缺省即静态，兼容旧清单。
                    e.Frames = b.Int("frames", 1);
                    if (e.Frames < 1) e.Frames = 1;
                    if (e.Frames > 512) e.Frames = 512;
                    e.FrameMs = b.Int("frameMs", 100);
                    if (e.FrameMs < 20) e.FrameMs = 20;
                    if (e.FrameMs > 5000) e.FrameMs = 5000;
                    a.Bubble.Add(e);
                }
            }

            JVal missing = root.Get("missing");
            if (missing != null && missing.IsArr)
            {
                for (int i = 0; i < missing.Arr.Count; i++)
                {
                    JVal m = missing.Arr[i];
                    if (m == null || !m.IsObj) continue;
                    MissingEntry e = new MissingEntry();
                    e.Name = m.Str("name", "");
                    e.Reason = m.Str("reason", "");
                    a.Missing.Add(e);
                }
            }

            return a;
        }

        /// <summary>按契约 §1 的优先级取最大值（大者胜）。未知状态按 idle(20) 计。</summary>
        public static int Priority(string state)
        {
            switch (state)
            {
                case "working": return 90;
                case "waiting": return 80;
                case "thinking": return 70;
                case "error": return 60;
                case "happy": return 50;
                case "listening": return 40;
                case "waking": return 30;
                case "idle": return 20;
                case "sleeping": return 10;
                default: return 20;
            }
        }

        public static string NormalizeState(string state)
        {
            if (IsKnownState(state)) return state;
            return "idle";
        }
    }
}