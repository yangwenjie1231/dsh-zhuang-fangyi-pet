using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §2 / §3 的客户端：
    ///   GET  /pet/events    SSE（event: hello / state，: ping 心跳，retry: 3000）
    ///   GET  /pet/state     轮询兜底
    ///   GET  /pet/atlas     素材清单
    ///   GET  /pet/art/<n>   图片字节（白名单由 Host 校验）
    ///   POST /pet/position  拖动结束上报
    ///   POST /pet/command   托盘/双击命令
    /// 全部带 Authorization: Bearer &lt;token&gt;（令牌正确一定放行）。
    /// 契约 §3 修订（令牌 **或** 同源围栏）：判定为「令牌正确 → 放行；否则同源围栏通过 → 放行；否则 403」。
    /// 连续 5 次 401/403 → 主动退出（宿主换端口/重启后不留连不上旧令牌的僵尸）。
    /// </summary>
    internal sealed class PetHttp : IDisposable
    {
        public const int AuthGiveUpAfter = 5;

        private readonly string _base;
        private readonly string _token;
        private readonly object _gate = new object();
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);

        private Thread _worker;
        private HttpWebRequest _liveRequest;
        private volatile bool _disposed;
        private int _consecutive401;

        // 观测
        private volatile bool _connected;
        private volatile string _lastError;
        private int _frames;

        public event Action<PetSnapshot> Snapshot;
        public event Action<bool> ConnectionChanged;   // true=SSE/轮询已连上
        public event Action AuthGiveUp;

        public string BaseUrl { get { return _base; } }
        public bool Connected { get { return _connected; } }
        public string LastError { get { return _lastError; } }
        public int FramesReceived { get { return _frames; } }
        public int Consecutive401 { get { return _consecutive401; } }

        public PetHttp(string baseUrl, string token)
        {
            _base = baseUrl;
            _token = token;
        }

        // ------------------------------------------------------------------
        // 生命周期
        // ------------------------------------------------------------------

        public void Start()
        {
            if (_worker != null) return;
            _worker = new Thread(Loop);
            _worker.IsBackground = true;
            _worker.Name = "pet-http";
            _worker.Start();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _stop.Set(); } catch { }
            AbortLive();
            Thread t = _worker;
            if (t != null && t.IsAlive)
            {
                try { t.Join(2500); } catch { }
            }
        }

        private void AbortLive()
        {
            HttpWebRequest r;
            lock (_gate) { r = _liveRequest; }
            if (r == null) return;
            try { r.Abort(); } catch { }
        }

        private bool Sleeping(int ms)
        {
            return _stop.WaitOne(ms);
        }

        // ------------------------------------------------------------------
        // 主循环：SSE 优先，连续失败降级轮询
        // ------------------------------------------------------------------

        private void Loop()
        {
            int backoff = 1000;
            int sseFailStreak = 0;
            int pollCount = 0;
            bool pollMode = false;

            while (!_disposed)
            {
                if (pollMode)
                {
                    // 轮询兜底：每 ~2.5s 一次；连续 5 次 401/403 也能在 ~12s 内触发退出，
                    // 而不是被 30s 的 SSE 重试间隔拖到 2 分钟以上。
                    bool ok = PollOnce();
                    if (_disposed) return;
                    if (ok) { sseFailStreak = 0; pollCount = 0; }
                    pollCount++;
                    if (pollCount % 12 == 0)
                    {
                        pollMode = false;
                        pollCount = 0;
                        PetLog.Info("http: 重试 SSE 流");
                        continue;
                    }
                    if (Sleeping(2500)) return;
                    continue;
                }

                SseResult r = RunSseOnce(backoff);
                if (_disposed) return;

                if (r == SseResult.AuthGaveUp) return;

                if (r == SseResult.Connected)
                {
                    // 正常结束（服务端关闭流）→ 立刻重连，backoff 归位
                    backoff = 1000;
                    sseFailStreak = 0;
                    SetConnected(false);
                    if (Sleeping(500)) return;
                    continue;
                }

                SetConnected(false);
                sseFailStreak++;
                if (sseFailStreak >= 3)
                {
                    PetLog.Warn("http: SSE 连续 " + sseFailStreak + " 次失败，降级为轮询 /pet/state");
                    pollMode = true;
                    continue;
                }

                PetLog.Warn("http: SSE 失败(" + sseFailStreak + ")，" + backoff + "ms 后重连: " + _lastError);
                int wait = backoff + new Random(unchecked(Environment.TickCount ^ sseFailStreak)).Next(0, 400);
                if (Sleeping(wait)) return;
                backoff = Math.Min(backoff * 2, 30000);
            }
        }

        private enum SseResult { Connected, Failed, AuthGaveUp }

        private SseResult RunSseOnce(int backoffHint)
        {
            string url = _base + "/api/zhuang-fangyi/pet/events";
            HttpWebResponse resp = null;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Accept = "text/event-stream";
                req.Timeout = 12000;
                req.ReadWriteTimeout = 45000;
                req.KeepAlive = true;
                req.Proxy = null;
                req.ServicePoint.Expect100Continue = false;
                req.Headers["Authorization"] = "Bearer " + _token;
                req.Headers["Cache-Control"] = "no-cache";

                lock (_gate) { _liveRequest = req; }

                try
                {
                    resp = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException we)
                {
                    HttpWebResponse er = we.Response as HttpWebResponse;
                    int code = er == null ? 0 : (int)er.StatusCode;
                    if (er != null) { try { er.Close(); } catch { } }
                    if (IsAuthRejected(code))
                    {
                        return HandleAuthRejected(code);
                    }
                    _lastError = DescribeWebError(we);
                    return SseResult.Failed;
                }

                _consecutive401 = 0;
                SetConnected(true);
                _lastError = null;
                PetLog.Startup("SSE 已连接: " + url);

                int retryMs = backoffHint;
                using (Stream st = resp.GetResponseStream())
                using (StreamReader rd = new StreamReader(st, new UTF8Encoding(false), true, 4096))
                {
                    SseFrame frame = new SseFrame();
                    bool sawData = false;
                    while (!_disposed)
                    {
                        string line;
                        try
                        {
                            line = rd.ReadLine();
                        }
                        catch (Exception ex)
                        {
                            _lastError = PetLog.Describe(ex);
                            return SseResult.Connected;   // 曾经连上过 → 立刻重连
                        }
                        if (line == null)
                        {
                            // 服务端关流
                            Dispatch(frame, sawData, ref retryMs);
                            _lastError = "SSE 流被服务端关闭";
                            return SseResult.Connected;
                        }

                        if (line.Length == 0)
                        {
                            Dispatch(frame, sawData, ref retryMs);
                            sawData = false;
                            frame = new SseFrame();
                            continue;
                        }
                        if (line[0] == ':') continue;   // : ping 心跳

                        int colon = line.IndexOf(':');
                        string field, value;
                        if (colon < 0) { field = line; value = ""; }
                        else
                        {
                            field = line.Substring(0, colon);
                            value = line.Substring(colon + 1);
                            if (value.StartsWith(" ", StringComparison.Ordinal)) value = value.Substring(1);
                        }

                        if (field == "event") frame.Event = value;
                        else if (field == "retry")
                        {
                            int rv;
                            if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out rv) && rv > 0)
                            {
                                retryMs = Math.Min(rv, 60000);
                                frame.RetryMs = retryMs;   // 记在帧上，便于诊断
                            }
                        }
                        else if (field == "data")
                        {
                            if (frame.Data == null) frame.Data = value;
                            else frame.Data = frame.Data + "\n" + value;
                            sawData = true;
                        }
                        // id / 其他字段：忽略
                    }
                }
                return SseResult.Connected;
            }
            catch (Exception ex)
            {
                _lastError = PetLog.Describe(ex);
                return SseResult.Failed;
            }
            finally
            {
                lock (_gate) { _liveRequest = null; }
                if (resp != null) { try { resp.Close(); } catch { } }
            }
        }

        private void Dispatch(SseFrame frame, bool sawData, ref int retryMs)
        {
            if (!sawData || string.IsNullOrEmpty(frame.Data)) return;
            PetSnapshot snap = PetSnapshot.Parse(frame.Data);
            if (snap == null)
            {
                PetLog.Warn("http: 无法解析 " + frame.Event + " 帧 (" + frame.Data.Length + "B)");
                return;
            }
            _frames++;
            Action<PetSnapshot> h = Snapshot;
            if (h != null)
            {
                try { h(snap); }
                catch (Exception ex) { PetLog.Error("快照回调异常 " + PetLog.Describe(ex)); }
            }
        }

        /// <summary>契约 §3：令牌被拒（401）或令牌+同源围栏都不过（403），都算「连不上宿主」。</summary>
        private static bool IsAuthRejected(int code)
        {
            return code == 401 || code == 403;
        }

        private SseResult HandleAuthRejected(int code)
        {
            int n = Interlocked.Increment(ref _consecutive401);
            _lastError = "HTTP " + code + (code == 401 ? "（令牌无效）" : "（令牌与同源围栏均被拒）");
            PetLog.Warn("http: " + code + " 第 " + n + "/" + AuthGiveUpAfter + " 次");
            if (n >= AuthGiveUpAfter)
            {
                PetLog.Error("http: 连续 " + AuthGiveUpAfter + " 次 " + code + " → 主动退出（契约 §5）");
                Action h = AuthGiveUp;
                if (h != null)
                {
                    try { h(); } catch { }
                }
                return SseResult.AuthGaveUp;
            }
            return SseResult.Failed;
        }

        // ------------------------------------------------------------------
        // 轮询兜底
        // ------------------------------------------------------------------

        private bool PollOnce()
        {
            try
            {
                byte[] body;
                int code = GetRaw("/api/zhuang-fangyi/pet/state", 6000, out body);
                if (IsAuthRejected(code))
                {
                    HandleAuthRejected(code);
                    return false;
                }
                if (code != 200 || body == null)
                {
                    SetConnected(false);
                    return false;
                }
                _consecutive401 = 0;
                string json = new UTF8Encoding(false).GetString(body);
                PetSnapshot snap = PetSnapshot.Parse(json);
                if (snap == null) return false;
                _frames++;
                _lastError = null;
                SetConnected(true);
                Action<PetSnapshot> h = Snapshot;
                if (h != null)
                {
                    try { h(snap); }
                    catch (Exception ex) { PetLog.Error("快照回调异常 " + PetLog.Describe(ex)); }
                }
                return true;
            }
            catch (Exception ex)
            {
                _lastError = PetLog.Describe(ex);
                SetConnected(false);
                return false;
            }
        }

        private void SetConnected(bool v)
        {
            bool changed = _connected != v;
            _connected = v;
            if (!changed) return;
            Action<bool> h = ConnectionChanged;
            if (h != null)
            {
                try { h(v); } catch { }
            }
        }

        // ------------------------------------------------------------------
        // 同步 GET / POST
        // ------------------------------------------------------------------

        /// <summary>返回 HTTP 状态码；body 为响应体（可能为 null）。异常吞掉并返回 0。</summary>
        public int GetRaw(string pathAndQuery, int timeoutMs, out byte[] body)
        {
            body = null;
            HttpWebResponse resp = null;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(_base + pathAndQuery);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;
                req.KeepAlive = false;
                req.ServicePoint.Expect100Continue = false;
                req.Headers["Authorization"] = "Bearer " + _token;
                try
                {
                    resp = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException we)
                {
                    HttpWebResponse er = we.Response as HttpWebResponse;
                    if (er != null)
                    {
                        int c = (int)er.StatusCode;
                        try { er.Close(); } catch { }
                        return c;
                    }
                    _lastError = DescribeWebError(we);
                    return 0;
                }

                int code = (int)resp.StatusCode;
                using (Stream st = resp.GetResponseStream())
                {
                    if (st != null) body = ReadAll(st, 32 * 1024 * 1024);
                }
                return code;
            }
            catch (Exception ex)
            {
                _lastError = PetLog.Describe(ex);
                return 0;
            }
            finally
            {
                if (resp != null) { try { resp.Close(); } catch { } }
            }
        }

        public string GetString(string pathAndQuery, int timeoutMs)
        {
            byte[] b;
            int code = GetRaw(pathAndQuery, timeoutMs, out b);
            if (code != 200 || b == null) return null;
            return new UTF8Encoding(false).GetString(b);
        }

        /// <summary>取一张素材的原始字节（画廊缩略图用）。失败返回 null，绝不抛。</summary>
        public byte[] GetArtBytes(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return null;
            try
            {
                byte[] b;
                int code = GetRaw("/api/zhuang-fangyi/pet/art/" + Uri.EscapeDataString(rel), 15000, out b);
                if (code != 200 || b == null || b.Length == 0) return null;
                return b;
            }
            catch { return null; }
        }

        /// <summary>
        /// 取一条语音的 mp3 字节（`GET /pet/voice/<name>`）。
        ///
        /// ⚠️ **名字必须已在 exe 侧白名单里**（见 `IsKnownVoiceName`）：这里只做
        /// 转义拼接，不做校验 —— 校验放在调用方，因为"哪些名字合法"是
        /// **从 Host 拉的清单**决定的，不是硬编码在 exe 里。
        /// 宿主侧也有白名单（两层），所以即使这里被绕过也拿不到清单外的文件。
        ///
        /// 失败返回 null 且**不抛**：没有声音不该影响桌宠其它任何功能。
        /// </summary>
        public byte[] GetVoiceBytes(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            try
            {
                byte[] b;
                int code = GetRaw("/api/zhuang-fangyi/pet/voice/" + Uri.EscapeDataString(name), 15000, out b);
                if (code != 200 || b == null || b.Length == 0) return null;
                return b;
            }
            catch { return null; }
        }

        /// <summary>
        /// 拉语音清单（`GET /pet/voices`）。失败返回 null（= 没有语音可用）。
        ///
        /// exe 用它知道"有哪些台词、多长、对应什么事件"，从而：
        ///   · 只对清单里存在的名字发请求（不猜、不硬编码）；
        ///   · 用真实时长做"上一句没播完就别播下一句"的去重。
        /// </summary>
        public PetVoiceManifest GetVoiceManifest(int timeoutMs)
        {
            string json = GetString("/api/zhuang-fangyi/pet/voices", timeoutMs);
            if (string.IsNullOrEmpty(json)) return null;
            try { return PetVoiceManifest.Parse(json); }
            catch (Exception ex)
            {
                PetLog.Warn("语音清单解析失败: " + PetLog.Describe(ex));
                return null;
            }
        }

        /// <summary>
        /// 拉表情清单（GET /pet/gallery）→ 回调（线程池线程上被调，UI 侧要自己切回来）。
        ///
        /// 失败时 items=null 且 error 给出原因 —— 画廊要能显示"为什么是空的"，
        /// 而不是给用户一个白框。
        /// </summary>
        public void GetGallery(Action<List<PetGalleryItem>, string> done)
        {
            if (done == null) return;
            if (_disposed) { done(null, "http 已释放"); return; }
            string url = _base + "/api/zhuang-fangyi/pet/gallery";
            string token = _token;
            ThreadPool.QueueUserWorkItem(delegate(object _)
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "GET";
                    req.Timeout = 15000;
                    req.ReadWriteTimeout = 15000;
                    req.Proxy = null;
                    req.KeepAlive = false;
                    req.Headers["Authorization"] = "Bearer " + token;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        int code = (int)resp.StatusCode;
                        if (IsAuthRejected(code)) Interlocked.Increment(ref _consecutive401);
                        else if (code >= 200 && code < 300) Interlocked.Exchange(ref _consecutive401, 0);
                        using (Stream st = resp.GetResponseStream())
                        {
                            string body = new UTF8Encoding(false).GetString(ReadAll(st, 4 * 1024 * 1024));
                            List<PetGalleryItem> items = PetJson.ParseGallery(body);
                            done(items, items == null ? "响应不是合法清单" : null);
                        }
                    }
                }
                catch (Exception ex)
                {
                    done(null, PetLog.Describe(ex));
                }
            });
        }


        private static byte[] ReadAll(Stream st, int cap)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                byte[] buf = new byte[16384];
                int n;
                while ((n = st.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > cap) break;
                }
                return ms.ToArray();
            }
        }

        /// <summary>POST 一个 JSON 字符串（异步，失败只记日志——桌宠不因上报失败而崩）。</summary>
        public void PostJson(string pathAndQuery, string json)
        {
            if (_disposed) return;
            string url = _base + pathAndQuery;
            string token = _token;
            ThreadPool.QueueUserWorkItem(delegate(object _)
            {
                HttpWebResponse resp = null;
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.ContentType = "application/json; charset=utf-8";
                    req.Timeout = 5000;
                    req.ReadWriteTimeout = 5000;
                    req.Proxy = null;
                    req.KeepAlive = false;
                    req.ServicePoint.Expect100Continue = false;
                    req.Headers["Authorization"] = "Bearer " + token;
                    byte[] payload = new UTF8Encoding(false).GetBytes(json == null ? "{}" : json);
                    req.ContentLength = payload.Length;
                    using (Stream rs = req.GetRequestStream()) rs.Write(payload, 0, payload.Length);
                    resp = (HttpWebResponse)req.GetResponse();
                    int code = (int)resp.StatusCode;
                    if (IsAuthRejected(code)) Interlocked.Increment(ref _consecutive401);
                    else if (code >= 200 && code < 300) Interlocked.Exchange(ref _consecutive401, 0);
                    else PetLog.Warn("http: POST " + pathAndQuery + " → " + code);
                }
                catch (WebException we)
                {
                    HttpWebResponse er = we.Response as HttpWebResponse;
                    int code = er == null ? 0 : (int)er.StatusCode;
                    if (er != null) { try { er.Close(); } catch { } }
                    if (IsAuthRejected(code)) HandleAuthRejected(code);
                    else PetLog.Info("http: POST " + pathAndQuery + " 失败: " + DescribeWebError(we));
                }
                catch (Exception ex)
                {
                    PetLog.Info("http: POST " + pathAndQuery + " 异常: " + PetLog.Describe(ex));
                }
                finally
                {
                    if (resp != null) { try { resp.Close(); } catch { } }
                }
            });
        }

        /// <summary>
        /// 契约 §3：拖动结束 POST /pet/position。
        /// 回响环修复（task-6）：body **不含 scale** —— 位置就是位置；scale 的上报走专用通道
        /// PostSettingsScale（滚轮去抖 → POST /pet/settings）。两个通道职责分开，
        /// Host 端 /position 不再回写 settings，"上报 → 广播 → 应用 → 再上报"的环才断得干净。
        /// </summary>
        public void PostPosition(int x, int y, int bubbleX, int bubbleY)
        {
            PostJson("/api/zhuang-fangyi/pet/position", BuildPositionBody(x, y, bubbleX, bubbleY));
        }

        /// <summary>构造 /pet/position body 的纯函数（SelfTest 断言其中无 scale 键）。</summary>
        public static string BuildPositionBody(int x, int y, int bubbleX, int bubbleY)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"x\":").Append(x.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"y\":").Append(y.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"bubbleX\":").Append(bubbleX.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"bubbleY\":").Append(bubbleY.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        /// <summary>契约 §3：/pet/command，command ∈ focus-dsh|reload-art|quit|hide|show。</summary>
        public void PostCommand(string command)
        {
            PostJson("/api/zhuang-fangyi/pet/command", "{\"command\":\"" + Escape(command) + "\"}");
        }

        /// <summary>
        /// task-6：滚轮缩放去抖后的上报（POST /pet/settings，body 只带 scale —— 其余字段不动）。
        /// 复用 PostJson（自带 Bearer 令牌头、异步、失败只记日志），与 POST /pet/position 同一写法。
        /// </summary>
        public void PostSettingsScale(double scale)
        {
            PostJson("/api/zhuang-fangyi/pet/settings",
                     "{\"scale\":" + scale.ToString("0.###", CultureInfo.InvariantCulture) + "}");
        }

        /// <summary>
        /// 托盘里换主题后回报宿主持久化（POST /pet/settings，body 只带 theme）。
        ///
        /// **合并语义**：宿主侧 `/pet/settings` 是合并补丁（不是整体替换），
        /// 所以只带一个字段不会抹掉其它设置（这条曾经踩过，见 Host 的注释）。
        /// theme 只可能是 auto/light/dark 三个常量，直接拼进 JSON 是安全的；
        /// 仍然过一遍白名单，避免将来误传别的值。
        /// </summary>
        /// <summary>
        /// 托盘改「显示状态」后回报宿主持久化（POST /pet/settings，只带这两个字段）。
        ///
        /// 合并语义：宿主侧 `/pet/settings` 是合并补丁，只带部分字段不会抹掉其它设置。
        /// </summary>
        public void PostSettingsStatus(bool hint, bool statusAlways)
        {
            PostJson("/api/zhuang-fangyi/pet/settings",
                     "{\"hint\":" + (hint ? "true" : "false") +
                     ",\"statusAlways\":" + (statusAlways ? "true" : "false") + "}");
        }

        public void PostSettingsTheme(string theme)
        {
            string t = theme == "light" || theme == "dark" ? theme : "auto";
            PostJson("/api/zhuang-fangyi/pet/settings", "{\"theme\":\"" + t + "\"}");
        }

        /// <summary>
        /// 契约 §3 新增：番茄钟动作（POST /pet/pomodoro）。
        ///
        /// ⚠️ **动作名必须在 exe 侧就是常量**（`start`/`pause`/...），
        /// 且**只从这里发出**。绝不把界面上的字符串直接拼进请求体 ——
        /// 那等于给了一个任意动作注入点（宿主侧也有白名单，两层都要有）。
        ///
        /// 失败只记日志（`PostJson` 的既有语义）：托盘点了"开始"但宿主不在，
        /// 不该弹错误框打断用户 —— 倒计时窗下个快照自然会显示真实状态。
        /// </summary>
        public void PostPomodoro(string action)
        {
            if (!IsKnownPomodoroAction(action)) return;
            PostJson("/api/zhuang-fangyi/pet/pomodoro", "{\"action\":\"" + action + "\"}");
        }

        /// <summary>允许的番茄钟动作（**唯一真相**，与 Host 的白名单同集合）。</summary>
        internal static readonly string[] PomodoroActions =
            new string[] { "start", "pause", "toggle", "skip", "reset" };

        /// <summary>动作名是否合法。纯函数（SelfTest 直接断言，不必起服务）。</summary>
        internal static bool IsKnownPomodoroAction(string action)
        {
            if (string.IsNullOrEmpty(action)) return false;
            for (int i = 0; i < PomodoroActions.Length; i++)
            {
                // 序号比较：动作名是 ASCII 常量，别让区域设置影响判定。
                if (string.Equals(PomodoroActions[i], action, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        /// <summary>
        /// 番茄钟**设置**（总开关 / 倒计时显示）→ POST /pet/settings。
        ///
        /// 为什么与 `PostPomodoro` 分开：那两个是**持久化设置**（要落盘、重启后还在），
        /// 而 start/pause/skip 是**瞬时动作**（不落盘，重启后不该自动接着跑）。
        /// 混在一条通道里会让"重启后番茄钟自己开始计时"这种怪事变得可能。
        ///
        /// 参数为 `null` = 本次不改该字段（合并语义，与 `/pet/settings` 一致）。
        /// </summary>
        public void PostSettingsPomodoro(bool? enabled, bool? countdown)
        {
            string body = "{";
            bool first = true;
            if (enabled.HasValue)
            {
                body += "\"pomodoro\":" + (enabled.Value ? "true" : "false");
                first = false;
            }
            if (countdown.HasValue)
            {
                if (!first) body += ",";
                body += "\"pomodoroCountdown\":" + (countdown.Value ? "true" : "false");
            }
            body += "}";
            // 两个都为 null 时 body 是 "{}"：那是空补丁，宿主侧归一化后无变化，
            // 不会误改任何设置。但发一个空请求没意义，直接跳过。
            if (body == "{}") return;
            PostJson("/api/zhuang-fangyi/pet/settings", body);
        }

        /// <summary>
        /// 语音开关（v8）→ POST /pet/settings，只带 `voice` 一个字段。
        ///
        /// 合并语义：宿主侧 `/pet/settings` 是合并补丁，只带一个字段不会抹掉其它设置。
        /// </summary>
        public void PostSettingsVoice(bool on)
        {
            PostJson("/api/zhuang-fangyi/pet/settings",
                     "{\"voice\":" + (on ? "true" : "false") + "}");
        }

        // ── v9：互动 ──────────────────────────────────────────────────────────

        /// <summary>允许的互动动作（**唯一真相**，与 Host 的 `INTERACT_KINDS` 同集合）。</summary>
        internal static readonly string[] InteractKinds =
            new string[] { "pet-head", "feed", "praise", "click" };

        /// <summary>动作名是否合法。纯函数（自检直接断言，不必起服务）。</summary>
        internal static bool IsKnownInteractKind(string kind)
        {
            if (string.IsNullOrEmpty(kind)) return false;
            for (int i = 0; i < InteractKinds.Length; i++)
            {
                if (string.Equals(InteractKinds[i], kind, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        /// <summary>
        /// 记一次互动（POST /pet/interact）。
        ///
        /// **动作名必须在 exe 侧就是常量**，且只从这里发出 —— 绝不把界面上的
        /// 字符串直接拼进请求体（宿主侧也有白名单，两层都要有）。
        /// </summary>
        public void PostInteract(string kind)
        {
            if (!IsKnownInteractKind(kind)) return;
            PostJson("/api/zhuang-fangyi/pet/interact", "{\"kind\":\"" + kind + "\"}");
        }

        /// <summary>
        /// 发一条**聊天**消息（v3：POST /pet/chat）。
        ///
        /// 与 `PostSend` 的差别：`PostSend` 发到你**指定的已有会话**，
        /// 而聊天发给**专用聊天会话**（工作区「庄方宜」，人设由 AGENTS.md 决定），
        /// 宿主会按需创建工作区与会话。
        ///
        /// 回调形状与 `PostSend` **完全一致**（`(status, body)`），
        /// 所以输入窗的失败文案映射能整段复用 —— 不为聊天再写一套错误提示。
        /// </summary>
        public void PostChat(string text, Action<int, string> done)
        {
            PostChatOrSend("/api/zhuang-fangyi/pet/chat", "{\"text\":\"" + Escape(text ?? "") + "\"}", done);
        }

        /// <summary>
        /// 两个 POST 的公共实现（发消息与聊天只差 URL 与 body）。
        ///
        /// 抽出来的理由：这段有 40 行（超时、令牌、401 计数、错误体读取），
        /// 抄两遍早晚有一处忘了同步 —— 而"忘了同步"在这类代码里的表现
        /// 就是"其中一个通道的失败原因丢了"，正是 502 那次的形态。
        /// </summary>
        private void PostChatOrSend(string path, string json, Action<int, string> done)
        {
            if (done == null) return;
            if (_disposed) { done(0, "http 已释放"); return; }
            string url = _base + path;
            string token = _token;
            ThreadPool.QueueUserWorkItem(delegate(object _)
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.Timeout = 20000;
                    req.ReadWriteTimeout = 20000;
                    req.Proxy = null;
                    req.KeepAlive = false;
                    req.ContentType = "application/json; charset=utf-8";
                    req.Headers["Authorization"] = "Bearer " + token;
                    byte[] payload = new UTF8Encoding(false).GetBytes(json);
                    req.ContentLength = payload.Length;
                    using (Stream rs = req.GetRequestStream()) rs.Write(payload, 0, payload.Length);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        int code = (int)resp.StatusCode;
                        using (Stream st = resp.GetResponseStream())
                        {
                            done(code, new UTF8Encoding(false).GetString(ReadAll(st, 256 * 1024)));
                        }
                    }
                }
                catch (WebException wex)
                {
                    // 非 2xx 会走到这里 —— 但**响应体里有宿主给的原因**，
                    // 必须读出来（502 那次就是把它丢了，界面上只剩"发送失败"）。
                    int code = 0;
                    string body = null;
                    try
                    {
                        HttpWebResponse r = wex.Response as HttpWebResponse;
                        if (r != null)
                        {
                            code = (int)r.StatusCode;
                            using (Stream st = r.GetResponseStream())
                            {
                                if (st != null) body = new UTF8Encoding(false).GetString(ReadAll(st, 256 * 1024));
                            }
                        }
                    }
                    catch { }
                    if (code == 0) code = 0;   // 网络层失败：0
                    done(code, body);
                }
                catch (Exception ex)
                {
                    done(0, PetLog.Describe(ex));
                }
            });
        }

        /// <summary>
        /// 拉互动动作表（GET /pet/interact）→ 回调（线程池线程上被调，UI 侧要自己切回来）。
        ///
        /// **菜单项由 Host 给**（不在 exe 里硬编码）：加一个互动只改
        /// `interactions.js`，exe 不用重新编译。
        /// </summary>
        public void GetInteractMenu(Action<PetInteractMenu, string> done)
        {
            if (done == null) return;
            if (_disposed) { done(null, "http 已释放"); return; }
            string url = _base + "/api/zhuang-fangyi/pet/interact";
            string token = _token;
            ThreadPool.QueueUserWorkItem(delegate(object _)
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "GET";
                    req.Timeout = 10000;
                    req.ReadWriteTimeout = 10000;
                    req.Proxy = null;
                    req.KeepAlive = false;
                    req.Headers["Authorization"] = "Bearer " + token;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        using (Stream st = resp.GetResponseStream())
                        {
                            string body = new UTF8Encoding(false).GetString(ReadAll(st, 256 * 1024));
                            PetInteractMenu m = PetInteractMenu.Parse(body);
                            done(m, m == null ? "响应不是合法菜单" : null);
                        }
                    }
                }
                catch (Exception ex)
                {
                    done(null, PetLog.Describe(ex));
                }
            });
        }

        /// <summary>
        /// 契约 §3 新增：GET /pet/settings → {"settings":{…}}。
        /// 原生 exe 目前不用它（位置走 POST /pet/position），但保留读取入口，
        /// 供将来「宿主侧持久化缩放/穿透」使用；失败一律返回 null，绝不抛。
        /// </summary>
        public PetJson.JVal GetSettings(int timeoutMs)
        {
            string json = GetString("/api/zhuang-fangyi/pet/settings", timeoutMs);
            if (string.IsNullOrEmpty(json)) return null;
            PetJson.JVal root = PetJson.Parse(json);
            if (root == null || !root.IsObj) return null;
            PetJson.JVal s = root.Get("settings");
            return (s != null && s.IsObj) ? s : root;
        }

        private static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        /// <summary>Escape 的公开包装：send body 构造与 SelfTest 共用（引号/反斜杠/&lt;32 控制符转义）。</summary>
        public static string JsonEscape(string s)
        {
            return Escape(s);
        }

        // ------------------------------------------------------------------
        // task-7：POST /pet/send（在气泡里发消息）
        // ------------------------------------------------------------------

        /// <summary>send 文本长度上限（与 Host 一致：&gt;2000 → 400 too-long）。</summary>
        public const int SendTextMax = 2000;

        /// <summary>task-7 预校验（与 Host 准入一致）：null/空白→"empty"；&gt;2000 字→"too-long"；通过→null。
        /// 纯函数，PetInput 与 SelfTest 共用。</summary>
        public static string ValidateSendText(string text)
        {
            if (text == null) return "empty";
            if (text.Trim().Length == 0) return "empty";
            if (text.Length > SendTextMax) return "too-long";
            return null;
        }

        /// <summary>构造 POST /pet/send body 的纯函数（{"text":"…"}，转义正确），SelfTest 直接断言。</summary>
        public static string BuildSendBody(string text, string sessionId)
        {
            string body = "{\"text\":\"" + Escape(text == null ? "" : text) + "\"";
            // 指定了会话就带上；没指定则交给 Host 挑最近活跃的（省略字段，不是发空串）。
            if (!string.IsNullOrEmpty(sessionId))
            {
                body += ",\"sessionId\":\"" + Escape(sessionId) + "\"";
            }
            return body + "}";
        }

        /// <summary>
        /// task-7：发送文本到当前会话（POST /pet/send，Bearer 头）。
        /// 排队语义：exe 不做任何打断（Host 固定 followup），只管把文本发出去。
        /// 与 PostJson 不同：**带结果回调**（done 在线程池线程上被调，done(status, body)，
        /// status=HTTP 状态码，网络失败=0 且 body=错误描述）——输入窗要靠它区分
        /// 成功（关窗+气泡「已发送」）/ 失败（就地报错不丢字）。done 可为 null（退化成 PostJson 语义）。
        /// </summary>
        public void PostSend(string text, string sessionId, Action<int, string> done)
        {
            if (_disposed)
            {
                if (done != null) done(0, "http 已释放");
                return;
            }
            string url = _base + "/api/zhuang-fangyi/pet/send";
            string json = BuildSendBody(text, sessionId);
            string token = _token;
            ThreadPool.QueueUserWorkItem(delegate(object _)
            {
                HttpWebResponse resp = null;
                int status = 0;
                string body = null;
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "POST";
                    req.ContentType = "application/json; charset=utf-8";
                    req.Timeout = 10000;
                    req.ReadWriteTimeout = 10000;
                    req.Proxy = null;
                    req.KeepAlive = false;
                    req.ServicePoint.Expect100Continue = false;
                    req.Headers["Authorization"] = "Bearer " + token;
                    byte[] payload = new UTF8Encoding(false).GetBytes(json);
                    req.ContentLength = payload.Length;
                    using (Stream rs = req.GetRequestStream()) rs.Write(payload, 0, payload.Length);
                    resp = (HttpWebResponse)req.GetResponse();
                    status = (int)resp.StatusCode;
                    using (Stream rs2 = resp.GetResponseStream())
                    using (StreamReader rd = new StreamReader(rs2, new UTF8Encoding(false)))
                        body = rd.ReadToEnd();
                    if (status >= 200 && status < 300) Interlocked.Exchange(ref _consecutive401, 0);
                }
                catch (WebException we)
                {
                    HttpWebResponse er = we.Response as HttpWebResponse;
                    if (er != null)
                    {
                        try
                        {
                            status = (int)er.StatusCode;
                            using (Stream rs3 = er.GetResponseStream())
                            using (StreamReader rd = new StreamReader(rs3, new UTF8Encoding(false)))
                                body = rd.ReadToEnd();
                        }
                        catch { }
                        try { er.Close(); } catch { }
                    }
                    if (status == 0) body = DescribeWebError(we);
                    if (IsAuthRejected(status)) HandleAuthRejected(status);
                }
                catch (Exception ex)
                {
                    body = PetLog.Describe(ex);
                }
                finally
                {
                    if (resp != null) { try { resp.Close(); } catch { } }
                }
                Action<int, string> d = done;
                if (d != null)
                {
                    try { d(status, body); } catch (Exception ex) { PetLog.Warn("send 回调异常: " + PetLog.Describe(ex)); }
                }
            });
        }

        public static string DescribeWebError(WebException we)
        {
            if (we == null) return "(null)";
            if (we.Status == WebExceptionStatus.ConnectFailure)
                return "无法连接宿主（宿主未启动？）";
            if (we.Status == WebExceptionStatus.Timeout)
                return "连接/读取超时";
            HttpWebResponse r = we.Response as HttpWebResponse;
            if (r != null) return "HTTP " + (int)r.StatusCode + " " + r.StatusDescription;
            return we.Status + ": " + we.Message;
        }

        /// <summary>一次性探测宿主是否在线（自检/离线判定用）。</summary>
        public bool Probe(int timeoutMs)
        {
            byte[] b;
            int code = GetRaw("/api/zhuang-fangyi/pet/state", timeoutMs, out b);
            return code == 200;
        }
    }
}