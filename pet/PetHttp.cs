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
        public void PostSettingsTheme(string theme)
        {
            string t = theme == "light" || theme == "dark" ? theme : "auto";
            PostJson("/api/zhuang-fangyi/pet/settings", "{\"theme\":\"" + t + "\"}");
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