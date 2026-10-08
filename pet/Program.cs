using System;
using System.Collections.Generic;
using System.Diagnostics;
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
        /// <summary>状态文字窗（独立窗口，纯展示恒穿透）。见 `PetStatusLabel` 的类注释。</summary>
        private PetStatusLabel _status;
        /// <summary>番茄钟倒计时窗（独立窗口，纯展示恒穿透）。见 `PetPomodoro` 的类注释。</summary>
        private PetPomodoro _pomo;

        // v8：语音（只播不合成 —— 见 PetVoicePlayer 的类注释）
        /// <summary>语音清单（从 Host 拉；null/空 = 没有语音可用，一切照常）。</summary>
        private PetVoiceManifest _voices;
        private PetVoicePlayer _voicePlayer;
        /// <summary>语音总开关（设置项；默认关 —— 见 `--voice` 的说明）。</summary>
        private bool _voiceOn;
        /// <summary>上一帧的 petState / attention，用于"状态变化时才出声"。</summary>
        private string _lastVoiceState;
        /// <summary>上一帧的番茄钟阶段（用于阶段切换出声）。</summary>
        private string _lastPomoPhase;
        /// <summary>本体当前是否被悬停（`hint` 用它决定状态文字显隐）。</summary>
        private bool _hovering;
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
        /// <summary>当前实际显示中的气泡 id（-1 = 没显示）。隐藏/重放时用它判断。</summary>
        private long _shownBubbleId = -1;
        /// <summary>最近一次快照（桌宠重新显示时用它重放当前气泡）。</summary>
        private PetSnapshot _lastSnapshot;
        private bool _bubbleOn;
        private bool _previewMode;
        private int _previewIndex;
        private bool _quitting;
        private DateTime _started;
        private int _stateChanges;

        // task-6：由 snapshot.settings 实时覆盖的运行时状态（argv 只提供初始值）
        private string _settingsTheme = "auto";        // 'auto' | 'light' | 'dark'
        /// <summary>契约 §2 v6：状态文字常显 / 悬停显示（与 overlay 同语义）。</summary>
        private bool _statusAlways;
        private bool _hintOn;
        /// <summary>状态文字字号倍率（1.0 = 基准）。用户点名"字太小了，想调大"。</summary>
        private double _statusFontScale = 1.0;
        /// <summary>气泡正文字号倍率（1.0 = 基准）。用户点名"对话里的文字大小也要能调"。</summary>
        private double _chatFontScale = 1.0;
        private string _doubleClick = "focus-dsh";     // 'focus-dsh' | 'emote' | 'none'

        // task-7：发消息（悬停 ✎ → 输入窗 → POST /pet/send）
        private bool _sendAvailable;   // snapshot.send.available（块缺失=false）
        private PetInput _input;

        // v3：聊天（输入窗的"聊天 / 指定对话"两种模式）
        /// <summary>宿主是否装配了聊天（`snapshot.chat.available`）。</summary>
        private bool _chatAvailable;
        /// <summary>设置里是否允许在气泡里聊天（`settings.chatEnabled`）。</summary>
        private bool _chatOn = true;

        // task-8：attention 常亮提醒（上次应用的值；null=无提醒）
        private PetAttentionInfo _lastAttention;

        // v7：番茄钟（上次应用的块；null=旧 Host 或不支持）
        private PetPomodoroInfo _lastPomodoro;
        /// <summary>倒计时窗每秒重绘的定时器（Host 不每秒推帧，见下）。</summary>
        private DispatcherTimer _pomoTimer;
        /// <summary>回复语音队列的续播泵（见 Init 里的说明）。</summary>
        private DispatcherTimer _replyPumpTimer;

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
            // 拖动**过程中**实时跟随：气泡贴回桌宠旁边，输入窗跟着挪。
            // （PositionReported 只在松手时发一次，拖动中靠这条。）
            _win.DragMoved = delegate
            {
                try { _bubble.PlaceNearPet(); } catch { }
                FollowInputWindow();
            };
            _win.OnDisplayChanged = OnDisplayChanged;
            _win.ScaleAdjusted = OnScaleAdjusted;       // task-6：滚轮缩放 → 去抖上报 + 托盘刷新
            _win.DoubleClickInvoked = OnPetDoubleClick; // task-6：双击行为由 settings.doubleClick 决定
            // v9：单击（与拖动区分）→ 记一次互动。判据在 PetWindow.IsClickGesture。
            _win.ClickInvoked = delegate { OnPetClicked(); };
            // v10：长按摸头（分级）与抛掷（飞完才上报一次）。
            _win.PatInvoked = OnPetPat;
            _win.FlingFinished = OnPetFlingFinished;
            _win.SendButtonClicked = OnSendButtonClicked;  // task-7：✎ → 打开输入窗
            // 悬停事实 → 状态文字（`hint` 用）。与 ✎ 同一时机，不另起一套判定。
            _win.HoverChanged = delegate(bool over)
            {
                _hovering = over;
                RefreshStatusLabel();
                // v10：悬停反应（默认关）。**延迟 400ms 再发** ——
                // 鼠标只是"路过"她（从屏幕一边移到另一边）不该触发互动，
                // 而 400ms 足够把"路过"和"停在她身上"分开。
                // 关掉时连计时器都不起（见 _hoverReactOn 的说明）。
                if (_hoverReactOn) ScheduleHoverReact(over);
            };

            _bubble = new PetBubble();
            _bubble.PetRectProvider = PetRect;
            _bubble.HideNow();

            // 状态文字窗（用户点名"在底下显示一下状态"）。
            // 独立窗口 + 纯展示：绝不能塞进本体窗，那会破坏"窗口尺寸=帧尺寸"与
            // 基于 ActualWidth 的 alpha 命中归一化（见 PetStatusLabel 类注释）。
            _status = new PetStatusLabel();

            // 番茄钟倒计时窗（用户点名"增加番茄钟提醒我休息"）。
            // 独立窗口的理由与状态文字完全相同（不能撑大本体窗、不能破坏 alpha 命中），
            // 但**显隐规则不同**：只要在跑就必须看得见，且穿透时照显示 —— 见 PetPomodoro。
            _pomo = new PetPomodoro();

            // 语音（v8）：**只播不合成**。清单从 Host 拉（拉不到就静音运行）。
            _voiceOn = _opt.VoiceEnabled;
            _voicePlayer = new PetVoicePlayer(_ui, Path.Combine(_cacheDir, "voice"));
            _voicePlayer.Enabled = _voiceOn;

            // 气泡大小按"桌宠显示宽度 × 70%"算，所以要把帧尺寸与 DPI 喂给气泡。
            // 高 DPI 下写死绝对像素会让气泡反超桌宠（用户反馈过）。
            PushPetMetricsToBubble();
            WireAttentionButton();   // task-8：「去处理」→ focus-dsh 链路

            _tray = new PetTray();
            _tray.IsVisible = delegate { return _win.IsVisible; };
            _tray.GetClickThrough = delegate { return _win.ClickThrough; };
            _tray.GetScale = delegate { return _opt.Scale; };
            _tray.GetBubble = delegate { return _bubbleOn; };
            _tray.GetTheme = delegate { return _settingsTheme; };
            _tray.SetTheme = delegate(string key)
            {
                // 托盘里换主题：**本地立即生效**（贴纸 + 气泡外壳），并回报宿主持久化。
                _settingsTheme = string.IsNullOrEmpty(key) ? "auto" : key;
                bool darkNow = PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme);
                try { _bubble.ApplyTheme(darkNow); } catch { }
                try { _http.PostSettingsTheme(_settingsTheme); } catch (Exception ex) { PetLog.Warn("主题回报失败: " + PetLog.Describe(ex)); }
                PetLog.Info("托盘：主题 → " + _settingsTheme + "（生效深色=" + (darkNow ? "1" : "0") + "）");
            };
            _tray.ToggleVisible = delegate { _win.ToggleVisible(); };
            // ⭐ 本体显隐 → 气泡联动。
            // 气泡是独立窗口，本体 Hide() 不会带走它；不联动就会出现
            // "桌宠隐藏了、旁边还挂着一个聊天气泡"。
            _win.VisibilityChanged = delegate(bool visible)
            {
                try
                {
                    if (!visible)
                    {
                        _bubble.HideNow();
                        // 状态文字也是独立窗口 —— 与气泡同理：本体藏了它必须一起藏，
                        // 否则会出现「隐藏了桌宠、底下还挂着一行状态」。
                        _status.Hide();
                        // 番茄钟窗同理（独立窗口不会自己跟着藏）。
                        try { _pomo.Hide(); } catch { }
                        _hovering = false;
                    }
                    else
                    {
                        // 重新显示：气泡与倒计时都要补回来（独立窗口不会自己重现）。
                        if (_bubbleOn && _lastBubbleId != _shownBubbleId) ReplayCurrentBubble();
                        RefreshPomodoro();
                        RefreshStatusLabel();
                    }
                }
                catch (Exception ex) { PetLog.Warn("气泡联动失败: " + PetLog.Describe(ex)); }
            };
            _tray.SetClickThrough = delegate(bool on)
            {
                _win.SetClickThrough(on);
                ReportSettingFlags(clickThrough: on);
            };
            _tray.SetTopmost = delegate(bool on)
            {
                _win.SetTopmost(on);
                _tray.SetTopmostCheck(on);
                ReportSettingFlags(topmost: on);
            };
            // ⚠️ 托盘缩放**必须走 OnScaleAdjusted**：它负责去抖上报（300ms）
            // 与气泡/状态/番茄钟几个独立窗口的同比缩放。原先这里自己抄了一份
            // SetScale 调用、**没有上报** —— 于是"托盘里改成 120%，设置页还
            // 显示 80%"，而且气泡缩放那几行也漏了。
            _tray.SetScale = delegate(double s)
            {
                _win.SetScale(s);
                _win.ReclampPosition(false);
                OnScaleAdjusted(s);
            };
            _tray.SetBubble = delegate(bool on)
            {
                _bubbleOn = on;
                if (!on) _bubble.HideNow();
                ReportSettingFlags(bubble: on);
            };
            _tray.ResetPosition = delegate { _win.ReclampPosition(true); };
            // 状态显示：本地立即生效 + 回报宿主持久化（与主题同一条链路）。
            _tray.GetStatusMode = delegate
            {
                if (_statusAlways) return "always";
                return _hintOn ? "hint" : "off";
            };
            _tray.SetStatusMode = delegate(string mode)
            {
                _statusAlways = string.Equals(mode, "always", StringComparison.Ordinal);
                _hintOn = string.Equals(mode, "hint", StringComparison.Ordinal);
                PetLog.Info("托盘：状态显示 → " + mode);
                try { _http.PostSettingsStatus(_hintOn, _statusAlways); } catch (Exception ex) { PetLog.Warn("状态显示回报失败: " + PetLog.Describe(ex)); }
                RefreshStatusLabel();
            };
            _tray.FocusDsh = delegate { OnFocusDsh(); };
            _tray.OpenGallery = delegate { OpenGallery(); };
            // v10：托盘「手势提示」→ 让宿主把那条指引气泡再发一次。
            // 走命令通道（`/pet/command`）而不是 exe 自己拼气泡：
            // 文案是**封闭集合**、由宿主的状态机给（两端同一份真相）。
            _tray.ShowGestureHint = delegate
            {
                try { if (_http != null) _http.PostCommand("gesture-hint"); } catch { }
                PetLog.Info("托盘：请求重发手势提示");
            };
            _tray.Quit = delegate { Quit(); };

            // ── 番茄钟（托盘）───────────────────────────────────────────────
            //
            // 每个动作都**先本地发请求、再靠快照回来更新界面** —— 不在本地
            // 猜"按了之后该是什么状态"。Host 是唯一真相：本地乐观更新一旦
            // 与 Host 不一致（比如时间已经走完了），界面就会说谎。
            _tray.GetPomodoroSummary = delegate
            {
                PetPomodoroInfo p = _lastPomodoro;
                if (p == null || !p.Enabled || !p.Show) return "";
                string label = PomodoroPhaseLabel(p.Phase);
                long remain = p.RemainingAt(NowMs());
                string text = FormatRemaining(remain);
                return label + " " + text + (p.Running ? "" : "（暂停）");
            };
            _tray.GetPomodoroRunning = delegate
            {
                return _lastPomodoro != null && _lastPomodoro.Running;
            };
            _tray.GetPomodoroEnabled = delegate
            {
                // 块缺失（旧 Host）→ 按"关"处理：不给用户一个点了没反应的菜单。
                return _lastPomodoro != null && _lastPomodoro.Enabled;
            };
            _tray.GetPomodoroCountdown = delegate
            {
                return _lastPomodoro != null && _lastPomodoro.Show;
            };
            _tray.TogglePomodoro = delegate
            {
                if (_http != null) _http.PostPomodoro("toggle");
            };
            _tray.SkipPomodoro = delegate
            {
                if (_http != null) _http.PostPomodoro("skip");
            };
            _tray.ResetPomodoro = delegate
            {
                if (_http != null) _http.PostPomodoro("reset");
            };
            _tray.SetPomodoroEnabled = delegate(bool on)
            {
                // 总开关是**设置**（要持久化），走 /pet/settings 而不是 /pet/pomodoro。
                if (_http != null) _http.PostSettingsPomodoro(on, null);
            };
            _tray.SetPomodoroCountdown = delegate(bool on)
            {
                if (_http != null) _http.PostSettingsPomodoro(null, on);
            };
            // 语音开关：本地立即生效 + 回报宿主持久化（与主题/状态显示同一条链路）。
            _tray.GetVoiceEnabled = delegate { return _voiceOn; };
            _tray.SetVoiceEnabled = delegate(bool on)
            {
                SetVoiceEnabled(on);   // 本地立即生效（关掉时还会停掉正在播的）
                try { _http.PostSettingsVoice(on); } catch (Exception ex) { PetLog.Warn("语音回报失败: " + PetLog.Describe(ex)); }
            };

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

            // v7：番茄钟倒计时每秒重绘一次。
            //
            // **为什么在 exe 侧每秒刷**：Host 只在**阶段切换**时推帧（那才是真事件）。
            // 若让 Host 每秒推，25 分钟 = 1500 帧无意义广播。秒级显示由 exe 用
            // `endsAt` 本地插值 —— 两个进程读同一个系统时钟，插值是安全的。
            // exe **绝不在这里判定"阶段结束"**：那只在 Host 里做，这里到 0 只是显示到 0。
            _pomoTimer = new DispatcherTimer(DispatcherPriority.Background);
            _pomoTimer.Interval = TimeSpan.FromSeconds(1);
            _pomoTimer.Tick += OnPomodoroTick;
            _pomoTimer.Start();

            // 回复语音队列的续播泵。
            //
            // ⚠️ **不能只靠"上游来帧"驱动**。上游（Host）只在状态变化时推帧，
            // 桌宠 idle 之后就没有帧了 —— 而一段回复会被切成好几段陆续送达
            //（去掉 60 字限制后，见 `chunkForSpeech`）。若只靠帧，
            // 第一段播完后队列里剩下的分片会**永远排不出去**。
            //
            // 250ms 足够跟上"上一段刚播完"（多等最多 0.25 秒起播），
            // 又远小于任何一段的时长，不会空转出噪音。
            _replyPumpTimer = new DispatcherTimer(DispatcherPriority.Background);
            _replyPumpTimer.Interval = TimeSpan.FromMilliseconds(250);
            _replyPumpTimer.Tick += OnReplyPumpTick;
            _replyPumpTimer.Start();

            if (_http != null) _http.Start();

            // 语音清单：**在 http 启动后拉一次**（拉不到就静音运行，不重试刷屏）。
            // 放在这里而不是更早：GetVoiceManifest 是同步 HTTP，早期调用会拖慢首帧。
            LoadVoiceManifest();

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

        /// <summary>
        /// 显示快照里的气泡（取图 → 主题选图 → 兜底 → Show）。
        ///
        /// 抽成方法的原因：**隐藏桌宠再显示时要"重放"当前气泡**。
        /// 气泡是独立窗口，本体隐藏时它必须一起藏；重新显示时若只 Show 本体，
        /// 那个气泡就再也不会出现（直到下一个新气泡 id 到来）—— 看起来像"气泡丢了"。
        /// </summary>
        private void ShowBubbleFrom(PetSnapshot snap)
        {
            if (snap == null || snap.Bubble == null) return;
            _lastBubbleId = snap.Bubble.Id;
            _shownBubbleId = snap.Bubble.Id;
            BitmapSource img = null;
            BitmapSource[] frames = null;
            int frameMs = 0;

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

                // 动图（契约 §4 v-next）：清单声明 `frames > 1` 才去解全部帧。
                // 帧数/帧间隔属于**素材清单**，快照里没有 → 按 rel 回查 atlas。
                // 静态气泡完全不进这条分支（不加内存、不加开销）。
                PetJson.BubbleEntry be = _store.GetBubbleEntry(rel);
                if (img != null && be != null && be.Frames > 1)
                {
                    try
                    {
                        int maxSide = Math.Max(be.W, be.H);
                        frames = _store.GetBubbleFrames(rel, maxSide);
                        frameMs = be.FrameMs;
                        if (frames == null || frames.Length <= 1)
                        {
                            frames = null;   // 解不出多帧 → 老实退回静态，不假装会动
                            PetLog.Warn("气泡声明动图但解不出多帧，按静态显示: " + rel);
                        }
                    }
                    catch (Exception ex)
                    {
                        frames = null;
                        PetLog.Warn("气泡动图加载失败（按静态显示）: " + PetLog.Describe(ex));
                    }
                }

                PetLog.Info("气泡取图 rel=" + rel + " dark=" + (dark ? "1" : "0") +
                            (img != null ? " → 解码成功" : " → 解码失败（走兜底）") +
                            " opaque=" + (snap.Bubble.Opaque ? "1" : "0") +
                            (frames != null ? " 动图=" + frames.Length + "帧/" + frameMs + "ms" : "") +
                            " theme=" + _settingsTheme);
            }

            try { _bubble.Show(snap.Bubble, img, frames, frameMs); }
            catch (Exception ex) { PetLog.Warn("气泡显示失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>本体重新显示后，把"当前仍该显示的气泡"补回来。</summary>
        private void ReplayCurrentBubble()
        {
            if (!_bubbleOn) return;
            PetSnapshot snap = _lastSnapshot;
            if (snap == null || snap.Bubble == null) return;
            ShowBubbleFrom(snap);
            PetLog.Info("桌宠重新显示 → 重放气泡 id=" + snap.Bubble.Id);
        }
        private void ApplySnapshot(PetSnapshot snap)
        {
            _lastSnapshot = snap;   // 供桌宠重新显示时重放当前气泡
            if (snap.Rev >= 0)
            {
                long prev = Interlocked.Read(ref _lastRev);
                if (snap.Rev < prev) return;
                Interlocked.Exchange(ref _lastRev, snap.Rev);
            }

            // task-6：先应用 snapshot.settings（可能改尺寸/穿透/主题，气泡定位要用新尺寸）。
            // 逐字段 diff，值没变就不动（避免每帧重复 SetScale 抖动）。
            ApplySettings(snap.Settings);
            // 首帧就把气泡对齐（ApplySettings 只在**变化**时才动，启动时"没变过"会全被跳过）。
            //
            // ⚠️ 这里踩过两个坑，都是"diff 判定把首帧跳过了"：
            //   ① 配色：气泡用构造期的浅色默认值；
            //   ② **缩放**：exe 是带着 `--scale` 启动的，本体天生就是对的，
            //      于是 `ApplySettings` 里 `Math.Abs(s - _win.Scale) > 0.001` 判定"没变"
            //      → `_bubble.SetScale()` 从未被调用 → **气泡保持 1.0 尺寸**，
            //      而本体已是用户设的 0.8 —— 表现就是"第一次启动气泡不按大小缩放"。
            // 首帧**无条件**同步一次，之后才交给 diff。
            try { _bubble.ApplyTheme(PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme)); } catch { }
            try { _bubble.SetScale(_win.Scale); } catch (Exception ex) { PetLog.Warn("首帧气泡缩放失败: " + PetLog.Describe(ex)); }
            // 状态文字同理由首帧对齐（它同样吃 SetScale）；顺带刷一次显隐 ——
            // hint/statusAlways 也是"首帧就该生效"的设置。
            try { _status.SetScale(_win.Scale); } catch { }
            // 字号倍率同理由首帧对齐（与 `scale` 同理：`ApplySettings` 的 diff 会把
            // "启动时就已经等于快照值"的情况跳过，于是字号一直停在默认 1.0）。
            try { _status.SetFontScale(_statusFontScale); } catch { }
            // 气泡正文字号同理由首帧对齐（同理：diff 会把"启动时就等于快照值"跳过）。
            try { _bubble.SetFontScale(_chatFontScale); } catch { }
            try { _pomo.SetScale(_win.Scale); } catch { }
            try { RefreshStatusLabel(); } catch { }
            try { RefreshPomodoro(); } catch { }

            // 输入窗开着时，会话列表跟着快照走（新开/结束的对话要即时反映）
            if (_input != null) ApplySendChoices();

            // task-7：send 能力位（available=false 或块缺失 → 不显示 ✎）
            ApplySendInfo(snap.Send);

            // v3：聊天能力位（不可用 → 输入窗不显示"聊天"选项）
            ApplyChatInfo(snap.Chat);

            // task-8：attention diff（值没变零日志；null → 立刻收恒亮气泡）
            ApplyAttention(snap);

            // v7：番茄钟 diff（块变化才动；null → 收起倒计时窗）
            ApplyPomodoro(snap);

            // v8：语音（只在**变化**时出声 —— 见 SpeakForSnapshot 的说明）
            SpeakForSnapshot(snap);
            SpeakForSessionSet(snap);   // v2：新会话出现时招呼一声
            ApplySpeech(snap);          // v3：AI 回答的合成语音
            ApplySpeechFallback(snap);   // 合成没兜住时用固定台词顶一下

            // v9：好感度 + 互动语音
            ApplyInteract(snap);

            // 状态文字：快照的 label 是**已本地化**的状态词（待机中/正在思考…）。
            // 先存进本体窗，再刷新标签（标签通过 VisibleLabel() 读它，单一真相）。
            _win.SetVisibleLabel(snap.Label);
            RefreshStatusLabel();

            string st = snap.EffectiveState();
            if (!_previewMode)
            {
                if (_win.CurrentState != st) _stateChanges++;
                _win.SetState(st);
                // 不同状态的帧宽不同（实测 239~288）→ 气泡的比例基准要跟着更新
                PushPetMetricsToBubble();
            }

            if (_bubbleOn && snap.Bubble != null && snap.Bubble.Id > _lastBubbleId)
            {
                ShowBubbleFrom(snap);
            }
            // 快照里没有气泡（宿主已收起）→ 本地也收起，别让旧气泡挂着。
            else if (_bubbleOn && snap.Bubble == null && _shownBubbleId >= 0)
            {
                try { _bubble.HideNow(); } catch { }
                _shownBubbleId = -1;
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
                    _bubble.SetScale(s);  // 气泡同比缩放（它是独立窗口，不会自己跟）
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
            // 契约 §2 v6：状态显示（逐字段 diff，值没变不动）
            bool statusChanged = false;
            if (st.HasHint && st.Hint != _hintOn) { _hintOn = st.Hint; statusChanged = true; }
            if (st.HasStatusAlways && st.StatusAlways != _statusAlways) { _statusAlways = st.StatusAlways; statusChanged = true; }
            if (statusChanged)
            {
                PetLog.Info("settings: 状态显示 → hint=" + (_hintOn ? "1" : "0") +
                            " statusAlways=" + (_statusAlways ? "1" : "0"));
                RefreshStatusLabel();
            }
            // 契约 §2 v-next：状态文字字号（用户点名"字太小了，想调大"）。
            // 与 hint/statusAlways 一样走 diff —— 值没变不动，避免每帧重排。
            if (st.HasStatusFontScale && Math.Abs(st.StatusFontScale - _statusFontScale) > 0.001)
            {
                _statusFontScale = st.StatusFontScale;
                PetLog.Info("settings: 状态文字字号 → " + _statusFontScale.ToString("0.##") + "×");
                try { _status.SetFontScale(_statusFontScale); } catch (Exception ex) { PetLog.Warn("状态字号应用失败: " + PetLog.Describe(ex)); }
                RefreshStatusLabel();
            }
            // 气泡正文字号（用户点名"对话里的文字大小也要能调"）。
            // 正在显示的气泡会立即重排 —— 拖滑杆时马上看到效果，不用等下一个气泡。
            if (st.HasChatFontScale && Math.Abs(st.ChatFontScale - _chatFontScale) > 0.001)
            {
                _chatFontScale = st.ChatFontScale;
                PetLog.Info("settings: 气泡正文字号 → " + _chatFontScale.ToString("0.##") + "×");
                try { _bubble.SetFontScale(_chatFontScale); } catch (Exception ex) { PetLog.Warn("气泡字号应用失败: " + PetLog.Describe(ex)); }
            }
            // 契约 §2 v8：语音开关
            if (st.HasVoice && st.Voice != _voiceOn)
            {
                SetVoiceEnabled(st.Voice);
                changed = true;
            }

            // ── 契约 §2 v10：三个手势开关 ────────────────────────────────
            //
            // ⚠️ 这三个必须**真的接到行为上**，否则设置页就是在骗人：
            // 用户关掉「拖住甩出去」之后还能甩飞她，他会以为开关坏了。
            //
            // 逐字段 diff（值没变不动），与上面几个开关同一条纪律。
            if (st.HasLongPress && st.LongPress != _longPressOn)
            {
                _longPressOn = st.LongPress;
                _win.LongPressEnabled = _longPressOn;
                PetLog.Info("settings: 长按摸头 → " + (_longPressOn ? "1" : "0"));
            }
            if (st.HasFling && st.FlingEnabled != _flingOn)
            {
                _flingOn = st.FlingEnabled;
                _win.FlingEnabled = _flingOn;
                PetLog.Info("settings: 抛掷 → " + (_flingOn ? "1" : "0"));
            }
            if (st.HasHoverReact && st.HoverReact != _hoverReactOn)
            {
                _hoverReactOn = st.HoverReact;
                PetLog.Info("settings: 悬停反应 → " + (_hoverReactOn ? "1" : "0"));
            }
            if (st.HasPomodoroBreath && st.PomodoroBreath != _breathOn)
            {
                _breathOn = st.PomodoroBreath;
                PetLog.Info("settings: 呼吸引导 → " + (_breathOn ? "1" : "0"));
                // 正在跑的话立刻换显示（不必等下一帧）
                try { RefreshPomodoro(); } catch { }
            }

            if (st.HasTheme && st.Theme != _settingsTheme)
            {
                _settingsTheme = st.Theme;
                bool darkNow = PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme);
                PetLog.Info("settings: theme → " + _settingsTheme + "（生效深色=" + (darkNow ? "1" : "0") + "）");
                // 气泡外壳也跟着换色（原先只换贴纸图，白框在深色桌面上很刺眼）。
                // 正在显示的气泡立即换色，不必等下一次弹出。
                try { _bubble.ApplyTheme(darkNow); } catch (Exception ex) { PetLog.Warn("气泡换色失败: " + PetLog.Describe(ex)); }
                try { _status.ApplyTheme(darkNow); } catch { }
                try { _pomo.ApplyTheme(darkNow); } catch { }
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

        // ── 语音（v8）───────────────────────────────────────────────────────
        //
        // 设计要点（每条都有代价）：
        //   · **只播不合成**：运行时合成要 5~30 秒，等于按了没反应。见 PetVoicePlayer。
        //   · **事件驱动，不是"每帧都响"**：只在 `petState` **真的变化**时出声，
        //     否则状态机每 tick 一次就叫一声。
        //   · **拉不到清单就静音**：语音是可选的，缺了不该影响任何功能。
        //   · **高频道事件节流**：连点十下不叠十条（在 player 里做）。

        /// <summary>拉语音清单（启动时一次；失败就静音运行，不重试刷屏）。</summary>
        private void LoadVoiceManifest()
        {
            if (_http == null) return;
            try
            {
                PetVoiceManifest m = _http.GetVoiceManifest(8000);
                if (m == null || m.Count == 0)
                {
                    PetLog.Info("语音：清单为空（未构建语音包或 Host 未接线）→ 静音运行");
                    _voices = null;
                    return;
                }
                _voices = m;
                PetLog.Info("语音：清单 " + m.Describe());
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音清单拉取失败（静音运行）: " + PetLog.Describe(ex));
                _voices = null;
            }
        }

        /// <summary>
        /// 按事件播一条语音。**失败一律静默**（没有声音不是错误）。
        ///
        /// @param eventKey 清单里的事件名（如 `pet/click`）
        /// @returns 是否真的开始播放
        /// </summary>
        private bool Speak(string eventKey)
        {
            if (!_voiceOn || _voices == null || _voicePlayer == null) return false;
            try
            {
                PetVoiceLine line = _voices.PickForEvent(eventKey, _voiceSeed++);
                if (line == null) return false;   // 该事件没有语音 —— 正常，不是错误
                byte[] bytes = _http == null ? null : _http.GetVoiceBytes(line.Name);
                if (bytes == null || bytes.Length == 0) return false;
                return _voicePlayer.Play(bytes, eventKey, line.DurationMs);
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音播放异常（已忽略）: " + PetLog.Describe(ex));
                return false;
            }
        }

        /// <summary>轮换种子（同名事件多条时换着播，避免每次点击都一样）。</summary>
        private int _voiceSeed;

        /// <summary>
        /// 状态/事件变化 → 出声。
        ///
        /// ⚠️ 只在**变化**时触发：`ApplySnapshot` 每帧都跑，无条件出声会让
        /// 桌宠变成复读机。所以这里比对上一帧的值。
        /// </summary>
        private void SpeakForSnapshot(PetSnapshot snap)
        {
            if (!_voiceOn || _voices == null) return;
            try
            {
                // ① attention（等你审批）优先级最高：它最需要被注意到。
                if (snap.Attention != null)
                {
                    if (_lastVoiceState != "attention")
                    {
                        _lastVoiceState = "attention";
                        Speak("attention/approval");
                        return;
                    }
                }
                else if (_lastVoiceState == "attention")
                {
                    // ⭐ 你处理完审批了 → 她接着干，有始有终（v2 新增）。
                    // v1 完全没有这个时机：审批解决后桌宠一声不吭，像是卡住了。
                    _lastVoiceState = null;
                    Speak("attention/cleared");
                    return;
                }

                // ② 番茄钟阶段切换（专注结束该休息了 —— 用户点名的功能）。
                PetPomodoroInfo p = snap.Pomodoro;
                bool pomoOn = p != null && p.Enabled && p.Show && p.Running;
                // ②b 「开始计时」这个时机 v3 之前**根本没有**：阶段切换分支只覆盖
                //    结束与切段，"从没在跑 → 开始跑"一个事件都不发 ——
                //    于是台词表里的 `pomodoro/start` 是一条永远不会被播的闲置台词。
                //    单独判一次（只在"由停到跑"的边沿上）。
                if (pomoOn != _lastPomoRunning)
                {
                    bool wasRunning = _lastPomoRunning;
                    _lastPomoRunning = pomoOn;
                    if (pomoOn)
                    {
                        string startEvt = PetVoiceTrigger.ForPomodoroStart(wasRunning);
                        _lastPomoPhase = p.Phase;      // 别让同一次开始再被当成阶段切换
                        if (startEvt != null) { Speak(startEvt); return; }
                    }
                }
                if (p != null && p.Enabled && p.Show)
                {
                    string phaseKey = p.Running ? p.Phase : (p.Phase + ":paused");
                    if (_lastPomoPhase != null && _lastPomoPhase != phaseKey)
                    {
                        string evt = null;
                        if (p.Phase == "long-break")
                        {
                            // ⭐ 进入**长**休息（每 4 轮一次）—— v1 只覆盖了短休。
                            evt = "pomodoro/long-start";
                        }
                        else if (p.Phase == "break")
                        {
                            // 专注刚结束 → 进短休
                            evt = "pomodoro/focus-end";
                        }
                        else if (p.Phase == "focus" && _lastPomoPhase != "focus:paused")
                        {
                            // 休息结束 → 回专注（区分长短休）
                            evt = _lastPomoPhase == "long-break"
                                ? "pomodoro/long-end"
                                : "pomodoro/break-end";
                        }
                        else if (p.Phase == "focus" && _lastPomoPhase == "focus:paused")
                        {
                            // 暂停后继续 —— 不吭声（用户自己按的，他知道）
                            evt = null;
                        }
                        _lastPomoPhase = phaseKey;
                        if (evt != null) { Speak(evt); return; }
                    }
                    else
                    {
                        _lastPomoPhase = phaseKey;
                    }
                }

                // ③ 普通状态变化（working / happy / error / thinking 等）。
                string st = snap.EffectiveState();
                if (st != _lastVoiceState)
                {
                    string prev = _lastVoiceState;
                    _lastVoiceState = st;
                    // 状态 → 台词事件的对应表抽成了纯函数（`PetVoiceTrigger`），
                    // 好让"哪个状态该说什么"能被单测钉住 —— 见那里的说明。
                    string evt = PetVoiceTrigger.ForStateTransition(prev, st);
                    if (evt != null) { Speak(evt); return; }
                }

                // ④ ⭐ 长时间空闲（v2 新增，低频）：她"守不住闲"，闲久了会主动搭话。
                //
                // 为什么用**长时间静默**而不是状态变化：`idle` 是最常见的状态，
                // 按状态触发会变成复读机。这里要求"连续空闲超过阈值"才说一次，
                // 且说完记时间戳，避免重复。
                if (st == "idle" && snap.Settings != null && snap.Settings.StatusAlways != null)
                {
                    // 只在真的闲了很久时出声（阈值取 20 分钟；测试可注入）
                    //
                    // ⚠️ 用 `Stopwatch.GetTimestamp()` 而**不是** `Environment.TickCount64`
                    // —— 后者是 .NET Core API，.NET Framework 4.8 上编译不过
                    //（实测 error CS0117: Environment 未包含 TickCount64 的定义）。
                    long now = Stopwatch.GetTimestamp();
                    if (_idleSinceMs == 0) _idleSinceMs = now;
                    long idleFor = (long)((now - _idleSinceMs) * 1000.0 / Stopwatch.Frequency);
                    long sinceTalk = (long)((now - _lastIdleTalkMs) * 1000.0 / Stopwatch.Frequency);
                    if (idleFor > IdleTalkAfterMs && sinceTalk > IdleTalkAfterMs)
                    {
                        _lastIdleTalkMs = now;
                        Speak("pet/idle-long");
                        return;
                    }
                }
                else
                {
                    _idleSinceMs = 0;
                }
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音触发失败（已忽略）: " + PetLog.Describe(ex));
            }
        }

        /// <summary>连续空闲多久后主动说一句（默认 20 分钟）。测试可改小。</summary>
        public static long IdleTalkAfterMs = 20 * 60 * 1000L;
        private long _idleSinceMs;
        private long _lastIdleTalkMs;
        /// <summary>上一帧番茄钟是否在跑（判定「开始计时」那个边沿，见 ②b）。</summary>
        private bool _lastPomoRunning;

        /// <summary>
        /// 会话集合变化 → 新会话出现时招呼一声（v2 新增）。
        ///
        /// 为什么单独一个方法：`SpeakForSnapshot` 只关心"当前状态"，
        /// 而"出现了新会话"是**集合层面**的变化 —— 塞进状态机分支里会污染它。
        /// </summary>
        private void SpeakForSessionSet(PetSnapshot snap)
        {
            if (!_voiceOn || _voices == null || snap == null || snap.Sessions == null) return;
            try
            {
                HashSet<string> now = new HashSet<string>();
                for (int i = 0; i < snap.Sessions.Count; i++)
                {
                    PetSessionInfo si = snap.Sessions[i];
                    if (si == null || string.IsNullOrEmpty(si.SessionId)) continue;
                    if (si.SessionId == "unknown") continue;
                    now.Add(si.SessionId);
                }
                // 首次填充不算"新增"（那是启动时把已有会话读进来）。
                if (_knownSessionIds == null) { _knownSessionIds = now; return; }
                bool appeared = false;
                foreach (string id in now) { if (!_knownSessionIds.Contains(id)) { appeared = true; break; } }
                _knownSessionIds = now;
                if (appeared) Speak("session/start");
            }
            catch (Exception ex)
            {
                PetLog.Warn("会话语音触发失败（已忽略）: " + PetLog.Describe(ex));
            }
        }

        /// <summary>上一帧见过的会话集合（判定"新会话出现"）。</summary>
        private HashSet<string> _knownSessionIds;

        /// <summary>最近播过的动态语音 name（去重：同一个 name 只播一次）。</summary>
        private string _lastSpeakName;

        /// <summary>
        /// 动态语音（AI 回答的合成音频）→ 播放。
        ///
        /// 与固定台词的区别：这批音频是 Host **运行时合成**的（子插件提供 TTS），
        /// 名字是缓存键，字节要去 `/pet/speech/&lt;name&gt;` 取。
        ///
        /// ⚠️ 去重按 **name** 而不是 seq：Host 重启后 seq 会归零，
        /// 而同一句话的 name 是稳定的（文本哈希）—— 按 name 去重不会
        /// 在重启后把同一句重复念一遍。
        /// </summary>
        private void ApplySpeech(PetSnapshot snap)
        {
            if (snap == null || string.IsNullOrEmpty(snap.SpeakName)) return;
            if (snap.SpeakName == _lastSpeakName) return;
            if (!_voiceOn || _voicePlayer == null) return;
            try
            {
                byte[] bytes = _http == null ? null : _http.GetSpeechBytes(snap.SpeakName);
                if (bytes == null || bytes.Length == 0)
                {
                    // 拿不到不算错：可能合成刚过期被 Host 清了缓存，或网络抖动。
                    PetLog.Warn("动态语音取不到字节（已忽略）: " + snap.SpeakName);
                    _lastSpeakName = snap.SpeakName;   // 记下，避免每帧重试
                    return;
                }
                // `Play` 的时长参数是 int（毫秒），快照里是 long —— 显式收窄并夹住
                //（超过 24 天会溢出 int，虽然不现实，但夹一下比留着溢出好）。
                int ms = snap.SpeakDurationMs > 0
                    ? (int)Math.Min(snap.SpeakDurationMs, int.MaxValue)
                    : 0;
                // ⭐ 走 `DeliverReply` 而不是 `Play(interrupt:true)` ——
                // **同一条回复的多个分片要排队续播，而不是每段都抢占**。
                //
                // 去掉"只念 60 字"的限制后，一段回复会被切成好几段陆续到达
                //（见 `chunkForSpeech`）。若每段都抢占，第 2 段一到就把还在播的
                // 第 1 段打断 —— 听起来就是每句只念开头几个字。
                // `utterance` 相同 → 入队等前一段播完；换号 → 清空队列播新的。
                _voicePlayer.DeliverReply(bytes, ms, snap.SpeakUtterance);
                // ⚠️⚠️ 这行**绝不能删** —— 它是"同一个 name 只交付一次"的唯一防线。
                //
                // 我把它删过一次（把 `Play` 换成 `DeliverReply` 时顺手重写，
                // 以为 `DeliverReply` 自己会去重）—— 结果**每一帧都重新交付同一段**：
                // 实测最后一段被塞进队列 20+ 遍，桌宠开始无限重复念
                //「那就什么都在。」（`pet.log` 里队列从 0 一路涨到 21）。
                //
                // 去重必须在**取字节之前**（上面那行早退）才算数；
                // 放到 `PetVoicePlayer` 里不行 —— 它拿不到 name，只拿到字节。
                _lastSpeakName = snap.SpeakName;
                // ⚠️ 措辞是"交付"不是"播放" —— 这一段可能只是**入了队**
                //    （上一段还在播）。真正起播时 `PetVoicePlayer` 会再记一条
                //    "回复分片起播"。之前这里写"播放"，于是日志会显示
                //    "播放"了好几条却只有一条真在响 —— 诊断自己骗自己。
                PetLog.Info("动态语音交付: " + snap.SpeakName + "（" + ms + "ms，回复#" +
                            snap.SpeakUtterance + "，队列 " + _voicePlayer.PendingReplies + "）");
            }
            catch (Exception ex)
            {
                PetLog.Warn("动态语音播放失败（已忽略）: " + PetLog.Describe(ex));
            }
        }

        /// <summary>最近播过的兜底台词 seq（去重：同一个 seq 只播一次）。</summary>
        private long _lastFallbackSeq;

        /// <summary>
        /// **动态语音没兜住时**播一句固定台词（契约 §2 `speak.fallback`）。
        ///
        /// 场景：聊天回复到了，但 TTS 子插件没装 / 超时 / 合成失败 ——
        /// Host 会把 `speak.fallback = {seq, event:'chat/reply'}` 塞进快照，
        /// 这里见到新 seq 就播一次固定台词，让"回复到达"这个时刻不至于完全无声。
        ///
        /// ⚠️ 两条不许越界的：
        ///   · **有**动态语音时不播（否则一句回复说两遍）；
        ///   · 事件名只接受清单里有的，且必须是白名单里的（见 <see cref="Speak"/>）。
        /// </summary>
        private void ApplySpeechFallback(PetSnapshot snap)
        {
            if (snap == null) return;
            if (snap.FallbackSeq <= 0 || snap.FallbackEvent == null) return;
            if (snap.FallbackSeq == _lastFallbackSeq) return;
            _lastFallbackSeq = snap.FallbackSeq;
            // 有动态音频 = 已经念过正文了，不必再补一句。
            if (!string.IsNullOrEmpty(snap.SpeakName)) return;
            if (!_voiceOn || _voices == null) return;
            PetLog.Info("动态语音不可用 → 兜底台词 " + snap.FallbackEvent +
                        "（#" + snap.FallbackSeq + "）");
            Speak(snap.FallbackEvent);
        }

        /// <summary>语音开关（设置页/托盘）。关掉时立刻停掉正在播的。</summary>
        private void SetVoiceEnabled(bool on)
        {
            if (on == _voiceOn) return;
            _voiceOn = on;
            if (_voicePlayer != null) _voicePlayer.Enabled = on;
            if (!on && _voicePlayer != null) _voicePlayer.Stop();
            PetLog.Info("语音 → " + (on ? "开" : "关"));
        }

        // ------------------------------------------------------------------
        // v9：互动与好感度
        // ------------------------------------------------------------------

        /// <summary>互动菜单（从 Host 拉的，含动作表与好感度）。</summary>
        private PetInteractMenu _interactMenu;
        /// <summary>最近处理过的互动序号（去重：同一个 seq 只播一次语音）。</summary>
        private long _lastInteractSeq = -1;
        /// <summary>当前好感度（快照里的）。</summary>
        private PetAffectionInfo _affection;

        /// <summary>今日番茄统计（v10，右键菜单「今天」一行用；块缺失 = null）。</summary>
        private PetTodayInfo _today;

        // ── v10：手势开关的本地镜像 ─────────────────────────────────────────
        //
        // ⚠️ 缺省值**从 `PetSettingsInfo` 读**，不在这里写常量 ——
        // 回滚验证抓到过：我原先在这里写 `= false`、在快照解析里也写一个
        // 缺省值，而解析里那个是**死代码**（进到那一支时键一定存在）。
        // 同一个语义两份、其中一份不可达 —— 假断言就是这么来的。
        /// <summary>长按摸头。默认开（要主动按住才触发）。</summary>
        private bool _longPressOn = PetSettingsInfo.DefaultLongPress();
        /// <summary>抛掷。默认开（要主动甩才触发）。</summary>
        private bool _flingOn = PetSettingsInfo.DefaultFlingEnabled();
        /// <summary>悬停反应。默认关（唯一"她主动找你"的互动）。</summary>
        private bool _hoverReactOn = PetSettingsInfo.DefaultHoverReact();
        /// <summary>专注期呼吸引导。默认关。</summary>
        private bool _breathOn = PetSettingsInfo.DefaultPomodoroBreath();

        /// <summary>
        /// 单击桌宠 → 记一次互动。
        ///
        /// **只发请求，不本地改状态**：好感度与文案都由 Host 算（它是唯一真相）。
        /// 本地乐观更新一旦与 Host 不一致（比如正好冷却中），界面就会说谎。
        /// </summary>
        private void OnPetClicked()
        {
            if (_http == null) return;
            _http.PostInteract("click");
            PetLog.Info("单击桌宠 → 互动 click");
        }

        /// <summary>右键菜单里的互动项被点。</summary>
        private void OnInteractChosen(string kind)
        {
            if (_http == null) return;
            _http.PostInteract(kind);
            PetLog.Info("右键互动 → " + kind);
        }

        /// <summary>
        /// v10：长按摸头到第 <paramref name="level"/> 级。
        ///
        /// 级数**只加在请求体里**，本地不做任何"这一级算不算数"的判断 ——
        /// 冷却、递减、日上限全在 Host（唯一真相）。exe 若也判一次，
        /// 两边的口径迟早分叉（比如这边按 600ms 一级、那边按 700ms）。
        /// </summary>
        private void OnPetPat(int level)
        {
            if (_http == null) return;
            _http.PostInteract("pat", level);
            PetLog.Info("长按摸头 → 第 " + level + " 级");
        }

        /// <summary>
        /// v10：悬停反应 —— 停在她身上 400ms 后报一次 `hover` 互动。
        ///
        /// ⚠️ 为什么需要延迟：`HoverChanged` 在鼠标**扫过**她时也会触发
        /// （从屏幕一边移到另一边必然会划过）。不延迟的话，每次鼠标路过
        /// 都会让她"看你一眼" —— 那正是"默认关"要防的那种骚扰。
        ///
        /// ⚠️ 离开时必须**取消**计时器：不取消的话，鼠标划过她、400ms 后
        /// 仍然会报一次（人早就走了，而气泡在她旁边冒出来）。
        ///
        /// 频率上限不在这里做：宿主的 `interactions.js` 有 `reactGapMs`（20 秒），
        /// 那是唯一真相 —— exe 再判一次只会让两边口径分叉。
        /// </summary>
        private void ScheduleHoverReact(bool over)
        {
            if (_hoverTimer == null)
            {
                _hoverTimer = new DispatcherTimer(DispatcherPriority.Background);
                _hoverTimer.Interval = TimeSpan.FromMilliseconds(400);
                _hoverTimer.Tick += delegate
                {
                    _hoverTimer.Stop();
                    // 触发时再确认一次"还悬停着"：计时器醒来时鼠标可能已经走了。
                    if (!_hovering) return;
                    if (!_hoverReactOn) return;
                    try { if (_http != null) _http.PostInteract("hover"); } catch { }
                    PetLog.Info("悬停反应 → 互动 hover");
                };
            }
            if (over)
            {
                if (!_hoverTimer.IsEnabled) _hoverTimer.Start();
            }
            else
            {
                _hoverTimer.Stop();
            }
        }

        /// <summary>悬停反应的延迟计时器（懒建；`_hoverReactOn` 关着时永不启动）。</summary>
        private DispatcherTimer _hoverTimer;

        /// <summary>
        /// 抛掷落地后上报**一次**。
        ///
        /// 为什么在落地时上报、而不是松手时：松手到落地之间用户看到的还是
        /// "她还在飞"，此时弹气泡/播语音会与画面错位（气泡在她飞走之前的位置）。
        /// 而且落地才可能"撞墙"—— 撞墙要换一句反应。
        /// </summary>
        private void OnPetFlingFinished(bool hitEdge)
        {
            if (_http == null) return;
            _http.PostInteract("fling");
            PetLog.Info("抛掷落地 → 互动 fling" + (hitEdge ? "（撞到边界）" : ""));
        }

        /// <summary>
        /// 应用快照里的好感度 + 处理"最近一次互动"。
        ///
        /// 互动语音**由这里触发**（而不是单击时立刻播）：Host 才是"这次互动
        /// 算不算数"的判定方（可能在冷却中）。等它把 `interact.seq` 推回来
        /// 再播，语音与真实结果才一致。
        /// </summary>
        private void ApplyInteract(PetSnapshot snap)
        {
            if (snap == null) return;

            // 好感度 diff（值没变零日志）。
            if (!PetAffectionInfo.Same(snap.Affection, _affection))
            {
                _affection = snap.Affection;
                if (_affection != null)
                {
                    PetLog.Info("好感度 → " + _affection.Points + " 分 / " +
                                _affection.Label() +
                                (_affection.NextMin > 0
                                    ? ("（下一档 " + _affection.NextMin + "）")
                                    : "（已满级）"));
                }
                _tray.Refresh();
            }

            // 今日统计 diff（v10）。值没变零日志 —— 它每帧都在快照里，
            // 无条件打日志会把日志淹掉。
            if (!PetTodayInfo.Same(snap.Today, _today))
            {
                _today = snap.Today;
                if (_today != null && _today.PomodoroCount > 0)
                {
                    PetLog.Info("今日统计 → " + _today.MenuLine());
                }
            }

            // 互动信号：只在 seq **变化**时播一次。
            // `_lastInteractSeq` 初值 -1：首次收到（seq 可能从 1 开始）也会播。
            if (snap.InteractSeq > 0 && snap.InteractSeq != _lastInteractSeq)
            {
                _lastInteractSeq = snap.InteractSeq;
                if (!string.IsNullOrEmpty(snap.InteractVoice))
                {
                    Speak(snap.InteractVoice);
                }
            }
        }

        /// <summary>
        /// 拉互动动作表（右键菜单用）。**异步**，失败就保持上一次的菜单
        /// （不把菜单清空 —— 那会让用户右键时看到空菜单）。
        /// </summary>
        private void RefreshInteractMenu()
        {
            if (_http == null) return;
            try
            {
                _http.GetInteractMenu(delegate(PetInteractMenu m, string err)
                {
                    if (m == null)
                    {
                        PetLog.Warn("互动菜单拉取失败（保持上一次）：" + (err ?? "未知原因"));
                        return;
                    }
                    if (_ui != null && !_ui.CheckAccess())
                    {
                        _ui.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                        {
                            _interactMenu = m;
                            _affection = m.Affection ?? _affection;
                        }));
                    }
                    else
                    {
                        _interactMenu = m;
                        _affection = m.Affection ?? _affection;
                    }
                });
            }
            catch (Exception ex) { PetLog.Warn("互动菜单刷新失败: " + PetLog.Describe(ex)); }
        }

        // ------------------------------------------------------------------
        // v7：番茄钟（块变化才动；exe 只显示，绝不判定阶段结束）
        // ------------------------------------------------------------------

        /// <summary>
        /// 应用快照里的番茄钟块。
        ///
        /// **只负责显示**：倒计时的推进由 `_pomoTimer` 每秒本地插值，
        /// "阶段结束 → 该提醒了"完全在 Host 里（它是唯一真相）。
        /// exe 若自己也判一次，DSH 重启/断线时两边口径必然分叉。
        /// </summary>
        private void ApplyPomodoro(PetSnapshot snap)
        {
            PetPomodoroInfo p = snap == null ? null : snap.Pomodoro;

            // 值没变就不动（避免每帧重排窗口导致闪烁）。
            // 但**每秒的本地插值不算"变"** —— 这里比的是块本身。
            if (PetPomodoroInfo.Same(p, _lastPomodoro))
            {
                // 即使块没变，也要刷一次显隐：本体刚显示/隐藏时倒计时得跟着走。
                RefreshPomodoro();
                return;
            }

            bool had = _lastPomodoro != null;
            _lastPomodoro = p;

            if (p == null)
            {
                if (had) PetLog.Info("番茄钟 → 块消失（旧 Host 或未启用）");
                RefreshPomodoro();
                _tray.Refresh();
                return;
            }

            if (had)
            {
                PetLog.Info("番茄钟 → phase=" + p.Phase + " running=" + (p.Running ? "1" : "0") +
                            " remain=" + p.RemainingMs.ToString(CultureInfo.InvariantCulture) + "ms" +
                            " round=" + p.Round.ToString(CultureInfo.InvariantCulture) +
                            "/" + p.RoundsPerLongBreak.ToString(CultureInfo.InvariantCulture) +
                            " completed=" + p.Completed.ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                PetLog.Info("番茄钟 → 首次收到块 phase=" + p.Phase +
                            " enabled=" + (p.Enabled ? "1" : "0") + " show=" + (p.Show ? "1" : "0"));
            }

            RefreshPomodoro();
            _tray.Refresh();
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

        /// <summary>
        /// v3：聊天能力位变化 → 告诉输入窗（它据此决定"聊天"选项显不显示）。
        ///
        /// 值没变就不动（避免每帧重填下拉 —— 那会把用户正在选的东西重置）。
        /// </summary>
        private void ApplyChatInfo(PetChatInfo chat)
        {
            bool avail = PetChatInfo.ShouldShowChat(chat);
            bool on = chat != null && chat.Enabled;
            if (avail == _chatAvailable && on == _chatOn) return;
            _chatAvailable = avail;
            _chatOn = on;
            try { if (_input != null) _input.SetChatAvailability(avail, on); } catch { }
            PetLog.Info("聊天能力位 → " + (avail ? "可用" : "不可用") +
                        (chat != null && !string.IsNullOrEmpty(chat.Reason) ? ("（" + chat.Reason + "）") : ""));
        }

        /// <summary>✎ 被点（只有可用时按钮才可见；防御式再查一次）→ 打开输入窗。</summary>
        private void OnSendButtonClicked()        {
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
            // 每次打开都刷一次可选对话（用户可能刚开了新对话/结束了旧的）
            ApplySendChoices();
            // v3：把"聊天能不能用"告诉输入窗（不可用就把选项藏起来 ——
            // "给了入口但点了必失败"是最糟的交互）。
            try { _input.SetChatAvailability(_chatAvailable, _chatOn); } catch { }
            int x, y, w, h;
            _win.GetScreenRect(out x, out y, out w, out h);
            _win.SetSendOpen(true);
            _input.OpenNear(x, y, w, h);
        }

        /// <summary>
        /// 把快照里的会话列表喂给输入窗的「发给哪个对话」选择器。
        ///
        /// 只取 Host 已回退好名字的项（title 一定有值），并按"在跑的优先、再按更新时间"排序 ——
        /// 用户最可能想发给正在干活的那个。
        /// </summary>
        private void ApplySendChoices()
        {
            if (_input == null) return;
            try
            {
                List<PetSessionChoice> list = new List<PetSessionChoice>();
                PetSnapshot snap = _lastSnapshot;
                if (snap != null && snap.Sessions != null)
                {
                    for (int i = 0; i < snap.Sessions.Count; i++)
                    {
                        PetSessionInfo si = snap.Sessions[i];
                        if (si == null || string.IsNullOrEmpty(si.SessionId)) continue;
                        if (si.SessionId == "unknown") continue;   // 不是真实会话
                        PetSessionChoice c = new PetSessionChoice();
                        c.SessionId = si.SessionId;
                        c.Title = si.Title;
                        c.Project = si.Project;   // 折叠分组用（缺了它会全落进"（其他）"）
                        c.Running = si.Running || si.State == "working" || si.State == "thinking";
                        list.Add(c);
                    }
                    list.Sort(delegate(PetSessionChoice a, PetSessionChoice b)
                    {
                        // ⚠️ 必须**先按项目**排序：分组是把相邻同类会话切在一起，
                        // 项目不挨着的话同一个文件夹会被拆成好几个组。
                        int byProject = string.Compare(a.Project ?? "", b.Project ?? "",
                                                       StringComparison.CurrentCulture);
                        if (byProject != 0) return byProject;
                        // 组内：在跑的优先，再按名字
                        if (a.Running != b.Running) return a.Running ? -1 : 1;
                        return string.Compare(a.Title, b.Title, StringComparison.CurrentCulture);
                    });
                }
                _input.SetChoices(list);
            }
            catch (Exception ex) { PetLog.Warn("会话选择器刷新失败: " + PetLog.Describe(ex)); }
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
            // 气泡同比缩放：滚轮时立刻重排（否则气泡僵在原尺寸，看着很突兀）
            try { _bubble.SetScale(newScale); } catch (Exception ex) { PetLog.Warn("气泡缩放失败: " + PetLog.Describe(ex)); }
            try { _status.SetScale(newScale); } catch { }
            try { _pomo.SetScale(newScale); } catch { }
            try { RefreshPomodoro(); } catch { }
        }

        /// <summary>
        /// 开关类设置改了 → 立即回报宿主持久化（POST /pet/settings，只带改动的字段）。
        ///
        /// 与缩放不同，开关**不需要去抖**：一次点击就是一个终值，没有连续拖动的中间态。
        /// 托盘菜单与桌宠右键菜单都走这里，保证"本地改了 → 宿主知道 → 设置页跟着变"。
        /// 失败只记日志（`PostJson` 的既有语义）：宿主不在时不该弹框打断用户。
        /// </summary>
        private void ReportSettingFlags(bool? clickThrough = null, bool? topmost = null, bool? bubble = null)
        {
            if (_http == null) return;
            try
            {
                _http.PostSettingsFlags(clickThrough, topmost, bubble);
                PetLog.Info("设置已上报 /pet/settings " + PetHttp.BuildSettingsFlagsBody(clickThrough, topmost, bubble));
            }
            catch (Exception ex) { PetLog.Warn("设置回报失败: " + PetLog.Describe(ex)); }
        }

        private void OnScalePostTick(object sender, EventArgs e)
        {
            _scalePostTimer.Stop();
            if (double.IsNaN(_pendingScalePost)) return;
            if (_http != null)
            {
                _http.PostSettingsScale(_pendingScalePost);
                PetLog.Info("设置已上报 /pet/settings scale=" +
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
            PushPetMetricsToBubble();   // DPI 可能变了 → 气泡比例基准跟着更新
            try { _bubble.PlaceNearPet(); } catch { }
        }

        /// <summary>
        /// 刷新状态文字窗（显隐 + 内容 + 位置）。
        ///
        /// **单点入口**：快照/设置/悬停/移动都走这里，避免"某个路径忘了更新"——
        /// 气泡那几轮反复踩过（隐藏不同步、缩放不同步、跟随不同步）。
        ///
        /// 显隐规则在 `PetStatusLabel.ShouldShow`（与 overlay 逐条对齐）：
        /// `statusAlways` 常显 / `hint` 悬停显示 / 两个都关不显示 / `clickThrough` 不显示。
        /// </summary>
        /// <summary>把本体帧尺寸/DPI 推给气泡（气泡据此按比例定尺寸）。</summary>
        private void PushPetMetricsToBubble()
        {
            try
            {
                int fw, fh; double dpi;
                if (_win.FrameMetrics(out fw, out fh, out dpi) && _bubble != null)
                {
                    _bubble.SetPetMetrics(fw, fh, dpi);
                }
            }
            catch (Exception ex) { PetLog.Warn("推送本体尺寸失败: " + PetLog.Describe(ex)); }
        }
        private void RefreshStatusLabel()
        {
            if (_status == null) return;
            try
            {
                int x, y, w, h;
                _win.GetScreenRect(out x, out y, out w, out h);
                // 倒计时在跑时，状态文字要**让位到它下面** —— 否则两个窗口重叠。
                // 锚点传"倒计时窗的矩形"，PetStatusLabel 的 ComputeTarget 会贴它下方。
                int[] anchor = StatusAnchorRect(x, y, w, h);
                _status.Update(
                    _win.VisibleLabel(),
                    _statusAlways,
                    _hintOn,
                    _win.ClickThrough,
                    _hovering,
                    anchor);
            }
            catch (Exception ex) { PetLog.Warn("状态文字刷新失败: " + PetLog.Describe(ex)); }
        }

        // ── 番茄钟（v7）─────────────────────────────────────────────────────

        /// <summary>当前 epoch 毫秒（与 Host 同一系统时钟 —— 本地插值的前提）。</summary>
        private static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        /// <summary>阶段名 → 界面标签。纯函数（自检直接断言）。</summary>
        internal static string PomodoroPhaseLabel(string phase)
        {
            if (phase == "break") return "休息";
            if (phase == "long-break") return "长休息";
            return "专注";
        }

        /// <summary>
        /// 剩余毫秒 → `24:59` / `1:05:00`。
        ///
        /// ⚠️ **必须与 Host 的 `formatRemaining` 同一口径（向上取整）**：
        /// 两边差一秒时，用户在托盘里看到 `24:59`、桌宠下面却是 `25:00`，
        /// 会以为其中一个坏了。自检里有一条"同口径"断言盯着这个。
        /// </summary>
        internal static string FormatRemaining(long ms)
        {
            long total = (ms + 999) / 1000;      // 向上取整（与 Host 的 Math.ceil 一致）
            if (total < 0) total = 0;
            long h = total / 3600;
            long m = (total % 3600) / 60;
            long s = total % 60;
            if (h > 0) return h.ToString(CultureInfo.InvariantCulture) + ":" +
                              m.ToString("00", CultureInfo.InvariantCulture) + ":" +
                              s.ToString("00", CultureInfo.InvariantCulture);
            return m.ToString("00", CultureInfo.InvariantCulture) + ":" +
                   s.ToString("00", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// 倒计时窗要显示的文字（null = 不显示）。纯函数，自检直接断言。
        ///
        /// 格式：`专注 24:59`；超过一轮时补上 `· 2/4`（用户要知道长休还有几轮）。
        /// </summary>
        internal static string PomodoroTextFor(PetPomodoroInfo p, long nowMs)
        {
            if (p == null || !p.Enabled || !p.Show) return null;
            string label = PomodoroPhaseLabel(p.Phase);
            string time = FormatRemaining(p.RemainingAt(nowMs));
            // 轮次只在专注阶段显示：休息时说"第 3/4 轮"会让人误以为在专注。
            if (p.Phase == "focus" && p.RoundsPerLongBreak > 1)
            {
                return label + " " + time + " · " + p.Round.ToString(CultureInfo.InvariantCulture) +
                       "/" + p.RoundsPerLongBreak.ToString(CultureInfo.InvariantCulture);
            }
            return label + " " + time;
        }

        /// <summary>倒计时窗当前是否该占位（决定状态文字要不要让位）。</summary>
        private bool PomodoroVisible()
        {
            PetPomodoroInfo p = _lastPomodoro;
            if (p == null || !p.Enabled || !p.Show) return false;
            if (_win == null || !_win.IsVisible) return false;
            return true;
        }

        /// <summary>
        /// 状态文字的定位锚点：倒计时可见时用**倒计时窗的矩形**（贴它下方），
        /// 否则用本体矩形。这样两者自然堆叠，且倒计时一消失状态文字就自动上移
        /// —— 不需要任何"重排"逻辑。
        /// </summary>
        private int[] StatusAnchorRect(int petX, int petY, int petW, int petH)
        {
            if (_pomo == null || !_pomo.IsVisible) return new int[] { petX, petY, petW, petH };
            try
            {
                IntPtr h = _pomo.HandleOrZero;
                double dpi = h == IntPtr.Zero ? 1.0 : PetNative.GetDpiForWindowSafe(h) / 96.0;
                if (dpi <= 0) dpi = 1.0;
                int bw, bh;
                _pomo.DiagMetrics(out bw, out bh);
                int px = (int)Math.Round(_pomo.Left * dpi);
                int py = (int)Math.Round(_pomo.Top * dpi);
                return new int[] { px, py, bw, bh };
            }
            catch
            {
                return new int[] { petX, petY, petW, petH };
            }
        }

        /// <summary>
        /// 刷新倒计时窗（**单点入口**：快照/设置/缩放/移动都走这里）。
        /// </summary>
        private void RefreshPomodoro()
        {
            if (_pomo == null || _win == null) return;
            try
            {
                int x, y, w, h;
                _win.GetScreenRect(out x, out y, out w, out h);
                string text = PomodoroTextFor(_lastPomodoro, NowMs());
                _pomo.Update(text, _lastPomodoro != null && _lastPomodoro.Show,
                    _win.IsVisible, new int[] { x, y, w, h }, null);
            }
            catch (Exception ex) { PetLog.Warn("番茄钟窗刷新失败: " + PetLog.Describe(ex)); }
        }

        /// <summary>
        /// 每秒推进一次倒计时显示。
        ///
        /// **为什么不让 Host 每秒推帧**：25 分钟 = 1500 帧无意义的状态广播，
        /// 而且 exe 还得为每帧重绘。Host 只在**阶段切换**时推（那才是真事件），
        /// 秒级显示由 exe 用 `EndsAt` 本地插值 —— 两个进程读同一个系统时钟，
        /// 所以插值是安全的。
        ///
        /// ⚠️ **exe 绝不在这里判定"阶段结束"**：那只在 Host 里做。
        /// 这里到 0 只是"显示到 0"，真正的提醒与切换等下一帧快照。
        /// </summary>
        private void OnPomodoroTick(object sender, EventArgs e)
        {
            PetPomodoroInfo p = _lastPomodoro;
            if (p == null || !p.Enabled || !p.Show) return;
            if (!p.Running) return;      // 暂停/停止时不必每秒重绘
            RefreshPomodoro();
            // 托盘标题也带倒计时 —— 但每 5 秒刷一次就够（菜单没打开时刷新是白做功）。
            if ((DateTime.Now.Second % 5) == 0) _tray.Refresh();
        }

        /// <summary>
        /// 回复语音队列的续播泵（250ms 一次）。
        ///
        /// 队列非空且当前空闲 → 播下一片。**必须有这个泵**：上游只在状态变化时
        /// 推帧，桌宠 idle 之后就没有帧了，而一段回复会被切成多段陆续送达
        ///（去掉 60 字限制后）—— 只靠帧的话，第一段播完剩下的分片会永远排不出去。
        ///
        /// 空闲时它什么都不做（一次 `Queue.Count` 判断），开销可忽略。
        /// </summary>
        private void OnReplyPumpTick(object sender, EventArgs e)
        {
            try
            {
                if (_voicePlayer != null) _voicePlayer.DrainReplies();
            }
            catch (Exception ex)
            {
                PetLog.Warn("回复续播失败（已忽略）: " + PetLog.Describe(ex));
            }
        }
        /// <summary>
        /// 桌宠移动时让输入窗跟着走。
        ///
        /// 用户反馈"输入框不跟随移动" —— 输入窗是独立窗口，桌宠拖走了它还杵在原地。
        /// 拖动过程中桌宠每帧上报位置，这里顺带把它拉过去（只挪，不改尺寸）。
        /// </summary>
        private void FollowInputWindow()
        {
            if (_input == null) return;
            try
            {
                int x, y, w, h;
                _win.GetScreenRect(out x, out y, out w, out h);
                _input.FollowPet(x, y, w, h);
            }
            catch (Exception ex) { PetLog.Warn("输入窗跟随失败: " + PetLog.Describe(ex)); }
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
            FollowInputWindow();   // 输入窗跟着桌宠走（用户反馈过它杵在原地）
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

        /// <summary>画廊窗口（懒建，关闭后置 null）。</summary>
        private PetGallery _gallery;

        /// <summary>打开表情包画廊（右键菜单 / 托盘共用）。</summary>
        private void OpenGallery()
        {
            try
            {
                if (_gallery == null)
                {
                    _gallery = new PetGallery(_http);
                    _gallery.Pick = delegate(string file)
                    {
                        // 点一张 → 立刻用它当气泡（本地假 id，不与 Host 的 bubble.id 撞）。
                        try
                        {
                            PetBubbleInfo b = new PetBubbleInfo();
                            b.Id = -DateTime.Now.Ticks;
                            b.Kind = "image";
                            b.Image = file;
                            b.DurationMs = 4000;
                            b.Priority = 95;
                            BitmapSource img = _store.GetBubbleImage(file);
                            // 画廊里点一张动图 → 也按动图播（预览就得跟真的一样）
                            BitmapSource[] frames = null;
                            int frameMs = 0;
                            PetJson.BubbleEntry be = _store.GetBubbleEntry(file);
                            if (img != null && be != null && be.Frames > 1)
                            {
                                frames = _store.GetBubbleFrames(file, Math.Max(be.W, be.H));
                                frameMs = be.FrameMs;
                                if (frames != null && frames.Length <= 1) frames = null;
                            }
                            _bubble.Show(b, img, frames, frameMs);
                        }
                        catch (Exception ex) { PetLog.Warn("画廊选图失败: " + PetLog.Describe(ex)); }
                    };
                    _gallery.Closed2 = delegate { _gallery = null; };
                    _gallery.ApplyTheme(PetTheme.ResolveIsDark(_opt.DarkOverride, _settingsTheme));
                }
                int x, y, w, h;
                _win.GetScreenRect(out x, out y, out w, out h);
                _gallery.OpenNear(x, y, w, h);
            }
            catch (Exception ex) { PetLog.Warn("打开画廊失败: " + PetLog.Describe(ex)); }
        }
        private void OnPetContextMenu(PetWindow w, MouseButtonEventArgs e)
        {
            // 每次右键都刷一次互动动作表：菜单项由 Host 给（加互动不必重编译 exe），
            // 且好感度档位会随互动变化，右键是最自然的"看看现在怎么样"的时机。
            RefreshInteractMenu();
            if (_petMenu == null) _petMenu = BuildPetMenu();
            // 好感度与「今天」两行是动态文本，每次打开都更新。
            UpdateAffectionMenuItem();
            UpdateTodayMenuItem();
            _petMenu.PlacementTarget = w;
            _petMenu.IsOpen = true;
        }

        /// <summary>右键菜单顶部的"好感度"行（只读展示）。</summary>
        private MenuItem _miAffection;

        /// <summary>右键菜单顶部的"今天"行（v10，只读展示）。</summary>
        private MenuItem _miToday;

        /// <summary>刷新好感度那一行。没有数据时显示"未知"而不是空白。</summary>
        private void UpdateAffectionMenuItem()
        {
            if (_miAffection == null) return;
            try
            {
                PetAffectionInfo a = _affection;
                if (a == null)
                {
                    _miAffection.Header = "好感度：—";
                    return;
                }
                string tail = a.NextMin > 0
                    ? ("（下一档 " + a.NextMin + "）")
                    : "（已满级）";
                _miAffection.Header = "好感度：" + a.Points.ToString(CultureInfo.InvariantCulture) +
                                      " · " + a.Label() + tail;
            }
            catch { }
        }

        /// <summary>
        /// 刷新「今天」那一行（v10）。
        ///
        /// ⚠️ 没数据时**整项隐藏**（`Visibility.Collapsed`），不是显示"今天：—"。
        /// 理由：番茄钟没开的人右键时，一行"今天：0 个番茄"只是噪音 ——
        /// 而好感度那行必须显示（它永远有意义）。两个只读行的空数据语义不同，
        /// 这不是不一致，是**同一份数据在两种功能下的不同相关性**。
        /// </summary>
        private void UpdateTodayMenuItem()
        {
            if (_miToday == null) return;
            try
            {
                PetTodayInfo t = _today;
                // 一次都没用过番茄钟 → 整项隐藏（不看"有没有开"，看"有没有用过"：
                // 开了但一轮没跑完的人也不该看到一行 0）。
                bool useful = t != null && (t.PomodoroCount > 0 || t.StreakDays > 1 || t.Interrupts > 0);
                _miToday.Visibility = useful ? Visibility.Visible : Visibility.Collapsed;
                if (useful) _miToday.Header = t.MenuLine();
            }
            catch { }
        }

        private ContextMenu BuildPetMenu()
        {
            ContextMenu m = new ContextMenu();

            // ── v10：互动**不再由菜单承载** ──────────────────────────────────
            //
            // 用户原话："互动当前方式，通过右键就点个按钮，很奇怪，能不能加一些
            // 更有意思的"。现在主路径是**手上的动作**：
            //   单击 = 打招呼 / 长按 = 摸头 / 甩出去 = 抛掷 / 悬停 = 她看你一眼。
            //
            // 但有两个动作**没有对应的手势**：`feed`（投喂）与 `praise`（夸奖）——
            // 它们不是"碰她"，是"对她做一件事"。删掉入口等于删掉功能。
            // 所以它们收进「更多」，而不是消失。
            //
            // `pet-head`/`click`/`pat`/`fling`/`hover` 一律不进菜单：
            // 同一个动作有两个入口时，用户会以为它们不一样（已有纪律）。
            //
            // 菜单项**由 Host 给**（`GET /pet/interact`），不在这里硬编码：
            // 加一个动作只改 `src/pet/interactions.js`，exe 不用重新编译。
            MenuItem more = new MenuItem();
            more.Header = "更多(_M)";
            PetInteractMenu menu = _interactMenu;
            if (menu != null && menu.Kinds.Count > 0)
            {
                for (int i = 0; i < menu.Kinds.Count; i++)
                {
                    PetInteractKind k = menu.Kinds[i];
                    // 只放"没有手势入口"的那两个（判据在 PetHttp.MenuInteractKinds，
                    // 自检有一条断言钉住"菜单 ∪ 手势 = 全部动作"）。
                    if (!PetHttp.IsMenuInteractKind(k.Kind)) continue;
                    string kind = k.Kind;
                    MenuItem mi = new MenuItem();
                    mi.Header = k.Label;
                    mi.Click += delegate { OnInteractChosen(kind); };
                    more.Items.Add(mi);
                }
            }
            if (more.Items.Count == 0)
            {
                // 兜底：还没拉到菜单时给内置的两个（名字与 Host 侧一致）。
                // **不显示"加载中"这种空洞** —— 用户右键是要做事，不是等。
                string[] fallback = new string[] { "feed", "praise" };
                string[] labels = new string[] { "投喂", "夸奖" };
                for (int i = 0; i < fallback.Length; i++)
                {
                    string kind = fallback[i];
                    MenuItem mi = new MenuItem();
                    mi.Header = labels[i];
                    mi.Click += delegate { OnInteractChosen(kind); };
                    more.Items.Add(mi);
                }
            }
            more.Items.Add(new Separator());
            MenuItem gallery = new MenuItem();
            gallery.Header = "表情包…(_G)";
            gallery.Click += delegate { OpenGallery(); };
            more.Items.Add(gallery);
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
            more.Items.Add(preview);
            MenuItem next = new MenuItem();
            next.Header = "切换表情预览(_N)";
            next.Click += delegate { CycleEmote(); };   // task-6：与双击 emote 共用同一机制
            more.Items.Add(next);
            m.Items.Add(more);

            // ── 两个只读状态行（"看看现在怎么样"是右键最自然的用途）─────────
            _miAffection = new MenuItem();
            _miAffection.Header = "好感度：—";
            _miAffection.IsEnabled = false;   // 纯展示
            m.Items.Add(_miAffection);
            UpdateAffectionMenuItem();

            _miToday = new MenuItem();
            _miToday.Header = "今天：—";
            _miToday.IsEnabled = false;       // 纯展示
            m.Items.Add(_miToday);
            UpdateTodayMenuItem();

            m.Items.Add(new Separator());

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
                // 与托盘里那一项**走同一条回报**：右键菜单改了不回报，
                // 设置页就与本地分叉（用户看到"设置页还是旧值"）。
                ReportSettingFlags(clickThrough: _win.ClickThrough);
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
            // 定时器先停：不然退出过程中还可能触发一次 Tick（访问已释放的窗口）。
            try { if (_pomoTimer != null) _pomoTimer.Stop(); } catch { }
            try { if (_replyPumpTimer != null) _replyPumpTimer.Stop(); } catch { }
            try { if (_retryTimer != null) _retryTimer.Stop(); } catch { }
            try { if (_diagTimer != null) _diagTimer.Stop(); } catch { }
            try { if (_scalePostTimer != null) _scalePostTimer.Stop(); } catch { }
            try { if (_http != null) _http.Dispose(); } catch { }
            try { if (_tray != null) _tray.Dispose(); } catch { }
            try { if (_bubble != null) _bubble.ForceClose(); } catch { }
            // ⚠️ 状态文字窗**曾经漏在这里**：它有自己的 HwndSource 钩子，
            // 不 ForceClose 会留下一个孤儿窗口（退出后仍浮在屏幕上）。
            try { if (_status != null) _status.ForceClose(); } catch { }
            try { if (_pomo != null) _pomo.ForceClose(); } catch { }
            try { if (_voicePlayer != null) _voicePlayer.Dispose(); } catch { }
            try { if (_win != null) _win.ForceClose(); } catch { }
            try { if (_store != null) _store.Dispose(); } catch { }
        }
    }
}