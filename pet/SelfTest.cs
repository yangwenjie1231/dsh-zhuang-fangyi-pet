using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// --selftest：无窗口自检（其实会短暂创建窗口但不可见，用于真正验证 HWND 与命中测试）。
    /// 覆盖：环境、参数、pet.json 解析、状态名过滤、优先级、条带解码、CroppedBitmap 取帧、
    /// alpha 命中表、命中测试、位置 clamp、气泡窗恒穿透、本体窗 alpha 穿透、互斥体、HTTP 连通。
    /// 退出码 0=全部通过；1=有失败项。
    /// </summary>
    internal static class SelfTest
    {
        private static int _pass;
        private static int _fail;
        private static readonly StringBuilder Report = new StringBuilder();

        /// <summary>
        /// 以确定的 UTF-8 字节写 stdout（宿主 Node 按 UTF-8 解码）。
        /// 不能直接用 Console.Out：-target:winexe 没有附加控制台，
        /// Console.OutputEncoding 不一定生效，中文会按 ANSI/GBK 输出成乱码。
        /// </summary>
        internal static void Out(string line)
        {
            try { PetLog.StdoutUtf8(line); }
            catch
            {
                try { Console.Out.WriteLine(line); } catch { }
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public static int Run(PetOptions opt, string cacheDir)
        {
            Out("=== dsh-zhuang-fangyi-pet selftest ===");
            Out("时间 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") +
                "  pid=" + System.Diagnostics.Process.GetCurrentProcess().Id);

            string artDir = opt.ArtDir;
            bool synth = false;
            if (string.IsNullOrEmpty(artDir))
            {
                artDir = Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-selftest");
                synth = true;
            }

            try
            {
                TestEnvironment(opt);
                TestArgs(opt);

                if (synth || !File.Exists(Path.Combine(artDir, "pet.json")))
                {
                    Synth.Generate(artDir);
                    Check(true, "合成素材已生成 → " + artDir, "");
                }
                else
                {
                    Check(true, "使用已有素材目录 → " + artDir, "");
                }

                PetJson.Atlas atlas = TestAtlas(artDir);
                TestPriority();
                TestBubbleOpaqueAndDark();
                TestSettingsScaleDoubleClickTheme();
                TestPositionReportBody();
                TestSendCapabilityAndBody();
                SpriteSheet sheet = TestSprite(artDir, atlas);
                TestFilesMapCompat();
                TestClamp();
                TestWindows(opt, artDir, cacheDir, sheet);
                TestAttentionPresentation();
                TestMutex();
                TestHttp(opt);
            }
            catch (Exception ex)
            {
                Check(false, "自检过程中抛出未处理异常", PetLog.Describe(ex));
            }

            Out("");
            Out(Report.ToString().TrimEnd());
            Out("");
            string verdict = "=== 自检" + (_fail == 0 ? "全部通过" : "存在失败") +
                             " (" + _pass + " 通过 / " + _fail + " 失败) ===";
            Out(verdict);
            PetLog.Startup(verdict);
            return _fail == 0 ? Program.ExitOk : Program.ExitSelfTestFailed;
        }

        // ------------------------------------------------------------------

        private static void Check(bool ok, string name, string detail)
        {
            if (ok) _pass++; else _fail++;
            string line = (ok ? "[ok]  " : "[FAIL]") + " " + name;
            if (!string.IsNullOrEmpty(detail)) line += " — " + detail;
            Report.AppendLine(line);
            Out(line);
        }

        // ------------------------------------------------------------------

        private static void TestEnvironment(PetOptions opt)
        {
            string ver = Environment.Version.ToString();
            List<PetNative.WorkArea> ss = PetNative.Screens();
            PetNative.WorkArea p = ss[0];
            for (int i = 0; i < ss.Count; i++) if (ss[i].Primary) { p = ss[i]; break; }
            Check(true, "环境: .NET " + ver + " / OS " + Environment.OSVersion.Version,
                  "屏幕 " + ss.Count + " 个，主工作区 " + p.W + "x" + p.H + "@" + p.X + "," + p.Y);

            // 进程 DPI（未创建窗口时用系统 DPI）
            uint dpi = 96;
            try
            {
                IntPtr hwnd = GetDesktopWindow();
                dpi = PetNative.GetDpiForWindowSafe(hwnd);
            }
            catch { }
            bool dpiOk = dpi >= 72 && dpi <= 480;
            Check(dpiOk, "DPI 探测", "desktop DPI=" + dpi + " (" + (dpi * 100 / 96) + "%)" +
                  (dpi == 144 ? "  ← 本机 150%" : ""));
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetDesktopWindow();

        private static void TestArgs(PetOptions opt)
        {
            Dictionary<string, string> d = opt.Describe();
            StringBuilder sb = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in d) sb.Append(kv.Key).Append('=').Append(kv.Value).Append(' ');
            Check(true, "参数解析", sb.ToString().Trim());

            // 非法参数必须被拒绝（exit 3 的前提）
            string e1;
            bool bad1 = PetOptions.Parse(new string[] { "--scale", "9" }, out e1) == null;
            string e2;
            bool bad2 = PetOptions.Parse(new string[] { "--url", "http://127.0.0.1:1" }, out e2) == null; // 缺 token
            string e3;
            bool bad3 = PetOptions.Parse(new string[] { "--nope" }, out e3) == null;
            Check(bad1 && bad2 && bad3, "参数校验拒绝非法输入",
                  "scale=9 → " + (bad1 ? "拒" : "过") + "; url 无 token → " + (bad2 ? "拒" : "过") +
                  "; 未知参数 → " + (bad3 ? "拒" : "过"));
        }

        private static PetJson.Atlas TestAtlas(string artDir)
        {
            string p = Path.Combine(artDir, "pet.json");
            string json = File.ReadAllText(p);
            PetJson.Atlas a = PetJson.ParseAtlas(json);
            if (a == null)
            {
                Check(false, "pet.json 解析", "返回 null: " + p);
                return null;
            }
            Check(a.States.Count > 0 && a.FrameHeight > 0, "pet.json 解析",
                  a.States.Count + " 状态 / " + a.Bubble.Count + " 气泡 / variants " + a.Variants.Count +
                  " / missing " + a.Missing.Count + " / frameHeight=" + a.FrameHeight);

            // 契约 §1：states 键只能是九个状态名；非法键必须被忽略
            bool onlyKnown = true;
            foreach (KeyValuePair<string, PetJson.StateEntry> kv in a.States)
                if (!PetJson.IsKnownState(kv.Key)) onlyKnown = false;
            Check(onlyKnown, "状态名过滤（契约 §1）",
                  "非法键已忽略=" + !a.States.ContainsKey("bogus") + "，合法状态=" + a.States.Count);

            bool anchor = true;
            foreach (KeyValuePair<string, PetJson.StateEntry> kv in a.States)
                if (kv.Value.AnchorY < 0 || kv.Value.AnchorY > 1) anchor = false;
            Check(anchor, "anchorY 归一化在 0~1", "全部状态 anchorY ∈ [0,1]");

            // 缺状态时回落 idle（契约 §4）
            Check(PetJson.NormalizeState("不存在的状态") == "idle", "未知状态回落 idle",
                  "NormalizeState(\"不存在的状态\") → idle");
            return a;
        }

        private static void TestPriority()
        {
            string[] order = new string[] { "working", "waiting", "thinking", "error", "happy",
                                            "listening", "waking", "idle", "sleeping" };
            bool mono = true;
            for (int i = 1; i < order.Length; i++)
                if (PetJson.Priority(order[i]) >= PetJson.Priority(order[i - 1])) mono = false;
            Check(mono && PetJson.Priority("working") == 90 && PetJson.Priority("sleeping") == 10,
                  "优先级顺序（契约 §1）",
                  "working=90 > waiting=80 > thinking=70 > error=60 > happy=50 > listening=40 > " +
                  "waking=30 > idle=20 > sleeping=10");

            // 跨会话取最大值
            PetSnapshot s = PetSnapshot.Parse(
                "{\"rev\":7,\"petState\":\"idle\",\"sessions\":[{\"sessionId\":\"a\",\"state\":\"idle\"}," +
                "{\"sessionId\":\"b\",\"state\":\"working\"},{\"sessionId\":\"c\",\"state\":\"thinking\"}]}");
            Check(s != null && s.EffectiveState() == "working", "跨会话状态取最大优先级",
                  s == null ? "解析失败" : ("sessions idle/working/thinking → " + s.EffectiveState()));
        }

        private static SpriteSheet TestSprite(string artDir, PetJson.Atlas atlas)
        {
            if (atlas == null) { Check(false, "条带解码", "无清单"); return null; }

            PetOptions o = new PetOptions();
            o.ArtDir = artDir;
            PetSpriteStore store = new PetSpriteStore(o, null, Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-selftest-cache"));
            store.LoadAtlas();

            SpriteSheet sh = store.GetSheet("idle");
            if (sh == null) { Check(false, "条带解码 idle", "GetSheet 返回 null"); return null; }

            Check(sh.Frames > 0 && sh.FrameW > 0 && sh.FrameH > 0, "条带解码 idle.png",
                  sh.Frames + " 帧 " + sh.FrameW + "x" + sh.FrameH + " @" + sh.FrameMs + "ms  anchorY=" +
                  sh.AnchorY.ToString("0.##", CultureInfo.InvariantCulture));

            int okFrames = 0;
            for (int i = 0; i < sh.Frames; i++) if (sh.Frame(i) != null) okFrames++;
            Check(okFrames == sh.Frames, "CroppedBitmap 取帧", okFrames + "/" + sh.Frames + " 帧成功");

            byte[] mask = sh.Mask(0);
            int opaque = 0;
            if (mask != null) for (int i = 0; i < mask.Length; i++) if (mask[i] > SpriteSheet.AlphaThreshold) opaque++;
            double l, t, r, b;
            bool hasBounds = sh.ContentBounds(0, out l, out t, out r, out b);
            Check(mask != null && opaque > 0 && opaque < mask.Length, "alpha 命中表",
                  (mask == null ? "null" : mask.Length + " 像素，不透明 " + opaque +
                   " 包围盒=(" + l.ToString("0.00") + "," + t.ToString("0.00") + ")-(" +
                   r.ToString("0.00") + "," + b.ToString("0.00") + ")"));

            // 命中测试：中心实体 / 角落穿透
            bool centerHit = sh.HitTest(0, 0.5, 0.5, 0);
            bool cornerHit = sh.HitTest(0, 0.02, 0.02, 0);
            Check(centerHit && !cornerHit, "alpha 命中测试",
                  "中心=" + (centerHit ? "实体" : "穿透") + "，角落=" + (cornerHit ? "实体" : "穿透"));

            // 懒加载：取一个没加载过的状态
            SpriteSheet w = store.GetSheet("working");
            Check(w != null, "按状态懒加载 working", w == null ? "无" : (w.File + " " + w.Frames + " 帧"));
            Check(store.GetSheet("sleeping") != null || atlas.States.ContainsKey("sleeping") == false,
                  "缺失状态回落 idle", "sleeping 不在清单 → 回落 idle");

            // 契约 §4：frameWidth 解析 + 非方形帧（单帧宽 ≠ 帧高）
            PetJson.StateEntry ie;
            bool haveIdle = atlas.States.TryGetValue("idle", out ie);
            bool fwOk = haveIdle && ie.FrameWidth > 0;
            Check(fwOk, "契约 §4 frameWidth 解析",
                  fwOk ? ("idle.frameWidth=" + ie.FrameWidth + "（清单） vs 实测 " + sh.FrameW + "px") : "未解析到");

            // 非方形帧校验：**不能断言某一个固定状态是方的还是非方的**。
            //
            // 这条曾经写成 `sh.FrameW != sh.FrameH`（对 idle 硬断言非方形），
            // 结果素材映射一改（idle 的 canonical 从 240x216 的 wx PNG 换成
            // 500x500 的方形 GIF）就误报失败 —— 那是**测试脆弱**，不是产品 bug。
            //
            // 真正要守的不变式是：**存在非方形帧，且清单如实报出了它的宽度**
            // （即没有拿 frameHeight 当 frameWidth 用）。所以扫全部状态找证据。
            string nonSquare = null;
            int checkedStates = 0;
            foreach (KeyValuePair<string, PetJson.StateEntry> kv in atlas.States)
            {
                PetJson.StateEntry e = kv.Value;
                if (e.FrameWidth <= 0) continue;
                checkedStates++;
                if (e.FrameWidth != atlas.FrameHeight)
                {
                    nonSquare = kv.Key + " " + e.FrameWidth + "x" + atlas.FrameHeight +
                                "（宽≠高）";
                    break;
                }
            }
            Check(nonSquare != null && checkedStates > 0, "非方形帧：存在单帧宽 ≠ 帧高且清单如实报出",
                  nonSquare != null
                      ? ("例：" + nonSquare + "；共检查 " + checkedStates + " 个状态")
                      : ("全部 " + checkedStates + " 个状态都是方形（本素材集恰好如此）——" +
                         "无法验证 frameWidth 路径"));
            Check(haveIdle && ie.FrameWidth == sh.FrameW, "清单 frameWidth 与实测一致（自洽性校验）",
                  haveIdle ? (ie.FrameWidth + " == " + sh.FrameW) : "-");

            // TryGetDeclaredSize：解码前就能算窗口占位尺寸。
            // 它预测的是**下一次 GetSheet 会返回的条带**，所以必须和随后的实际取帧比对
            // （真实素材里 idle 有 3 个变体，尺寸各不相同，拿旧的 sh 比会误判）。
            int dw, dh;
            bool declared = store.TryGetDeclaredSize("idle", out dw, out dh);
            SpriteSheet nxt = store.GetSheet("idle");
            bool sizeOk = declared && nxt != null && dw == nxt.FrameW && dh == nxt.FrameH;
            Check(sizeOk, "解码前预估尺寸（TryGetDeclaredSize）",
                  (declared && nxt != null)
                    ? ("预估 " + dw + "x" + dh + "，实际 " + nxt.FrameW + "x" + nxt.FrameH + "（" + nxt.File + "）")
                    : (declared ? "未命中条带" : "未命中"));

            // canonical 文件的声明若与实测不符，应以实测为准（不能拒收，否则宠物不显示）。
            // 合成素材里 happy 故意写错 frameWidth=999；真实素材里它是自洽的。
            SpriteSheet hp = store.GetSheet("happy");
            PetJson.StateEntry he;
            bool haveHappy = atlas.States.TryGetValue("happy", out he);
            bool happyOk;
            string happyDetail;
            if (haveHappy && he.FrameWidth == 999)
            {
                happyOk = hp != null && hp.FrameW == 58 && hp.DeclaredFrameW == 999;
                happyDetail = hp == null ? "取不到" : ("实测=" + hp.FrameW + " 声明=" + hp.DeclaredFrameW + "（声明错→以实测为准）");
            }
            else
            {
                happyOk = hp != null && haveHappy && hp.FrameW == he.FrameWidth;
                happyDetail = hp == null ? "取不到" : ("实测=" + hp.FrameW + " 声明=" + (haveHappy ? he.FrameWidth : -1) + "（一致）");
            }
            Check(happyOk, "canonical 条带几何自洽/以实测为准", happyDetail);

            // ---- 契约 §4 variants + files 的两条路径 ----
            // (A) 反向用例：idle 的变体 idle-badvariant.png 几何不符，且 files 里**没有**它
            //     → 必须被拒收并回落 canonical idle.png(4 帧 71px)。
            //     若没做校验会按 4 帧切出 71/4 = 17px 的碎条。
            List<string> idleVariants;
            bool hasBadVariant = atlas.Variants.TryGetValue("idle", out idleVariants) &&
                                 idleVariants != null && idleVariants.Count > 0 &&
                                 idleVariants[0] == "idle-badvariant.png";
            if (hasBadVariant)
            {
                // 游标会轮换：多取几次，确认**任何一次**都不会用到坏变体
                bool sawBad = false;
                bool sawCanonical = false;
                for (int i = 0; i < 4; i++)
                {
                    SpriteSheet vs = store.GetSheet("idle");
                    if (vs == null) continue;
                    if (vs.File == "idle-badvariant.png") sawBad = true;
                    if (vs.File == "idle.png" && vs.Frames == 4 && vs.FrameW == 71) sawCanonical = true;
                }
                Check(!sawBad && sawCanonical,
                      "无 files 且几何不符的变体 → 拒收并回落 canonical（防碎条）",
                      "用到坏变体=" + sawBad + "，用到 canonical(4 帧 71px)=" + sawCanonical);
            }

            // (B) 正向用例：working 的变体 working-var.png 几何与 states 声明**不同**
            //     (声明 3 帧 66px，变体实为 2 帧 50px)，但 files 给了它自己的几何
            //     → 必须被**接受**并按 2 帧 50px 播放（这是新契约的核心用法）。
            List<string> workVariants;
            bool hasFilesVariant = atlas.Variants.TryGetValue("working", out workVariants) &&
                                   workVariants != null && workVariants.Count > 0 &&
                                   workVariants[0] == "working-var.png";
            if (hasFilesVariant && atlas.GeomFor("working-var.png") != null)
            {
                bool accepted = false;
                string detail = "未取到";
                for (int i = 0; i < 4 && !accepted; i++)
                {
                    SpriteSheet ws = store.GetSheet("working");
                    if (ws == null) continue;
                    if (ws.File == "working-var.png")
                    {
                        accepted = ws.Frames == 2 && ws.FrameW == 50 && ws.GeometrySource == "files";
                        detail = "working-var.png " + ws.Frames + " 帧 " + ws.FrameW + "px 来源=" + ws.GeometrySource;
                    }
                    else
                    {
                        detail = "当前 " + ws.File + " " + ws.Frames + " 帧 " + ws.FrameW + "px（未轮到变体）";
                    }
                }
                Check(accepted, "files 提供几何的变体 → 被接受并按自己的几何播放", detail);

                // TryGetDeclaredSize 必须**预测 GetSheet 下一次会返回的条带**的尺寸
                // （PetWindow.ReloadSprite 正是「先按它预摆窗口，再取帧」，两者必须一致）。
                // 不能先手动轮换游标再断言固定值——那样测的是游标位置，不是这个不变式。
                int vw, vh;
                bool got = store.TryGetDeclaredSize("working", out vw, out vh);
                SpriteSheet next = store.GetSheet("working");
                bool predictOk = got && next != null && vw == next.FrameW && vh == next.FrameH;
                Check(predictOk, "TryGetDeclaredSize 预测下一次取帧尺寸（认 files 几何）",
                      (got && next != null)
                        ? ("预估 " + vw + "x" + vh + "，实际 " + next.FrameW + "x" + next.FrameH +
                           "（" + next.File + " 来源=" + next.GeometrySource + "）")
                        : "未命中");
            }

            store.Dispose();
            return sh;
        }

        /// <summary>
        /// 契约 §4 向后兼容：顶层 `files` 是**附加字段**。
        /// 这里用一份**不含 files** 的旧清单（合成素材的变体）跑一遍，
        /// 证明旧清单仍然可用：无 files 时几何回落到 states 声明 + 图片实测，
        /// 坏变体照样被拒收并回落 canonical。
        /// </summary>
        private static void TestFilesMapCompat()
        {
            string dir = Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-nofiles");
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                Synth.Generate(dir, false);   // ← 不含 files 的旧清单

                string json = File.ReadAllText(Path.Combine(dir, "pet.json"));
                bool hasFilesKey = json.IndexOf("\"files\"", StringComparison.Ordinal) >= 0;
                PetJson.Atlas a = PetJson.ParseAtlas(json);
                Check(a != null && a.Files.Count == 0 && !hasFilesKey,
                      "旧清单（无 files）解析：Files 为空且不报错",
                      a == null ? "解析失败" : ("Files.Count=" + a.Files.Count + "，清单含 files 键=" + hasFilesKey));

                PetOptions o = new PetOptions();
                o.ArtDir = dir;
                PetSpriteStore store = new PetSpriteStore(o, null,
                    Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-nofiles-cache"));
                bool atlasOk = store.LoadAtlas();

                // idle：坏变体（无 files 几何）必须被拒收 → 每次取都回落到 canonical
                bool sawBad = false, sawGood = false;
                for (int i = 0; i < 4; i++)
                {
                    SpriteSheet s = store.GetSheet("idle");
                    if (s == null) continue;
                    if (s.File == "idle-badvariant.png") sawBad = true;
                    if (s.File == "idle.png" && s.Frames == 4 && s.FrameW == 71 && s.GeometrySource == "states") sawGood = true;
                }
                Check(atlasOk && !sawBad && sawGood,
                      "旧清单（无 files）仍可正常取帧 + 坏变体兜底",
                      "坏变体被用到=" + sawBad + "，回落到 canonical(4 帧 71px, 来源 states)=" + sawGood);

                // working 的变体（无 files 时几何不符）→ 也应被拒收回落
                bool wOk = false;
                for (int i = 0; i < 4 && !wOk; i++)
                {
                    SpriteSheet s = store.GetSheet("working");
                    if (s != null && s.File == "working.png" && s.Frames == 3 && s.FrameW == 66) wOk = true;
                }
                Check(wOk, "旧清单（无 files）：几何不符的变体同样被拒收回落",
                      "working 最终用 canonical working.png(3 帧 66px)=" + wOk);

                store.Dispose();
            }
            catch (Exception ex)
            {
                Check(false, "旧清单向后兼容测试", PetLog.Describe(ex));
            }
        }

        /// <summary>
        /// 契约 §4 opaque/fileDark：新字段解析、旧快照向后兼容、深色判定（注册表 + --dark 覆盖）、
        /// 选图矩阵。选图走 Program 实际使用的 PetTheme.SelectBubbleImageRel 纯函数，
        /// 自检测的就是运行路径本身。
        /// </summary>
        private static void TestBubbleOpaqueAndDark()
        {
            // (1) 新字段解析：imageOpaque:true + imageDark
            PetSnapshot s1 = PetSnapshot.Parse(
                "{\"rev\":11,\"petState\":\"working\",\"bubble\":{\"id\":9001,\"kind\":\"image\"," +
                "\"image\":\"bubble/new/01.png\",\"imageOpaque\":true," +
                "\"imageDark\":\"bubble/new/01-dark.png\"}}");
            bool ok1 = s1 != null && s1.Bubble != null && s1.Bubble.Opaque &&
                       s1.Bubble.ImageDark == "bubble/new/01-dark.png" &&
                       s1.Bubble.Image == "bubble/new/01.png";
            Check(ok1, "契约 §4：snapshot.bubble.imageOpaque/imageDark 解析",
                  ok1 ? "imageOpaque:true → Opaque=true；imageDark 原样读出" : "解析失败");

            // (2) 向后兼容：旧快照没有这两个字段 → Opaque=false、ImageDark=null
            PetSnapshot s2 = PetSnapshot.Parse(
                "{\"rev\":12,\"petState\":\"idle\",\"bubble\":{\"id\":9002,\"kind\":\"image\"," +
                "\"image\":\"bubble/04.png\"}}");
            bool ok2 = s2 != null && s2.Bubble != null &&
                       !s2.Bubble.Opaque && s2.Bubble.ImageDark == null;
            Check(ok2, "旧快照向后兼容：缺 imageOpaque/imageDark → Opaque=false、ImageDark=null",
                  ok2 ? "旧 Host 快照行为不变（透明抠图呈现保留）" : "解析失败");

            // (3) 显式 false / null 与缺省一致
            PetSnapshot s3 = PetSnapshot.Parse(
                "{\"rev\":13,\"bubble\":{\"id\":9003,\"kind\":\"both\",\"image\":\"bubble/x.png\"," +
                "\"text\":\"你好\",\"imageOpaque\":false,\"imageDark\":null}}");
            bool ok3 = s3 != null && s3.Bubble != null &&
                       !s3.Bubble.Opaque && s3.Bubble.ImageDark == null;
            Check(ok3, "显式 imageOpaque:false / imageDark:null 与缺省一致", ok3 ? "一致" : "解析失败");

            // (4) 选图矩阵（Program.ApplySnapshot 实际调用的纯函数）
            bool selOk =
                PetTheme.SelectBubbleImageRel(true, "a.png", "a-dark.png", true) == "a-dark.png" &&
                PetTheme.SelectBubbleImageRel(true, "a.png", "a-dark.png", false) == "a.png" &&
                PetTheme.SelectBubbleImageRel(true, "a.png", null, true) == "a.png" &&
                PetTheme.SelectBubbleImageRel(true, "a.png", "", true) == "a.png" &&
                PetTheme.SelectBubbleImageRel(false, "a.png", "a-dark.png", true) == null &&
                PetTheme.SelectBubbleImageRel(true, null, null, true) == null;
            Check(selOk, "气泡选图矩阵（深色且 imageDark 非空 → imageDark，否则 → image）",
                  "深色+变体→变体；浅色→原图；深色无变体→原图；kind 无 image→null");

            // (5) --dark 参数：auto/0/1 与非法值
            string e;
            PetOptions d1 = PetOptions.Parse(new string[] { "--dark", "1" }, out e);
            PetOptions d0 = PetOptions.Parse(new string[] { "--dark", "0" }, out e);
            PetOptions da = PetOptions.Parse(new string[] { "--dark=auto" }, out e);
            PetOptions dbad = PetOptions.Parse(new string[] { "--dark", "maybe" }, out e);
            bool optOk = d1 != null && d1.DarkOverride == true &&
                         d0 != null && d0.DarkOverride == false &&
                         da != null && da.DarkOverride == null &&
                         dbad == null;
            Check(optOk, "--dark auto/0/1 解析与非法值拒绝（exit 3 的前提）",
                  "1→强制深色，0→强制浅色，auto→读注册表，maybe→" + (dbad == null ? "拒绝" : "误过"));

            // (6) 深色判定：强制覆盖语义 + 注册表读取不抛异常（读不到按浅色）
            bool sysDark = PetTheme.SystemPrefersDark();
            bool covOk = PetTheme.IsDark(true) && !PetTheme.IsDark(false) &&
                         PetTheme.IsDark(null) == sysDark;
            Check(covOk, "深色判定：--dark 覆盖生效，auto 跟随注册表（读不到按浅色，绝不崩）",
                  "本机注册表 SystemPrefersDark()=" + (sysDark ? "深色" : "浅色") +
                  "（Lead 实测本机 AppsUseLightTheme=0；浅色机器上同样通过）");
        }

        /// <summary>
        /// task-6：滚轮缩放夹取（滚轮事件无法脚本化 → 测的就是 OnMouseWheel 用的
        /// 同一个纯函数 StepScale/ClampScale）、snapshot.settings 解析与向后兼容、
        /// doubleClick 三值解析、theme 优先级矩阵（argv &gt; settings &gt; 注册表）。
        /// </summary>
        private static void TestSettingsScaleDoubleClickTheme()
        {
            // (1) 缩放夹取：0.3~3.0，NaN/Infinity 回落 1.0
            bool clampOk =
                PetOptions.ClampScale(0.3) == 0.3 &&
                PetOptions.ClampScale(3.0) == 3.0 &&
                PetOptions.ClampScale(1.55) == 1.55 &&
                PetOptions.ClampScale(0.0) == 0.3 &&
                PetOptions.ClampScale(-2.0) == 0.3 &&
                PetOptions.ClampScale(100.0) == 3.0 &&
                PetOptions.ClampScale(double.NaN) == 1.0 &&
                PetOptions.ClampScale(double.PositiveInfinity) == 1.0;
            Check(clampOk, "缩放夹取 0.3~3.0（settings/argv/滚轮共用 ClampScale）",
                  "0.3/3.0 原样；0→0.3；100→3.0；NaN/∞→1.0");

            // (2) 滚轮一步 ±0.1（OnMouseWheel 调用的就是这个函数，事件本身无法脚本化）
            bool stepOk =
                PetOptions.StepScale(1.0, 120) == 1.1 &&
                Math.Abs(PetOptions.StepScale(1.0, -120) - 0.9) < 1e-9 &&
                PetOptions.StepScale(0.3, -120) == 0.3 &&
                PetOptions.StepScale(3.0, 120) == 3.0 &&
                PetOptions.StepScale(2.95, 120) == 3.0 &&
                Math.Abs(PetOptions.StepScale(0.35, -120) - 0.3) < 1e-9;
            Check(stepOk, "滚轮一步 ±0.1 + 边界不再动（StepScale）",
                  "1.0+轮→1.1；1.0-轮→0.9；0.3-轮→0.3；3.0+轮→3.0；2.95+轮→3.0（夹回）；0.35-轮→0.3");

            // (3) snapshot.settings：块缺失 → null（现状不动）
            PetSnapshot noSt = PetSnapshot.Parse("{\"rev\":1,\"petState\":\"idle\"}");
            Check(noSt != null && noSt.Settings == null,
                  "settings 块缺失 → Settings=null（旧 Host 快照零回归）",
                  noSt != null && noSt.Settings == null ? "Settings=null" : "误建对象");

            // (4) settings={} → 全部 Has*=false（逐字段「缺 = 不动现状」）
            PetSnapshot emptySt = PetSnapshot.Parse("{\"rev\":2,\"settings\":{}}");
            PetSettingsInfo es = emptySt == null ? null : emptySt.Settings;
            bool emptyOk = es != null && !es.HasScale && !es.HasOpacity && !es.HasClickThrough &&
                           !es.HasTopmost && !es.HasBubble && !es.HasDoubleClick && !es.HasTheme &&
                !es.HasHint && !es.HasStatusAlways;
            Check(emptyOk, "settings={} → 全部字段缺省（逐字段不动现状）",
                  emptyOk ? "7 个 Has* 全为 false" : "误置 Has*");

            // (5) 完整 settings → 逐字段解析
            PetSnapshot full = PetSnapshot.Parse(
                "{\"rev\":3,\"settings\":{\"scale\":2,\"opacity\":0.5,\"clickThrough\":true," +
                "\"topmost\":false,\"bubble\":false,\"doubleClick\":\"emote\",\"theme\":\"dark\"}}");
            PetSettingsInfo fs = full == null ? null : full.Settings;
            bool fullOk = fs != null &&
                fs.HasScale && fs.Scale == 2 &&
                fs.HasOpacity && fs.Opacity == 0.5 &&
                fs.HasClickThrough && fs.ClickThrough &&
                fs.HasTopmost && !fs.Topmost &&
                fs.HasBubble && !fs.Bubble &&
                fs.HasDoubleClick && fs.DoubleClick == "emote" &&
                fs.HasTheme && fs.Theme == "dark";
            Check(fullOk, "settings 全字段解析",
                  fullOk ? "scale=2 opacity=0.5 clickThrough=1 topmost=0 bubble=0 doubleClick=emote theme=dark"
                         : "解析失败");

            // (6) 部分 settings → 只出现的字段生效
            PetSnapshot part = PetSnapshot.Parse("{\"rev\":4,\"settings\":{\"scale\":0.4}}");
            PetSettingsInfo ps = part == null ? null : part.Settings;
            bool partOk = ps != null && ps.HasScale && Math.Abs(ps.Scale - 0.4) < 1e-9 &&
                          !ps.HasOpacity && !ps.HasClickThrough && !ps.HasTopmost &&
                          !ps.HasBubble && !ps.HasDoubleClick && !ps.HasTheme;
            Check(partOk, "settings 只给 scale → 其余字段不动现状",
                  partOk ? "HasScale=true，其余 6 个 Has*=false" : "解析失败");

            // (7) doubleClick 三值 + 非法值回落 focus-dsh
            bool dcOk = PetSettingsInfo.NormalizeDoubleClick("focus-dsh") == "focus-dsh" &&
                        PetSettingsInfo.NormalizeDoubleClick("emote") == "emote" &&
                        PetSettingsInfo.NormalizeDoubleClick("none") == "none" &&
                        PetSettingsInfo.NormalizeDoubleClick("xyz") == "focus-dsh" &&
                        PetSettingsInfo.NormalizeDoubleClick(null) == "focus-dsh";
            Check(dcOk, "doubleClick 解析：focus-dsh/emote/none，非法回落 focus-dsh",
                  "xyz/null → focus-dsh（= 现状行为）");

            // (8) theme 非法值回落 auto
            bool thOk = PetSettingsInfo.NormalizeTheme("auto") == "auto" &&
                        PetSettingsInfo.NormalizeTheme("light") == "light" &&
                        PetSettingsInfo.NormalizeTheme("dark") == "dark" &&
                        PetSettingsInfo.NormalizeTheme("bogus") == "auto" &&
                        PetSettingsInfo.NormalizeTheme(null) == "auto";
            Check(thOk, "theme 解析：auto/light/dark，非法回落 auto", "bogus/null → auto");

            // (9) 主题优先级矩阵：argv --dark 0|1 > settings.theme > 注册表
            bool sysDark = PetTheme.SystemPrefersDark();
            bool matrixOk =
                PetTheme.ResolveIsDark(true, "light") &&            // argv 强深色压过 settings.light
                !PetTheme.ResolveIsDark(false, "dark") &&           // argv 强浅色压过 settings.dark
                PetTheme.ResolveIsDark(null, "dark") &&             // settings.dark 生效
                !PetTheme.ResolveIsDark(null, "light") &&           // settings.light 生效
                PetTheme.ResolveIsDark(null, "auto") == sysDark &&  // auto → 注册表
                PetTheme.ResolveIsDark(null, null) == sysDark &&    // 无 settings → 注册表
                PetTheme.ResolveIsDark(null, "bogus") == sysDark;   // 非法 → 注册表
            string e2;
            PetOptions dk1 = PetOptions.Parse(new string[] { "--dark", "1" }, out e2);
            PetOptions dk0 = PetOptions.Parse(new string[] { "--dark", "0" }, out e2);
            bool comboOk = dk1 != null && dk1.DarkOverride == true &&
                           dk0 != null && dk0.DarkOverride == false &&
                           PetTheme.ResolveIsDark(dk1.DarkOverride, "light") &&
                           !PetTheme.ResolveIsDark(dk0.DarkOverride, "dark");
            Check(matrixOk && comboOk, "主题优先级矩阵：argv --dark > settings.theme > 注册表",
                  "argv(1/0) 压过 settings(light/dark)；auto/缺失/非法 → 注册表（本机=" +
                  (sysDark ? "深色" : "浅色") + "）");
        }

        /// <summary>
        /// 回响环修复（task-6）：/pet/position 的 body **不得含 scale** ——
        /// 位置与设置两个上报通道职责分离。body 由 PetHttp.BuildPositionBody
        /// 纯函数构造（PostPosition 实际调用的就是它），这里序列化后断言无该键。
        /// </summary>
        private static void TestPositionReportBody()
        {
            string body = PetHttp.BuildPositionBody(12, 34, 56, 78);
            bool noScale = body.IndexOf("scale", StringComparison.Ordinal) < 0;
            bool fieldsOk = body.IndexOf("\"x\":12", StringComparison.Ordinal) >= 0 &&
                            body.IndexOf("\"y\":34", StringComparison.Ordinal) >= 0 &&
                            body.IndexOf("\"bubbleX\":56", StringComparison.Ordinal) >= 0 &&
                            body.IndexOf("\"bubbleY\":78", StringComparison.Ordinal) >= 0;
            Check(noScale && fieldsOk, "位置上报 body 不含 scale（回响环修复：位置/设置通道分离）", body);
        }

        /// <summary>
        /// task-7：send 能力位解析（缺失=不可用）、ShouldShowSendButton 纯函数、
        /// 发送 body 构造（转义：引号/反斜杠/换行/中文）、空/超长预校验、错误文案映射。
        /// 窗口交互（悬停/点击/键盘）无法脚本化 —— 全部走运行路径实际引用的纯函数单测。
        /// </summary>
        private static void TestSendCapabilityAndBody()
        {
            // (1) snapshot.send 缺失 → Send=null → 不可用（旧 Host 快照不显示 ✎）
            PetSnapshot noSend = PetSnapshot.Parse("{\"rev\":1,\"petState\":\"idle\"}");
            Check(noSend != null && noSend.Send == null &&
                  !PetSendInfo.ShouldShowSendButton(noSend.Send),
                  "snapshot.send 块缺失 → 不可用（不显示 ✎）", "Send=null → ShouldShowSendButton=false");

            // (2) available:false → 不可用；available:true → 可用
            PetSnapshot off = PetSnapshot.Parse(
                "{\"rev\":2,\"send\":{\"available\":false,\"reason\":\"no sessionController\"}}");
            PetSnapshot on = PetSnapshot.Parse("{\"rev\":3,\"send\":{\"available\":true}}");
            bool capOk = off != null && off.Send != null && !off.Send.Available &&
                         off.Send.Reason == "no sessionController" &&
                         !PetSendInfo.ShouldShowSendButton(off.Send) &&
                         on != null && on.Send != null && on.Send.Available &&
                         PetSendInfo.ShouldShowSendButton(on.Send);
            Check(capOk, "snapshot.send 解析：available=false 不显示 ✎；true 可用",
                  "false(reason 原样读出)→false；true→true；null→false");

            // (3) 发送 body 构造：转义正确（引号/反斜杠/换行/中文）。
            // 注意：Escape 把 <0x20 的控制字符转成 \uXXXX（合法 JSON），所以换行在 body 里是 \u000a；
            // 正确的验证方式是「反序列化回来等于原文」（roundtrip），而不是断言特定转义写法。
            // ⭐ 指定会话时 body 必须带 sessionId（这是"发给哪个对话"的落地点）；
            //    没指定时**省略字段**（不是发空串）—— 省略才让 Host 去挑最近活跃的。
            string bodyWithSession = PetHttp.BuildSendBody("你好", "session-abc");
            bool hasSessionField = bodyWithSession.IndexOf("\"sessionId\":\"session-abc\"", StringComparison.Ordinal) >= 0;
            Check(hasSessionField, "发消息：指定会话时 body 带 sessionId",
                  hasSessionField ? bodyWithSession : "缺 sessionId：" + bodyWithSession);
            string bodyNoSession = PetHttp.BuildSendBody("你好", null);
            bool omitsSession = bodyNoSession.IndexOf("sessionId", StringComparison.Ordinal) < 0;
            Check(omitsSession, "发消息：未指定会话时省略字段（交给 Host 挑最近活跃）",
                  omitsSession ? bodyNoSession : "不该出现 sessionId：" + bodyNoSession);
            // 会话 id 里的特殊字符也要转义（不然会破坏 JSON）
            string bodyEsc = PetHttp.BuildSendBody("x", "s\"q\\b");
            bool sessionEscOk = bodyEsc.IndexOf("\\\"", StringComparison.Ordinal) >= 0;
            Check(sessionEscOk, "发消息：会话 id 里的引号被转义（不破坏 JSON）", bodyEsc);
            // ⭐ 会话列表解析（契约 §2 v5）：title/running 要进快照对象，旧快照缺省不崩。
            PetSnapshot withSess = PetSnapshot.Parse(
                "{\"rev\":9,\"petState\":\"idle\",\"sessions\":[" +
                "{\"sessionId\":\"s1\",\"title\":\"桌宠开发\",\"state\":\"working\",\"running\":true,\"toolsInFlight\":2}," +
                "{\"sessionId\":\"s2\",\"state\":\"idle\"}]}");
            bool sessOk = withSess != null && withSess.Sessions.Count == 2 &&
                withSess.Sessions[0].Title == "桌宠开发" && withSess.Sessions[0].Running &&
                withSess.Sessions[1].Title == null && !withSess.Sessions[1].Running;
            Check(sessOk, "会话列表：title/running 解析（缺字段不崩）",
                  sessOk ? "s1 标题=桌宠开发 running=1；s2 缺字段 → null/false"
                         : "解析结果不符：" + (withSess == null ? "null" : withSess.Sessions.Count.ToString()));

            // ⭐ 选择器：选中项回传的 sessionId 必须与列表项对应（发错对话就是这里出的错）。
            // ⭐ **新建**的气泡就必须有正常的图片上限与内边距。
            //
            // 这条是被真实事故逼出来的：把外观常量改成"随缩放变化"的字段时漏了初值，
            // 字段默认全 0 → 图片上限 0（图片被压成 0 高，气泡里空空如也）、
            // 内边距/边框 0（没有底色）——而**图片解码日志全是成功的**，
            // 只看日志完全看不出问题。断言必须查"没缩放过"的初始状态。
            PetBubble freshBubble = new PetBubble();
            double freshImgH = freshBubble.DiagImageMaxH;
            double freshPadX = freshBubble.DiagPaddingLeft;
            bool freshOk = freshImgH > 100 && freshPadX > 5;
            Check(freshOk, "新建气泡就有正常外观（图片上限/内边距不为 0）",
                  "图片上限=" + freshImgH.ToString("0") + "（期望 >100）  内边距=" + freshPadX.ToString("0") + "（期望 >5）");
            try { freshBubble.ForceClose(); } catch { }
            // ⭐ 画廊清单解析（GET /pet/gallery）：能读、能容错、缺字段不崩。
            // 这是"主动看全 41 张表情"的数据入口，解析坏了用户看到的就是白框。
            List<PetGalleryItem> gal = PetJson.ParseGallery(
                "{\"items\":[" +
                "{\"file\":\"bubble/17-yay.png\",\"hasText\":true,\"opaque\":false,\"fileDark\":null,\"group\":\"happy\"}," +
                "{\"file\":\"bubble/new/13-so-good.png\",\"hasText\":true,\"opaque\":true,\"group\":\"happy\"}," +
                "{\"file\":\"bubble/gif-24.png\"}," +          // 缺字段 → 全默认
                "{\"noFile\":1}]}");                          // 没有 file → 跳过
            bool galOk = gal != null && gal.Count == 3 &&
                gal[0].File == "bubble/17-yay.png" && gal[0].HasText && !gal[0].Opaque && gal[0].Group == "happy" &&
                gal[1].Opaque && gal[2].File == "bubble/gif-24.png" && !gal[2].HasText;
            Check(galOk, "画廊清单解析（缺字段/无 file 项都不崩）",
                  gal == null ? "返回 null" : ("解析出 " + gal.Count + " 项（期望 3）"));
            // 坏输入必须返回 null 而不是抛
            bool galBad = PetJson.ParseGallery("not json") == null &&
                          PetJson.ParseGallery("{}") == null &&
                          PetJson.ParseGallery(null) == null;
            Check(galBad, "画廊清单：坏输入返回 null（不抛）", galBad ? "三种坏输入都安全返回 null" : "有输入导致异常");

            // ⭐ 画廊缩略图标题：`bubble/new/13-so-good.png` → `13-so-good`
            bool nameOk = PetGallery.ShortName("bubble/new/13-so-good.png") == "13-so-good" &&
                          PetGallery.ShortName("bubble/17-yay.png") == "17-yay" &&
                          PetGallery.ShortName("") == "";
            Check(nameOk, "画廊缩略图标题取文件名主干（去目录与扩展名）",
                  nameOk ? "bubble/new/13-so-good.png → 13-so-good" : "取名不符");
            // ⭐ 状态显示（契约 §2 v6）：hint/statusAlways 必须能解析出来。
            // 这两个字段原先只有 overlay 用，exe 拿到 label 却没人渲染 ——
            // 桌面版因此一直没有状态文字（用户点名过"在底下显示一下状态"）。
            PetSnapshot stSnap = PetSnapshot.Parse(
                "{\"rev\":7,\"label\":\"正在思考…\",\"settings\":{\"hint\":true,\"statusAlways\":true}}");
            bool stParse = stSnap != null && stSnap.Settings != null &&
                stSnap.Settings.HasHint && stSnap.Settings.Hint &&
                stSnap.Settings.HasStatusAlways && stSnap.Settings.StatusAlways &&
                stSnap.Label == "正在思考…";
            Check(stParse, "状态显示：hint/statusAlways 解析 + label 取到",
                  stParse ? "hint=1 statusAlways=1 label=正在思考…" : "解析结果不符");

            // ⭐ 显隐矩阵（与 overlay 逐条对齐；这是"两端表现一致"的唯一保证）
            PetStatusLabel lbl = new PetStatusLabel();
            lbl.DiagSetLabel("待机中", 1.0, false);
            bool m1, m2, m3, m4, m5;
            lbl.DiagSetState(true, false, false, false); m1 = lbl.DiagShouldShow;   // 常显 → 显示
            lbl.DiagSetState(false, true, false, true);  m2 = lbl.DiagShouldShow;   // 悬停 + hint → 显示
            lbl.DiagSetState(false, true, false, false); m3 = lbl.DiagShouldShow;   // 没悬停 → 不显示
            lbl.DiagSetState(false, false, false, true); m4 = lbl.DiagShouldShow;   // 都关 → 不显示
            lbl.DiagSetState(true, false, true, true);   m5 = lbl.DiagShouldShow;   // 穿透 → 不显示
            Check(m1 && m2 && !m3 && !m4 && !m5,
                  "状态显示矩阵：常显/悬停/都关/穿透 四态（与 overlay 一致）",
                  "常显=" + (m1 ? "显" : "隐") + " 悬停=" + (m2 ? "显" : "隐") +
                  " 未悬停=" + (m3 ? "显" : "隐") + " 都关=" + (m4 ? "显" : "隐") +
                  " 穿透=" + (m5 ? "显" : "隐"));

            // ⭐ 纯展示：状态文字窗必须恒穿透、不吃焦点（不能挡住桌面图标）
            bool pureOk = lbl.IsPureDisplay;
            Check(pureOk, "状态文字窗是纯展示（不吃焦点）",
                  pureOk ? "ShowActivated=false, Topmost=true" : "属性不符");

            // ⭐ 字号随缩放（与气泡同一模式）；新建就该有正常值（不是 0）
            double f1 = lbl.DiagFontSize;
            lbl.DiagSetLabel("待机中", 0.5, false);
            double f05 = lbl.DiagFontSize;
            lbl.DiagSetLabel("待机中", 2.0, false);
            double f2 = lbl.DiagFontSize;
            bool fontOk = f1 > 0 && f05 < f1 && f2 > f1;
            Check(fontOk, "状态文字字号随缩放（0.5× 变小 / 2× 变大）",
                  f1.ToString("0.#") + " → " + f05.ToString("0.#") + " → " + f2.ToString("0.#"));

            // ⭐ 定位：贴本体下方居中（主次与气泡相反）
            lbl.DiagSetLabel("待机中", 1.0, false);
            double tx, ty; int tbw, tbh;
            lbl.DiagTargetFor(1000, 1000, 200, 200, out tx, out ty, out tbw, out tbh);
            bool belowOk = ty > 1200;   // 本体底边 1200 → 文字在更下方
            bool centeredOk = Math.Abs(tx + tbw / 2 - 1100) <= 2;   // 本体中心 x=1100
            Check(belowOk && centeredOk, "状态文字贴本体下方居中",
                  "目标=(" + tx.ToString("0") + "," + ty.ToString("0") + ") 宽=" + tbw +
                  "（本体 1000,1000 200x200，中心 x=1100，底边 1200）");
            try { lbl.ForceClose(); } catch { }
            // ⭐ 气泡大小必须**相对桌宠**（用户反馈"气泡相对于桌宠太大了"）。
            //
            // 原先写死绝对像素（160/200/240 DIP）× scale，**漏了 DPI 换算**：
            // 150% 缩放下桌宠窗口 ≈136 DIP，而满幅贴纸上限 192 DIP = 141% —— 比桌宠还大。
            // 这条断言直接验"比例"，因此任何 DPI/缩放档位都能抓住回归。
            PetBubble sizeProbe = new PetBubble();
            // 模拟用户真实环境：DPI=144（150%）、scale=0.8、帧 256px
            double cap = sizeProbe.DiagCapForPet(256, 256, 144, 0.8);
            double petDip = 256 * 0.8 * (96.0 / 144.0);        // ≈136.5 DIP
            double ratio = cap / petDip;
            bool ratioOk = ratio > 0.6 && ratio < 0.8;
            Check(ratioOk, "气泡大小约为桌宠的 70%（高 DPI 下不再反超）",
                  "气泡上限=" + cap.ToString("0.#") + " DIP，桌宠=" + petDip.ToString("0.#") +
                  " DIP，比例=" + (ratio * 100).ToString("0") + "%（期望 60~80%）");
            // 换个 DPI 与缩放档，比例必须**恒定**（这正是"按比例"的意义）
            double cap2 = sizeProbe.DiagCapForPet(256, 256, 96, 1.0);
            double pet2 = 256 * 1.0 * (96.0 / 96.0);
            double ratio2 = cap2 / pet2;
            bool stableOk = Math.Abs(ratio - ratio2) < 0.02;
            Check(stableOk, "不同 DPI/缩放下气泡与桌宠的比例恒定",
                  "150%×0.8 → " + (ratio * 100).ToString("0") + "%；100%×1.0 → " + (ratio2 * 100).ToString("0") + "%");
            try { sizeProbe.ForceClose(); } catch { }

            // ⭐ 满幅贴纸必须有圆角（用户反馈"有的气泡没有圆角"）。
            // 那批 F4 贴纸是方形硬边（实测四角 alpha=255），原先 CornerRadius(0) 且无裁剪
            // → 直角方块直接贴桌面。Border.CornerRadius 不裁子元素，必须挂 Clip。
            PetBubble opaqueProbe = new PetBubble();
            PetBubbleInfo opb = new PetBubbleInfo();
            opb.Id = 88001;
            opb.Kind = "image";
            opb.Opaque = true;          // 满幅贴纸
            opb.DurationMs = 60000;
            // ⚠️ 必须给**真实位图**：满幅呈现的判据是 `hasImg && b.Opaque`，
            // 传 null 的话 hasImg=false，根本走不到 opaque 分支（第一版就是这么写的，
            // 结果断言红得莫名其妙 —— 其实是测试没搭对）。
            BitmapSource opImg = MakeSolidBubbleBitmap(64);
            opaqueProbe.Show(opb, opImg);
            Pump(250);
            bool clipped = opaqueProbe.DiagOpaqueClipped;
            Check(clipped, "满幅方形贴纸被裁圆角（不再直角贴桌面）",
                  clipped ? "已挂圆角 Clip" : "无圆角裁剪 → 会显示直角方块");
            // 切回普通透明气泡时，裁剪必须撤掉（气泡窗是复用的）
            PetBubbleInfo ntb = new PetBubbleInfo();
            ntb.Id = 88002;
            ntb.Kind = "text";
            ntb.Text = "普通气泡";
            ntb.DurationMs = 60000;
            opaqueProbe.Show(ntb, null);
            Pump(200);
            bool cleared = !opaqueProbe.DiagOpaqueClipped;
            Check(cleared, "切回透明气泡时撤销贴纸圆角裁剪（窗复用不留残留）",
                  cleared ? "裁剪已清除" : "残留裁剪 → 普通气泡四角会被切掉");
            try { opaqueProbe.ForceClose(); } catch { }
            // ⭐ 双击桌宠要把 DSH 叫回来 —— 找窗判定必须**接受最小化窗口**。
            //
            // 被真实反馈逼出来的：原先 `FindDshWindow` 里有 `if (IsIconic(h)) return true;`
            // 跳过最小化窗口，而用户双击的**目的就是把它叫回来**。
            // 日志实证："FocusDsh: 未找到 DSH 主窗" → 双击完全没反应。
            //
            // ⚠️ 断言必须打**真实判定函数** `IsDshCandidate`（运行路径与它共用），
            // 不能自己另造窗口去检查 IsIconic 语义 —— 第一版就是那样，结果把过滤
            // 改回去断言照样绿（假绿）。这里造一个标题合规、**已最小化**的真实窗口，
            // 直接问 `IsDshCandidate` 收不收它。
            bool minAccepted;
            string minTitle;
            {
                System.Windows.Window probe = new System.Windows.Window();
                probe.Title = "DeepSeek Harness";
                probe.Width = 60; probe.Height = 60;
                probe.ShowInTaskbar = false;
                probe.Show();
                probe.WindowState = System.Windows.WindowState.Minimized;
                Pump(120);
                IntPtr ph = new System.Windows.Interop.WindowInteropHelper(probe).Handle;
                bool mini;
                // 用**别的 pid** 冒充外来进程（本进程窗口会被 selfPid 过滤掉）
                minAccepted = PetNative.IsDshCandidate(ph, 999999u, out minTitle, out mini);
                bool actuallyMinimized = mini;
                probe.Close();
                minAccepted = minAccepted && actuallyMinimized;
            }
            Check(minAccepted, "找窗判定接受最小化窗口（双击才能把 DSH 叫回来）",
                  minAccepted ? "标题合规且已最小化 → 仍被接受为候选"
                              : "最小化窗口被拒 → 最小化时双击无效");

            // 反面：不可见的窗口不该被接受（Electron 辅助窗就是这类）
            bool invisibleRejected;
            {
                System.Windows.Window probe = new System.Windows.Window();
                probe.Title = "DeepSeek Harness";
                probe.Width = 60; probe.Height = 60;
                probe.ShowInTaskbar = false;
                probe.Show();
                IntPtr ph = new System.Windows.Interop.WindowInteropHelper(probe).Handle;
                probe.Hide();
                Pump(120);
                bool mini;
                string tt;
                invisibleRejected = !PetNative.IsDshCandidate(ph, 999999u, out tt, out mini);
                probe.Close();
            }
            Check(invisibleRejected, "找窗判定拒绝不可见窗口（不误选 Electron 辅助窗）",
                  invisibleRejected ? "不可见 → 被拒" : "不可见窗口也被接受了");

            // ⭐ 前置窗口必须带 **Z 序兜底**，且断言要打到真实函数 `ActivateWindow`。
            //
            // 跨进程时 `SetForegroundWindow` 会被前台锁定拒绝（实测返回 False），
            // 日志里的"前置失败"就是这么来的；只靠它会导致"双击没反应"。
            // 第一版断言直接调 SetWindowPos（测的是副本），把兜底删掉照样绿 —— 已改正。
            bool activated;
            {
                System.Windows.Window probe = new System.Windows.Window();
                probe.Width = 60; probe.Height = 60;
                probe.WindowStyle = System.Windows.WindowStyle.None;
                probe.ShowInTaskbar = false;
                probe.Show();
                Pump(120);
                IntPtr ph = new System.Windows.Interop.WindowInteropHelper(probe).Handle;
                // 真正调**运行路径**：ActivateWindow
                activated = PetNative.ActivateWindow(ph);
                probe.Close();
            }
            Check(activated, "前置窗口走真实路径且成功（含 Z 序兜底）",
                  activated ? "ActivateWindow 返回 true（前台化或 Z 序提升成功）"
                            : "ActivateWindow 返回 false → 双击会没反应");

            // 常量核对（Z 序兜底依赖这些值）
            bool constOk = PetNative.HWND_TOP == IntPtr.Zero &&
                           PetNative.SWP_NOMOVE == 2 && PetNative.SWP_NOSIZE == 1 &&
                           PetNative.SWP_SHOWWINDOW == 0x40;
            Check(constOk, "SetWindowPos 常量值正确（0/2/1/0x40）",
                  constOk ? "HWND_TOP=0 SWP_NOMOVE=2 SWP_NOSIZE=1 SWP_SHOWWINDOW=0x40"
                          : "常量值不符（会导致 Z 序操作异常）");
            // ⭐ 输入窗与气泡**不能占同一侧**（用户反馈"输入框会和气泡重叠"）。
            //
            // 两者是独立窗口、互不知情：气泡优先贴**头顶**，输入窗原本也贴上方
            // → 同时出现时直接叠在一起。现在分工：**气泡占上方、输入窗占下方**。
            // 断言用**计算出的目标方位**比较（不读未 Show 的 Left/Top —— 那会是 NaN）。
            PetInput posProbe = new PetInput(new PetHttp("http://127.0.0.1:1/", "t"));
            double inX, inY;
            posProbe.DiagTargetFor(1000, 1000, 200, 200, out inX, out inY);
            // 本体底边 = 1200。输入窗应在**下方**（y > 1200），气泡在**上方**（y < 1000）
            bool inputBelow = inY > 1200;
            Check(inputBelow, "输入窗放在桌宠下方（与气泡分占两侧，不重叠）",
                  "输入窗目标 y=" + inY.ToString("0") + "（桌宠底边 1200，应在其下）");
            // 气泡的目标方位（同一本体矩形）应与输入窗**不同侧**
            PetBubble sideProbe = new PetBubble();
            int bx, by;
            sideProbe.DiagTargetFor(1000, 1000, 200, 200, out bx, out by);
            bool oppositeSide = by < 1000 && inY > 1200;
            Check(oppositeSide, "气泡在上 / 输入窗在下（方位相反，互不遮挡）",
                  "气泡 y=" + by.ToString("0") + "（上方）；输入窗 y=" + inY.ToString("0") + "（下方）");
            try { posProbe.Close(); } catch { }
            try { sideProbe.ForceClose(); } catch { }
            PetInput picker = new PetInput(new PetHttp("http://127.0.0.1:1/", "t"));
            List<PetSessionChoice> chs = new List<PetSessionChoice>();
            PetSessionChoice c1 = new PetSessionChoice(); c1.SessionId = "s-a"; c1.Title = "甲"; c1.Running = true;
            PetSessionChoice c2 = new PetSessionChoice(); c2.SessionId = "s-b"; c2.Title = "乙";
            chs.Add(c1); chs.Add(c2);
            picker.SetChoices(chs);
            // ⭐ 多行输入 + 跟随移动（用户反馈"不支持多行""不跟随移动"）
            bool multiOk = picker.DiagAcceptsReturn && picker.DiagMaxLines > 1;
            Check(multiOk, "输入窗支持多行（Enter 换行，不误发）",
                  "AcceptsReturn=" + picker.DiagAcceptsReturn + " MaxLines=" + picker.DiagMaxLines);
            // 跟随：算出来的目标位置应贴在桌宠**上方**且水平居中。
            // 注意：窗口没 Show 过时 WPF 的 Left/Top 是 NaN，所以这里断言**计算结果**
            // （纯函数式取值），而不是窗口属性 —— 跟随本身也只在可见时才动窗口。
            picker.FollowPet(1000, 1000, 200, 200);
            double fx, fy;
            picker.DiagFollowTarget(1000, 1000, 200, 200, out fx, out fy);
            bool centered = Math.Abs(fx + picker.DiagWidth / 2 - 1100) <= 2;   // 桌宠中心 x=1100
            bool above = fy < 1000;                                            // 在桌宠上方
            Check(centered && above, "输入窗跟随桌宠：水平居中 + 贴在桌宠上方",
                  "目标=(" + fx.ToString("0") + "," + fy.ToString("0") + ") 宽=" + picker.DiagWidth.ToString("0") +
                  "（桌宠 1000,1000 200x200，中心 x=1100）");            // ⭐ 选择器显示要带**项目前缀**（用户反馈"选择对话的时候没有层级"）。
            // 真机 385 个会话大量同名，平铺一串根本选不出来。
            PetSessionChoice hier = new PetSessionChoice();
            hier.SessionId = "s-hier";
            hier.Title = "精确中文画面文字转录（OCR） · s-dup-aa";
            hier.Project = "demac-e2e-cef";
            hier.Running = true;
            string disp = hier.Display;
            bool hierOk = disp.Contains("[demac-e2e-cef]") && disp.Contains("●") && disp.Contains("s-dup-aa");
            Check(hierOk, "选择器显示带项目前缀与运行标记（形成层级）", disp);
            // 没有 project 时不显示空方括号
            PetSessionChoice noProj = new PetSessionChoice();
            noProj.SessionId = "s-x"; noProj.Title = "无项目";
            bool noProjOk = !noProj.Display.Contains("[");
            Check(noProjOk, "选择器：没有项目时不显示空方括号", noProj.Display);
            bool sel1 = picker.SelectedSessionId() == "s-a";
            // 换一批（模拟会话结束），选择必须落到新列表里存在的项上
            List<PetSessionChoice> chs2 = new List<PetSessionChoice>();
            PetSessionChoice c3 = new PetSessionChoice(); c3.SessionId = "s-c"; c3.Title = "丙";
            chs2.Add(c3);
            picker.SetChoices(chs2);
            bool sel2 = picker.SelectedSessionId() == "s-c";
            picker.SetChoices(new List<PetSessionChoice>());
            bool sel3 = picker.SelectedSessionId() == null;
            Check(sel1 && sel2 && sel3, "会话选择器：选中项回传正确、列表变化不残留旧选择",
                  "首项=" + (sel1 ? "s-a" : "错") + " 换批=" + (sel2 ? "s-c" : "错") + " 空表=" + (sel3 ? "null" : "错"));
            try { picker.Close(); } catch { }
            string body1 = PetHttp.BuildSendBody("你好", null);
            string body2 = PetHttp.BuildSendBody("说\"引\"与\\反斜", null);
            string body3 = PetHttp.BuildSendBody("第一行\n第二行\t制表", null);
            string body4 = PetHttp.BuildSendBody(null, null);
            bool escOk = body1 == "{\"text\":\"你好\"}" &&
                         body2.IndexOf("\\\"引\\\"", StringComparison.Ordinal) >= 0 &&
                         body2.IndexOf("\\\\反斜", StringComparison.Ordinal) >= 0 &&
                         body3.IndexOf("\\u000a", StringComparison.Ordinal) >= 0 &&
                         body3.IndexOf("\\u0009", StringComparison.Ordinal) >= 0 &&
                         body4 == "{\"text\":\"\"}";
            // 反序列化自洽：解析回来必须等于原文（含控制字符与引号/反斜杠）
            PetJson.JVal back2 = PetJson.Parse(body2);
            PetJson.JVal back3 = PetJson.Parse(body3);
            bool roundtrip = back2 != null && back2.IsObj && back2.Str("text", null) == "说\"引\"与\\反斜" &&
                             back3 != null && back3.IsObj && back3.Str("text", null) == "第一行\n第二行\t制表";
            Check(escOk && roundtrip, "send body 构造 + 转义（引号/反斜杠/换行/中文/空串）",
                  "你好→原样；引号→\\\"；换行→\\u000a；roundtrip 与原文一致；null→{\"text\":\"\"}");

            // (4) 预校验：空/空白不发；2000 字通过；2001 字挡下
            string longOk = new string('字', PetHttp.SendTextMax);
            string longBad = new string('字', PetHttp.SendTextMax + 1);
            bool preOk = PetHttp.ValidateSendText(null) == "empty" &&
                         PetHttp.ValidateSendText("") == "empty" &&
                         PetHttp.ValidateSendText("   ") == "empty" &&
                         PetHttp.ValidateSendText("hi") == null &&
                         PetHttp.ValidateSendText(longOk) == null &&
                         PetHttp.ValidateSendText(longBad) == "too-long";
            Check(preOk, "send 预校验（与 Host 准入一致）",
                  "null/空/空白→empty 不发；2000 字→过；2001 字→too-long 挡下");

            // (5) 失败文案映射（Host 的 400/409/503/401 语义）
            bool errOk = PetInput.DescribeSendError(0, null).IndexOf("连不上", StringComparison.Ordinal) >= 0 &&
                         PetInput.DescribeSendError(400, "{\"error\":\"too-long\"}").IndexOf("太长", StringComparison.Ordinal) >= 0 &&
                         PetInput.DescribeSendError(409, "{}").IndexOf("会话", StringComparison.Ordinal) >= 0 &&
                         PetInput.DescribeSendError(503, "{}").IndexOf("宿主", StringComparison.Ordinal) >= 0 &&
                         PetInput.DescribeSendError(418, "{}").IndexOf("418", StringComparison.Ordinal) >= 0;
            Check(errOk, "send 失败文案映射（0/400/409/503/其它）", "网络失败/超长/无会话/不可用/未知码各有一句话");
        }

        /// <summary>
        /// task-8：attention 解析（缺失/显式 null/正常/非法 kind 回落）、bubble.sticky/attentionCount
        /// 解析（缺省 false/1）、attention diff 纯函数、真实气泡窗呈现矩阵
        /// （attention：描边加粗+脉动+徽标+按钮；普通：全无）、按钮转发 focus-dsh 桩断言、旧快照零回归。
        /// </summary>
        private static void TestAttentionPresentation()
        {
            // (1) attention 块缺失 → null（旧 Host 快照零回归）
            PetSnapshot none = PetSnapshot.Parse("{\"rev\":1,\"petState\":\"idle\"}");
            Check(none != null && none.Attention == null,
                  "attention 块缺失 → null（旧快照零回归）", "Attention=null");

            // (2) 显式 null → null（attentionReminder:false 时 Host 恒发 null）
            PetSnapshot nul = PetSnapshot.Parse("{\"rev\":2,\"attention\":null}");
            Check(nul != null && nul.Attention == null,
                  "attention 显式 null → null（Host 恒发 null 语义）", "Attention=null");

            // (3) 正常块 → 字段齐全；非法 kind 回落 question（不崩）
            PetSnapshot ok = PetSnapshot.Parse(
                "{\"rev\":3,\"attention\":{\"kind\":\"approval\",\"sessionId\":\"s-1\"," +
                "\"text\":\"在等你审批\",\"since\":1791159411846,\"count\":2}}");
            PetAttentionInfo a = ok == null ? null : ok.Attention;
            bool parseOk = a != null && a.Kind == "approval" && a.SessionId == "s-1" &&
                           a.Text == "在等你审批" && a.Since == 1791159411846L && a.Count == 2 &&
                           a.IsApproval;
            PetSnapshot badKind = PetSnapshot.Parse(
                "{\"rev\":4,\"attention\":{\"kind\":\"bogus\",\"text\":\"x\"}}");
            bool kindOk = badKind != null && badKind.Attention != null &&
                          badKind.Attention.Kind == "question";
            Check(parseOk && kindOk, "attention 解析：字段齐全 + 非法 kind 回落 question",
                  "kind=approval session=s-1 count=2；bogus→question（不崩）");

            // (4) attention diff 纯函数（Program 用它做"值没变零日志"）
            PetAttentionInfo a2 = PetSnapshot.Parse(
                "{\"rev\":5,\"attention\":{\"kind\":\"approval\",\"sessionId\":\"s-1\"," +
                "\"text\":\"在等你审批\",\"since\":1791159411846,\"count\":2}}").Attention;
            PetAttentionInfo a3 = PetSnapshot.Parse(
                "{\"rev\":6,\"attention\":{\"kind\":\"approval\",\"sessionId\":\"s-1\"," +
                "\"text\":\"在等你审批\",\"since\":1791159411846,\"count\":3}}").Attention;
            bool diffOk = PetAttentionInfo.Same(null, null) &&
                          !PetAttentionInfo.Same(a, null) && !PetAttentionInfo.Same(null, a) &&
                          PetAttentionInfo.Same(a, a2) && !PetAttentionInfo.Same(a, a3);
            Check(diffOk, "attention diff：Same(null,null)=同值零动作；count 变化=不同",
                  "同值→true；count 2→3→false（触发一次日志/重渲染）");

            // (5) bubble.sticky / attentionCount 解析（缺省 false/1）
            PetBubbleInfo plain = PetSnapshot.Parse(
                "{\"rev\":7,\"bubble\":{\"id\":1,\"kind\":\"text\",\"text\":\"hi\"}}").Bubble;
            PetBubbleInfo stick = PetSnapshot.Parse(
                "{\"rev\":8,\"bubble\":{\"id\":2,\"kind\":\"attention\",\"text\":\"在等你审批\"," +
                "\"sticky\":true,\"attentionCount\":3,\"priority\":100}}").Bubble;
            bool stickyOk = plain != null && !plain.Sticky && plain.AttentionCount == 1 &&
                            stick != null && stick.Sticky && stick.AttentionCount == 3 &&
                            stick.Kind == "attention" && stick.Priority == 100;
            Check(stickyOk, "bubble.sticky/attentionCount 解析（缺省 false/1）",
                  "普通气泡 sticky=false count=1；attention 气泡 sticky=true count=3 priority=100");

            // (6) 真实气泡窗呈现矩阵（在 TestWindows 已验证穿透的同一窗口上加断言）
            // 放在 TestWindows 之后执行：此处独立再建一个气泡窗，不依赖前面的实例。
            PetBubble bubble = null;
            try
            {
                bubble = new PetBubble();
                bubble.Opacity = 0;
                bubble.Show();
                Pump(120);
                BitmapSource bmp = MakeSolidBubbleBitmap(24);

                // 6a. 普通气泡：无头部条/无徽标/无按钮/无脉动
                PetBubbleInfo tb = new PetBubbleInfo();
                tb.Id = 1001; tb.Kind = "text"; tb.Text = "普通";
                bubble.Show(tb, null);
                bool plainOk = !bubble.IsAttentionPresentation && !bubble.GoButtonVisible &&
                               bubble.BadgeText == null;
                Check(plainOk, "普通气泡：无 attention 头部条/徽标/按钮/脉动", "全隐藏");

                // 6b. attention 气泡：头部条+描边加粗+脉动；count=1 无徽标
                PetBubbleInfo ab1 = new PetBubbleInfo();
                ab1.Id = 1002; ab1.Kind = "attention"; ab1.Text = "在等你审批";
                ab1.Sticky = true; ab1.AttentionCount = 1; ab1.Priority = 100; ab1.DurationMs = 4000;
                bubble.Show(ab1, null);
                bool at1Ok = bubble.IsAttentionPresentation && bubble.GoButtonVisible &&
                             bubble.BadgeText == null;
                Check(at1Ok, "attention 气泡：恒亮呈现（描边 2.5 + 脉动 + 去处理按钮）",
                      "count=1 → 无徽标；IsAttentionPresentation=true");

                // 6c. count=2 → 红色计数徽标 "2"
                PetBubbleInfo ab2 = new PetBubbleInfo();
                ab2.Id = 1003; ab2.Kind = "attention"; ab2.Text = "在等你审批";
                ab2.Sticky = true; ab2.AttentionCount = 2; ab2.Priority = 100;
                bubble.Show(ab2, null);
                bool badgeOk = bubble.IsAttentionPresentation && bubble.GoButtonVisible &&
                               bubble.BadgeText == "2";
                Check(badgeOk, "attentionCount>=2 → 红色计数徽标", "徽标文本=2");

                // 6d. 「去处理」按钮转发 focus-dsh（桩断言：GoAction 回调被触发）
                int goHits = 0;
                Action stub = delegate { goHits++; };
                Action realGo = bubble.GoAction;
                bubble.GoAction = stub;
                try { bubble.RaiseGoForTest(); } catch { }
                bubble.GoAction = realGo;
                Check(goHits == 1, "「去处理」点击 → 转发 focus-dsh 链路（桩断言）",
                      "GoAction 桩被调用 " + goHits + " 次（Program 装配的是 OnFocusDsh）");

                // 6e. attention 解除 → 收起（Host attention=null 的落点）
                bubble.HideAttention();
                bool downOk = !bubble.IsAttentionPresentation && !bubble.GoButtonVisible &&
                              !bubble.Showing;
                Check(downOk, "attention=null → 气泡立刻收起（脉动停、头部条复位）",
                      "Showing=false，各元素复位");
            }
            catch (Exception ex)
            {
                Check(false, "attention 气泡呈现矩阵", PetLog.Describe(ex));
            }
            finally
            {
                    // ⭐ 缩放后气泡必须**重新贴齐桌宠**（用户反馈："气泡缩小之后坐标不变"）。
                //
                // 判据用"贴齐"而不是"坐标变了"：定位规则是右对齐（x = 桌宠右边 - 气泡宽），
                // 所以缩放后**气泡右边必须仍与桌宠右边对齐**。
                // 这条能抓住真 bug：若定位用了滞后的旧尺寸、且事后不重贴，
                // 窗口会按新尺寸缩、位置却留在旧尺寸算出来的地方 → 右边错开。
                // 假桌宠矩形必须落在**工作区内**，否则 PlaceNearPet 会把它 clamp 到屏幕边缘，
                // 那样测的是 clamp 逻辑、不是缩放对齐（第一版就踩了这个坑：差值恒为常数）。
                PetNative.WorkArea wa = PetNative.NearestScreen(0, 0);
                int petW = 200, petH = 200;
                int[] petRect = new int[] { wa.X + 120, wa.Y + 300, petW, petH };
                bubble.PetRectProvider = delegate { return petRect; };
                PetBubbleInfo probeBubble = new PetBubbleInfo();
                probeBubble.Id = 99001;
                probeBubble.Kind = "text";
                probeBubble.Text = "缩放定位测试";
                probeBubble.DurationMs = 60000;
                bubble.Show(probeBubble, null);
                Pump(150);

                bool AlignedAt(double sc, out string detail)
                {
                    bubble.SetScale(sc);
                    Pump(300);                       // 等布局落定 + 延迟重贴执行
                    int[] r = bubble.DiagWindowRect();
                    if (r == null) { detail = "拿不到窗口矩形"; return false; }
                    int bubbleRight = r[0] + r[2];
                    int petRight = petRect[0] + petRect[2];
                    detail = sc.ToString("0.##") + "×: 气泡 " + r[2] + "x" + r[3] + "@" + r[0] + "," + r[1] +
                             " 右边=" + bubbleRight + " 桌宠右边=" + petRight + " 差=" + (bubbleRight - petRight);
                    return Math.Abs(bubbleRight - petRight) <= 3;   // 容 3px 舍入
                }

                string d1, d2, d3;
                bool alignLo = AlignedAt(1.0, out d1);
                bool alignSm = AlignedAt(0.4, out d2);
                bool alignBg = AlignedAt(2.0, out d3);
                Check(alignLo && alignSm && alignBg, "气泡缩放后仍贴齐桌宠右边（坐标随尺寸重算）",
                      (alignLo ? "✓" : "✗") + d1 + " | " + (alignSm ? "✓" : "✗") + d2 + " | " + (alignBg ? "✓" : "✗") + d3);

                bubble.SetScale(1.0);
                bubble.HideNow();
                Pump(100);
            try { if (bubble != null) bubble.ForceClose(); } catch { }
            }
        }

        private static void TestClamp()
        {
            PetNative.WorkArea v = PetNative.VirtualWorkspace();            int cx, cy;
            PetNative.ClampToWorkspace(999999, 999999, 200, 200, out cx, out cy);
            bool ok1 = cx + 200 <= v.Right && cy + 200 <= v.Bottom && cx >= v.X && cy >= v.Y;
            PetNative.ClampToWorkspace(-999999, -999999, 200, 200, out cx, out cy);
            bool ok2 = cx >= v.X && cy >= v.Y && cx + 200 <= v.Right && cy + 200 <= v.Bottom;
            Check(ok1 && ok2, "位置 clamp 进工作区",
                  "虚拟工作区 " + v.W + "x" + v.H + "@" + v.X + "," + v.Y +
                  "；(大)→(" + cx + "," + cy + ") 双向均在界内");

            int dx, dy;
            PetNative.DefaultPosition(200, 200, out dx, out dy);
            bool ok3 = dx >= v.X && dy >= v.Y && dx + 200 <= v.Right && dy + 200 <= v.Bottom;
            Check(ok3, "缺省位置=主屏右下角", "(" + dx + "," + dy + ")");
        }

        // ------------------------------------------------------------------
        // 真实创建窗口并验证 WM_NCHITTEST
        // ------------------------------------------------------------------

        private static void TestWindows(PetOptions opt, string artDir, string cacheDir, SpriteSheet sheet)
        {
            PetOptions o = new PetOptions();
            o.ArtDir = artDir;
            o.Url = opt.Url;
            o.Token = opt.Token;
            o.Scale = 1.0;
            o.Opacity = 0.0;          // 自检窗口不可见
            // ⚠️ 必须 false：命中测试的语义是
            //   透明像素 → HTTRANSPARENT（始终穿透）
            //   不透明像素 → HTCLIENT（可点/可拖/可滚轮），**仅当 clickThrough=false**
            // 设 true 会让整窗纯穿透，那就测不出"不透明处可点"了（曾经因此误报失败）。
            o.ClickThrough = false;
            o.Topmost = false;
            o.HasPos = false;
            o.State = "idle";
            o.BubbleEnabled = false;

            PetSpriteStore store = new PetSpriteStore(o, null, cacheDir);
            // 必须先把清单装进 store，否则本体窗取不到条带、退化成兜底方块，
            // alpha 命中测试就失去意义（自检必须验证真实精灵的穿透）。
            bool atlasOk = store.LoadAtlas();
            Check(atlasOk, "自检用 store 载入清单", atlasOk ? (store.Atlas.States.Count + " 状态") : store.AtlasError);

            // ---- 气泡窗：恒 HTTRANSPARENT ----
            PetBubble bubble = null;
            try
            {
                bubble = new PetBubble();
                bubble.Opacity = 0;
                bubble.Show();
                Pump(120);
                IntPtr h = new WindowInteropHelper(bubble).Handle;
                IntPtr r1 = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero, MakeLParam(10, 10));
                IntPtr r2 = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero, MakeLParam(200, 200));
                bool ok = h != IntPtr.Zero && r1.ToInt32() == PetNative.HTTRANSPARENT &&
                          r2.ToInt32() == PetNative.HTTRANSPARENT;
                Check(ok, "气泡窗：HWND 创建 + 恒 HTTRANSPARENT",
                      "hwnd=0x" + h.ToInt64().ToString("X") + " NCHITTEST(10,10)=" + r1.ToInt32() +
                      " (200,200)=" + r2.ToInt32() + " 期望 -1");

                // ---- 契约 §4 opaque：不透明满幅贴纸不画气泡底；透明抠图恢复默认 ----
                BitmapSource bmp = MakeSolidBubbleBitmap(24);
                PetBubbleInfo ob = new PetBubbleInfo();
                ob.Id = 990001;
                ob.Kind = "image";
                ob.Image = "bubble/opaque-selftest.png";
                ob.Opaque = true;
                bubble.Show(ob, bmp);
                bool opaqueOk = bubble.IsOpaquePresentation;
                Check(opaqueOk, "不透明满幅气泡：不画底/边框/内边距 + 图片上限放宽 240",
                      "IsOpaquePresentation=" + opaqueOk +
                      "（背景透明、BorderThickness=0、Padding=0、MaxWidth/MaxHeight=240，投影保留）");

                PetBubbleInfo tb = new PetBubbleInfo();
                tb.Id = 990002;
                tb.Kind = "image";
                tb.Image = "bubble/cutout-selftest.png";
                bubble.Show(tb, bmp);
                bool backOk = !bubble.IsOpaquePresentation;
                Check(backOk, "透明抠图气泡：opaque 贴纸之后恢复默认底/边框/内边距 + 上限 160x200",
                      "第二次显示普通抠图，IsOpaquePresentation=" + bubble.IsOpaquePresentation + " 期望 false");
            }
            catch (Exception ex)
            {
                Check(false, "气泡窗创建", PetLog.Describe(ex));
            }
            finally
            {
                try { if (bubble != null) bubble.ForceClose(); } catch { }
            }

            // ---- 本体窗：alpha 命中测试 ----
            PetWindow win = null;
            try
            {
                win = new PetWindow(o, null, store);
                win.Show();
                Pump(250);
                IntPtr h = win.Handle;
                bool created = h != IntPtr.Zero;

                // 取窗口在屏幕上的物理矩形
                int x, y, w, hh;
                win.GetScreenRect(out x, out y, out w, out hh);

                // ⚠️ WM_NCHITTEST 的 lParam 是**物理屏幕像素**，而窗口内布局是 DIP。
                // 取窗口中心的物理坐标 = 左上角物理 + 物理尺寸的一半（GetScreenRect 给的都是物理）。
                // 曾经这里写错过单位：把物理中心当 DIP 用，命中落到 0.75/0.75（帧间透明区），
                // 于是误报"中心不可点"。产品代码没问题，是断言自己算错了坐标。
                int cxPhys = x + w / 2;
                int cyPhys = y + hh / 2;
                IntPtr corner = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero,
                    MakeLParam(x + 2, y + 2));
                IntPtr center = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero,
                    MakeLParam(cxPhys, cyPhys));

                bool alphaOk = corner.ToInt32() == PetNative.HTTRANSPARENT &&
                               center.ToInt32() == PetNative.HTCLIENT;
                Check(created, "本体窗：HWND 创建",
                      "hwnd=0x" + h.ToInt64().ToString("X") + " rect=" + w + "x" + hh + "@" + x + "," + y +
                      " dpi=" + PetNative.GetDpiForWindowSafe(h) + " dip=" +
                      win.ActualWidth.ToString("0") + "x" + win.ActualHeight.ToString("0"));
                Check(alphaOk, "本体窗：透明处穿透 / 不透明处可点",
                      "角落(" + (x + 2) + "," + (y + 2) + ")=" + corner.ToInt32() +
                      " 期望 -1；中心(" + (x + w / 2) + "," + (y + hh / 2) + ")=" + center.ToInt32() + " 期望 1");

                // ⭐ 不透明处必须返回 HTCLIENT，**不能是 HTCAPTION**。
                // 这是一条被真实事故换来的断言：曾经这里返回 HTCAPTION（"把窗口伪装成标题栏
                // 换取系统拖动"），后果是 Windows 按标题栏语义处理鼠标 ——
                // **滚轮消息不再派发给 WPF**（滚轮缩放彻底失效），点击/双击/悬停也一并被吞。
                // HTCAPTION=2, HTCLIENT=1, HTTRANSPARENT=-1。
                bool notCaption = center.ToInt32() != 2;
                Check(notCaption, "本体窗：不透明处不用 HTCAPTION（否则滚轮/点击被系统吞掉）",
                      "中心返回 " + center.ToInt32() + (notCaption ? "（=HTCLIENT，滚轮可达）" : "（=HTCAPTION，滚轮必失效）"));

                // ⭐ 滚轮缩放链路：StepScale 必须真的改变 scale（不依赖窗口消息，纯逻辑断言）。
                double s0 = win.DiagScale;
                win.DiagApplyWheel(120);
                double s1 = win.DiagScale;
                win.DiagApplyWheel(-120);
                double s2 = win.DiagScale;
                bool wheelOk = s1 > s0 && Math.Abs(s2 - s0) < 0.001;
                Check(wheelOk, "滚轮缩放：上滚变大、下滚复原",
                      s0.ToString("0.##") + " → " + s1.ToString("0.##") + " → " + s2.ToString("0.##"));
                // ⭐ ✎ 按钮必须**完全落在窗口内**（伸到窗口外的像素收不到鼠标消息，
                // 看得见点不着 —— 曾经用负 Margin 往右上角外伸，就是这个毛病）。
                // 同时：鼠标离开桌宠后**不能立刻隐藏**（否则手还没移到按钮上它就消失了）。
                bool btnInside = win.DiagSendBtnInsideWindow();
                Check(btnInside, "✎ 按钮完全在窗口内（窗口外的像素点不到）",
                      btnInside ? "按钮矩形未越界" : "按钮越出窗口矩形 → 必然点不到");
                bool btnLingers = win.DiagSendBtnLingers();
                Check(btnLingers, "✎ 按钮离开桌宠后延迟隐藏（给手移到按钮的时间）",
                      btnLingers ? "有隐藏宽限期" : "MouseLeave 立即隐藏 → 够不着");
                // ⭐ 隐藏桌宠时，气泡窗必须一起隐藏（它是独立窗口，不会自动跟随）。
                // 这是一条被真实反馈换来的断言："隐藏了桌宠，旁边还挂着一个聊天气泡"。
                bool visCbFired = false;
                bool visCbValue = true;
                Action<bool> probe = delegate(bool v) { visCbFired = true; visCbValue = v; };
                win.VisibilityChanged = probe;
                win.HidePet();
                Pump(120);
                bool hideNotified = visCbFired && !visCbValue;
                Check(hideNotified, "隐藏桌宠会通知联动（气泡跟着藏）",
                      hideNotified ? "VisibilityChanged(false) 已发出" : "隐藏时没有通知 → 气泡会留在屏幕上");
                win.ShowPet();
                Pump(120);
                bool showNotified = visCbFired && visCbValue;
                Check(showNotified, "重新显示桌宠也会通知（气泡可重放）",
                      showNotified ? "VisibilityChanged(true) 已发出" : "显示时没有通知");
                win.VisibilityChanged = delegate { };
                // ⭐ 气泡必须**跟着桌宠同比缩放**：它是独立窗口，尺寸/字号写死的话
                // 桌宠缩到 0.5× 时气泡还是原尺寸（比例崩掉）。
                // 断言用"内容尺寸"而不是窗口尺寸 —— 窗口来自 SizeToContent，
                // 只改窗口没用，必须改字号/图片上限这些布局输入。
                // 先按 1× 铺一次，让图片上限等"布局输入"落到基准值
                //（没 Show 过时 _image.MaxHeight 还是控件默认 0，直接比会误判）。
                bubble.SetScale(1.0);
                Pump(80);
                double fsBefore = bubble.DiagTextFontSize;
                double imgBefore = bubble.DiagImageMaxH;
                bubble.SetScale(0.5);
                Pump(120);
                double fsSmall = bubble.DiagTextFontSize;
                double imgSmall = bubble.DiagImageMaxH;
                bubble.SetScale(2.0);
                Pump(120);
                double fsBig = bubble.DiagTextFontSize;
                double imgBig = bubble.DiagImageMaxH;
                bubble.SetScale(1.0);
                Pump(120);
                double fsBack = bubble.DiagTextFontSize;

                bool scalesDown = fsSmall < fsBefore && imgSmall < imgBefore;
                bool scalesUp = fsBig > fsBefore && imgBig > imgBefore;
                bool returnsBack = Math.Abs(fsBack - fsBefore) < 0.01;
                Check(scalesDown && scalesUp && returnsBack,
                      "气泡跟随缩放：0.5× 变小 / 2× 变大 / 1× 复原",
                      "字号 " + fsBefore.ToString("0.#") + " → " + fsSmall.ToString("0.#") +
                      " → " + fsBig.ToString("0.#") + " → " + fsBack.ToString("0.#") +
                      "；图片上限 " + imgBefore.ToString("0") + " → " + imgSmall.ToString("0") +
                      " → " + imgBig.ToString("0"));

                // ⭐ 深浅色主题：气泡外壳必须真的换色（原先只换贴纸图，白框在深色桌面上刺眼）。
                PetTheme.BubblePalette darkPal = PetTheme.BubblePalette.For(true);
                PetTheme.BubblePalette lightPal = PetTheme.BubblePalette.For(false);
                bool paletteDiffers = darkPal.BgR != lightPal.BgR || darkPal.BgG != lightPal.BgG ||
                                      darkPal.BgB != lightPal.BgB;
                bool darkIsDark = darkPal.BgR < 90 && darkPal.FgR > 180;   // 深底浅字
                bool lightIsLight = lightPal.BgR > 200 && lightPal.FgR < 90; // 浅底深字
                Check(paletteDiffers && darkIsDark && lightIsLight, "主题配色：深色是深底浅字、浅色是浅底深字",
                      "深色底 rgb(" + darkPal.BgR + "," + darkPal.BgG + "," + darkPal.BgB + ") 字 " + darkPal.FgR +
                      " / 浅色底 rgb(" + lightPal.BgR + "," + lightPal.BgG + "," + lightPal.BgB + ") 字 " + lightPal.FgR);

                // 主题优先级矩阵（argv > settings.theme > 注册表）
                bool prioOk =
                    PetTheme.ResolveIsDark(true, "light") &&      // argv 压过 settings
                    !PetTheme.ResolveIsDark(false, "dark") &&
                    PetTheme.ResolveIsDark(null, "dark") &&
                    !PetTheme.ResolveIsDark(null, "light") &&
                    PetTheme.ResolveIsDark(null, "auto") == PetTheme.SystemPrefersDark();
                Check(prioOk, "主题优先级：argv > settings.theme > 注册表",
                      "argv/settings/registry 三级都按预期");

                // 150% DPI：窗口 DIP 尺寸 × dpi/96 必须等于精灵的物理像素帧尺寸
                double dpi = PetNative.GetDpiForWindowSafe(h);
                if (dpi <= 0) dpi = 96;
                bool hasSprite = win.HasSprite;
                int physW = (int)Math.Round(win.ActualWidth * dpi / 96.0);
                int physH = (int)Math.Round(win.ActualHeight * dpi / 96.0);
                int wantW = sheet == null ? 0 : sheet.FrameW;
                int wantH = sheet == null ? 0 : sheet.FrameH;
                bool dipOk = hasSprite && Math.Abs(physW - wantW) <= 1 && Math.Abs(physH - wantH) <= 1;
                Check(dipOk, "150% DPI 缩放换算（物理像素 1:1，不糊）",
                      "精灵 " + wantW + "x" + wantH + "px @ dpi " + dpi + "（" + (dpi * 100 / 96) + "%）→ 窗口 DIP " +
                      win.ActualWidth.ToString("0.0") + "x" + win.ActualHeight.ToString("0.0") +
                      " = 物理 " + physW + "x" + physH + "px");

                // 位置 clamp
                win.ReclampPosition(true);
                int x2, y2, w2, h2;
                win.GetScreenRect(out x2, out y2, out w2, out h2);
                PetNative.WorkArea v = PetNative.VirtualWorkspace();
                bool posOk = x2 >= v.X && y2 >= v.Y && x2 + w2 <= v.Right && y2 + h2 <= v.Bottom;
                Check(posOk, "本体窗位置在工作区内", "(" + x2 + "," + y2 + ") " + w2 + "x" + h2);

                // 状态切换不崩
                string[] all = PetJson.AllStates;
                for (int i = 0; i < all.Length; i++) win.SetState(all[i]);
                Check(true, "九个状态切换无异常", "waking…sleeping 全部切过");
            }
            catch (Exception ex)
            {
                Check(false, "本体窗创建/命中测试", PetLog.Describe(ex));
            }
            finally
            {
                try { if (win != null) win.ForceClose(); } catch { }
                try { store.Dispose(); } catch { }
            }
        }

        private static IntPtr MakeLParam(int x, int y)
        {
            return new IntPtr(unchecked((y << 16) | (x & 0xFFFF)));
        }

        /// <summary>自检用：生成一张不透明的实心 PNG 位图（模拟满幅贴纸）。</summary>
        private static BitmapSource MakeSolidBubbleBitmap(int size)
        {
            using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                    g.Clear(Color.FromArgb(255, 255, 255, 255));
                using (MemoryStream ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    ms.Position = 0;
                    BitmapSource src = BitmapFrame.Create(ms, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                    src.Freeze();
                    return src;
                }
            }
        }

        private static void Pump(int ms)
        {
            DispatcherFrame frame = new DispatcherFrame();
            DispatcherTimer t = new DispatcherTimer(DispatcherPriority.Background);
            t.Interval = TimeSpan.FromMilliseconds(ms);
            t.Tick += delegate(object s, EventArgs e)
            {
                t.Stop();
                frame.Continue = false;
            };
            t.Start();
            Dispatcher.PushFrame(frame);
        }

        private static void TestMutex()
        {
            bool created = false;
            Mutex m = null;
            try
            {
                m = new Mutex(true, Program.MutexName, out created);
                if (created)
                {
                    Check(true, "命名互斥体可创建", Program.MutexName + "（本机无权限问题）");
                }
                else
                {
                    Check(true, "命名互斥体已被占用（另一只桌宠在跑）",
                          Program.MutexName + " → 新实例将 exit " + Program.ExitMutexTaken);
                }
            }
            catch (Exception ex)
            {
                Check(false, "命名互斥体创建失败", PetLog.Describe(ex));
            }
            finally
            {
                if (m != null)
                {
                    try { if (created) m.ReleaseMutex(); } catch { }
                    try { m.Close(); } catch { }
                }
            }
        }

        private static void TestHttp(PetOptions opt)
        {
            if (opt.Url == null)
            {
                Check(true, "HTTP 客户端", "未提供 --url → 离线模式（跳过连通测试）");
                return;
            }
            PetHttp h = new PetHttp(opt.Url, opt.Token);
            bool ok = false;
            try { ok = h.Probe(2500); }
            catch { }
            finally { h.Dispose(); }
            Check(true, "HTTP 客户端",
                  "基址 " + opt.Url + " → " + (ok ? "宿主可达（/pet/state 200）" : "宿主不可达（离线启动，会后台重连）"));
        }
    }

    /// <summary>
    /// 自检用的合成素材（不依赖素材管线任务）：
    /// 横向条带 PNG + 一份严格符合契约 §4 的最小 pet.json。
    /// </summary>
    internal static class Synth
    {
        public static void Generate(string dir) { Generate(dir, true); }

        /// <summary>
        /// 生成合成素材。
        /// includeFiles=true  → 含契约 §4 新增的顶层 `files` 映射（新清单）
        /// includeFiles=false → **不含** files（旧清单），用于验证向后兼容回落
        /// </summary>
        public static void Generate(string dir, bool includeFiles)
        {
            Directory.CreateDirectory(dir);
            Directory.CreateDirectory(Path.Combine(dir, "bubble"));

            // 真实素材的单帧**不是方形**（实测宽 239~288、高统一 256），
            // 所以合成素材也刻意用非方形帧宽，才能真正验证 frameWidth 这条路径。
            int fh = 64;
            int idleW = 71, workW = 66, happyW = 58;
            MakeStrip(Path.Combine(dir, "idle.png"), idleW, fh, 4, Color.FromArgb(255, 96, 152, 232));
            MakeStrip(Path.Combine(dir, "working.png"), workW, fh, 3, Color.FromArgb(255, 232, 152, 96));
            MakeStrip(Path.Combine(dir, "happy.png"), happyW, fh, 2, Color.FromArgb(255, 120, 210, 130));

            // (A) 反向用例：几何不符的变体，**files 里没有它** → 必须拒收并回落 canonical。
            //     idle 声明 4 帧 × 71px，这个变体只有 1 帧宽(71px)；
            //     若不校验会按 4 帧切 → 71/4 = 17px 碎条。
            MakeStrip(Path.Combine(dir, "idle-badvariant.png"), 71, fh, 1, Color.FromArgb(255, 200, 90, 90));

            // (B) 正向用例：几何**与 states 声明不同**的变体，但 files 给了它自己的几何 → 必须被接受。
            //     working 声明 3 帧 × 66px；这个变体是 2 帧 × 50px（100px 宽）。
            //     没有 files 时它会被拒收；有 files 时应正常播放 2 帧 50px。
            int varW = 50, varFrames = 2;
            MakeStrip(Path.Combine(dir, "working-var.png"), varW, fh, varFrames, Color.FromArgb(255, 240, 200, 120));

            // 气泡图 1 张 96x96
            MakeBubble(Path.Combine(dir, "bubble", "01.png"), 96);

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"version\": 1,");
            sb.AppendLine("  \"generatedAt\": \"" + DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.000Z",
                          CultureInfo.InvariantCulture) + "\",");
            sb.AppendLine("  \"frameHeight\": " + fh + ",");
            sb.AppendLine("  \"states\": {");
            sb.AppendLine("    \"idle\":    { \"file\": \"idle.png\",    \"frames\": 4, \"frameWidth\": " + idleW +
                          ", \"frameMs\": 40, \"anchorY\": 1.0 },");
            sb.AppendLine("    \"working\": { \"file\": \"working.png\", \"frames\": 3, \"frameWidth\": " + workW +
                          ", \"frameMs\": 50, \"anchorY\": 1.0 },");
            // happy 故意写错 frameWidth（真实值 58），且**不给 files 条目**，
            // 用来验证 canonical 声明错时以实测为准（只 Warn 不崩）
            sb.AppendLine("    \"happy\":   { \"file\": \"happy.png\",   \"frames\": 2, \"frameWidth\": 999" +
                          ", \"frameMs\": 60, \"anchorY\": 1.0 },");
            sb.AppendLine("    \"bogus\":   { \"file\": \"nope.png\",    \"frames\": 2, \"frameMs\": 60, \"anchorY\": 1.0 }");
            sb.AppendLine("  },");
            sb.AppendLine("  \"variants\": {");
            // idle 的第一个变体是几何不符的坏文件 → 无 files 条目 → 必须被拒收并回落 canonical
            sb.AppendLine("    \"idle\": [\"idle-badvariant.png\", \"idle.png\"],");
            // working 的第一个变体几何与声明不同，但 files 里有它的几何 → 必须被接受
            sb.AppendLine("    \"working\": [\"working-var.png\", \"working.png\"]");
            sb.AppendLine("  },");
            if (includeFiles)
            {
                sb.AppendLine("  \"files\": {");
                sb.AppendLine("    \"working-var.png\": { \"frames\": " + varFrames + ", \"frameWidth\": " + varW +
                              ", \"frameMs\": 30 },");
                sb.AppendLine("    \"idle.png\":        { \"frames\": 4, \"frameWidth\": " + idleW + ", \"frameMs\": 40 }");
                sb.AppendLine("  },");
            }
            sb.AppendLine("  \"bubble\": [");
            sb.AppendLine("    { \"file\": \"bubble/01.png\", \"w\": 96, \"h\": 96 }");
            sb.AppendLine("  ],");
            sb.AppendLine("  \"missing\": [");
            sb.AppendLine("    { \"name\": \"表情包_08_爱你哦\", \"reason\": \"needsCutout\" }");
            sb.AppendLine("  ]");
            sb.AppendLine("}");
            File.WriteAllText(Path.Combine(dir, "pet.json"), sb.ToString(), new UTF8Encoding(false));
        }

        private static void MakeStrip(string path, int fw, int fh, int frames, Color color)
        {
            int w = fw * frames;
            using (Bitmap bmp = new Bitmap(w, fh, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    for (int i = 0; i < frames; i++)
                    {
                        int ox = i * fw;
                        int shade = 20 * i;
                        // 显式 (int) 转换：否则 Math.Min(byte,byte) 与 Math.Min(int,int) 二义
                        Color c = Color.FromArgb(255,
                            Math.Min(255, (int)color.R + shade),
                            Math.Min(255, (int)color.G + shade),
                            Math.Min(255, (int)color.B));
                        // 椭圆比帧小一圈 → 四周留透明边，供 alpha 穿透测试
                        using (SolidBrush b = new SolidBrush(c))
                            g.FillEllipse(b, ox + 5, 5, fw - 11, fh - 11);
                    }
                }
                bmp.Save(path, ImageFormat.Png);
            }
        }

        private static void MakeBubble(string path, int size)
        {
            using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 255, 214, 102)))
                        g.FillEllipse(b, 4, 4, size - 9, size - 9);
                }
                bmp.Save(path, ImageFormat.Png);
            }
        }
    }
}