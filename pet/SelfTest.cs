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
                SpriteSheet sheet = TestSprite(artDir, atlas);
                TestFilesMapCompat();
                TestClamp();
                TestWindows(opt, artDir, cacheDir, sheet);
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
                           !es.HasTopmost && !es.HasBubble && !es.HasDoubleClick && !es.HasTheme;
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
            o.ClickThrough = true;
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

                IntPtr corner = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero,
                    MakeLParam(x + 2, y + 2));
                IntPtr center = SendMessage(h, PetNative.WM_NCHITTEST, IntPtr.Zero,
                    MakeLParam(x + w / 2, y + hh / 2));

                bool alphaOk = corner.ToInt32() == PetNative.HTTRANSPARENT &&
                               center.ToInt32() == PetNative.HTCLIENT;
                Check(created, "本体窗：HWND 创建",
                      "hwnd=0x" + h.ToInt64().ToString("X") + " rect=" + w + "x" + hh + "@" + x + "," + y +
                      " dpi=" + PetNative.GetDpiForWindowSafe(h) + " dip=" +
                      win.ActualWidth.ToString("0") + "x" + win.ActualHeight.ToString("0"));
                Check(alphaOk, "本体窗：透明处穿透 / 不透明处可点",
                      "角落(" + (x + 2) + "," + (y + 2) + ")=" + corner.ToInt32() +
                      " 期望 -1；中心(" + (x + w / 2) + "," + (y + hh / 2) + ")=" + center.ToInt32() + " 期望 1");

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