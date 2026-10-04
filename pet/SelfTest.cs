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

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public static int Run(PetOptions opt, string cacheDir)
        {
            Console.Out.WriteLine("=== dsh-zhuang-fangyi-pet selftest ===");
            Console.Out.WriteLine("时间 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") +
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
                SpriteSheet sheet = TestSprite(artDir, atlas);
                TestClamp();
                TestWindows(opt, artDir, cacheDir, sheet);
                TestMutex();
                TestHttp(opt);
            }
            catch (Exception ex)
            {
                Check(false, "自检过程中抛出未处理异常", PetLog.Describe(ex));
            }

            Console.Out.WriteLine();
            Console.Out.WriteLine(Report.ToString().TrimEnd());
            Console.Out.WriteLine();
            string verdict = "=== 自检" + (_fail == 0 ? "全部通过" : "存在失败") +
                             " (" + _pass + " 通过 / " + _fail + " 失败) ===";
            Console.Out.WriteLine(verdict);
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
            Console.Out.WriteLine(line);
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
            Check(sh.FrameW != sh.FrameH, "非方形帧：单帧宽 ≠ 帧高",
                  "实测 " + sh.FrameW + "x" + sh.FrameH + "（宽≠高，验证没有拿 frameHeight 当宽度用）");
            Check(haveIdle && ie.FrameWidth == sh.FrameW, "清单 frameWidth 与实测一致（自洽性校验）",
                  haveIdle ? (ie.FrameWidth + " == " + sh.FrameW) : "-");

            // TryGetDeclaredSize：解码前就能算窗口占位尺寸
            int dw, dh;
            bool declared = store.TryGetDeclaredSize("idle", out dw, out dh);
            Check(declared && dw == sh.FrameW && dh == sh.FrameH, "解码前预估尺寸（TryGetDeclaredSize）",
                  declared ? (dw + "x" + dh) : "未命中");

            // happy 的清单 frameWidth 被故意写错(999) → 必须以实测为准且只 Warn 不崩
            SpriteSheet hp = store.GetSheet("happy");
            Check(hp != null && hp.FrameW == 58 && hp.DeclaredFrameW == 999,
                  "清单与素材不一致时以实测为准（仅 Warn）",
                  hp == null ? "取不到" : ("实测=" + hp.FrameW + " 清单=" + hp.DeclaredFrameW));

            store.Dispose();
            return sh;
        }

        private static void TestClamp()
        {
            PetNative.WorkArea v = PetNative.VirtualWorkspace();
            int cx, cy;
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
        public static void Generate(string dir)
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
            // happy 故意写错 frameWidth（真实值 58），用来验证自洽性校验只 Warn 不崩
            sb.AppendLine("    \"happy\":   { \"file\": \"happy.png\",   \"frames\": 2, \"frameWidth\": 999" +
                          ", \"frameMs\": 60, \"anchorY\": 1.0 },");
            sb.AppendLine("    \"bogus\":   { \"file\": \"nope.png\",    \"frames\": 2, \"frameMs\": 60, \"anchorY\": 1.0 }");
            sb.AppendLine("  },");
            sb.AppendLine("  \"variants\": {");
            sb.AppendLine("    \"idle\": [\"idle.png\"]");
            sb.AppendLine("  },");
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