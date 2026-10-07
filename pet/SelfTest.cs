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
                TestSettingsFlagsReportBody();
                TestGesture();
                TestSendCapabilityAndBody();
                SpriteSheet sheet = TestSprite(artDir, atlas);
                TestFilesMapCompat();
                TestVariantDwell(artDir);
                TestClamp();
                TestWindows(opt, artDir, cacheDir, sheet);
                TestAttentionPresentation();
                TestPomodoro();
                TestVoice();
                TestInteract();
                TestChatMode();
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

            // 契约 §4 v-next：气泡动图字段（缺省即静态；越界钳制）
            PetJson.BubbleEntry animEntry = null, clampEntry = null, staticEntry = null;
            for (int i = 0; i < a.Bubble.Count; i++)
            {
                PetJson.BubbleEntry be = a.Bubble[i];
                if (be.File == "bubble/anim-selftest.gif") animEntry = be;
                else if (be.File == "bubble/03.png") clampEntry = be;
                else if (be.File == "bubble/01.png") staticEntry = be;
            }
            bool animParsed = animEntry != null && animEntry.Frames == 5 && animEntry.FrameMs == 40;
            bool staticDefault = staticEntry != null && staticEntry.Frames == 1 && staticEntry.FrameMs == 100;
            bool clamped = clampEntry != null && clampEntry.Frames == 1 && clampEntry.FrameMs == 20;
            Check(animParsed && staticDefault && clamped,
                  "气泡动图字段：frames/frameMs 解析 + 缺省静态 + 越界钳制",
                  "动图=" + (animEntry == null ? "缺" : animEntry.Frames + "帧/" + animEntry.FrameMs + "ms") +
                  "，缺省=" + (staticEntry == null ? "缺" : staticEntry.Frames + "帧/" + staticEntry.FrameMs + "ms") +
                  "，越界(frames:0,frameMs:1)=" + (clampEntry == null ? "缺" : clampEntry.Frames + "帧/" + clampEntry.FrameMs + "ms"));
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
        /// 变体**驻留**：同一状态在短时间内反复取帧，必须拿到**同一张**。
        ///
        /// 用户反馈："主体变的太快了"。
        ///
        /// 根因（实测 exe 日志）：`PickVariant` 原先**每次调用都推进游标**，
        /// 而状态机在 `thinking ↔ working` 之间高频抖动（AI 干活的真实节奏，
        /// 实测相邻间隔 0.04 ~ 1.5 秒）—— 每跳一次就换一身"衣服"，
        /// 看起来像人物在疯狂变装。一次对话实测换了十几张。
        ///
        /// ⚠️ **为什么自造 fixture 而不用现成素材**：第一版对着自检 fixture 的
        /// `idle` 测，而它的变体是 `[idle-badvariant.png, idle.png]` ——
        /// 第一个因**几何不符被拒收**，于是每次都回落 `idle.png`，`distinct` 恒为 1。
        /// 结果：**把驻留去掉，断言照样绿**（回滚验证实测），是个抓不住 bug 的假断言。
        ///
        /// 真实素材（`art/pet`）里 idle 有 5 个可用变体，但自检不该依赖它的具体构成。
        /// 所以这里现造一个"**3 个都有几何的变体**"的最小 fixture —— 判据只依赖
        /// "变体确实在轮换"这一件事，不依赖任何外部素材长什么样。
        /// </summary>
        private static void TestVariantDwell(string srcArtDir)
        {
            string dir = null;
            try
            {
                dir = Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-dwell-fixture");
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                Directory.CreateDirectory(dir);
                Directory.CreateDirectory(Path.Combine(dir, "bubble"));

                // 源条带：借真实素材的 idle.png（4 帧 × 71px = 284 宽）
                //
                // ⚠️ 声明值必须与**实际像素**一致，否则变体会被判为几何不符而拒收 ——
                // 第一版这里写死 frameWidth:256（其实应为 284/4=71），
                // 于是三个变体全被拒收、回落 canonical，测试测了个空气。
                // 所以这里**按实际像素算**，不写死。
                string src = Path.Combine(srcArtDir, "idle.png");
                if (!File.Exists(src))
                {
                    Check(false, "⭐ 变体驻留", "找不到基准素材 " + src);
                    return;
                }
                int stripW, stripH, frameW;
                using (var fs2 = new FileStream(src, FileMode.Open, FileAccess.Read))
                {
                    var dec = BitmapFrame.Create(fs2, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                    stripW = dec.PixelWidth; stripH = dec.PixelHeight;
                }
                const int dwellFrames = 4;                       // idle.png 是 4 帧条带
                frameW = stripW / dwellFrames;
                if (frameW <= 0 || stripH <= 0)
                {
                    Check(false, "⭐ 变体驻留", "基准素材尺寸异常 " + stripW + "x" + stripH);
                    return;
                }
                string[] files = { "dwell-a.png", "dwell-b.png", "dwell-c.png" };
                foreach (string f in files) File.Copy(src, Path.Combine(dir, f), true);

                // 三个变体**都**在 files 里给出**真实**几何 → 都会被接受（这是关键）
                var sb = new System.Text.StringBuilder();
                sb.Append("{\"version\":2,\"frameHeight\":").Append(stripH).Append(',');
                sb.Append("\"states\":{\"idle\":{\"file\":\"dwell-a.png\",\"frames\":").Append(dwellFrames)
                  .Append(",\"frameMs\":100,\"frameWidth\":").Append(frameW).Append("}},");
                sb.Append("\"variants\":{\"idle\":[\"dwell-a.png\",\"dwell-b.png\",\"dwell-c.png\"]},");
                sb.Append("\"files\":{");
                for (int i = 0; i < files.Length; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('"').Append(files[i]).Append("\":{\"frames\":").Append(dwellFrames)
                      .Append(",\"frameWidth\":").Append(frameW).Append(",\"frameMs\":100}");
                }
                sb.Append("},\"bubble\":[],\"missing\":[]}");
                File.WriteAllText(Path.Combine(dir, "pet.json"), sb.ToString(), new System.Text.UTF8Encoding(false));

                PetOptions o = new PetOptions();
                o.ArtDir = dir;
                PetSpriteStore store = new PetSpriteStore(o, null,
                    Path.Combine(Path.GetTempPath(), "dsh-zhuang-fangyi-pet-dwell-cache"));
                if (!store.LoadAtlas()) { Check(false, "变体驻留", "fixture 清单加载失败: " + dir); return; }

                // ── ① 驻留期内：短时间连取多次必须**同一张** ──────────────────
                //
                // 这正是用户看到的"变的太快"：状态在 thinking↔working 之间抖动，
                // 每抖动一次就换一张。驻留的作用就是让这串抖动只换一次。
                var rapid = new List<string>();
                for (int i = 0; i < 10; i++) { SpriteSheet s = store.GetSheet("idle"); if (s != null) rapid.Add(s.File); }
                int rapidDistinct = 0;
                for (int i = 0; i < rapid.Count; i++)
                {
                    bool first = true;
                    for (int j = 0; j < i; j++) if (rapid[j] == rapid[i]) { first = false; break; }
                    if (first) rapidDistinct++;
                }
                bool holdOk = rapid.Count == 10 && rapidDistinct == 1;
                Check(holdOk, "⭐ 变体驻留：短时间反复取帧不换图（用户：变的太快了）",
                      "fixture 3 个可用变体，连取 10 次得到 " + rapidDistinct + " 张：" +
                      (rapid.Count > 0 ? rapid[0] : "-") +
                      (holdOk ? "" : "（期望 1 张；>1 说明驻留没生效）"));

                // ── ② 驻留期过后：必须**重新轮换**（否则就退回"呆板"了）──────
                //
                // ⚠️ 只验①是不够的：把驻留写成"永远不换"也能过①，
                // 但那就等于把变体功能废掉（用户先前抱怨过变化度不够）。
                // 所以这里睡过驻留窗口，再取一次，必须换到**别的**变体。
                double dwell = PetSpriteStore.VariantDwellMsDiag;
                System.Threading.Thread.Sleep((int)dwell + 250);
                SpriteSheet after = store.GetSheet("idle");
                bool rotated = after != null && rapid.Count > 0 && after.File != rapid[0];
                Check(rotated, "⭐ 驻留是「慢下来」不是「不换」：过了驻留窗口仍会轮换",
                      "驻留 " + dwell.ToString("0") + "ms 后：" +
                      (rapid.Count > 0 ? rapid[0] : "-") + " → " + (after == null ? "-" : after.File) +
                      (rotated ? "" : "（没换 = 变体功能被废掉）"));

                // ── ③ 再走一轮，确认是**真的在循环**（不只是 A/B 两张来回）────
                var seen = new List<string> { rapid[0], after.File };
                for (int k = 0; k < 3; k++)
                {
                    System.Threading.Thread.Sleep((int)dwell + 250);
                    SpriteSheet s = store.GetSheet("idle");
                    if (s != null) seen.Add(s.File);
                }
                int seenDistinct = 0;
                for (int i = 0; i < seen.Count; i++)
                {
                    bool first = true;
                    for (int j = 0; j < i; j++) if (seen[j] == seen[i]) { first = false; break; }
                    if (first) seenDistinct++;
                }
                // 3 个变体轮 4 次（含首张）应见到 >= 2 张（严格说 3 张，但取 >=2 更稳，
                // 避免依赖 fixture 的起始游标位置）
                bool cycles = seenDistinct >= 2;
                Check(cycles, "⭐ 变体仍在循环（不是卡死在一张）",
                      "跨驻留窗口取样得到 " + seenDistinct + " 张：" + string.Join(" → ", seen.ToArray()));

                // ── ④ 预估尺寸与实际取到的一致（驻留期内也不能对不上）──────
                // PetWindow.ReloadSprite 先按 TryGetDeclaredSize 预摆窗口，再取帧。
                int pw, ph;
                store.TryGetDeclaredSize("idle", out pw, out ph);
                SpriteSheet nxt = store.GetSheet("idle");
                bool consistent = nxt != null && pw == nxt.FrameW && ph == nxt.FrameH;
                Check(consistent, "驻留期内：预估尺寸与实际取到的条带一致",
                      "预估 " + pw + "x" + ph + "，实际 " + (nxt == null ? "-" : nxt.FrameW + "x" + nxt.FrameH));

                store.Dispose();
            }
            catch (Exception ex)
            {
                Check(false, "变体驻留测试", PetLog.Describe(ex));
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
        /// 「桌面端改了设置、DSH 设置页不跟着变」那一轮：
        /// 托盘 / 右键菜单的开关类改动必须**只带改动的字段**回报宿主，
        /// 且**一个字段都没有时不许发空 body**（空补丁会白触发一次广播）。
        ///
        /// 纯函数单测 —— 托盘/右键菜单的点击无法脚本化，但它俩最终都调这一个构造器。
        /// </summary>
        private static void TestSettingsFlagsReportBody()
        {
            // (1) 只报一个字段 → body 里只有它（合并语义：其余字段靠宿主保持不动）
            string one = PetHttp.BuildSettingsFlagsBody(null, true, null);
            bool oneOk = one == "{\"topmost\":true}";
            Check(oneOk, "开关类设置上报 body 只含改动字段（合并语义）", one ?? "(null)");

            // (2) 三个字段 → 顺序固定、逗号正确、布尔是 JSON 字面量
            string three = PetHttp.BuildSettingsFlagsBody(false, true, false);
            bool threeOk = three == "{\"clickThrough\":false,\"topmost\":true,\"bubble\":false}";
            Check(threeOk, "三个开关一起报 → 逗号/布尔都正确", three ?? "(null)");

            // (3) 一个都不给 → null（调用方据此**不发请求**）
            //     为什么单独立一条：空 body `{}` 会被宿主当成一次空补丁，
            //     白白广播一帧，而广播又会让 exe 再走一遍"应用设置"。
            string none = PetHttp.BuildSettingsFlagsBody(null, null, null);
            Check(none == null, "没有任何开关变化 → 不构造 body（不发空补丁）", none ?? "(null)");

            // (4) 键名必须与 Host 的设置字段同名（大小写敏感）——
            //     写错一个键宿主会静默忽略（合并语义下缺键 ≠ 报错）。
            bool keysOk = three != null &&
                          three.IndexOf("\"clickThrough\"", StringComparison.Ordinal) >= 0 &&
                          three.IndexOf("\"topmost\"", StringComparison.Ordinal) >= 0 &&
                          three.IndexOf("\"bubble\"", StringComparison.Ordinal) >= 0;
            Check(keysOk, "三个键名与 Host 设置字段完全一致（写错会被静默忽略）",
                  "clickThrough / topmost / bubble");
        }

        /// <summary>
        /// v10：手势判定（点击 / 长按摸头 / 挪位置 / 抛掷）与抛掷轨迹。
        ///
        /// 这四件事**全都无法在无头自检里真的用鼠标做出来**（要模拟按下-移动-抬起
        /// 的时序，还要控制速度）。所以判定与轨迹必须是纯函数 —— 这里断言的就是
        /// 那四条判据的边界值，以及"坏数据绝不飞"这条安全性质。
        /// </summary>
        private static void TestGesture()
        {
            // (1) 单击仍然成立（与 v9 同判据，不能被新增手势破坏）
            bool clickOk =
                PetGesture.Classify(0, 0, 50, 0) == PetGestureKind.Click &&
                PetGesture.Classify(4, 0, 300, 0) == PetGestureKind.Click &&
                PetGesture.Classify(0, 4, 300, 0) == PetGestureKind.Click;
            Check(clickOk, "手势：位移 ≤4px 且时长 ≤300ms → 单击",
                  "0px/50ms、4px/300ms 都是 Click");

            // (2) ⭐ 长按摸头：时长进窗口、位移仍小
            bool patOk =
                PetGesture.Classify(0, 0, 350, 0) == PetGestureKind.Pat &&
                PetGesture.Classify(1, 1, 1200, 0) == PetGestureKind.Pat &&
                PetGesture.Classify(0, 0, 4000, 0) == PetGestureKind.Pat;
            Check(patOk, "手势：350ms~4000ms 且位移 ≤6px → 长按摸头",
                  "350ms/1200ms/4000ms 都是 Pat");

            // (2b) ⭐ 300~350ms 是**故意留的死区**：既不算点击、也不算长按。
            //      两个判据紧贴时，采样抖动会让同一次按下在两条路径里各自命中一次
            //      （用户看到"点一下"和"摸一下"同时发生）。
            bool deadZone =
                PetGesture.Classify(0, 0, 320, 0) == PetGestureKind.Drag;
            Check(deadZone, "手势：300~350ms 是死区（既不点击也不长按，避免双重触发）",
                  "320ms → Drag");

            // (3) ⭐⭐ 抛掷：速度达标 **且** 按下够久。位移大但速度低 → 仍是挪位置。
            //
            // ⚠️ 用例里的 dx/dy 必须与速度**自洽**：800px/s 的甩动在 100ms
            // 窗口里至少要走 80px，所以"位移 0px + 速度 900px/s"这种输入
            // 物理上不可能出现 —— 它会先被单击那一支截走（≤4px 且 ≤300ms）。
            // 我第一版就写了那个自相矛盾的用例，自检立刻把它抓出来了。
            bool flingOk =
                PetGesture.Classify(200, 0, 400, 2000) == PetGestureKind.Fling &&
                PetGesture.Classify(120, 0, 200, 1500) == PetGestureKind.Fling;
            bool slowDrag =
                PetGesture.Classify(200, 0, 1500, 200) == PetGestureKind.Drag &&
                PetGesture.Classify(200, 0, 400, 799) == PetGestureKind.Drag;
            Check(flingOk && slowDrag,
                  "⭐⭐ 抛掷看**速度**不看距离：≥800px/s 才飞，慢拖仍是挪位置",
                  "2000/1500px·s⁻¹→Fling；799px·s⁻¹ 与 200px·s⁻¹→Drag");

            // (3b) 按下时长不足 → 不做速度估计（差 1ms 就能让速度翻倍）
            Check(PetGesture.Classify(200, 0, 59, 5000) == PetGestureKind.Drag,
                  "手势：按下不足 60ms → 拒绝抛掷（速度估计不可信）", "59ms/5000px·s⁻¹ → Drag");

            // (4) ⭐⭐ 坏数据**什么都不做**（Drag），既不飞也不打招呼。
            //
            // 两个方向都要挡：飞出去（NaN 落点会让窗口从屏幕消失）与
            // 变成一次点击（那会**改变** v9 的行为 —— 坐标异常本该静默）。
            //
            // ⚠️ 长按那一支**不看速度**：按住不动时速度天然是 0（甚至因为
            // 没有 MouseMove 而根本没有样本）。所以"坏速度 + 长按"必须仍是
            // 长按 —— 要求速度有效等于把摸头整个功能废掉。这条断言就是
            // 用来钉住"哪一支看速度、哪一支不看"的。
            bool badOk =
                PetGesture.Classify(double.NaN, 0, 500, 5000) == PetGestureKind.Drag &&
                PetGesture.Classify(0, double.NaN, 500, 5000) == PetGestureKind.Drag &&
                PetGesture.Classify(double.PositiveInfinity, 0, 500, 5000) == PetGestureKind.Drag &&
                PetGesture.Classify(0, double.NegativeInfinity, 500, 5000) == PetGestureKind.Drag &&
                PetGesture.Classify(0, 0, -1, 5000) == PetGestureKind.Drag;
            bool badSpeedOk =
                PetGesture.Classify(0, 0, 500, double.NaN) == PetGestureKind.Pat &&
                PetGesture.Classify(0, 0, 500, double.PositiveInfinity) == PetGestureKind.Pat &&
                PetGesture.Classify(200, 0, 500, double.NaN) == PetGestureKind.Drag;
            Check(badOk && badSpeedOk,
                  "⭐⭐ 坏坐标 → 什么都不做；坏速度不影响长按（长按不看速度）",
                  "NaN/±Inf/负时长 → Drag；坏速度+按住不动 → 仍是 Pat");

            // (5) 长按分级：350ms 起第 1 级，每 600ms 一级，封顶 3 级
            bool levelOk =
                PetGesture.PatLevel(0) == 0 &&
                PetGesture.PatLevel(349) == 0 &&
                PetGesture.PatLevel(350) == 1 &&
                PetGesture.PatLevel(949) == 1 &&
                PetGesture.PatLevel(950) == 2 &&
                PetGesture.PatLevel(1550) == 3 &&
                PetGesture.PatLevel(99999) == 3;
            Check(levelOk, "长按分级：350ms 起 1 级、每 600ms 升一级、封顶 3 级",
                  "0/349→0；350/949→1；950→2；1550+→3");

            // (6) ⭐⭐ 抛掷轨迹**绝不飞出工作区**（这类动画最典型的缺陷）
            FlingPlan p = PetGesture.PlanFling(500, 400, 3000, 0, 0, 0, 800, 600);
            bool inBounds = p.Points.Count > 0;
            for (int i = 0; i < p.Points.Count; i++)
            {
                ScreenPoint pt = p.Points[i];
                if (pt.X < 0 || pt.X > 800 || pt.Y < 0 || pt.Y > 600) inBounds = false;
            }
            Check(inBounds && p.HitEdge,
                  "⭐⭐ 抛掷轨迹逐帧夹进工作区（撞墙标记 HitEdge）",
                  p.Points.Count + " 帧 / " + p.DurationMs + "ms / HitEdge=" + p.HitEdge);

            // (6b) 轨迹有上限：不能一直飘
            FlingPlan far = PetGesture.PlanFling(0, 0, 99999, 0, 0, 0, 800, 600);
            Check(far.Points.Count <= PetGesture.FlingMaxSteps + 1 &&
                  far.DurationMs <= PetGesture.FlingMaxSteps * PetGesture.FlingStepMs,
                  "抛掷有时长上限（不会一直飘）",
                  far.Points.Count + " 帧 ≤ " + (PetGesture.FlingMaxSteps + 1) +
                  " / " + far.DurationMs + "ms ≤ " + (PetGesture.FlingMaxSteps * PetGesture.FlingStepMs) + "ms");

            // (6c) ⭐ 初速坏掉 → 轨迹只有起点（原地不动），坐标**必须是有限值**
            FlingPlan bad = PetGesture.PlanFling(double.NaN, 100, double.NaN, 0, 0, 0, 800, 600);
            Check(bad.Points.Count == 1 &&
                  !double.IsNaN(bad.Points[0].X) && !double.IsNaN(bad.Points[0].Y),
                  "⭐ 初速/起点坏掉 → 原地不动（绝不出 NaN 坐标）",
                  "1 帧 @ (" + bad.Points[0].X + "," + bad.Points[0].Y + ")");

            // (6d) 速度不够 → 不产生动画（调用方据此**不启动计时器**）
            FlingPlan still = PetGesture.PlanFling(100, 100, 5, 5, 0, 0, 800, 600);
            Check(still.Points.Count == 1 && still.DurationMs == 0,
                  "速度低于停止阈值 → 轨迹只有一个点（不启动动画）",
                  still.Points.Count + " 帧");

            // (7) ⭐⭐ 速度取样窗口：只看松手前 100ms，不是整段平均。
            //      整段平均会让"慢慢拖 3 秒、最后猛甩一下"算不出速度（该飞不飞），
            //      也会让"快速拖到底再停住"算成在飞（不该飞却飞出去）。
            GestureSample[] s = new GestureSample[8];
            // t=0..300ms 慢慢挪 30px（100px/s），最后 100ms 猛冲 200px（2000px/s）
            s[0] = new GestureSample(0, 0, 0);
            s[1] = new GestureSample(100, 10, 0);
            s[2] = new GestureSample(200, 20, 0);
            s[3] = new GestureSample(300, 30, 0);
            s[4] = new GestureSample(400, 230, 0);
            double fast = PetGesture.FlingSpeed(s, 5, 400);
            Check(fast >= 1900 && fast <= 2100,
                  "⭐⭐ 速度只看松手前 100ms（慢拖后猛甩仍能飞）",
                  fast.ToString("0", CultureInfo.InvariantCulture) + "px/s（期望 ≈2000）");

            // 反例：快速拖到底**再停住** 300ms → 窗口内速度为 0 → 不飞
            GestureSample[] s2 = new GestureSample[8];
            s2[0] = new GestureSample(0, 0, 0);
            s2[1] = new GestureSample(50, 300, 0);
            s2[2] = new GestureSample(350, 300, 0);
            double stopped = PetGesture.FlingSpeed(s2, 3, 350);
            Check(stopped == 0,
                  "⭐⭐ 松手前已经停住 → 速度为 0（不该飞就不飞）",
                  stopped.ToString("0", CultureInfo.InvariantCulture) + "px/s");

            // (7b) 样本不足 / 时间为 0 → 0（安全侧）
            GestureSample[] one = new GestureSample[8];
            one[0] = new GestureSample(100, 0, 0);
            Check(PetGesture.FlingSpeed(one, 1, 100) == 0 &&
                  PetGesture.FlingSpeed(one, 0, 100) == 0 &&
                  PetGesture.FlingSpeed(null, 0, 100) == 0,
                  "速度样本不足 → 0（安全侧：不飞）", "1 个样本 / 0 个样本 / null 都是 0");

            // (8) ⭐ 阈值必须是常量而不是散落的魔数（改一处就够）
            Check(PetGesture.ClickMaxMovePx == 4.0 && PetGesture.ClickMaxMs == 300 &&
                  PetGesture.PatMinMs == 350 && PetGesture.PatMaxLevels == 3 &&
                  PetGesture.FlingMinSpeed == 800.0,
                  "手势阈值集中为常量（窗口里不再有第二套判据）",
                  "4px/300ms/350ms/3级/800px·s⁻¹");

            // (9) ⭐ 窗口的点击判定必须**转发**到 PetGesture（单一真相）。
            //      回退验证：把 PetWindow.IsClickGesture 换回自己那套实现时，
            //      只要阈值一致就仍然全绿 —— 所以这条断言查的是**同一性**：
            //      拿一个"只有 PetGesture 认、窗口自己那套不认"的边界值来试。
            //      PatMinMs 边界正是这样的值：v9 的实现会拒绝 350ms（>300ms），
            //      而 v10 的转发版会走完整个判定返回 false/true 一致的结论。
            bool forwardOk =
                PetWindow.IsClickGesture(0, 0, 300) == PetGesture.IsClick(0, 0, 300) &&
                PetWindow.IsClickGesture(0, 0, 301) == PetGesture.IsClick(0, 0, 301) &&
                PetWindow.IsClickGesture(double.NaN, 0, 50) == PetGesture.IsClick(double.NaN, 0, 50);
            Check(forwardOk, "⭐ PetWindow 的点击判定转发到 PetGesture（不是各写一套）",
                  "300ms/301ms/NaN 三处结论一致");

            // (10) 互动动作白名单 v10 扩到 7 个（exe 侧与 Host 同集合）
            bool kindsOk =
                PetHttp.IsKnownInteractKind("pat") &&
                PetHttp.IsKnownInteractKind("fling") &&
                PetHttp.IsKnownInteractKind("hover") &&
                PetHttp.InteractKinds.Length == 7;
            Check(kindsOk, "互动白名单 v10：pat / fling / hover 已加（共 7 个）",
                  "InteractKinds.Length=" + PetHttp.InteractKinds.Length);

            // (11) ⭐⭐ 菜单里的动作 + 手势动作 = 全部动作，**一个都不许漏**。
            //
            // 这条断言防的是"加了新动作却忘了给入口"：菜单里没有、手势也没有，
            // 那个动作就**永远无法触发** —— 而且不会有任何报错（Host 的表里有它，
            // 白名单也认它，只是没人能发出那个请求）。
            // 反过来也防"两个入口"：同一个动作既有手势又在菜单里，
            // 用户会以为它们不一样（这是 v9 就定下的纪律）。
            bool everyKindReachable = true;
            string missing = null;
            for (int i = 0; i < PetHttp.InteractKinds.Length; i++)
            {
                string k = PetHttp.InteractKinds[i];
                bool inMenu = PetHttp.IsMenuInteractKind(k);
                bool hasGesture = PetHttp.HasGestureEntry(k);
                if (!inMenu && !hasGesture) { everyKindReachable = false; missing = k; break; }
                if (inMenu && hasGesture) { everyKindReachable = false; missing = k + "（两个入口）"; break; }
            }
            Check(everyKindReachable,
                  "⭐⭐ 每个互动动作**恰好有一个**入口（菜单 或 手势，不许漏也不许重）",
                  missing == null ? ("菜单 " + PetHttp.MenuInteractKinds.Length + " 个 / 手势 5 个") : ("问题：" + missing));

            // (12) 今日统计那一行：格式化 + 空数据隐藏
            PetTodayInfo t1 = new PetTodayInfo();
            t1.PomodoroCount = 3; t1.FocusMs = 75 * 60 * 1000; t1.GoalCount = 8;
            bool line1 = t1.MenuLine() == "今天：3/8 个番茄 · 1 小时 15 分";
            PetTodayInfo t2 = new PetTodayInfo();
            t2.PomodoroCount = 1; t2.FocusMs = 25 * 60 * 1000; t2.Interrupts = 4; t2.StreakDays = 3;
            bool line2 = t2.MenuLine() == "今天：1 个番茄 · 25 分 · 摸鱼 4 次 · 连续 3 天";
            Check(line1 && line2, "今日统计行：目标进度 / 时长 / 摸鱼 / 连续天数",
                  line1 ? line2.ToString() : t1.MenuLine());

            // (12b) 时长格式化的三个边界
            bool durOk =
                PetTodayInfo.FormatDuration(0) == "0 分" &&
                // 不足一分钟但确实有专注 → "1 分"（显示 0 分而番茄 +1 会让人以为统计坏了）
                PetTodayInfo.FormatDuration(30 * 1000) == "1 分" &&
                PetTodayInfo.FormatDuration(60 * 1000) == "1 分" &&
                PetTodayInfo.FormatDuration(60 * 60 * 1000) == "1 小时" &&
                PetTodayInfo.FormatDuration(2 * 60 * 60 * 1000) == "2 小时" &&
                PetTodayInfo.FormatDuration(65 * 60 * 1000) == "1 小时 5 分" &&
                PetTodayInfo.FormatDuration(-5000) == "0 分";
            Check(durOk, "时长格式化：不足一分钟显示 1 分（不是 0 分）",
                  "0→0 分；30s→1 分；1h→1 小时；65m→1 小时 5 分");

            // (13) snapshot.today 块解析：缺块 = null（零回归）、坏值夹到非负
            PetSnapshot noToday = PetSnapshot.Parse("{\"rev\":1,\"petState\":\"idle\"}");
            Check(noToday != null && noToday.Today == null,
                  "snapshot.today 块缺失 → null（旧 Host 零回归，菜单不显示那一行）", "Today=null");

            PetSnapshot withToday = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"today\":{\"pomodoroCount\":3," +
                "\"focusMs\":1500000,\"interrupts\":-2,\"streakDays\":5,\"goalCount\":8}}");
            bool todayOk = withToday != null && withToday.Today != null &&
                           withToday.Today.PomodoroCount == 3 &&
                           withToday.Today.FocusMs == 1500000 &&
                           // 负数夹到 0：显示"-2 次摸鱼"是统计坏了的信号，不如显示 0
                           withToday.Today.Interrupts == 0 &&
                           withToday.Today.StreakDays == 5 &&
                           withToday.Today.GoalCount == 8;
            Check(todayOk, "snapshot.today 解析正确，且负数被夹到 0",
                  withToday?.Today?.MenuLine() ?? "(null)");

            // (14) 没开过番茄钟 → 菜单那一行整项隐藏（而不是显示"今天：0 个番茄"）
            PetTodayInfo blank = new PetTodayInfo();
            bool hideBlank = !(blank.PomodoroCount > 0 || blank.StreakDays > 1 || blank.Interrupts > 0);
            PetTodayInfo used = new PetTodayInfo();
            used.PomodoroCount = 1;
            bool showUsed = used.PomodoroCount > 0 || used.StreakDays > 1 || used.Interrupts > 0;
            Check(hideBlank && showUsed,
                  "「今天」行的显隐：一次没用过 → 隐藏；用过 → 显示",
                  "空白隐藏 / 有番茄显示");

            // (15) ⭐⭐ 三个手势开关：缺键 ≠ 用户设成 false。
            //
            // 这是"升级插件后手势失灵"的根因：旧 Host 的快照里根本没有这三个键，
            // 而 `flingEnabled` / `longPress` 的**默认是 true**。
            // 若实现直接 `Bool("flingEnabled", false)`，旧 Host 会让它们变 false
            // —— 用户甩不动她、按不住她，且**没有任何报错**。
            // 真正的守卫是 `Has*` 标记：没有键 = "不动现状"。
            PetSnapshot noGestureKeys = PetSnapshot.Parse("{\"rev\":1,\"petState\":\"idle\",\"settings\":{\"scale\":1}}");
            bool absentOk = noGestureKeys != null && noGestureKeys.Settings != null &&
                            !noGestureKeys.Settings.HasLongPress &&
                            !noGestureKeys.Settings.HasFling &&
                            !noGestureKeys.Settings.HasHoverReact &&
                            !noGestureKeys.Settings.HasPomodoroBreath;
            Check(absentOk, "⭐⭐ 旧 Host 快照缺手势键 → Has* 全为 false（= 不动现状，手势仍然可用）",
                  "缺键时不会把默认开的手势关掉");

            PetSnapshot withGestureKeys = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"settings\":{\"longPress\":false," +
                "\"flingEnabled\":true,\"hoverReact\":true,\"pomodoroBreath\":true}}");
            bool presentOk = withGestureKeys != null && withGestureKeys.Settings != null &&
                             withGestureKeys.Settings.HasLongPress && !withGestureKeys.Settings.LongPress &&
                             withGestureKeys.Settings.HasFling && withGestureKeys.Settings.FlingEnabled &&
                             withGestureKeys.Settings.HasHoverReact && withGestureKeys.Settings.HoverReact &&
                             withGestureKeys.Settings.HasPomodoroBreath && withGestureKeys.Settings.PomodoroBreath;
            Check(presentOk, "显式给的手势开关按原值解析（false 就是 false）",
                  "longPress=false / fling=true / hover=true / breath=true");

            // (15b) ⭐⭐ 缺省值必须**只有一处真相**，且方向正确。
            //
            // 这一条是被回滚验证逼出来的：我原先断言"把 hoverReact 的缺省写成
            // true 会变红"，结果改坏了**仍然全绿** —— 因为那个常量在解析里是
            // 死代码（进到那一支时键一定存在），真正的缺省值活在 Program 的
            // 字段初始化里。同一个语义两份、其中一份不可达 = 假断言。
            // 现在缺省值收进 `PetSettingsInfo.Default*()`，两边都读它，
            // 所以直接断言这几个函数就是断言了真实行为。
            Check(PetSettingsInfo.DefaultLongPress() &&
                  PetSettingsInfo.DefaultFlingEnabled() &&
                  !PetSettingsInfo.DefaultHoverReact() &&
                  !PetSettingsInfo.DefaultPomodoroBreath(),
                  "⭐⭐ 手势开关缺省值唯一真相：长按/抛掷默认开，悬停/呼吸默认关",
                  "longPress=1 fling=1 hover=0 breath=0");
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

            // ⭐ 契约 §2 v-next：状态文字字号倍率（缺省不动现状 = 1.0）
            PetSnapshot fsSnap = PetSnapshot.Parse(
                "{\"rev\":8,\"label\":\"待机中\",\"settings\":{\"statusFontScale\":2.5}}");
            bool fsParse = fsSnap != null && fsSnap.Settings != null &&
                fsSnap.Settings.HasStatusFontScale &&
                Math.Abs(fsSnap.Settings.StatusFontScale - 2.5) < 0.001;
            Check(fsParse, "状态文字字号倍率：快照字段解析",
                  fsParse ? "statusFontScale=2.5" : "解析结果不符");
            // 越界要夹取（Host 也会夹，但 exe 是网络数据的第二道防线）
            PetSnapshot clampSnap = PetSnapshot.Parse(
                "{\"rev\":9,\"label\":\"待机中\",\"settings\":{\"statusFontScale\":99}}");
            bool fsClamp = clampSnap != null && clampSnap.Settings != null &&
                clampSnap.Settings.StatusFontScale <= 3.0;
            Check(fsClamp, "状态文字字号倍率：越界值夹取",
                  "99 → " + (clampSnap?.Settings?.StatusFontScale ?? -1).ToString("0.##"));
            // 缺字段 → Has=false（exe 对该字段"不动现状"，旧 Host 快照零回归）
            PetSnapshot missSnap = PetSnapshot.Parse("{\"rev\":10,\"label\":\"待机中\",\"settings\":{}}");
            bool fsMissing = missSnap != null && missSnap.Settings != null &&
                !missSnap.Settings.HasStatusFontScale;
            Check(fsMissing, "状态文字字号倍率：缺字段不动现状（旧快照零回归）",
                  fsMissing ? "Has=false" : "不该被置为 true");

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

            // ⭐⭐ 框必须**贴合内容**（用户截图反馈："第一次启动的状态栏大小有问题"）。
            //
            // ⚠️ 用户补充的关键线索：**只有第一次启动（刚启动那一下）是这样**，之后正常。
            // 所以这里必须模拟"**首次显示**"的时序，而不是先 Show 再量 ——
            // 先 Show 会把首帧的问题掩盖掉（第一版就是这么写的，于是绿着、用户照样看到歪框）。
            //
            // 机制：`Update()` 先设文字、紧接着 `PlaceNearPet()` 读 `_chrome.DesiredSize`
            // 来定位。**首帧那次布局还没发生**，DesiredSize 还是旧内容（空文字）的尺寸
            // → 位置按错尺寸算一次。之后任何一次刷新（悬停/快照/缩放）都会重算，所以"过一会就好"。
            // ⭐⭐ 框必须**贴合内容**（用户截图反馈："第一次启动的状态栏大小有问题"，
            // 用户补充："只有在第一次启动就是刚启动的时候会这个样子"）。
            //
            // 尺寸链路（`DiagSizeChain`）能把问题定位到具体哪一环：
            //   textDesired → chromeDesired → actual（SizeToContent 之后）
            // 实测：内容 61.3x13.3 正确，但 actual 是 134.7x37.3 —— 窗口没跟着缩。
            //
            // ⚠️ 这条用**独立实例 + 独立 Pump**，且放在前面那个 `lbl` 关闭**之后**
            //（两个 Topmost 状态窗同时存在会互相干扰测量）。
            try { lbl.ForceClose(); } catch { }
            Pump(150);
            try
            {
                PetStatusLabel fresh = new PetStatusLabel();
                fresh.Update("正在调用工具…", true, false, false, false, new[] { 100, 100, 200, 200 });
                Pump(300);
                double fitW, fitH, winW, winH;
                fresh.DiagChromeSize(out fitW, out fitH);
                fresh.DiagActualSize(out winW, out winH);
                bool firstFit = winW > 0 && winH > 0 &&
                                Math.Abs(winW - fitW) <= 1.0 && Math.Abs(winH - fitH) <= 1.0;
                Check(firstFit, "⭐ 首次显示后框贴合内容（启动瞬间不再歪）",
                      "内容 " + fitW.ToString("0.#") + "x" + fitH.ToString("0.#") +
                      " vs 窗口 " + winW.ToString("0.#") + "x" + winH.ToString("0.#") +
                      " ｜ " + fresh.DiagSizeChain());
                try { fresh.ForceClose(); } catch { }
            }
            catch (Exception ex)
            {
                Check(false, "首帧状态栏尺寸自检", PetLog.Describe(ex));
            }

            // ⭐ 状态文字**独立字号倍率**（用户点名"我希望能够调整字的大小，
            // 因为有的时候字太小了"）。
            //
            // 关键性质有两条，缺一不可：
            //   ① 与 `scale` **相乘**，所以"桌宠小 + 字大"能共存
            //      （用户就是把 scale 调到 0.4，字才小得看不清）；
            //   ② 内边距必须跟**最终字号**成比例 —— 否则字调大后文字贴边。
            //      这条踩过：内边距按 `scale` 单独算，字放 3× 时上下几乎没留白。
            {
                PetStatusLabel fsLabel = new PetStatusLabel();
                fsLabel.DiagSetLabel("正在调用工具…", 0.4, false);   // 用户的实际 scale
                double baseFont = fsLabel.DiagFontSize;
                double basePad = fsLabel.DiagPaddingLeft;
                fsLabel.SetFontScale(3.0);
                double bigFont = fsLabel.DiagFontSize;
                double bigPad = fsLabel.DiagPaddingLeft;
                bool grew = bigFont > baseFont;
                bool padGrew = bigPad > basePad;
                // 倍率应真的生效：0.4×3.0 = 1.2 → 11×1.2 = 13.2
                bool exact = Math.Abs(bigFont - 11 * 0.4 * 3.0) < 0.01;
                Check(grew && padGrew && exact,
                      "⭐ 状态文字字号可独立调大（且内边距同比放大，不贴边）",
                      "0.4× 基准: 字 " + baseFont.ToString("0.#") + "/边距 " + basePad.ToString("0.#") +
                      " → 字号 3×: 字 " + bigFont.ToString("0.#") + "/边距 " + bigPad.ToString("0.#") +
                      "（期望字 " + (11 * 0.4 * 3.0).ToString("0.#") + "）");
                // 下限保护：极端小也不该变成读不了的 1px
                fsLabel.SetFontScale(0.5);
                double tiny = fsLabel.DiagFontSize;
                Check(tiny >= 8, "字号下限保护（再小也不低于 8px）",
                      "0.4 × 0.5 → " + tiny.ToString("0.#") + "px（MinFontSize=8）");
                try { fsLabel.ForceClose(); } catch { }
            }

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

            // ⭐⭐ 裁剪矩形必须**等于图片尺寸**，不能等于 Border 尺寸。
            //
            // 真因（日志实测）：`_border` 挂了 `DropShadowEffect`，`ActualWidth`
            // 把投影外扩量也算进去 —— 修复前 `actual=134.7x119.3` 而贴纸只有
            // `119.3x119.3`。用 134.7 去裁 119.3 的图，圆角落在图片**外面**，
            // 四角仍是直角 → 用户看到"第一次启动那张图没有圆角"。
            //
            // 我先前误判成"时序问题"（加了布局后重刷，治不了它）——
            // 是**把运行期真值写进日志**才定位到的，不是靠读代码推理。
            PetBubble sizeClip = new PetBubble();
            PetBubbleInfo scb = new PetBubbleInfo();
            scb.Id = 90001;
            scb.Kind = "image";
            scb.Opaque = true;
            scb.DurationMs = 60000;
            BitmapSource simg = MakeSolidBubbleBitmap(120);
            sizeClip.Show(scb, simg);
            Pump(300);
            double clipW, clipH, clipR;
            sizeClip.DiagClipGeometry(out clipW, out clipH, out clipR);
            double imgW, imgH;
            sizeClip.DiagImageSize(out imgW, out imgH);
            // 裁剪尺寸必须贴近图片尺寸（容 1px 舍入），而不是 Border（含投影，会大 ~15px）
            bool clipMatchesImage = imgW > 0 && Math.Abs(clipW - imgW) <= 1.5 &&
                                    Math.Abs(clipH - imgH) <= 1.5;
            Check(clipMatchesImage,
                  "⭐ 圆角裁剪用图片尺寸（不是含投影的 Border 尺寸）",
                  "裁剪=" + clipW.ToString("0.#") + "x" + clipH.ToString("0.#") +
                  " 图片=" + imgW.ToString("0.#") + "x" + imgH.ToString("0.#") +
                  (clipMatchesImage ? "（吻合）" : "（偏差过大 → 圆角会落在图外）"));

            // ⭐⭐ 更强的一条：**人为把 Border 撑大**（模拟投影外扩），
            // 裁剪尺寸必须**仍然跟着图片走**。
            //
            // 为什么需要它：上面那条在自检里区分不出 bug —— 自检窗口没有真实投影外扩，
            // `_border.ActualWidth` 恰好等于图片尺寸，所以"用 Border 尺寸裁"也能通过
            //（回退验证时确认过：改回 Border 基准，断言照样绿）。
            // 这里直接把 Border 的 Padding 撑大 30px 来制造差异，
            // 于是"用图片尺寸"与"用 Border 尺寸"必然分道扬镳。
            PetBubble spread = new PetBubble();
            PetBubbleInfo spb = new PetBubbleInfo();
            spb.Id = 91001;
            spb.Kind = "image";
            spb.Opaque = true;
            spb.DurationMs = 60000;
            BitmapSource spimg = MakeSolidBubbleBitmap(120);
            spread.Show(spb, spimg);
            Pump(250);
            double beforeW, beforeH, beforeR, beforeImgW, beforeImgH;
            spread.DiagClipGeometry(out beforeW, out beforeH, out beforeR);
            spread.DiagImageSize(out beforeImgW, out beforeImgH);
            spread.DiagSpreadBorder(30);   // 撑大 Border（模拟投影/内边距造成的外扩）
            Pump(250);
            double afterW, afterH, afterR, afterImgW, afterImgH;
            spread.DiagClipGeometry(out afterW, out afterH, out afterR);
            spread.DiagImageSize(out afterImgW, out afterImgH);
            // Border 撑大了，但**图片没变** → 裁剪也必须没变（跟着图片走）。
            bool followsImage = Math.Abs(afterImgW - beforeImgW) <= 1.5 &&
                                Math.Abs(afterW - beforeW) <= 1.5;
            Check(followsImage,
                  "⭐⭐ Border 被撑大时裁剪仍跟图片走（投影外扩不影响圆角）",
                  "撑大前 裁剪=" + beforeW.ToString("0.#") + " 图片=" + beforeImgW.ToString("0.#") +
                  " → 撑大后 裁剪=" + afterW.ToString("0.#") + " 图片=" + afterImgW.ToString("0.#"));
            try { spread.ForceClose(); } catch { }

            try { sizeClip.ForceClose(); } catch { }
            // ⭐⭐ **新建窗口**首次显示满幅贴纸时圆角必须生效（"第一次启动没圆角"）。
            //
            // 这条是被真实反馈逼出来的：`ApplyBubbleChrome` 在 `UpdateLayout` **之前**
            // 执行，那时 `_border.ActualWidth` 还是 0；而 `SizeToContent` 的真实尺寸
            // 要到布局后才确定。少了"布局后重刷"，首帧的裁剪会按错误尺寸落下 ——
            // 用户看到的就是"第一次启动那张图没有圆角"。
            //
            // 关键点：必须用**全新构造**的气泡（复用的那只会残留上次的裁剪，
            // 掩盖首帧问题 —— 这正是原断言漏掉它的原因）。
            PetBubble freshOpaque = new PetBubble();
            PetBubbleInfo fob = new PetBubbleInfo();
            fob.Id = 89001;
            fob.Kind = "image";
            fob.Opaque = true;
            fob.DurationMs = 60000;
            BitmapSource fimg = MakeSolidBubbleBitmap(64);
            freshOpaque.Show(fob, fimg);
            Pump(300);
            bool freshClipped = freshOpaque.DiagOpaqueClipped;
            double cw, ch, cr;
            freshOpaque.DiagClipGeometry(out cw, out ch, out cr);
            Check(freshClipped && cw > 0 && ch > 0 && cr > 0.5,
                  "⭐ 新建气泡首帧就裁圆角（尺寸/半径都有效）",
                  "裁剪=" + (freshClipped ? "有" : "无") +
                  " 尺寸=" + cw.ToString("0") + "x" + ch.ToString("0") +
                  " 半径=" + cr.ToString("0.#"));
            try { freshOpaque.ForceClose(); } catch { }
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
            // ⭐ 气泡贴本体**左上角**（用户要求："气泡不应该优先在左上角而不是在头顶上吗"）。
            //
            // 原先贴正上方，会**遮住角色的头**。现在气泡右下角对着本体左上角，
            // 像对话框的尾巴指向角色，本体完全不被遮挡。
            // 断言用**计算出的目标方位**（不读未 Show 的 Left/Top —— 那会是 NaN）。
            PetBubble sideProbe = new PetBubble();
            int bx, by;
            sideProbe.DiagTargetFor(1000, 1000, 200, 200, out bx, out by);
            // 本体左上角 = (1000,1000)：气泡应落在**左侧**（bx < 1000）
            bool leftOfPet = bx < 1000;
            bool nearTop = by > 700 && by < 1100;      // 垂直上靠近本体顶部
            Check(leftOfPet && nearTop, "⭐ 气泡贴本体左上角（不再压头顶）",
                  "气泡目标=(" + bx + "," + by + ")；本体左上角=(1000,1000) → " +
                  (leftOfPet ? "在左侧" : "**不在左侧**"));

            // ⭐ 输入窗与气泡**不能占同一侧**（用户反馈"输入框会和气泡重叠"）。
            //
            // 两者是独立窗口、互不知情。现在分工：**气泡占左上、输入窗占正下方**。
            PetInput posProbe = new PetInput(new PetHttp("http://127.0.0.1:1/", "t"));
            double inX, inY;
            posProbe.DiagTargetFor(1000, 1000, 200, 200, out inX, out inY);
            bool inputBelow = inY > 1200;              // 本体底边 = 1200
            Check(inputBelow, "输入窗放在桌宠下方（与气泡分占两侧，不重叠）",
                  "输入窗目标 y=" + inY.ToString("0") + "（桌宠底边 1200，应在其下）");
            // 气泡在左、输入窗在下 → 方位不同，不会叠
            Check(leftOfPet && inputBelow, "气泡在左上 / 输入窗在下方（互不遮挡）",
                  "气泡 x=" + bx + "（本体左侧）；输入窗 y=" + inY.ToString("0") + "（本体下方）");
            try { posProbe.Close(); } catch { }
            try { sideProbe.ForceClose(); } catch { }
            // ⭐ 选择器是**两级折叠**：项目（文件夹）→ 该项目的对话。
            //
            // 被真实反馈逼出来的：同一个项目下能有十几个对话
            //（用户截图一整列 `demac-e2e-cef · session-`），平铺一个下拉翻不到 ——
            // 原话"对话一多，根本翻不到"。项目这一层就是折叠：
            // 先把 N 个对话收敛成 M 个项目（M << N）。
            PetInput picker = new PetInput(new PetHttp("http://127.0.0.1:1/", "t"));
            List<PetSessionChoice> grouped = new List<PetSessionChoice>();
            // alpha 项目 3 个对话（模拟同一文件夹下多个对话 —— 折叠要解决的就是这个）
            for (int gi = 0; gi < 3; gi++)
            {
                PetSessionChoice g = new PetSessionChoice();
                g.SessionId = "session-aaaa111" + gi + "-x";
                g.Title = "alpha 对话" + gi;
                g.Project = "alpha";
                grouped.Add(g);
            }
            // beta 项目 1 个
            PetSessionChoice gb = new PetSessionChoice();
            gb.SessionId = "session-bbbb222-0-x";
            gb.Title = "beta 对话";
            gb.Project = "beta";
            grouped.Add(gb);
            // 没有项目的（应落进"（其他）"）
            PetSessionChoice gn = new PetSessionChoice();
            gn.SessionId = "session-cccc333-0-x";
            gn.Title = "无项目对话";
            grouped.Add(gn);

            picker.SetChoices(grouped);
            List<string> projItems = picker.DiagProjectItems();
            List<string> sessItems = picker.DiagSessionItems();
            // 折叠效果：7 个（含无项目）→ 3 个项目条目
            bool collapsed = projItems.Count == 3 &&
                             projItems[0].Contains("alpha") && projItems[0].Contains("3") &&
                             projItems[1].Contains("beta") && projItems[2].Contains("其他");
            Check(collapsed, "选择器折叠成项目级（N 个对话 → M 个项目）",
                  collapsed ? "项目条目：" + string.Join(" / ", projItems)
                            : "折叠结果不符：" + string.Join(" / ", projItems));
            // 默认落在第一个项目，且只显示该项目下的对话
            bool firstGroupOnly = sessItems.Count == 3;
            Check(firstGroupOnly, "对话级只显示当前项目下的对话（不跨项目混排）",
                  "当前项目对话数=" + sessItems.Count + "（alpha 应有 3 个）");
            // 切到 beta → 对话级应只剩 1 个
            List<string> betaItems = picker.DiagSwitchProject(1);
            bool switched = betaItems.Count == 1 &&
                            picker.SelectedSessionId() == "session-bbbb222-0-x";
            Check(switched, "切项目后对话级跟着换，选中项回传正确",
                  switched ? "beta 下 1 个，选中=" + picker.SelectedSessionId()
                           : "切项目结果不符（" + betaItems.Count + " 个）");
            // 切到"（其他）" → 无项目那 1 个
            List<string> otherItems = picker.DiagSwitchProject(2);
            bool otherOk = otherItems.Count == 1 &&
                           picker.SelectedSessionId() == "session-cccc333-0-x";
            Check(otherOk, "没有项目的对话归入「（其他）」而不是丢失",
                  otherOk ? "（其他）下 1 个" : "结果不符（" + otherItems.Count + " 个）");

            bool sel1 = picker.SelectedSessionId() == "s-a";
            // 换一批（模拟会话结束），选择必须落到新列表里存在的项上 ——
            // 不能残留在已消失的会话上（那会导致消息发给不存在的对话）。
            List<PetSessionChoice> chs2 = new List<PetSessionChoice>();
            PetSessionChoice c3 = new PetSessionChoice(); c3.SessionId = "s-c"; c3.Title = "丙"; c3.Project = "p3";
            chs2.Add(c3);
            picker.SetChoices(chs2);
            bool sel2 = picker.SelectedSessionId() == "s-c";
            picker.SetChoices(new List<PetSessionChoice>());
            bool sel3 = picker.SelectedSessionId() == null;
            // 换批后不残留旧选择（chs2 只有一个会话，应自动选中它）
            Check(sel2 && sel3, "会话选择器：列表变化不残留旧选择、空表返回 null",
                  "换批=" + (sel2 ? "s-c" : "错") + " 空表=" + (sel3 ? "null" : "错"));
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

            // (5b) ⭐ **必须把宿主给的原因带上** —— 这一条是被真机事故逼出来的。
            //
            // 原先 502 只显示"发送失败（HTTP 502）"，把响应体里的 message 整段丢掉，
            // 于是"漏传 signal"的 bug 拖了两轮才定位：宿主明明回了
            // "Cannot read properties of undefined (reading 'throwIfAborted')"，
            // 却被那一行吞掉。**兜底文案不该吃掉原始原因。**
            string b502 = "{\"error\":\"send-failed\",\"message\":\"Cannot read properties of undefined (reading 'throwIfAborted')\"}";
            string r502 = PetInput.DescribeSendError(502, b502);
            bool keepReason = r502.IndexOf("throwIfAborted", StringComparison.Ordinal) >= 0 &&
                              r502.IndexOf("502", StringComparison.Ordinal) >= 0;
            Check(keepReason, "⭐ 502 文案带上宿主给的原因（不再只显示「发送失败」）",
                  "502 →「发送失败（HTTP 502）：Cannot read properties of undefined…」");

            // (5c) 503 用 `reason` 字段（形状与 502 的 `message` 不同）
            bool keepReason503 = PetInput.DescribeSendError(
                503, "{\"error\":\"unavailable\",\"reason\":\"宿主未装配 sessionController 服务\"}")
                .IndexOf("sessionController", StringComparison.Ordinal) >= 0;
            Check(keepReason503, "503 文案带上 reason 字段", "503 → 宿主未装配 sessionController 服务");

            // (5d) 诊断路径**绝不能自己崩**：畸形 / 空 / 非 JSON body 一律安全回落
            bool diagSafe =
                PetInput.ExtractReason(null) == null &&
                PetInput.ExtractReason("") == null &&
                PetInput.ExtractReason("not json at all") == null &&
                PetInput.ExtractReason("{\"message\":}") == null &&
                PetInput.ExtractReason("{\"message\":\"unterminated") == null &&
                PetInput.DescribeSendError(502, "{oops").IndexOf("发送失败", StringComparison.Ordinal) >= 0;
            Check(diagSafe, "解析畸形响应体不抛错（诊断路径自己绝不能崩）",
                  "null/空/非 JSON/缺值/未闭合引号 → 返回 null 并退回通用文案");

            // (5e) 转义与字段优先级：`message` 优先于 `reason`，`\n` 还原成换行
            bool reasonEscOk = PetInput.ExtractReason("{\"reason\":\"次要\",\"message\":\"主\\n原因\"}") == "主\n原因";
            Check(reasonEscOk, "字段优先级与 JSON 转义（message > reason；\\n 还原）", "取到「主⏎原因」");
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
                    // ⭐ 缩放后气泡必须**重新贴齐本体左上角**（坐标随尺寸重算）。
            //
            // 判据随规则更新：以前是"右对齐本体"（贴头顶），现在是
            // **气泡右边缘 = 本体左边缘 - gap**（贴左上角）。
            // 这条能抓住真 bug：若定位用了滞后的旧尺寸、且事后不重贴，
            // 气泡会按新尺寸缩、位置却留在旧尺寸算出来的地方 → 贴不齐。
            PetNative.WorkArea wa2 = PetNative.NearestScreen(0, 0);
            int[] petRect = new int[] { wa2.X + 600, wa2.Y + 300, 200, 200 };
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
                Pump(300);
                int[] r = bubble.DiagWindowRect();
                if (r == null) { detail = "拿不到窗口矩形"; return false; }
                int petLeft = petRect[0];
                int bubbleRight = r[0] + r[2];
                detail = sc.ToString("0.##") + "×: 气泡 " + r[2] + "x" + r[3] + "@" + r[0] + "," + r[1] +
                         " 右边缘=" + bubbleRight + " 本体左边缘=" + petLeft +
                         " 差=" + (petLeft - bubbleRight);
                // 气泡右边缘应在本体左边缘**左侧**（留 gap），容差放宽到 gap+8
                return bubbleRight <= petLeft && petLeft - bubbleRight <= 20;
            }

            string d1, d2, d3;
            bool alignLo = AlignedAt(1.0, out d1);
            bool alignSm = AlignedAt(0.4, out d2);
            bool alignBg = AlignedAt(2.0, out d3);
            Check(alignLo && alignSm && alignBg, "气泡缩放后仍贴齐本体左上角（坐标随尺寸重算）",
                  (alignLo ? "✓" : "✗") + d1 + " | " + (alignSm ? "✓" : "✗") + d2 + " | " + (alignBg ? "✓" : "✗") + d3);
                bubble.SetScale(1.0);
                bubble.HideNow();
                Pump(100);
            try { if (bubble != null) bubble.ForceClose(); } catch { }
            }
        }

        // ------------------------------------------------------------------
        // v7：番茄钟（用户点名"增加番茄钟提醒我休息"）
        // ------------------------------------------------------------------
        //
        // ⚠️ 这一节测的**全是纯函数与解析**，不测计时推进 —— 推进逻辑在 Host 的
        // `src/pet/pomodoro.js` 里（那边有 43 条带假时钟的单测覆盖"每 4 轮长休"
        // 这类跨 25 分钟的行为）。exe 侧只负责**显示**，所以这里盯的是：
        // 解析健壮性、本地插值、格式化与 Host 同口径、显隐规则、定位。
        private static void TestPomodoro()
        {
            // (1) 块缺失 → null（旧 Host 快照零回归）
            PetSnapshot noBlock = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"label\":\"待机中\"}");
            Check(noBlock != null && noBlock.Pomodoro == null,
                  "pomodoro 块缺失 → null（旧快照零回归）",
                  "Pomodoro=" + (noBlock == null || noBlock.Pomodoro == null ? "null" : "非 null"));

            // (2) 完整块解析
            PetSnapshot s = PetSnapshot.Parse(
                "{\"rev\":2,\"petState\":\"idle\",\"label\":\"待机中\",\"pomodoro\":{" +
                "\"enabled\":true,\"phase\":\"focus\",\"running\":true," +
                "\"remainingMs\":1500000,\"totalMs\":1500000,\"endsAt\":1700000000000," +
                "\"completed\":2,\"round\":3,\"roundsPerLongBreak\":4," +
                "\"autoNext\":true,\"notify\":true,\"text\":\"25:00\",\"show\":true}}");
            PetPomodoroInfo p = s == null ? null : s.Pomodoro;
            bool parsed = p != null && p.Enabled && p.Phase == "focus" && p.Running &&
                          p.RemainingMs == 1500000 && p.TotalMs == 1500000 &&
                          p.EndsAt == 1700000000000L && p.Completed == 2 && p.Round == 3 &&
                          p.RoundsPerLongBreak == 4 && p.Show;
            Check(parsed, "pomodoro 解析：字段齐全",
                  p == null ? "解析失败" : ("phase=" + p.Phase + " running=" + (p.Running ? "1" : "0") +
                  " remain=" + p.RemainingMs + " round=" + p.Round + "/" + p.RoundsPerLongBreak));

            // (3) 非法值回落（不崩）
            PetSnapshot bad = PetSnapshot.Parse(
                "{\"rev\":3,\"petState\":\"idle\",\"pomodoro\":{" +
                "\"enabled\":true,\"phase\":\"__nonsense__\",\"running\":false," +
                "\"remainingMs\":-500,\"totalMs\":-1,\"endsAt\":0," +
                "\"completed\":-9,\"round\":0,\"roundsPerLongBreak\":0}}");
            PetPomodoroInfo bp = bad == null ? null : bad.Pomodoro;
            bool sane = bp != null && bp.Phase == "focus" && bp.RemainingMs == 0 &&
                        bp.TotalMs == 0 && bp.Completed == 0 && bp.Round == 1 &&
                        bp.RoundsPerLongBreak == 4;
            Check(sane, "pomodoro 非法值回落（负数/0/未知 phase 都不崩）",
                  bp == null ? "解析失败" : ("phase=" + bp.Phase + " remain=" + bp.RemainingMs +
                  " round=" + bp.Round + " per=" + bp.RoundsPerLongBreak));

            // (4) ⭐ 本地插值：跑着时用 endsAt - now（Host 不每秒推帧）
            PetPomodoroInfo run = new PetPomodoroInfo();
            run.Enabled = true; run.Running = true; run.EndsAt = 1_700_000_060_000L;
            run.RemainingMs = 999_999;   // 故意给个错的：跑着时应以 endsAt 为准
            long at = 1_700_000_000_000L;
            bool interp = run.RemainingAt(at) == 60_000L;
            Check(interp, "⭐ 跑着时按 endsAt 本地插值（不依赖 Host 每秒推帧）",
                  "endsAt-now=" + run.RemainingAt(at) + "ms（Host 给的 999999ms 被忽略）");

            // (5) ⭐ 暂停时用 Host 的 remainingMs（endsAt 为 0，绝不能拿它算）
            PetPomodoroInfo paused = new PetPomodoroInfo();
            paused.Enabled = true; paused.Running = false; paused.EndsAt = 0;
            paused.RemainingMs = 754_000;
            bool frozen = paused.RemainingAt(at) == 754_000L;
            Check(frozen, "⭐ 暂停时用 Host 的剩余值（EndsAt=0 不会算出负数）",
                  "remain=" + paused.RemainingAt(at) + "ms");

            // (5b) ⭐⭐ **Running=true 但 EndsAt 缺失**时也必须回落 RemainingMs。
            //
            // 这一条是回退验证逼出来的：原先只测了 Running=false 的情形，
            // 而那种情形下 `!Running` 已经短路，`|| EndsAt <= 0` 那段**从未被走到**
            // —— 把 `EndsAt <= 0` 删掉，自检照样全绿（探针实测 FAIL=0）。
            // 真实场景：残缺/被截断的快照，或旧 Host 给了 running 却没给 endsAt。
            // 那时硬算 `EndsAt - now` 会得到 -1750000000000ms 这种荒唐值。
            PetPomodoroInfo noEnds = new PetPomodoroInfo();
            noEnds.Enabled = true; noEnds.Running = true; noEnds.EndsAt = 0;
            noEnds.RemainingMs = 321_000;
            bool fellBack = noEnds.RemainingAt(at) == 321_000L;
            Check(fellBack, "⭐⭐ Running=true 但 EndsAt 缺失 → 回落 Host 的剩余值（不硬算负数）",
                  "EndsAt=0 且 running=1 → " + noEnds.RemainingAt(at) + "ms（期望 321000）");

            // (6) 插值下限夹 0（倒计时走完不该显示 -00:03）
            PetPomodoroInfo over = new PetPomodoroInfo();
            over.Running = true; over.EndsAt = at - 5_000; over.RemainingMs = 0;
            bool clamped = over.RemainingAt(at) == 0L;
            Check(clamped, "插值下限夹 0（不出现负数倒计时）",
                  "已过期 5s → " + over.RemainingAt(at) + "ms");

            // (7) ⭐⭐ 格式化必须与 Host 同口径（向上取整）
            // 差一秒会让托盘显示 24:59、桌宠下面显示 25:00，用户以为其中一个坏了。
            bool fmt =
                PetApp.FormatRemaining(400) == "00:01" &&      // 向上取整（Host 的 Math.ceil）
                PetApp.FormatRemaining(0) == "00:00" &&
                PetApp.FormatRemaining(-5) == "00:00" &&       // 负数不出负号
                PetApp.FormatRemaining(60_000) == "01:00" &&
                PetApp.FormatRemaining(1_500_000) == "25:00" &&
                PetApp.FormatRemaining(59_999) == "01:00" &&
                PetApp.FormatRemaining(3_600_000) == "1:00:00" &&
                PetApp.FormatRemaining(3_661_000) == "1:01:01";
            Check(fmt, "⭐⭐ 剩余时间格式化与 Host 同口径（向上取整 / 时分进位）",
                  "400ms→" + PetApp.FormatRemaining(400) + " 1.5Mms→" + PetApp.FormatRemaining(1_500_000) +
                  " 3600s→" + PetApp.FormatRemaining(3_600_000));

            // (8) 阶段名标签
            bool labels = PetApp.PomodoroPhaseLabel("focus") == "专注" &&
                          PetApp.PomodoroPhaseLabel("break") == "休息" &&
                          PetApp.PomodoroPhaseLabel("long-break") == "长休息" &&
                          PetApp.PomodoroPhaseLabel("__x__") == "专注";   // 未知按专注（前向兼容）
            Check(labels, "阶段名标签（未知阶段回落专注，不显示空白）",
                  "focus→" + PetApp.PomodoroPhaseLabel("focus") +
                  " long-break→" + PetApp.PomodoroPhaseLabel("long-break"));

            // (9) 显示文本：专注带轮次、休息不带
            PetPomodoroInfo fp = new PetPomodoroInfo();
            fp.Enabled = true; fp.Show = true; fp.Running = false;
            fp.Phase = "focus"; fp.Round = 3; fp.RoundsPerLongBreak = 4;
            fp.RemainingMs = 754_000; fp.EndsAt = 0;
            string focusText = PetApp.PomodoroTextFor(fp, at);
            fp.Phase = "break";
            string breakText = PetApp.PomodoroTextFor(fp, at);
            bool textOk = focusText == "专注 12:34 · 3/4" && breakText == "休息 12:34";
            Check(textOk, "显示文本：专注带轮次、休息不带（避免误以为在专注）",
                  "focus=\"" + focusText + "\" break=\"" + breakText + "\"");

            // (10) show=false / enabled=false / 块 null → 不显示
            PetPomodoroInfo off = new PetPomodoroInfo();
            off.Enabled = true; off.Show = false;
            bool hidden = PetApp.PomodoroTextFor(off, at) == null &&
                          PetApp.PomodoroTextFor(null, at) == null;
            PetPomodoroInfo disabled = new PetPomodoroInfo();
            disabled.Enabled = false; disabled.Show = true;
            hidden = hidden && PetApp.PomodoroTextFor(disabled, at) == null;
            Check(hidden, "enabled=false / show=false / 块 null 一律不显示",
                  "三种关闭路径都返回 null");

            // (11) diff：值相同 = Same（零日志零重排）
            PetPomodoroInfo a1 = PetSnapshot.Parse(
                "{\"rev\":4,\"petState\":\"idle\",\"pomodoro\":{\"enabled\":true,\"phase\":\"focus\"," +
                "\"running\":true,\"remainingMs\":1000,\"totalMs\":2000,\"endsAt\":5,\"completed\":1," +
                "\"round\":1,\"roundsPerLongBreak\":4,\"show\":true}}").Pomodoro;
            PetPomodoroInfo a2 = PetSnapshot.Parse(
                "{\"rev\":5,\"petState\":\"idle\",\"pomodoro\":{\"enabled\":true,\"phase\":\"focus\"," +
                "\"running\":true,\"remainingMs\":1000,\"totalMs\":2000,\"endsAt\":5,\"completed\":1," +
                "\"round\":1,\"roundsPerLongBreak\":4,\"show\":true}}").Pomodoro;
            PetPomodoroInfo a3 = PetSnapshot.Parse(
                "{\"rev\":6,\"petState\":\"idle\",\"pomodoro\":{\"enabled\":true,\"phase\":\"break\"," +
                "\"running\":true,\"remainingMs\":1000,\"totalMs\":2000,\"endsAt\":5,\"completed\":1," +
                "\"round\":1,\"roundsPerLongBreak\":4,\"show\":true}}").Pomodoro;
            bool diffOk = PetPomodoroInfo.Same(a1, a2) && !PetPomodoroInfo.Same(a1, a3) &&
                          PetPomodoroInfo.Same(null, null) && !PetPomodoroInfo.Same(a1, null);
            Check(diffOk, "pomodoro diff：同值不动作、阶段变化才动作、null 与有值不同",
                  "同值→true；focus→break→false；null/null→true");

            // (12) ⭐ 动作白名单（exe 侧也要挡一层，不能只靠 Host）
            bool wl = PetHttp.IsKnownPomodoroAction("start") &&
                      PetHttp.IsKnownPomodoroAction("pause") &&
                      PetHttp.IsKnownPomodoroAction("toggle") &&
                      PetHttp.IsKnownPomodoroAction("skip") &&
                      PetHttp.IsKnownPomodoroAction("reset") &&
                      !PetHttp.IsKnownPomodoroAction("__proto__") &&
                      !PetHttp.IsKnownPomodoroAction("START") &&      // 大小写敏感
                      !PetHttp.IsKnownPomodoroAction("start ") &&     // 尾空格不许过
                      !PetHttp.IsKnownPomodoroAction("") &&
                      !PetHttp.IsKnownPomodoroAction(null) &&
                      !PetHttp.IsKnownPomodoroAction("start;exit");
            Check(wl, "番茄钟动作白名单（大小写/空格/注入串一律拒绝）",
                  "5 个合法动作通过；__proto__/START/尾空格/空/注入串全部拒绝");

            // (13) 倒计时窗：纯展示（不吃焦点、置顶）
            PetPomodoro pomo = new PetPomodoro();
            Check(pomo.IsPureDisplay, "番茄钟窗是纯展示（不抢焦点 + 置顶）",
                  "ShowActivated=false, Topmost=true");

            // (14) 定位复用 ComputeTarget（测运行路径，不是副本）
            double tx, ty; int bw, bh;
            pomo.DiagTargetFor(1000, 800, 200, 200, out tx, out ty, out bw, out bh);
            bool placed = tx > 0 && ty > 800;   // 在本体下方
            Check(placed, "倒计时窗贴本体下方居中（复用 ComputeTarget）",
                  "本体(1000,800,200,200) → 窗 " + bw + "x" + bh + " @" + (int)tx + "," + (int)ty);

            // (15) ⭐ 显隐：**穿透时照显示**（与状态文字的关键差别）
            pomo.DiagSetState("专注 25:00", true, true);
            bool shownWhenWanted = pomo.DiagShouldShow;
            pomo.DiagSetState("专注 25:00", false, true);
            bool hiddenWhenOff = !pomo.DiagShouldShow;
            pomo.DiagSetState("专注 25:00", true, false);   // 本体藏了 → 一起藏
            bool hiddenWithPet = !pomo.DiagShouldShow;
            pomo.DiagSetState("", true, true);              // 没内容 → 不显示空框
            bool hiddenWhenEmpty = !pomo.DiagShouldShow;
            Check(shownWhenWanted && hiddenWhenOff && hiddenWithPet && hiddenWhenEmpty,
                  "⭐ 倒计时显隐：要显示就显示 / 关掉不显示 / 本体藏了一起藏 / 空内容不显示",
                  "wanted→" + shownWhenWanted + " off→" + hiddenWhenOff +
                  " petHidden→" + hiddenWithPet + " empty→" + hiddenWhenEmpty);

            try { pomo.ForceClose(); } catch { }
            Pump(60);
        }

        // ------------------------------------------------------------------
        // v8：语音（只播不合成）
        // ------------------------------------------------------------------
        //
        // ⚠️ 这一节**不测真实播放**（自检环境可能没有音频设备，且出声会打扰人）。
        // 测的是三件会真出错的事：清单解析与白名单、事件轮换、播放器的
        // 去重/节流/开关语义 —— 那些都是纯逻辑，可以确定性地验。
        private static void TestVoice()
        {
            // (1) 清单缺失/坏掉 → 空清单（不抛）
            PetVoiceManifest empty = PetVoiceManifest.Parse(null);
            Check(empty != null && empty.Count == 0 && empty.Has("x") == false,
                  "语音清单缺失 → 空清单（不抛，静音运行）",
                  "Count=" + (empty == null ? -1 : empty.Count));

            PetVoiceManifest bad = PetVoiceManifest.Parse("{ not json");
            Check(bad != null && bad.Count == 0, "语音清单坏 JSON → 空清单（不抛）", "Count=" + bad.Count);

            // (2) 正常解析
            string json =
                "{\"version\":1,\"generatedAt\":\"2026-01-01T00:00:00Z\",\"count\":3,\"lines\":[" +
                "{\"name\":\"click-1\",\"file\":\"click-1.mp3\",\"event\":\"pet/click\",\"source\":\"real\",\"durationMs\":2480,\"bytes\":20315}," +
                "{\"name\":\"click-2\",\"file\":\"click-2.mp3\",\"event\":\"pet/click\",\"source\":\"real\",\"durationMs\":920,\"bytes\":7985}," +
                "{\"name\":\"done-1\",\"file\":\"done-1.mp3\",\"event\":\"turn/complete\",\"source\":\"real\",\"durationMs\":2570,\"bytes\":21150}" +
                "]}";
            PetVoiceManifest m = PetVoiceManifest.Parse(json);
            bool parsed = m.Count == 3 && m.Version == 1 &&
                          m.Has("click-1") && m.Has("done-1") && !m.Has("nope") &&
                          m.Get("click-1").DurationMs == 2480 && m.Get("click-1").Bytes == 20315 &&
                          m.Get("click-1").Source == "real";
            Check(parsed, "语音清单解析：条数/时长/字节/来源都正确",
                  "Count=" + m.Count + " click-1=" + m.Get("click-1").DurationMs + "ms");

            // (3) ⭐ 按事件轮换（同名事件多条时换着播）
            PetVoiceLine v0 = m.PickForEvent("pet/click", 0);
            PetVoiceLine v1 = m.PickForEvent("pet/click", 1);
            PetVoiceLine v2 = m.PickForEvent("pet/click", 2);
            bool rotate = v0.Name == "click-1" && v1.Name == "click-2" && v2.Name == "click-1";
            Check(rotate, "⭐ 同名事件按 seed 轮换（连点不会永远是同一句）",
                  "seed 0/1/2 → " + v0.Name + " / " + v1.Name + " / " + v2.Name);

            // (4) 没有该事件的语音 → null（不抛）
            Check(m.PickForEvent("nope/event", 0) == null && m.PickForEvent(null, 0) == null,
                  "没有该事件的语音 → null（不抛）", "nope/event → null");

            // (4a) ⭐⭐ 状态 → 台词事件的对应表（抽成纯函数后逐条钉住）
            //
            // 为什么值得单测：这段判断原先埋在 `SpeakForSnapshot` 里（周围还塞着
            // attention、番茄钟、空闲计时三个分支），漏一条的后果是
            // **台词表里有、运行时永不播，且完全无声**。实测就是这样漏掉了
            // `pet/wake` / `pet/sleeping` / `pomodoro/start` / `chat/reply` 共 27 条。
            bool trig =
                PetVoiceTrigger.ForStateTransition("idle", "error") == "agent/error" &&
                PetVoiceTrigger.ForStateTransition("idle", "happy") == "turn/complete" &&
                PetVoiceTrigger.ForStateTransition("thinking", "working") == "agent/working" &&
                PetVoiceTrigger.ForStateTransition("idle", "working") == "agent/working" &&
                PetVoiceTrigger.ForStateTransition(null, "working") == "agent/working" &&
                PetVoiceTrigger.ForStateTransition("idle", "thinking") == "agent/thinking" &&
                PetVoiceTrigger.ForStateTransition(null, "waking") == "pet/wake" &&
                PetVoiceTrigger.ForStateTransition("idle", "sleeping") == "pet/sleeping";
            Check(trig, "⭐⭐ 状态切换 → 台词事件（含此前漏掉的 pet/wake / pet/sleeping）",
                  "error→agent/error, happy→turn/complete, working→agent/working, " +
                  "thinking→agent/thinking, waking→pet/wake, sleeping→pet/sleeping");

            // ⚠️ 两条"刻意不说话"是有意为之，不是遗漏：
            //   · `working → thinking`：干活时已经报过幕，回到思考**不再重复**
            //     （否则一轮里来回调三次"让我想想"，像复读机）；
            //   · `idle`：最常见的状态，按状态出声必然变复读机。
            bool trigSilent =
                PetVoiceTrigger.ForStateTransition("idle", "idle") == null &&
                PetVoiceTrigger.ForStateTransition("working", "thinking") == null &&
                PetVoiceTrigger.ForStateTransition("sleeping", "sleeping") == null &&
                PetVoiceTrigger.ForStateTransition("idle", "listening") == null &&  // 已降级为纯气泡
                PetVoiceTrigger.ForStateTransition("idle", null) == null;
            Check(trigSilent, "⭐ 这些切换**刻意**不出声（idle 不响、working→thinking 不重复、listening 已降级）",
                  "idle→idle / working→thinking / sleeping→sleeping / idle→listening 均返回 null");

            // 番茄钟「开始计时」那个此前缺失的时机
            Check(PetVoiceTrigger.ForPomodoroStart(false) == "pomodoro/start" &&
                  PetVoiceTrigger.ForPomodoroStart(true) == null,
                  "⭐⭐ 番茄钟由停到跑 → pomodoro/start（此前根本没有这个触发点）",
                  "wasRunning=false → pomodoro/start；已在跑 → null");

            // (4b) ⭐⭐ v2：exe 会说的**每一个**事件，台词表里都必须有货。
            //
            // 为什么必须断言这条：`Speak()` 找不到语音时**静默返回 false**
            //（那是正常的 —— 有些事件就是没有语音）。于是"改了事件名/删了台词"
            // 这类错误在运行时**完全无声**：用户只会觉得"某些时候她不出声"，
            // 永远定位不到。把清单与代码的契约钉在自检里。
            //
            // ⚠️ 名单改用 `PetVoiceTrigger.SpokenEvents`（v3）：原来这里**另抄了一份**，
            //   于是抄漏的 `pet/wake` / `pet/sleeping` / `chat/reply` / `pomodoro/start`
            //   在名单里躺着、代码里却一个 `Speak()` 都没有 —— 这条断言看着绿，
            //   实际是**空的**（清单 137 条里有 27 条永远不会被播）。
            //   触发点与名单现在同源，且下面 (4c) 反向再查一遍。
            string[] spokenEvents = PetVoiceTrigger.SpokenEvents;
            // 名单本身必须是**合法**的台词事件名（不能写错字却"自洽"地全绿）
            bool listSane = spokenEvents.Length == 20 &&
                            Array.IndexOf(spokenEvents, "pet/wake") >= 0 &&
                            Array.IndexOf(spokenEvents, "pet/sleeping") >= 0 &&
                            Array.IndexOf(spokenEvents, "chat/reply") >= 0 &&
                            Array.IndexOf(spokenEvents, "pomodoro/start") >= 0;
            Check(listSane,
                  "⭐⭐ 可说事件名单就是那 20 个（含 pet/wake / pet/sleeping / chat/reply / pomodoro/start）",
                  "20 个：" + string.Join(", ", spokenEvents));
            string manifestJson = null;
            try
            {
                string mp = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,
                    "..", "art", "voice", "voice.json");
                if (File.Exists(mp)) manifestJson = File.ReadAllText(mp, System.Text.Encoding.UTF8);
                else
                {
                    string mp2 = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "art", "voice", "voice.json");
                    if (File.Exists(mp2)) manifestJson = File.ReadAllText(mp2, System.Text.Encoding.UTF8);
                }
            }
            catch { }
            if (manifestJson != null)
            {
                PetVoiceManifest real = PetVoiceManifest.Parse(manifestJson);
                List<string> gap = new List<string>();
                for (int i = 0; i < spokenEvents.Length; i++)
                {
                    if (real.PickForEvent(spokenEvents[i], 0) == null) gap.Add(spokenEvents[i]);
                }
                Check(gap.Count == 0,
                      "⭐⭐ 代码会说的每个事件，台词表里都有语音（无静默缺口）",
                      gap.Count == 0
                        ? "20 个事件全部有货（清单 " + real.Count + " 条）"
                        : "缺：" + string.Join(", ", gap.ToArray()));
            }
            else
            {
                Check(true, "⭐ 代码事件覆盖（跳过：自检环境读不到 art/voice/voice.json）", "跳过");
            }

            // (4c) ⭐⭐ **反向**覆盖：台词表里的每个事件都必须真的会被播。
            //
            // (4b) 查的是"名单 ⊆ 清单"，查不出"名单里多了一个没人触发的事件"。
            // 实测就是这样攒出 27 条闲置台词（137 条的 20%）—— 而症状是
            // **完全无声**：没有报错、没有日志，用户只会觉得"她有时候不说话"。
            // 这条把"清单事件 ⊆ 名单"钉住。
            if (manifestJson != null)
            {
                PetVoiceManifest real = PetVoiceManifest.Parse(manifestJson);
                List<string> orphans = new List<string>();
                HashSet<string> known = new HashSet<string>(spokenEvents);
                for (int i = 0; i < real.Lines.Count; i++)
                {
                    string ev = real.Lines[i].Event;
                    if (string.IsNullOrEmpty(ev)) continue;      // 无归属条目：另有断言
                    if (!known.Contains(ev)) orphans.Add(ev);
                }
                List<string> uniq = new List<string>();
                for (int i = 0; i < orphans.Count; i++)
                {
                    if (!uniq.Contains(orphans[i])) uniq.Add(orphans[i]);
                }
                Check(uniq.Count == 0,
                      "⭐⭐ 台词表里没有\"永远不会被播\"的事件（反向覆盖）",
                      uniq.Count == 0
                        ? ("清单 " + real.Count + " 条全部有触发点（" + spokenEvents.Length + " 个事件）")
                        : ("这些事件没有任何 Speak() 调用：" + string.Join(", ", uniq.ToArray())));
            }

            // (5) ⭐⭐ 名字白名单（exe 侧也要挡：清单是网络来的，是跨进程信任边界）
            bool safe = PetVoiceManifest.IsSafeVoiceName("click-1") &&
                        PetVoiceManifest.IsSafeVoiceName("pomodoro-focus-end") &&
                        PetVoiceManifest.IsSafeVoiceName("a.b_c-D9") &&
                        !PetVoiceManifest.IsSafeVoiceName("../index.js") &&
                        !PetVoiceManifest.IsSafeVoiceName("..") &&
                        !PetVoiceManifest.IsSafeVoiceName(".") &&
                        !PetVoiceManifest.IsSafeVoiceName("a/b") &&
                        !PetVoiceManifest.IsSafeVoiceName("a\\b") &&
                        !PetVoiceManifest.IsSafeVoiceName("C:\\x.mp3") &&
                        !PetVoiceManifest.IsSafeVoiceName("a..b") &&
                        !PetVoiceManifest.IsSafeVoiceName(".hidden") &&
                        !PetVoiceManifest.IsSafeVoiceName("") &&
                        !PetVoiceManifest.IsSafeVoiceName(null) &&
                        !PetVoiceManifest.IsSafeVoiceName("a b") &&
                        !PetVoiceManifest.IsSafeVoiceName("a;b");
            Check(safe, "⭐⭐ 语音名白名单（穿越/盘符/分隔符/空白一律拒绝）",
                  "合法 3 个通过；../、..、a/b、C:\\、a..b、.hidden、空、空格、分号全部拒绝");

            // (6) 清单里的非法条目被丢弃（第二层防线）
            PetVoiceManifest dirty = PetVoiceManifest.Parse(
                "{\"lines\":[" +
                "{\"name\":\"good\",\"file\":\"good.mp3\",\"event\":\"e\"}," +
                "{\"name\":\"../evil\",\"file\":\"evil.mp3\",\"event\":\"e\"}," +
                "{\"name\":\"evil2\",\"file\":\"../x.mp3\",\"event\":\"e\"}," +
                "{\"name\":\"\",\"file\":\"x.mp3\"}," +
                "null," +
                "\"string\"" +
                "]}");
            Check(dirty.Count == 1 && dirty.Has("good") && !dirty.Has("../evil"),
                  "清单里的非法条目被丢弃（第二层防线，不只靠 Host）",
                  "6 条输入 → 保留 " + dirty.Count + " 条");

            // (8) ⭐ 动态语音：快照解析与去重语义
            //
            // 这批音频是 Host 运行时合成的（子插件 TTS），名字是缓存键。
            // 两条要害：
            //   ① 旧 Host 没这个块 → 全 0/null，exe 不发请求也不出声（零回归）；
            //   ② 去重按 name 而不是 seq —— Host 重启后 seq 归零，
            //      按 name 去重才不会把同一句重复念一遍。
            PetSnapshot noSpeak = PetSnapshot.Parse("{\"petState\":\"idle\"}");
            Check(noSpeak != null && noSpeak.SpeakSeq == 0 &&
                  string.IsNullOrEmpty(noSpeak.SpeakName),
                  "旧快照缺 speak 块 → 零回归（不发请求、不出声）",
                  "SpeakSeq=" + (noSpeak == null ? -1 : noSpeak.SpeakSeq));

            PetSnapshot withSpeak = PetSnapshot.Parse(
                "{\"petState\":\"listening\",\"speak\":{\"seq\":7,\"name\":\"a1b2c3d4e5f60718\"," +
                "\"durationMs\":2400,\"text\":\"做完了，你看看。\"}}");
            Check(withSpeak != null && withSpeak.SpeakSeq == 7 &&
                  withSpeak.SpeakName == "a1b2c3d4e5f60718" && withSpeak.SpeakDurationMs == 2400,
                  "speak 块解析：seq/name/durationMs 都读对",
                  "seq=" + (withSpeak == null ? -1 : withSpeak.SpeakSeq) +
                  " name=" + (withSpeak == null ? "null" : withSpeak.SpeakName));

            PetSnapshot badSpeak = PetSnapshot.Parse(
                "{\"speak\":{\"seq\":\"NaN\",\"name\":null,\"durationMs\":-5}}");
            Check(badSpeak != null && badSpeak.SpeakSeq == 0 &&
                  string.IsNullOrEmpty(badSpeak.SpeakName),
                  "speak 块非法值不崩（seq 非数字→0，name null→null）",
                  "seq=" + (badSpeak == null ? -1 : badSpeak.SpeakSeq));

            // 动态语音的名字形状（Host 侧的读取路由也按这个白名单挡）
            bool speechNameShape = System.Text.RegularExpressions.Regex.IsMatch(
                "a1b2c3d4e5f60718", "^[0-9a-f]{16}$") &&
                !System.Text.RegularExpressions.Regex.IsMatch("A1B2C3D4E5F60718", "^[0-9a-f]{16}$") &&
                !System.Text.RegularExpressions.Regex.IsMatch("../evil", "^[0-9a-f]{16}$");
            Check(speechNameShape,
                  "⭐ 动态语音名形状：16 位小写十六进制（穿越/大写/短名都不匹配）",
                  "a1b2…匹配；A1B2…/../evil 不匹配");

            string cacheDir = Path.Combine(Path.GetTempPath(), "zf-voice-selftest");
            try { if (!Directory.Exists(cacheDir)) Directory.CreateDirectory(cacheDir); } catch { }
            PetVoicePlayer player = new PetVoicePlayer(null, cacheDir);
            // (7) ⭐⭐ 播放器：开关关掉时**不播**（默认静音）
            byte[] fakeMp3 = new byte[256];
            fakeMp3[0] = 0xFF; fakeMp3[1] = 0xFB;   // 帧同步头（内容不重要，不真解码）

            player.Enabled = false;
            bool playedWhenOff = player.Play(fakeMp3, "pet/click", 1000);
            Check(!playedWhenOff, "⭐ 语音关掉时**不播**（默认静音，用户主动开才出声）",
                  "Enabled=false → Play 返回 false");

            // (8) ⭐ 空字节不播（不崩）—— 且**必须在改动任何状态之前**就挡下。
            //
            // ⚠️ 这条断言被回退验证修过一次：原先只断言"返回 false"，而把
            // `bytes.Length == 0` 判断删掉后**仍然返回 false** —— 因为
            // `File.WriteAllBytes(path, null)` 会抛，被 catch 兜住又返回 false。
            // 那是**巧合式安全**（靠下游异常兜底），断言测不出差别。
            //
            // 真正的可观测差别：守卫路径在**碰任何状态之前**就返回，
            // 所以既不该写文件、也不该记节流时间戳。这里用**独立的 eventKey**
            // 断言"节流表里没有它"，从而把"提前挡下"与"事后兜底"区分开。
            player.Enabled = true;
            const string emptyEvt = "selftest/empty";
            bool playedNull = player.Play(null, emptyEvt, 1000);
            bool playedEmptyArr = player.Play(new byte[0], emptyEvt, 1000);
            bool noSideEffect = player.DiagLastFired(emptyEvt) == 0;
            Check(!playedNull && !playedEmptyArr && noSideEffect,
                  "空字节在改动任何状态之前就被挡下（不写文件、不记节流表）",
                  "null/空数组 → false；节流表无记录=" + noSideEffect);

            // (9) ⭐ 播放中再请求 → 丢弃（不排队：排队会让语音滞后于事件）
            //
            // ⚠️ 只对**固定台词**成立。动态回复走 `interrupt: true` 会抢占，
            //    见下面的 (9b) —— 那条是实际丢过语音才加的。
            player.DiagSetPlayingUntil(unchecked(Environment.TickCount + 5000));
            int before = player.DroppedCount;
            bool playedWhileBusy = player.Play(fakeMp3, "pet/wake", 1000);
            Check(!playedWhileBusy && player.DroppedCount > before,
                  "⭐ 上一句没播完就丢弃新的（不排队 —— 排队会让语音滞后于事件）",
                  "播放中 → Play 返回 false，Dropped " + before + " → " + player.DroppedCount);

            // (9b) ⭐⭐ 动态回复可以**抢占**固定台词（忙也要播）
            //
            // 这是实测丢过语音才补的断言：AI 回复的合成音频与固定台词共用
            // 同一个单槽播放器，原先一律"忙就丢"。只要回复音频到达的瞬间
            // 正好有条固定台词在响，回复就被静默丢弃，而且**再也不会播**
            //（重试只发生在上游来帧的时候，桌宠 idle 之后就没有帧了）。
            // 实测：一次被拖 51.4 秒，另一次 20 秒内零日志、那句永久丢失。
            player.DiagSetPlayingUntil(unchecked(Environment.TickCount + 5000));
            int preemptBefore = player.PreemptedCount;
            int droppedBefore = player.DroppedCount;
            bool replyWhileBusy = player.Play(fakeMp3, "speech", 1000, interrupt: true);
            Check(replyWhileBusy && player.PreemptedCount > preemptBefore,
                  "⭐⭐ 动态回复忙时也播（抢占固定台词）—— 否则回复会被静默丢弃且不再重试",
                  "播放中 + interrupt:true → Play 返回 true，Preempted " +
                  preemptBefore + " → " + player.PreemptedCount);
            Check(player.DroppedCount == droppedBefore,
                  "⭐ 抢占路径不该**同时**记一次丢弃（那是两条互斥的路）",
                  "Dropped 保持 " + droppedBefore);

            // (9c) ⭐⭐ 同一条回复的**后续分片要排队**，不能互相抢占
            //
            // 去掉"只念 60 字"的限制靠的是"按句分段、边合成边播"。
            // 于是同一句回复会有好几段陆续到达。若每段都当新的一句去抢占，
            // 第 2 段一到就把还在播的第 1 段打断 —— 听起来就是每句只念开头几个字。
            player.DiagSetPlayingUntil(0);
            player.Stop();
            long utt = 4242;
            player.DeliverReply(fakeMp3, 1000, utt);        // 第一段：空闲 → 立刻播
            bool firstPlaying = player.IsPlaying;
            player.DeliverReply(fakeMp3, 1000, utt);        // 第二段：上一段还在播 → 入队
            player.DeliverReply(fakeMp3, 1000, utt);        // 第三段：同上
            Check(firstPlaying && player.PendingReplies == 2,
                  "⭐⭐ 同一次回复的后续分片**排队**（不抢占）—— 否则每段只念开头几个字",
                  "第 1 段起播=" + firstPlaying + "，队列剩 " + player.PendingReplies);

            // (9d) ⭐⭐ 换一句（新 utterance）→ 清空队列并打断
            int intBefore = player.InterruptedCount;
            long utt2 = 4243;
            player.DeliverReply(fakeMp3, 1000, utt2);
            Check(player.InterruptedCount > intBefore && player.PendingReplies == 0,
                  "⭐⭐ 换了新的一句 → 清空旧队列并打断（旧答案已经没意义了）",
                  "Interrupted " + intBefore + " → " + player.InterruptedCount +
                  "，队列 " + player.PendingReplies);

            // (9e) ⭐ 队列会按序排出去（续播泵调用的就是它）
            //
            // ⚠️ 注意第一段是**立刻播**的（空闲时不等），所以"队列长度"要
            //    在第 2 段之后才开始涨。我第一版断言写的是"入队后 ≥2"，
            //    忘了这一点 → 误报。**测试错了也要当 bug 查。**
            player.Stop();
            long utt3 = 4244;
            player.DeliverReply(fakeMp3, 1000, utt3);        // 第 1 段：空闲 → 立刻播（队列 0）
            player.DeliverReply(fakeMp3, 1000, utt3);        // 第 2 段：排队
            player.DeliverReply(fakeMp3, 1000, utt3);        // 第 3 段：排队
            int qAfterEnqueue = player.PendingReplies;       // 期望 2
            player.Stop();                                   // 模拟"上一段播完了"
            player.DrainReplies();                           // 泵一次 → 播第 2 段
            int qAfterDrain = player.PendingReplies;         // 期望 1
            Check(qAfterEnqueue == 2 && qAfterDrain == 1,
                  "⭐ 续播泵每滴一次推进一段（队列不会卡住）",
                  "队列入队后 " + qAfterEnqueue + " → 泵一次后 " + qAfterDrain);
            // 收尾：清干净，别让残留队列影响后面的用例
            player.Stop();
            player.DrainReplies();
            player.Stop();
            player.DrainReplies();

            // (9f) ⭐⭐ 队列有上限（第二道防线：上游去重失效时不会无限重复念）
            //
            // 我踩过这个：把 `Play` 换成 `DeliverReply` 时**漏掉了
            // `_lastSpeakName = snap.SpeakName` 那行**，于是每一帧都重新交付同一段。
            // 实测队列从 0 一路涨到 21 且还在涨，桌宠开始无限重复念
            //「那就什么都在。」真正的防线是上游的 name 去重（已修），
            // 这里是第二道：即使上游再犯，也不能无限刷屏。
            player.Stop();
            long uttFlood = 7777;
            for (int i = 0; i < PetVoicePlayer.MaxReplyQueue + 10; i++)
            {
                player.DeliverReply(fakeMp3, 1000, uttFlood);
            }
            Check(player.PendingReplies <= PetVoicePlayer.MaxReplyQueue,
                  "⭐⭐ 回复队列有上限（上游去重失效时不会无限重复念同一句）",
                  "灌入 " + (PetVoicePlayer.MaxReplyQueue + 10) + " 段 → 队列 " +
                  player.PendingReplies + "（上限 " + PetVoicePlayer.MaxReplyQueue + "）");
            // 收尾
            player.Stop();
            for (int i = 0; i < PetVoicePlayer.MaxReplyQueue + 2; i++) { player.DrainReplies(); player.Stop(); }

            // (10) ⭐ 高频道事件节流（连点十下不叠十条）
            //
            // ⚠️ 这条也被回退验证修过：原先两次 Play 之间**没有清掉"正在播"**，
            // 于是第二次被"播放中"守卫挡下（而不是被节流挡下）——
            // 把节流判断整个删掉，断言照样通过。
            // 修法：每次 Play 前显式 `DiagSetPlayingUntil(0)`，让"正在播"这条
            // 不可能成为原因，从而**只有节流**能解释第二次的失败。
            player.DiagSetPlayingUntil(0);
            player.Play(fakeMp3, "pet/click", 10);
            player.DiagSetPlayingUntil(0);   // 关键：排除"播放中"这个混淆因素
            int after1 = player.DroppedCount;
            bool second = player.Play(fakeMp3, "pet/click", 10);   // 立刻再来一次
            Check(!second && player.DroppedCount > after1,
                  "⭐ 高频道事件节流：同事件最小间隔内重复触发被丢弃（已排除'播放中'干扰）",
                  "间隔 <" + PetVoicePlayer.MinRepeatMs + "ms → 第二次返回 false");

            // (11) 不同事件互不影响节流（点完立刻完成，完成该响）
            player.DiagSetPlayingUntil(0);
            bool otherEvent = player.Play(fakeMp3, "turn/complete", 10);
            Check(otherEvent, "节流是按事件的：点完立刻完成，完成提醒照样响",
                  "pet/click 节流中 → turn/complete 仍可播");

            // (12) 事件名为 null 时不节流（诊断/测试路径）
            player.DiagSetPlayingUntil(0);
            player.Play(fakeMp3, null, 10);
            player.DiagSetPlayingUntil(0);
            bool noKey = player.Play(fakeMp3, null, 10);
            Check(noKey, "事件名为 null 时不做节流（内部/诊断路径）", "null 事件名 → 可连续播");

            // (13) IsPlaying 的时间判定（不依赖真实播放）
            player.DiagSetPlayingUntil(0);
            bool idleNotPlaying = !player.IsPlaying;
            player.DiagSetPlayingUntil(unchecked(Environment.TickCount + 3000));
            bool busyPlaying = player.IsPlaying;
            player.DiagSetPlayingUntil(unchecked(Environment.TickCount - 3000));
            bool expiredNotPlaying = !player.IsPlaying;
            Check(idleNotPlaying && busyPlaying && expiredNotPlaying,
                  "IsPlaying 三态：空闲/播放中/已过期（TickCount 回绕安全）",
                  "0→false；now+3s→true；now-3s→false");

            try { player.Dispose(); } catch { }

            // (14) 真实清单（若已构建）—— 解析器能吃下真实产物
            //
            // 路径从 **exe 所在目录**往上找（exe 在 `bin/`，产物在 `art/voice/`）。
            // 找不到就跳过：语音包是可选的，自检不该因此失败。
            string realManifest = null;
            try
            {
                string exeDir = Path.GetDirectoryName(
                    System.Reflection.Assembly.GetExecutingAssembly().Location);
                string[] candidates = new string[]
                {
                    Path.Combine(exeDir, "art", "voice", "voice.json"),
                    Path.Combine(exeDir, "..", "art", "voice", "voice.json"),
                    Path.Combine(exeDir, "..", "..", "art", "voice", "voice.json")
                };
                for (int i = 0; i < candidates.Length; i++)
                {
                    if (File.Exists(candidates[i])) { realManifest = candidates[i]; break; }
                }
            }
            catch { }

            if (realManifest != null)
            {
                PetVoiceManifest real = PetVoiceManifest.Parse(File.ReadAllText(realManifest, Encoding.UTF8));
                bool realOk = real.Count > 0 &&
                              real.PickForEvent("pomodoro/focus-end", 0) != null &&
                              real.PickForEvent("pet/click", 0) != null &&
                              real.PickForEvent("turn/complete", 0) != null;
                // 关键事件都该有语音（缺了就是功能残废，不是"少一句台词"）
                Check(realOk, "⭐ 真实语音清单：解析成功且关键事件都有语音",
                      "Count=" + real.Count + "；focus-end/click/complete 均有");
                // 每条时长都该 > 0（exe 靠它做播放去重）
                bool allDur = true;
                for (int i = 0; i < real.Lines.Count; i++)
                {
                    if (real.Lines[i].DurationMs <= 0) { allDur = false; break; }
                }
                Check(allDur, "真实清单每条都有非零时长（播放去重的依据）",
                      real.Count + " 条全部 durationMs > 0");
            }
            else
            {
                Check(true, "真实语音清单不存在（未构建）→ 跳过", realManifest);
            }
        }

        // ------------------------------------------------------------------
        // v9：互动与好感度（exe 侧只做三件事：区分点击/拖动、建菜单、播语音）
        // ------------------------------------------------------------------
        //
        // ⚠️ 好感度的**规则**（冷却/递减/日上限）全在 Host 的
        // `src/pet/interactions.js` 里（那边有 27 条带假时钟的单测）。
        // exe 不重算任何数值 —— 这里测的是 exe 自己那部分：
        // 手势判定、白名单、菜单解析、互动信号的去重。
        private static void TestInteract()
        {
            // (1) ⭐⭐ 点击 vs 拖动：两个阈值都要看
            // 只看位移的话"慢慢拖 3px"会被当成点击；只看时间的话"快速拖一大段"也是。
            bool clickCases =
                // 真正的点击：没动或抖了 1~2px，时间很短
                PetWindow.DiagIsClick(0, 0, 50) &&
                PetWindow.DiagIsClick(1, 1, 120) &&
                PetWindow.DiagIsClick(2, 2, 200) &&
                // 边界：刚好 4px / 刚好 300ms 都算点击
                PetWindow.DiagIsClick(4, 0, 300) &&
                PetWindow.DiagIsClick(0, 4, 300);
            bool notClickCases =
                // 拖了 5px → 不是点击
                !PetWindow.DiagIsClick(5, 0, 100) &&
                !PetWindow.DiagIsClick(0, 5, 100) &&
                // 斜着拖：3+3 的直线距离 ≈4.24 > 4 → 不是点击
                !PetWindow.DiagIsClick(3, 3, 100) &&
                // 按了 301ms → 不是点击（长按不该触发互动）
                !PetWindow.DiagIsClick(0, 0, 301) &&
                !PetWindow.DiagIsClick(0, 0, 5000) &&
                // 坐标算不出来（NaN）→ 保守判成"不是点击"（宁可漏一次互动，
                // 也不要把一次拖动误判成点击）
                !PetWindow.DiagIsClick(double.NaN, 0, 50) &&
                !PetWindow.DiagIsClick(0, double.NaN, 50) &&
                // 负数时长（时钟异常）→ 不是点击
                !PetWindow.DiagIsClick(0, 0, -1);
            Check(clickCases && notClickCases,
                  "⭐⭐ 单击 vs 拖动：位移 ≤4px **且** 时长 ≤300ms（两个都要）",
                  "点击 5 例通过；5px/3+3px/301ms/NaN/负时长 全部拒绝");

            // (1b) ⭐ NaN 坐标必须判成"不是点击"。
            //
            // ⚠️ 这条断言**不能只靠"返回 false"** —— 回退验证发现：把
            // `double.IsNaN` 那行删掉，断言照样通过，因为 NaN 参与任何比较
            // 都得 false，`Math.Sqrt(...) <= 4` 本身就是 false。那是**巧合式安全**。
            //
            // 真正该断言的是**这条性质本身**："算不出坐标时保守地不当点击"，
            // 无论实现是靠显式判断还是靠 NaN 语义。所以这里显式写出
            // "NaN 必须为 false"并把理由记下来 —— 将来若有人把它改成
            // `!(dist > 4)`（NaN 会通过！），这条断言就会失败。
            Check(!PetWindow.DiagIsClick(double.NaN, 0, 50) &&
                  !PetWindow.DiagIsClick(0, double.NaN, 50) &&
                  !PetWindow.DiagIsClick(double.NaN, double.NaN, 50) &&
                  !PetWindow.DiagIsClick(double.PositiveInfinity, 0, 50) &&
                  !PetWindow.DiagIsClick(0, double.NegativeInfinity, 50),
                  "⭐ 坐标算不出来（NaN/Inf）时保守判成不是点击（宁可漏一次互动）",
                  "NaN×3 / +Inf / -Inf 全部返回 false");

            // (2) ⭐ 拖动过程中的"移动过"判定用的是同一个阈值（单一真相）
            // 若两处各写一套，早晚出现"判定说没动、实际动了"。
            Check(PetWindow.ClickMaxMovePx == 4.0 && PetWindow.ClickMaxMs == 300,
                  "点击阈值是常量（4px / 300ms），不是散落的魔数",
                  "ClickMaxMovePx=" + PetWindow.ClickMaxMovePx + " ClickMaxMs=" + PetWindow.ClickMaxMs);

            // (3) ⭐⭐ 互动动作白名单（exe 侧也要挡：跨进程信任边界）
            bool wl = PetHttp.IsKnownInteractKind("pet-head") &&
                      PetHttp.IsKnownInteractKind("feed") &&
                      PetHttp.IsKnownInteractKind("praise") &&
                      PetHttp.IsKnownInteractKind("click") &&
                      !PetHttp.IsKnownInteractKind("__proto__") &&
                      !PetHttp.IsKnownInteractKind("toString") &&
                      !PetHttp.IsKnownInteractKind("PRAISE") &&      // 大小写敏感
                      !PetHttp.IsKnownInteractKind("praise ") &&     // 尾空格不许过
                      !PetHttp.IsKnownInteractKind("") &&
                      !PetHttp.IsKnownInteractKind(null) &&
                      !PetHttp.IsKnownInteractKind("praise;exit");
            Check(wl, "互动动作白名单（原型链名字/大小写/空格/注入串一律拒绝）",
                  "4 个合法动作通过；__proto__/toString/PRAISE/尾空格/空/注入串全部拒绝");

            // (4) 互动菜单解析
            string menuJson =
                "{\"kinds\":[" +
                "{\"kind\":\"pet-head\",\"label\":\"摸摸头\",\"hasText\":true}," +
                "{\"kind\":\"feed\",\"label\":\"投喂\",\"hasText\":true}," +
                "{\"kind\":\"praise\",\"label\":\"夸奖\",\"hasText\":true}," +
                "{\"kind\":\"click\",\"label\":\"打招呼\",\"hasText\":false}," +
                "{\"kind\":\"__proto__\",\"label\":\"坏人\"}," +
                "null," +
                "\"string\"" +
                "],\"affection\":{\"points\":25,\"tier\":\"familiar\"," +
                "\"tierLabel\":{\"zh\":\"熟悉\",\"en\":\"Familiar\"},\"nextMin\":60,\"progress\":0.125}}";
            PetInteractMenu menu = PetInteractMenu.Parse(menuJson);
            bool menuOk = menu != null && menu.Kinds.Count == 4 &&
                          menu.Affection != null && menu.Affection.Points == 25 &&
                          menu.Affection.Tier == "familiar" &&
                          menu.Affection.Label() == "熟悉" &&
                          menu.Affection.NextMin == 60;
            Check(menuOk, "⭐ 互动菜单解析（非法动作被丢弃，好感度解析正确）",
                  menu == null ? "解析失败" : ("Kinds=" + menu.Kinds.Count + "（__proto__/null/string 已丢弃）" +
                  " affection=" + menu.Affection.Points + "分/" + menu.Affection.Label()));

            // (5) 菜单解析对坏输入安全
            //
            // ⚠️ 这条断言修过一次。原先只断言"返回 null"，但回退验证发现
            // 把 `arr.IsArr` 检查删掉照样全绿（`PetJson.Get` 对非对象返回 null，
            // 所以 `arr == null` 已经覆盖了）。那是**冗余判断**，不是假守卫。
            //
            // 真正要防的是：**坏 JSON 被容错解析器解析成"合法但没动作的菜单"**，
            // 界面上表现为一个**空的互动子菜单**（用户右键看到空白，不知为何）。
            // `PetJson.Parse` 确实是容错的（`"{ not json"` → 空对象而非 null），
            // 所以这里必须断言"**没有 kinds 数组 → null**"，而不只是"不抛"。
            PetInteractMenu badJson = PetInteractMenu.Parse("{ not json");
            Check(PetInteractMenu.Parse(null) == null &&
                  PetInteractMenu.Parse("") == null &&
                  badJson == null,
                  "⭐ 互动菜单解析：null/空/坏 JSON 一律返回 null（不产生空菜单）",
                  "坏 JSON → " + (badJson == null ? "null（正确）" : "非 null（会显示成空菜单！）"));
            // 反向确认：正常输入必须**能**解析出来（否则上面可能是"什么都解析不出来"）
            Check(PetInteractMenu.Parse("{\"kinds\":[]}") != null,
                  "反向：合法的空动作表仍能解析（证明上面不是一律 null）",
                  "{\"kinds\":[]} → 非 null（Kinds=0）");

            // (6) 菜单缺 label → 回落动作名（界面不出现空白）
            PetInteractMenu noLabel = PetInteractMenu.Parse(
                "{\"kinds\":[{\"kind\":\"feed\"}]}");
            Check(noLabel != null && noLabel.Kinds.Count == 1 &&
                  noLabel.Kinds[0].Label == "feed",
                  "菜单项缺 label → 回落动作名（不显示空白）",
                  "label=\"" + (noLabel == null || noLabel.Kinds.Count == 0 ? "?" : noLabel.Kinds[0].Label) + "\"");

            // (7) ⭐ 好感度解析：非法值回落、进度夹取
            PetAffectionInfo bad = PetAffectionInfo.Parse(
                PetJson.Parse("{\"points\":-5,\"tier\":\"bogus\",\"nextMin\":-1,\"progress\":9}"));
            bool badOk = bad != null && bad.Points == 0 && bad.NextMin == 0 &&
                         bad.Progress == 1 && bad.Label() == "bogus";
            Check(badOk, "好感度解析：负数夹 0、进度夹到 0~1（不崩）",
                  bad == null ? "解析失败" : ("points=" + bad.Points + " nextMin=" + bad.NextMin +
                  " progress=" + bad.Progress));

            // (8) 好感度 diff：值没变不动作
            PetAffectionInfo a1 = PetAffectionInfo.Parse(PetJson.Parse(
                "{\"points\":10,\"tier\":\"stranger\",\"nextMin\":20}"));
            PetAffectionInfo a2 = PetAffectionInfo.Parse(PetJson.Parse(
                "{\"points\":10,\"tier\":\"stranger\",\"nextMin\":20}"));
            PetAffectionInfo a3 = PetAffectionInfo.Parse(PetJson.Parse(
                "{\"points\":20,\"tier\":\"familiar\",\"nextMin\":60}"));
            bool diffOk = PetAffectionInfo.Same(a1, a2) && !PetAffectionInfo.Same(a1, a3) &&
                          PetAffectionInfo.Same(null, null) && !PetAffectionInfo.Same(a1, null);
            Check(diffOk, "好感度 diff：同值不动作、档位变化才动作、null 与有值不同",
                  "同值→true；10→20 分→false；null/null→true");

            // (9) ⭐⭐ 快照里的互动信号：seq 解析（exe 靠它"恰好播一次"语音）
            PetSnapshot s = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"interact\":{\"seq\":7," +
                "\"kind\":\"praise\",\"voice\":\"pet/praise\"}}");
            bool sigOk = s != null && s.InteractSeq == 7 &&
                         s.InteractKind == "praise" && s.InteractVoice == "pet/praise";
            Check(sigOk, "⭐ 互动信号解析（seq/kind/voice）",
                  s == null ? "解析失败" : ("seq=" + s.InteractSeq + " kind=" + s.InteractKind));

            // (10) 旧快照（无 interact/affection 块）→ 零回归
            PetSnapshot old = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"label\":\"待机中\"}");
            Check(old != null && old.InteractSeq == 0 && old.Affection == null,
                  "旧快照缺 interact/affection 块 → 零回归（不显示档位、不播语音）",
                  "InteractSeq=" + (old == null ? -1 : old.InteractSeq) +
                  " Affection=" + (old == null || old.Affection == null ? "null" : "非 null"));

            // (11) ⭐ seq 去重语义：同一个 seq 只该播一次
            // 这里只断言"比较逻辑"（真实的 _lastInteractSeq 在 PetApp 里）：
            // 初值 -1 时 1 > -1 → 播；同一 seq 再来 → 不播。
            long last = -1;
            bool firstPlays = 7 > last;
            last = 7;
            bool sameSkips = !(7 > last);
            bool nextPlays = 8 > last;
            Check(firstPlays && sameSkips && nextPlays,
                  "⭐ 互动语音去重：同 seq 只播一次，新 seq 才播",
                  "seq 7 → 播；再来 7 → 不播；8 → 播");

            // (12) 好感度显示文案（菜单那一行）
            PetAffectionInfo disp = PetAffectionInfo.Parse(PetJson.Parse(
                "{\"points\":25,\"tier\":\"familiar\",\"tierLabel\":{\"zh\":\"熟悉\"}," +
                "\"nextMin\":60,\"progress\":0.125}"));
            bool labelOk = disp != null && disp.Label() == "熟悉";
            PetAffectionInfo maxed = PetAffectionInfo.Parse(PetJson.Parse(
                "{\"points\":200,\"tier\":\"trusted\",\"tierLabel\":{\"zh\":\"信赖\"}," +
                "\"nextMin\":0,\"progress\":1}"));
            bool maxedOk = maxed != null && maxed.NextMin == 0;
            Check(labelOk && maxedOk,
                  "好感度显示：档位名可读、满级时 nextMin=0（界面显示已满级）",
                  "25 分 → " + (disp == null ? "?" : disp.Label()) +
                  "；200 分 → nextMin=" + (maxed == null ? "?" : maxed.NextMin.ToString()));
        }

        // ------------------------------------------------------------------
        // v3：聊天模式（输入窗的"聊天 / 指定对话"两种投递目标）
        // ------------------------------------------------------------------
        //
        // ⚠️ 这一节**不测真实发送**（那要起宿主），测的是：
        // 能力位解析、以及"不可用时**藏起选项**而不是留着让你点了报错"。
        private static void TestChatMode()
        {
            // (1) 块缺失 → 不可用（旧 Host 零回归：输入窗只显示"指定对话"）
            PetSnapshot noBlock = PetSnapshot.Parse(
                "{\"rev\":1,\"petState\":\"idle\",\"label\":\"待机中\"}");
            Check(noBlock != null && noBlock.Chat == null &&
                  !PetChatInfo.ShouldShowChat(noBlock.Chat),
                  "chat 块缺失 → 不可用（旧快照零回归）",
                  "Chat=" + (noBlock == null || noBlock.Chat == null ? "null" : "非 null") +
                  " → ShouldShow=false");

            // (2) 完整块解析
            PetSnapshot s = PetSnapshot.Parse(
                "{\"rev\":2,\"petState\":\"idle\",\"chat\":{" +
                "\"available\":true,\"enabled\":true,\"reason\":null,\"persona\":\"庄方宜\"}}");
            PetChatInfo c = s == null ? null : s.Chat;
            Check(c != null && c.Available && c.Enabled && c.Persona == "庄方宜" &&
                  PetChatInfo.ShouldShowChat(c),
                  "chat 块解析：能力位 + 人设名",
                  c == null ? "解析失败" : ("available=1 enabled=1 persona=" + c.Persona));

            // (3) ⭐ available=false → 不显示（宿主没装配，留着入口就是坑）
            PetSnapshot off = PetSnapshot.Parse(
                "{\"rev\":3,\"petState\":\"idle\",\"chat\":{\"available\":false," +
                "\"enabled\":true,\"reason\":\"宿主未装配 sessionController\"}}");
            Check(off != null && off.Chat != null && !PetChatInfo.ShouldShowChat(off.Chat),
                  "⭐ available=false → 不显示聊天选项（不给一个点了必失败的入口）",
                  "reason=" + (off?.Chat?.Reason ?? "(null)"));

            // (4) ⭐ 用户关掉（enabled=false）时 Host 会报 available=false
            //     —— 两种"不可用"的原因不同，reason 要能区分
            PetSnapshot userOff = PetSnapshot.Parse(
                "{\"rev\":4,\"petState\":\"idle\",\"chat\":{\"available\":false," +
                "\"enabled\":false,\"reason\":\"聊天已在设置里关闭\"}}");
            Check(userOff != null && !PetChatInfo.ShouldShowChat(userOff.Chat) &&
                  userOff.Chat.Enabled == false &&
                  (userOff.Chat.Reason ?? "").Contains("设置"),
                  "⭐ 用户关掉聊天 → 也不显示，且 reason 指明是设置里关的（不是宿主问题）",
                  "reason=" + (userOff?.Chat?.Reason ?? "(null)"));

            // (5) ShouldShowChat 对 null 安全
            Check(!PetChatInfo.ShouldShowChat(null),
                  "ShouldShowChat(null) 安全返回 false", "null → false");

            // (6) ⭐ 真实输入窗：可用性变化时选项真的跟着变
            PetInput input = new PetInput(null);
            try
            {
                List<string> both = input.DiagSetChatAvailability(true, true);
                bool okBoth = both.Count == 2 && both[0] == "聊天" && both[1] == "指定对话";
                Check(okBoth, "⭐ 可用时输入窗有「聊天 + 指定对话」两个选项",
                      string.Join(" / ", both));

                List<string> noHost = input.DiagSetChatAvailability(false, true);
                bool okNoHost = noHost.Count == 1 && noHost[0] == "指定对话";
                Check(okNoHost, "⭐ 宿主不可用时只剩「指定对话」（聊天选项被藏起来）",
                      string.Join(" / ", noHost));

                List<string> chatOff = input.DiagSetChatAvailability(true, false);
                bool okChatOff = chatOff.Count == 1 && chatOff[0] == "指定对话";
                Check(okChatOff, "⭐ 用户关掉聊天时也只剩「指定对话」",
                      string.Join(" / ", chatOff));

                // 反向确认：重新打开后两个选项回来（证明不是"一旦隐藏就回不来"）
                List<string> back = input.DiagSetChatAvailability(true, true);
                Check(back.Count == 2, "反向：重新可用后两个选项都回来",
                      string.Join(" / ", back));
            }
            finally
            {
                try { input.Close(); } catch { }
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

                // ---- 气泡外壳：**按内容决定，不按图片 alpha 决定** ----
                //
                // 用户的原话："表情做气泡内容的时候，为什么一定要加个白底？白底可以去掉啊"。
                // 白底的唯一用途是**让文字可读** —— 纯表情（贴纸/动图）自己就是内容，
                // 垫白卡只会多出双层边框 + 白占内边距。所以规则是：
                //   · 满幅贴纸（opaque=true）      → 不画外壳（原规则）
                //   · 纯图片、无文字（image-only）  → **也不画外壳**（本次新增）
                //   · 有文字                        → 必须有卡片承载
                BitmapSource bmp = MakeSolidBubbleBitmap(24);
                PetBubbleInfo ob = new PetBubbleInfo();
                ob.Id = 990001;
                ob.Kind = "image";
                ob.Image = "bubble/opaque-selftest.png";
                ob.Opaque = true;
                bubble.Show(ob, bmp);
                bool opaqueOk = bubble.IsOpaquePresentation;
                Check(opaqueOk, "满幅贴纸气泡：不画底/边框/内边距 + 图片上限放宽 240",
                      "IsOpaquePresentation=" + opaqueOk +
                      "（背景透明、BorderThickness=0、Padding=0、MaxWidth/MaxHeight=240，投影保留）");

                // 纯表情（透明抠图、无文字）—— 同样不套白卡
                PetBubbleInfo tb = new PetBubbleInfo();
                tb.Id = 990002;
                tb.Kind = "image";
                tb.Image = "bubble/cutout-selftest.png";
                bubble.Show(tb, bmp);
                bool cutoutBare = bubble.IsOpaquePresentation && bubble.DiagPaddingLeft == 0;
                Check(cutoutBare, "⭐ 纯表情（无文字）：**不垫白底**（用户明确要求去掉）",
                      "IsOpaquePresentation=" + bubble.IsOpaquePresentation +
                      " PaddingLeft=" + bubble.DiagPaddingLeft + " 期望：true / 0");

                // 反向：**有文字**时必须恢复白卡 —— 否则字直接飘在桌面上看不清
                // ⚠️ id 必须避开后面动图用例用的号段：`Show` 对**同 id 会拒收**
                //（契约 §2 的幂等保护），撞号会让后面那条"动图在推进"假红。
                PetBubbleInfo txt = new PetBubbleInfo();
                txt.Id = 990011;
                txt.Kind = "both";
                txt.Image = "bubble/cutout-selftest.png";
                txt.Text = "正在调用工具…";
                bubble.Show(txt, bmp);
                bool textCard = !bubble.IsOpaquePresentation && bubble.DiagPaddingLeft > 0;
                Check(textCard, "⭐ 有文字的气泡必须恢复白卡（否则字飘在桌面上看不清）",
                      "IsOpaquePresentation=" + bubble.IsOpaquePresentation +
                      " PaddingLeft=" + bubble.DiagPaddingLeft + " 期望：false / >0");

                // ---- 契约 §4 v-next：气泡**动图**（真 GIF → 全帧解码 → 定时器真推进）----
                //
                // 原先气泡永远只显示首帧（`Decode` 取 `Frames[0]`），所以动态表情包
                // 一直是"定格图"。这里逐环验证，**任何一环断掉都要红**：
                //   解码多帧 → 缩到显示尺寸 → Show 启动定时器 → 泵消息后帧号前进
                //   → 静态气泡重置动画器（防串台）→ 收起停推进（不后台空转）。
                MakeGif(Path.Combine(artDir, "bubble", "anim-selftest.gif"), 96, 5);
                BitmapSource[] anim = store.GetBubbleFrames("bubble/anim-selftest.gif", 48);
                bool decOk = anim != null && anim.Length == 5 &&
                             Math.Max(anim[0].PixelWidth, anim[0].PixelHeight) <= 48;
                Check(decOk, "动图解码：解出全部帧并缩到显示尺寸",
                      anim == null ? "null" : (anim.Length + " 帧，首帧 " +
                      anim[0].PixelWidth + "x" + anim[0].PixelHeight + "（源 96，上限 48）"));

                BitmapSource[] oneFrame = store.GetBubbleFrames("bubble/01.png", 48);
                Check(oneFrame != null && oneFrame.Length == 1,
                      "静态图走同一条路只解出 1 帧（据此判定不做动画）",
                      oneFrame == null ? "null" : (oneFrame.Length + " 帧"));

                PetBubbleInfo ab = new PetBubbleInfo();
                ab.Id = 990003;
                ab.Kind = "image";
                ab.DurationMs = 600000;              // 别到点自己收掉，干扰后面的断言
                bubble.Show(ab, anim == null ? bmp : anim[0], anim, 40);
                bool started = bubble.DiagAnimRunning && bubble.DiagAnimFrameCount == 5;
                int f0 = bubble.DiagAnimFrame;
                for (int k = 0; k < 5; k++) Pump(60);   // 分段泵，给 Render 优先级多次机会
                int ticks = bubble.DiagAnimTicks;
                int f1 = bubble.DiagAnimFrame;
                // ⚠️ 断言必须用**单调的 Tick 次数**，不能只看帧号：
                // 帧号是模 5 循环的，正好跑完整一轮（5 次 Tick）会回到 0 ——
                // 第一版就是这么写的，于是"真的在动"被判成失败（假红）。
                Check(started && ticks >= 2 && f1 == ticks % 5,
                      "动图真的在推进（Tick 前进 + 帧号按帧数取模）",
                      "running=" + started + " 帧数=" + bubble.DiagAnimFrameCount +
                      " ticks=" + ticks + " 帧号 " + f0 + " → " + f1 + "（期望 " + (ticks % 5) + "）");

                PetBubbleInfo sb = new PetBubbleInfo();
                sb.Id = 990004;
                sb.Kind = "image";
                bubble.Show(sb, bmp);
                Check(!bubble.DiagAnimRunning, "静态气泡会重置动画器（防上一条动图串台）",
                      "running=" + bubble.DiagAnimRunning + " 期望 false");

                bubble.Show(ab, anim == null ? bmp : anim[0], anim, 40);
                Pump(60);
                bubble.HideNow();
                Check(!bubble.DiagAnimRunning, "收起气泡会停帧推进（不后台空转烧 CPU）",
                      "running=" + bubble.DiagAnimRunning + " 期望 false");
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

                // ⭐⭐ 对话正文**独立字号**（用户点名"你对话里面的文字大小也需要可调呀"）。
                //
                // 与状态栏同一个道理：字号原先只乘 scale，用户把桌宠调到 0.5 是为了
                // 不占地，正文却被一起缩到 6.5px（下限兜底）—— 读不了。
                // 这里验三件事：
                //   ① 独立倍率真的生效（且在 scale 很小时也能把字撑大）；
                //   ② `MaxWidth` 跟着字号走 —— 否则字放大了仍挤在旧宽度里，变成竖条；
                //   ③ 内边距跟着字号走 —— 否则字贴边。
                {
                    // ⚠️ 用**独立实例**：这块所在的 bubble 可能已被前面的用例关掉，
                    // 关闭后 Show 会抛（"关闭 Window 之后…无法调用 Show"），
                    // 那会把同一 try 块后面的断言全带崩（实测掉了 5 条）。
                    PetBubble fsBubble = null;
                    try
                    {
                        fsBubble = new PetBubble();
                        fsBubble.Opacity = 0;
                        fsBubble.SetScale(0.5);      // 用户的实际档位
                        // 内边距要**先铺外壳**才落到 `_border` 上（`UpdateMetrics` 只算
                        // `DefaultPadding`，由 `ApplyCurrentChrome` 应用）—— 所以走
                        // `Show` 的真实路径，而不是只读 `UpdateMetrics` 的结果。
                        PetBubbleInfo fsInfo = new PetBubbleInfo();
                        fsInfo.Id = 991001;
                        fsInfo.Kind = "both";
                        fsInfo.Text = "这是一句用来量字号与内边距的对话正文。";
                        fsInfo.DurationMs = 600000;
                        fsBubble.Show(fsInfo, MakeSolidBubbleBitmap(24));
                        Pump(150);
                        double smallFont = fsBubble.DiagTextFontSize;
                        double smallMaxW = fsBubble.DiagTextMaxWidth;
                        double smallPad = fsBubble.DiagPaddingLeft;
                        fsBubble.SetFontScale(3.0);
                        Pump(150);
                        double bigFont = fsBubble.DiagTextFontSize;
                        double bigMaxW = fsBubble.DiagTextMaxWidth;
                        double bigPad = fsBubble.DiagPaddingLeft;
                        bool grew = bigFont > smallFont;
                        bool maxWGrew = bigMaxW > smallMaxW;
                        bool padGrew = bigPad > smallPad;
                        Check(grew && maxWGrew && padGrew,
                              "⭐⭐ 对话文字可独立调大（MaxWidth/内边距同比，不挤成竖条、不贴边）",
                              "字号 " + smallFont.ToString("0.#") + " → " + bigFont.ToString("0.#") +
                              "；MaxWidth " + smallMaxW.ToString("0") + " → " + bigMaxW.ToString("0") +
                              "；内边距 " + smallPad.ToString("0.#") + " → " + bigPad.ToString("0.#"));
                    }
                    finally
                    {
                        try { if (fsBubble != null) fsBubble.ForceClose(); } catch { }
                    }
                }

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

        /// <summary>
        /// 造一个**真正的多帧 GIF**（自检用）。
        ///
        /// 为什么必须真 GIF：动图链路每一环都跟"帧"有关 —— 解码器解不解全部帧、
        /// 缩放是否逐帧生效、定时器有没有推进。拿 PNG 冒充测不出来（PNG 天生 1 帧）。
        /// 用 WPF 自带的 `GifBitmapEncoder` 生成，不引第三方编码器；
        /// 每帧画在不同位置，保证帧与帧**真的不同**（否则"帧号前进"毫无意义）。
        /// </summary>
        private static void MakeGif(string path, int size, int frames)
        {
            // 全程**全限定**：SelfTest 里 `Color` 指的是 System.Drawing.Color，
            // 引 `using System.Windows.Media` 会让它变成二义（既有代码全在用它）。
            GifBitmapEncoder enc = new GifBitmapEncoder();
            for (int i = 0; i < frames; i++)
            {
                RenderTargetBitmap rtb = new RenderTargetBitmap(
                    size, size, 96, 96, System.Windows.Media.PixelFormats.Pbgra32);
                System.Windows.Media.DrawingVisual dv = new System.Windows.Media.DrawingVisual();
                using (System.Windows.Media.DrawingContext dc = dv.RenderOpen())
                {
                    double off = 2 + i * 5;
                    dc.DrawEllipse(
                        new System.Windows.Media.SolidColorBrush(
                            System.Windows.Media.Color.FromArgb(255, 255, 214, 102)),
                        null, new System.Windows.Point(off, off), size / 5.0, size / 5.0);
                }
                rtb.Render(dv);
                rtb.Freeze();
                enc.Frames.Add(BitmapFrame.Create(rtb));
            }
            using (FileStream fs = File.Create(path)) enc.Save(fs);
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
            sb.AppendLine("    { \"file\": \"bubble/01.png\", \"w\": 96, \"h\": 96 },");
            // 契约 §4 v-next：动图声明 + 越界钳制（frames<1 → 1，frameMs<20 → 20）
            sb.AppendLine("    { \"file\": \"bubble/anim-selftest.gif\", \"w\": 96, \"h\": 96, \"frames\": 5, \"frameMs\": 40 },");
            sb.AppendLine("    { \"file\": \"bubble/03.png\", \"w\": 96, \"h\": 96, \"frames\": 0, \"frameMs\": 1 }");
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