using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    internal static class Program
    {
        public const string MutexName = @"Global\DSH-ZhuangFangyi-Pet";

        // 契约 §5 退出码
        public const int ExitOk = 0;
        public const int ExitSelfTestFailed = 1;
        public const int ExitMutexTaken = 2;
        public const int ExitBadArgs = 3;
        public const int ExitNoMaterial = 4;

        private static Mutex _singleInstance;

        [STAThread]
        public static int Main(string[] args)
        {
            int code;
            try
            {
                code = MainCore(args);
            }
            catch (Exception ex)
            {
                try { PetLog.Error("Main 未捕获异常: " + PetLog.Describe(ex)); } catch { }
                code = ExitSelfTestFailed;
            }

            // 先把缓冲输出刷出去（宿主靠管道收 stdout，硬退出不会自动 Flush）。
            try { Console.Out.Flush(); } catch { }
            try { Console.Error.Flush(); } catch { }

            // 硬退出：用 kernel32!TerminateProcess，**不走 Environment.Exit / ExitProcess**。
            //
            // 实测（本机 .NET Framework 4.8 + WPF + -target:winexe + stdout 为管道）：
            //   * Environment.Exit(0)  在自检路径上永久阻塞、不返回；
            //   * ExitProcess(0)       同样卡住（退出前会跑 DLL_PROCESS_DETACH，
            //                          某个 WPF/Win32 DLL 的 detach 处理里阻塞了）；
            //   * 对照实验：console 子系统的 WPF 程序能正常退出，winexe 的不能；
            //     非 WPF 的 winexe 也能正常退出 → 是「WPF + winexe + 管道」的组合触发。
            // 宿主（Node child_process / ctx.subprocess.spawn）必须能在 graceMs 内观测到退出，
            // 否则契约 §5 的「t<10s 内非零退出则不自动重启」永远不生效。
            //
            // TerminateProcess 不跑 detach 处理，立即结束进程。前面已显式 Flush 过
            // stdout/stderr，所以不会丢输出（Node 侧实测收到全部 ~5.8KB 自检输出，
            // 退出码 0，耗时约 1.1s —— 远小于契约的 10s 窗口）。
            try
            {
                TerminateProcess(GetCurrentProcess(), (uint)code);
            }
            catch { }
            return code;   // 正常路径不会到这里
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        private static int MainCore(string[] args)
        {
            TrySetUtf8Console();

            string err;
            PetOptions opt = PetOptions.Parse(args, out err);
            if (opt == null)
            {
                // 用 UTF-8 字节写 stderr（winexe 下 Console.Error 的编码不可靠，中文会乱码）
                try
                {
                    byte[] b = System.Text.Encoding.UTF8.GetBytes(
                        "参数错误: " + err + "\n" + PetOptions.Usage() + "\n");
                    Stream es = Console.OpenStandardError();
                    es.Write(b, 0, b.Length);
                    es.Flush();
                }
                catch
                {
                    try { Console.Error.WriteLine("参数错误: " + err); } catch { }
                }
                return ExitBadArgs;
            }

            string baseDir = AppDataDir();
            PetLog.Init(Path.Combine(baseDir, "pet.log"), opt.Verbose);

            if (opt.Help)
            {
                PetLog.StdoutUtf8(PetOptions.Usage());
                return ExitOk;
            }

            PetLog.Startup("dsh-zhuang-fangyi-pet 启动 pid=" + System.Diagnostics.Process.GetCurrentProcess().Id +
                           " args=" + args.Length + " 日志=" + PetLog.LogPath);

            if (opt.SelfTest)
            {
                return SelfTest.Run(opt, Path.Combine(baseDir, PetSpriteStore.CacheFolderName));
            }

            // ---- 命名互斥体（契约 §5）：已被占用 → exit 2 ----
            bool createdNew;
            try
            {
                _singleInstance = new Mutex(true, MutexName, out createdNew);
            }
            catch (Exception ex)
            {
                PetLog.Error("创建互斥体失败: " + PetLog.Describe(ex));
                createdNew = true;   // 退化：宁可有两只桌宠，也不要起不来
            }
            if (!createdNew)
            {
                PetLog.Error("已有桌宠实例在运行（互斥体 " + MutexName + "）→ exit " + ExitMutexTaken);
                return ExitMutexTaken;
            }

            try
            {
                PetApp app = new PetApp(opt, baseDir);
                return app.Run();
            }
            catch (Exception ex)
            {
                PetLog.Error("未捕获异常: " + PetLog.Describe(ex));
                return ExitSelfTestFailed;
            }
            finally
            {
                try { if (_singleInstance != null) _singleInstance.ReleaseMutex(); } catch { }
                try { if (_singleInstance != null) _singleInstance.Close(); } catch { }
            }
        }

        public static string AppDataDir()
        {
            string root = null;
            try { root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); }
            catch { }
            if (string.IsNullOrEmpty(root))
            {
                try { root = Path.Combine(Path.GetTempPath(), "DSH-ZhuangFangyi-Pet"); }
                catch { root = "."; }
            }
            string dir = Path.Combine(root, "DSH-ZhuangFangyi-Pet");
            try { if (!Directory.Exists(dir)) Directory.CreateDirectory(dir); }
            catch { }
            return dir;
        }

        /// <summary>
        /// 尽力把控制台编码设为 UTF-8。
        /// 注意：本 exe 是 -target:winexe（无附加控制台），这个设置**不保证生效**，
        /// 所以真正的输出路径是 PetLog.StdoutUtf8（直接写 UTF-8 字节）。
        /// 这里只是让「从控制台手动运行」时观感正常一点。
        /// </summary>
        private static void TrySetUtf8Console()
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            try { Console.InputEncoding = new UTF8Encoding(false); } catch { }
        }
    }

    /// <summary>
    /// 应用装配：素材 → 窗口 → 气泡 → 托盘 → HTTP → 消息循环。
    /// </summary>
    internal sealed class PetApp : IDisposable
    {
        private readonly PetOptions _opt;
        private readonly string _baseDir;
        private readonly string _cacheDir;

        private PetHttp _http;
        private PetSpriteStore _store;
        private PetWindow _win;
        private PetBubble _bubble;
        private PetTray _tray;
        private Application _app;

        private DispatcherTimer _retryTimer;
        private DispatcherTimer _diagTimer;
        /// <summary>task-6：滚轮缩放 → POST /pet/settings 的去抖定时器（300ms，快速滚动只发最后一次）。</summary>
        private DispatcherTimer _scalePostTimer;
        private double _pendingScalePost = double.NaN;
        private Dispatcher _ui;

        private long _lastRev = -1;
        private long _lastBubbleId = -1;
        private bool _bubbleOn;
        private bool _previewMode;
        private int _previewIndex;
        private bool _quitting;
        private DateTime _started;
        private int _stateChanges;

        // task-6：由 snapshot.settings 实时覆盖的运行时状态（argv 只提供初始值）
        private string _settingsTheme = "auto";        // 'auto' | 'light' | 'dark'
        private string _doubleClick = "focus-dsh";     // 'focus-dsh' | 'emote' | 'none'

        // task-7：发消息（悬停 ✎ → 输入窗 → POST /pet/send）
        private bool _sendAvailable;   // snapshot.send.available（块缺失=false）
        private PetInput _input;

        // task-8：attention 常亮提醒（上次应用的值；null=无提醒）
        private PetAttentionInfo _lastAttention;

        private static readonly string[] PreviewStates = new string[]
        {
            "waking", "idle", "listening", "thinking", "working",
            "waiting", "happy", "error", "sleeping"
        };

        public PetApp(PetOptions opt, string baseDir)
        {
            _opt = opt;
            _baseDir = baseDir;
            _cacheDir = Path.Combine(baseDir, PetSpriteStore.CacheFolderName);
            _bubbleOn = opt.BubbleEnabled;
            _doubleClick = PetSettingsInfo.NormalizeDoubleClick(opt.DoubleClick);
        }

        public int Run()
        {
            _started = DateTime.Now;
            try { if (!Directory.Exists(_cacheDir)) Directory.CreateDirectory(_cacheDir); }
            catch (Exception ex) { PetLog.Warn("创建缓存目录失败: " + PetLog.Describe(ex)); }

            _app = new Application();
            _app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _ui = Dispatcher.CurrentDispatcher;

            if (_opt.Url != null)
            {
                _http = new PetHttp(_opt.Url, _opt.Token);
                _http.Snapshot += OnSnapshot;
                _http.ConnectionChanged += OnConnectionChanged;
                _http.AuthGiveUp += OnAuthGiveUp;
            }
            else
            {
                PetLog.Warn("未提供 --url：离线模式（只显示本地/缓存素材，不连接宿主）");
            }

            _store = new PetSpriteStore(_opt, _http, _cacheDir);

            // 先同步拉一次清单（短超时），保证首帧尺寸正确
            bool haveAtlas = _store.LoadAtlas();
            if (!haveAtlas)
            {
                PetLog.Warn("启动时无素材清单: " + _store.AtlasError);
                // 契约 §5 退出码 4 = 素材缺失。只有「完全没有素材来源」才算致命；
                // 宿主暂时不可达不算（会后台重试 + 用缓存），否则 DSH 重启会把桌宠打死。
                bool anySource = _opt.Url != null || !string.IsNullOrEmpty(_opt.ArtDir);
                if (!anySource)
                {
                    PetLog.Error("既没有 --url 也没有 --art-dir，且无本地缓存 → exit " + Program.ExitNoMaterial);
                    return Program.ExitNoMaterial;
                }
            }

            _win = new PetWindow(_opt, _http, _store);
            _win.PetContextMenuRequested = OnPetContextMenu;
            _win.FocusDshRequested = OnFocusDsh;
            _win.PositionReported = OnPositionReported;
            _win.OnDisplayChanged = OnDisplayChanged;
            _win.ScaleAdjusted = OnScaleAdjusted;       // task-6：滚轮缩放 → 去抖上报 + 托盘刷新
            _win.DoubleClickInvoked = OnPetDoubleClick; // task-6：双击行为由 settings.doubleClick 决定
            _win.SendButtonClicked = OnSendButtonClicked;  // task-7：✎ → 打开输入窗

            _bubble = new PetBubble();
            _bubble.PetRectProvider = PetRect;
            _bubble.HideNow();
            WireAttentionButton();   // task-8：「去处理」→ focus-dsh 链路

            _tray = new PetTray();
            _tray.IsVisible = delegate { return _win.IsVisible; };
            _tray.GetClickThrough = delegate { return _win.ClickThrough; };
            _tray.GetScale = delegate { return _opt.Scale; };
            _tray.GetBubble = delegate { return _bubbleOn; };
            _tray.ToggleVisible = delegate { _win.ToggleVisible(); };
            _tray.SetClickThrough = delegate(bool on) { _win.SetClickThrough(on); };
            _tray.SetTopmost = delegate(bool on) { _win.SetTopmost(on); _tray.SetTopmostCheck(on); };
            _tray.SetScale = delegate(double s) { _win.SetScale(s); _win.ReclampPosition(false); };
            _tray.SetBubble = delegate(bool on)
            {
                _bubbleOn = on;
                if (!on) _bubble.HideNow();
            };
            _tray.ResetPosition = delegate { _win.ReclampPosition(true); };
            _tray.FocusDsh = delegate { OnFocusDsh(); };
            _tray.Quit = delegate { Quit(); };

            _win.Show();
            _tray.Install();
            _tray.SetTopmostCheck(_opt.Topmost);

            // 后台重试素材（宿主晚起 / 首次无缓存）
            _retryTimer = new DispatcherTimer(DispatcherPriority.Background);
            _retryTimer.Interval = TimeSpan.FromSeconds(5);
            _retryTimer.Tick += OnRetryTick;
            if (_store.Atlas == null) _retryTimer.Start();

            _diagTimer = new DispatcherTimer(DispatcherPriority.Background);
            _diagTimer.Interval = TimeSpan.FromSeconds(15);
            _diagTimer.Tick += OnDiagTick;
            _diagTimer.Start();

            _scalePostTimer = new DispatcherTimer(DispatcherPriority.Background);
            _scalePostTimer.Interval = TimeSpan.FromMilliseconds(300);   // task-6：去抖
            _scalePostTimer.Tick += OnScalePostTick;

            if (_http != null) _http.Start();

            PetLog.Startup("进入消息循环（窗口已显示，托盘已就绪）");

            try
            {
                _app.Run();
            }
            catch (Exception ex)
            {
                PetLog.Error("消息循环异常: " + PetLog.Describe(ex));
                return Program.ExitSelfTestFailed;
            }

            PetLog.Startup("消息循环结束，退出码 " + Program.ExitOk);
            Dispose();
            // 托盘图标必须显式移除，否则会残留一个幽灵图标直到鼠标划过
            try { if (_tray != null) _tray.Dispose(); } catch { }
            PetLog.Startup("清理完成，进程即将退出");
            return Program.ExitOk;
        }

        // ------------------------------------------------------------------
        // 宿主事件（来自 HTTP 线程 → 必须切回 UI 线程）
        // ------------------------------------------------------------------

        private void OnSnapshot(PetSnapshot snap)
        {
            if (snap == null) return;
            if (snap.Rev >= 0 && snap.Rev < Interlocked.Read(ref _lastRev)) return;   // 丢弃更旧帧

            Dispatcher d = _ui;
            if (d != null && !d.CheckAccess())
            {
                d.BeginInvoke(DispatcherPriority.Normal, new Action(delegate { ApplySnapshot(snap); }));
                return;
            }
            ApplySnapshot(snap);
        }

        private void ApplySnapshot(PetSnapshot snap)
        {
            if (snap.Rev >= 0)
            {
                long prev = Interlocked.Read(ref _lastRev);
                if (snap.Rev < prev) return;
                Interlocked.Exchange(ref _lastRev, snap.Rev);
            }

            // task-6：先应用 snapshot.settings（可能改尺寸/穿透/主题，气泡定位要用新尺寸）。
            // 逐字段 diff，值没变就不动（避免每帧重复 SetScale 抖动）。
            ApplySettings(snap.Settings);

            // task-7：send 能力位（available=false 或块缺失 → 不显示 ✎）
            ApplySendInfo(snap.Send);

            // task-8：attention diff（值没变零日志；null → 立刻收恒亮气泡）
            ApplyAttention(snap);

            string st = snap.EffectiveState();
            if (!_previewMode)
            {
                if (_win.CurrentState != st) _stateChanges++;
                _win.SetState(st);
            }

            if (_bubbleOn && snap.Bubble != null && snap.Bubble.Id > _lastBubbleId)
            {
                _lastBubbleId = snap.Bubble.Id;
                BitmapSource img = null;

                // 契约 §4 fileDark：只有渲染方知道实际主题 → exe 自己判深色选图。
                // task-6 优先级：argv --dark 0|1 > settings.theme > 注册表。
                // task-8：attention 气泡是纯文本提醒，不需要贴图（跳过取图省一次下载）。
                bool dark = PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme);
                string rel = snap.Bubble.Kind == "attention" ? null :
                    PetTheme.SelectBubbleImageRel(
                        snap.Bubble.WantsImage, snap.Bubble.Image, snap.Bubble.ImageDark, dark);

                if (rel != null)
                {
                    try { img = _store.GetBubbleImage(rel); }
                    catch (Exception ex) { PetLog.Warn("气泡图加载失败: " + PetLog.Describe(ex)); }

                    // 深色变体取不到（404/断网）→ 回落浅色原图，尽量还显示"这句话"；
                    // 再不行才走随机气泡池（原有兜底，保持不变）。
                    if (img == null && rel != snap.Bubble.Image && !string.IsNullOrEmpty(snap.Bubble.Image))
                    {
                        PetLog.Warn("深色变体取图失败，回落浅色原图: " + rel);
                        try { img = _store.GetBubbleImage(snap.Bubble.Image); } catch { }
                    }
                    if (img == null)
                    {
                        string alt = _store.RandomBubbleFile();
                        if (alt != null) img = _store.GetBubbleImage(alt);
                    }
                    PetLog.Info("气泡取图 rel=" + rel + " dark=" + (dark ? "1" : "0") +
                                (img != null ? " → 解码成功" : " → 解码失败（走兜底）") +
                                " opaque=" + (snap.Bubble.Opaque ? "1" : "0") +
                                " theme=" + _settingsTheme);
                }

                try { _bubble.Show(snap.Bubble, img); }
                catch (Exception ex) { PetLog.Warn("气泡显示失败: " + PetLog.Describe(ex)); }
            }
        }

        // ------------------------------------------------------------------
        // task-6：snapshot.settings 实时应用（逐字段 diff）
        // ------------------------------------------------------------------

        /// <summary>
        /// 把 snapshot.settings 里**出现且变化**的字段应用到窗口/托盘/气泡。
        /// 字段缺失（Has*=false）→ 完全不动现状（additive 兼容）；块缺失（null）→ 整体跳过。
        /// </summary>
        private void ApplySettings(PetSettingsInfo st)
        {
            if (st == null) return;
            bool changed = false;

            if (st.HasScale)
            {
                double s = PetOptions.ClampScale(st.Scale);
                if (Math.Abs(s - _win.Scale) > 0.001)
                {
                    _win.SetScale(s);   // 内部含 ApplySizeForSheet + ReclampPosition
                    PetLog.Info("settings: scale → " + s.ToString("0.0#", CultureInfo.InvariantCulture));
                    changed = true;
                }
            }
            if (st.HasOpacity)
            {
                double o = PetOptions.ClampOpacity(st.Opacity);
                if (Math.Abs(o - _opt.Opacity) > 0.001)
                {
                    _win.SetOpacity(o);
                    PetLog.Info("settings: opacity → " + o.ToString("0.##", CultureInfo.InvariantCulture));
                    changed = true;
                }
            }
            if (st.HasClickThrough && st.ClickThrough != _win.ClickThrough)
            {
                _win.SetClickThrough(st.ClickThrough);
                PetLog.Info("settings: clickThrough → " + (st.ClickThrough ? "1" : "0"));
                changed = true;
            }
            if (st.HasTopmost && st.Topmost != _win.Topmost)
            {
                _win.SetTopmost(st.Topmost);
                _tray.SetTopmostCheck(st.Topmost);
                PetLog.Info("settings: topmost → " + (st.Topmost ? "1" : "0"));
                changed = true;
            }
            if (st.HasBubble && st.Bubble != _bubbleOn)
            {
                _bubbleOn = st.Bubble;
                if (!_bubbleOn) _bubble.HideNow();
                PetLog.Info("settings: bubble → " + (st.Bubble ? "1" : "0"));
                changed = true;
            }
            if (st.HasDoubleClick && st.DoubleClick != _doubleClick)
            {
                _doubleClick = st.DoubleClick;
                PetLog.Info("settings: doubleClick → " + _doubleClick);
                changed = true;
            }
            if (st.HasTheme && st.Theme != _settingsTheme)
            {
                _settingsTheme = st.Theme;
                PetLog.Info("settings: theme → " + _settingsTheme + "（生效深色=" +
                            (PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme) ? "1" : "0") + "）");
                changed = true;
            }

            if (changed) _tray.Refresh();   // 托盘勾选状态（缩放档位/穿透/气泡）跟着真实值走
        }

        // ------------------------------------------------------------------
        // task-8：attention 常亮提醒（存续判定完全以 attention 块为准，exe 不自算超时）
        // ------------------------------------------------------------------

        /// <summary>
        /// attention diff：块变化才动（起/落/换内容各一次日志），值没变零日志。
        /// - attention 出现且 bubble.kind==='attention' → 交给 Show（PetBubble 走恒亮路径）
        /// - attention=null（或块缺失）→ **立刻收**恒亮气泡（HideAttention）
        /// </summary>
        private void ApplyAttention(PetSnapshot snap)
        {
            PetAttentionInfo at = snap == null ? null : snap.Attention;
            if (PetAttentionInfo.Same(at, _lastAttention)) return;

            bool had = _lastAttention != null;
            _lastAttention = at;

            if (at == null)
            {
                if (had) PetLog.Info("attention → null");
                try { _bubble.HideAttention(); } catch (Exception ex) { PetLog.Warn("收 attention 气泡失败: " + PetLog.Describe(ex)); }
                return;
            }

            PetLog.Info("attention → kind=" + at.Kind + " session=" + at.SessionId +
                        " count=" + at.Count.ToString(CultureInfo.InvariantCulture) +
                        (had ? "（内容更新）" : ""));
            // 气泡本体由下方 bubble 渲染分支处理（Host 会同时给 kind:'attention' 气泡，
            // id 递增走 Show）；这里只记 diff 日志与接管"解除"时机。
            // 同一 attention 存续期内 Host 不再发新 bubble.id 时也要能收到解除 → 见上 null 分支。
        }

        /// <summary>装配「去处理」→ 复用双击已实现的 focus-dsh 链路。</summary>
        private void WireAttentionButton()
        {
            _bubble.GoAction = delegate { OnFocusDsh(); };
        }

        // ------------------------------------------------------------------
        // task-7：发消息（悬停 ✎ → 输入窗 → POST /pet/send，排队语义）
        // ------------------------------------------------------------------

        /// <summary>snapshot.send 能力位变化：available=false → 按钮立刻隐藏。</summary>
        private void ApplySendInfo(PetSendInfo send)
        {
            bool avail = PetSendInfo.ShouldShowSendButton(send);
            if (avail == _sendAvailable) return;
            _sendAvailable = avail;
            _win.SetSendAvailable(avail);
            PetLog.Info("send 能力位 → " + (avail ? "可用" : ("不可用" +
                (send != null && !string.IsNullOrEmpty(send.Reason) ? "（" + send.Reason + "）" : ""))));
        }

        /// <summary>✎ 被点（只有可用时按钮才可见；防御式再查一次）→ 打开输入窗。</summary>
        private void OnSendButtonClicked()
        {
            if (!_sendAvailable) return;
            if (_input == null)
            {
                _input = new PetInput(_http);
                _input.Sent = delegate
                {
                    // 成功 → 关输入窗，气泡提示「已发送」（不弹 Host 气泡，用本地假 id）
                    try
                    {
                        PetBubbleInfo b = new PetBubbleInfo();
                        b.Id = -DateTime.Now.Ticks;   // 负 id：绝不与 Host 的 bubble.id 撞
                        b.Kind = "text";
                        b.Text = "已发送";
                        b.DurationMs = 1600;
                        b.Priority = 95;
                        _bubble.Show(b, null);
                    }
                    catch { }
                };
                _input.Closed2 = delegate
                {
                    try { _win.SetSendOpen(false); } catch { }
                    _input = null;
                };
            }
            int x, y, w, h;
            _win.GetScreenRect(out x, out y, out w, out h);
            _win.SetSendOpen(true);
            _input.OpenNear(x, y, w, h);
        }

        /// <summary>退出时若输入窗还开着，一并收掉。</summary>
        private void CloseInput()
        {
            try { if (_input != null) _input.Close(); } catch { }
            _input = null;
        }

        // ------------------------------------------------------------------
        // task-6：滚轮缩放上报（去抖 300ms）与双击行为
        // ------------------------------------------------------------------

        /// <summary>滚轮改了缩放（UI 线程）：记下目标值，300ms 内没有后续滚动才 POST 一次。</summary>
        private void OnScaleAdjusted(double newScale)
        {
            _pendingScalePost = newScale;
            _scalePostTimer.Stop();
            _scalePostTimer.Start();
            _tray.Refresh();   // 缩放档位勾选立即对齐
        }

        private void OnScalePostTick(object sender, EventArgs e)
        {
            _scalePostTimer.Stop();
            if (double.IsNaN(_pendingScalePost)) return;
            if (_http != null)
            {
                _http.PostSettingsScale(_pendingScalePost);
                PetLog.Info("滚轮缩放已上报 /pet/settings scale=" +
                            _pendingScalePost.ToString("0.##", CultureInfo.InvariantCulture));
            }
            _pendingScalePost = double.NaN;
        }

        /// <summary>双击本体：按 settings.doubleClick 分派（缺省 focus-dsh = 现状）。</summary>
        private void OnPetDoubleClick()
        {
            if (_doubleClick == "emote") { CycleEmote(); return; }
            if (_doubleClick == "focus-dsh") { OnFocusDsh(); return; }
            // "none"：什么都不做
        }

        /// <summary>轮换一个表情（托盘「切换表情预览」与双击 emote 共用同一机制）。</summary>
        private void CycleEmote()
        {
            _previewMode = true;
            _previewIndex = (_previewIndex + 1) % PreviewStates.Length;
            _win.SetState(PreviewStates[_previewIndex]);
        }

        private void OnConnectionChanged(bool connected)
        {
            PetLog.Info(connected ? "与宿主已连接" : "与宿主断开");
        }

        private void OnAuthGiveUp()
        {
            // 契约 §5：连续 5 次 401/403 → 主动退出（宿主换端口/重启后不留连不上旧令牌的僵尸）
            Dispatcher d = _ui;
            if (d != null)
            {
                d.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                {
                    PetLog.Error("鉴权被拒（连续 401/403），桌宠退出");
                    Quit();
                }));
            }
        }

        // ------------------------------------------------------------------
        // 定时器
        // ------------------------------------------------------------------

        private void OnRetryTick(object sender, EventArgs e)
        {
            if (_store.Atlas != null)
            {
                _retryTimer.Stop();
                return;
            }
            if (_store.LoadAtlas())
            {
                _retryTimer.Stop();
                _win.ReloadSprite();
                _tray.ShowBalloon("庄方宜桌宠", "素材已就绪");
            }
        }

        private void OnDiagTick(object sender, EventArgs e)
        {
            if (!_opt.Verbose) return;
            string http = _http == null ? "offline" :
                ("connected=" + _http.Connected + " frames=" + _http.FramesReceived +
                 " 401/403=" + _http.Consecutive401 + " last=" + (_http.LastError == null ? "-" : _http.LastError));
            PetLog.Info("diag: 状态=" + _win.CurrentState + " 切换=" + _stateChanges +
                        " 可见=" + _win.IsVisible + " http[" + http + "]");
        }

        // ------------------------------------------------------------------
        // 位置 / 显示变化
        // ------------------------------------------------------------------

        private int[] PetRect()
        {
            int x, y, w, h;
            _win.GetScreenRect(out x, out y, out w, out h);
            return new int[] { x, y, w, h };
        }

        private void OnDisplayChanged()
        {
            try { _bubble.PlaceNearPet(); } catch { }
        }

        private void OnPositionReported(int x, int y)
        {
            if (_http == null) return;
            int bx = 0, by = 0;
            try
            {
                double dpi = 96.0;
                int px, py, pw, ph;
                _win.GetScreenRect(out px, out py, out pw, out ph);
                dpi = PetNative.GetDpiForWindowSafe(_win.Handle) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                bx = (int)Math.Round(_bubble.Left * dpi);
                by = (int)Math.Round(_bubble.Top * dpi);
            }
            catch { }
            // 契约 §3：拖动结束 POST /pet/position。
            // 回响环修复：body 不带 scale（缩放走 /pet/settings 专用通道），且仅在位置变化时触发。
            _http.PostPosition(x, y, bx, by);
            PetLog.Info("上报位置 x=" + x + " y=" + y);
        }

        // ------------------------------------------------------------------
        // 命令 / 菜单
        // ------------------------------------------------------------------

        private void OnFocusDsh()
        {
            if (_http != null) _http.PostCommand("focus-dsh");
            PetNative.FocusDsh();     // best-effort，找不到就静默
        }

        private ContextMenu _petMenu;

        private void OnPetContextMenu(PetWindow w, MouseButtonEventArgs e)
        {
            if (_petMenu == null) _petMenu = BuildPetMenu();
            _petMenu.PlacementTarget = w;
            _petMenu.IsOpen = true;
        }

        private ContextMenu BuildPetMenu()
        {
            ContextMenu m = new ContextMenu();

            MenuItem preview = new MenuItem();
            preview.Header = "表情预览(_E)";
            MenuItem auto = new MenuItem();
            auto.Header = "自动跟随状态";
            auto.Click += delegate
            {
                _previewMode = false;
                if (_http != null && _http.FramesReceived > 0) _win.ReloadSprite();
            };
            preview.Items.Add(auto);
            preview.Items.Add(new Separator());
            for (int i = 0; i < PreviewStates.Length; i++)
            {
                string st = PreviewStates[i];
                MenuItem mi = new MenuItem();
                mi.Header = st;
                mi.Click += delegate
                {
                    _previewMode = true;
                    _previewIndex = Array.IndexOf(PreviewStates, st);
                    _win.SetState(st);
                };
                preview.Items.Add(mi);
            }
            m.Items.Add(preview);

            MenuItem next = new MenuItem();
            next.Header = "切换表情预览(_N)";
            next.Click += delegate { CycleEmote(); };   // task-6：与双击 emote 共用同一机制
            m.Items.Add(next);

            MenuItem focus = new MenuItem();
            focus.Header = "打开 DSH 窗口(_D)";
            focus.Click += delegate { OnFocusDsh(); };
            m.Items.Add(focus);

            MenuItem hide = new MenuItem();
            hide.Header = "隐藏(_H)";
            hide.Click += delegate { _win.HidePet(); };
            m.Items.Add(hide);

            m.Items.Add(new Separator());

            MenuItem ct = new MenuItem();
            ct.Header = "点击穿透（透明处穿透）";
            ct.IsCheckable = true;
            ct.IsChecked = _win.ClickThrough;
            ct.Click += delegate
            {
                _win.SetClickThrough(!_win.ClickThrough);
                ct.IsChecked = _win.ClickThrough;
                _tray.Refresh();
            };
            m.Items.Add(ct);

            MenuItem reset = new MenuItem();
            reset.Header = "重置位置(_R)";
            reset.Click += delegate { _win.ReclampPosition(true); };
            m.Items.Add(reset);

            m.Items.Add(new Separator());

            MenuItem quit = new MenuItem();
            quit.Header = "退出桌宠(_X)";
            quit.Click += delegate { Quit(); };
            m.Items.Add(quit);

            return m;
        }

        private void Quit()
        {
            if (_quitting) return;
            _quitting = true;
            PetLog.Startup("退出中…");
            try { if (_http != null) _http.PostCommand("quit"); } catch { }
            try { if (_retryTimer != null) _retryTimer.Stop(); } catch { }
            try { if (_diagTimer != null) _diagTimer.Stop(); } catch { }
            try { if (_scalePostTimer != null) _scalePostTimer.Stop(); } catch { }
            try { CloseInput(); } catch { }   // task-7：输入窗还开着就一并收掉

            Dispatcher d = _ui;
            if (d != null && !d.CheckAccess())
            {
                d.BeginInvoke(DispatcherPriority.Normal, new Action(delegate { Quit(); }));
                return;
            }
            Dispose();
            if (_app != null) _app.Shutdown();
        }

        public void Dispose()
        {
            try { if (_http != null) _http.Dispose(); } catch { }
            try { if (_tray != null) _tray.Dispose(); } catch { }
            try { if (_bubble != null) _bubble.ForceClose(); } catch { }
            try { if (_win != null) _win.ForceClose(); } catch { }
            try { if (_store != null) _store.Dispose(); } catch { }
        }
    }
}