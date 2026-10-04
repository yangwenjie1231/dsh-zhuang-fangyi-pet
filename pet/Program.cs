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
            TrySetUtf8Console();

            string err;
            PetOptions opt = PetOptions.Parse(args, out err);
            if (opt == null)
            {
                Console.Error.WriteLine("参数错误: " + err);
                Console.Error.WriteLine(PetOptions.Usage());
                return ExitBadArgs;
            }

            string baseDir = AppDataDir();
            PetLog.Init(Path.Combine(baseDir, "pet.log"), opt.Verbose);

            if (opt.Help)
            {
                Console.Out.WriteLine(PetOptions.Usage());
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
        private Dispatcher _ui;

        private long _lastRev = -1;
        private long _lastBubbleId = -1;
        private bool _bubbleOn;
        private bool _previewMode;
        private int _previewIndex;
        private bool _quitting;
        private DateTime _started;
        private int _stateChanges;

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

            _bubble = new PetBubble();
            _bubble.PetRectProvider = PetRect;
            _bubble.HideNow();

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
                if (snap.Bubble.WantsImage && !string.IsNullOrEmpty(snap.Bubble.Image))
                {
                    try { img = _store.GetBubbleImage(snap.Bubble.Image); }
                    catch (Exception ex) { PetLog.Warn("气泡图加载失败: " + PetLog.Describe(ex)); }
                    if (img == null)
                    {
                        string alt = _store.RandomBubbleFile();
                        if (alt != null) img = _store.GetBubbleImage(alt);
                    }
                }
                try { _bubble.Show(snap.Bubble, img); }
                catch (Exception ex) { PetLog.Warn("气泡显示失败: " + PetLog.Describe(ex)); }
            }
        }

        private void OnConnectionChanged(bool connected)
        {
            PetLog.Info(connected ? "与宿主已连接" : "与宿主断开");
        }

        private void OnAuthGiveUp()
        {
            // 契约 §5：连续 5 次 401 → 主动退出（宿主重启后不留连不上旧令牌的僵尸）
            Dispatcher d = _ui;
            if (d != null)
            {
                d.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                {
                    PetLog.Error("令牌失效（连续 401），桌宠退出");
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
                 " 401=" + _http.Consecutive401 + " last=" + (_http.LastError == null ? "-" : _http.LastError));
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

        private void OnPositionReported(int x, int y, double scale)
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
            // 契约 §3：拖动结束 POST /pet/position
            _http.PostPosition(x, y, scale, bx, by);
            PetLog.Info("上报位置 x=" + x + " y=" + y + " scale=" + scale.ToString("0.###", CultureInfo.InvariantCulture));
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
            next.Click += delegate
            {
                _previewMode = true;
                _previewIndex = (_previewIndex + 1) % PreviewStates.Length;
                _win.SetState(PreviewStates[_previewIndex]);
            };
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