using System;
using System.Collections.Generic;
using System.IO;
using System.Windows.Media;
using System.Windows.Threading;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 桌宠语音播放（**只播不合成** —— 见下）。
    ///
    /// ── 为什么运行时绝不合成 ──────────────────────────────────────────────────
    ///
    /// 实测 GPT-SoVITS（`D:\A\voiceclone\synth.py`）冷启动 30.6 秒、热态约 5 秒/句。
    /// 桌宠要在一秒内回应一次点击 —— 运行时合成等于"按了没反应"。
    /// 所以台词是封闭集合，构建期已压成 mp3（`tools/build-voice.ps1`），
    /// 这里只做一件事：**取字节 → 播**。
    ///
    /// ── 为什么用 MediaPlayer 而不是 SoundPlayer ───────────────────────────────
    ///
    /// `SoundPlayer` 只吃 WAV（PCM），而我们的产物是 mp3（体积小一半以上：
    /// 19 条 412KB vs 未压缩 WAV 约 4MB）。`MediaPlayer` 能吃 mp3，
    /// 且 `PresentationCore` 本来就已经被引用（WPF 必需）—— **零新增依赖**。
    ///
    /// ── 三条硬约束 ────────────────────────────────────────────────────────────
    ///
    /// 1. **绝不阻塞 UI 线程**：`Open()` 要读文件、`Play()` 要起解码器，
    ///    都在 UI 线程上做会让桌宠卡顿。所以解码走线程池，只有"开始播放"
    ///    这一步回到 Dispatcher。
    /// 2. **同一时刻只播一条**：`MediaPlayer` 是一个播放器实例，
    ///    同时 `Play()` 两条会互相打断。用 `_playingUntil` 做去重：
    ///    上一条还没播完就**丢弃**新的（而不是排队）—— 排队会让语音滞后于
    ///    它描述的事件，听起来像"桌宠反应迟钝"。
    ///
    ///    ⚠️ **但"动态回复" (interrupt: true) 例外 —— 它抢占。**
    ///
    ///    这条是实测踩出来的：原先所有语音一律"忙就丢"，于是
    ///    「AI 回答的合成语音」和「固定台词（点击/状态的拟声词）」抢同一个
    ///    单槽播放器。只要回复音频到达的那一刻正好有一条固定台词在响，
    ///    回复就被**静默丢弃**；而重试只发生在"上游又来一帧"的时候 ——
    ///    桌宠一旦进入 idle 就没帧了，**这句话永远播不出来**。
    ///
    ///    实测证据（`pet.log`）：固定台词 `pet/pet-head` 先响，
    ///    470ms 后回复音频交付 → 之后 20 秒零日志、一声没出；
    ///    另一次是回复音频被拖了 **51.4 秒**才播（等到下一次状态变化）。
    ///    而 `/pet/speech/probe` 那一路还回 `played:true`（它只表示"已交付"），
    ///    所以连诊断都在骗人。
    ///
    ///    语义上也不该丢：固定台词是"嗯哼"式的点缀，回复才是用户在等的那句。
    ///    所以回复可以打断固定台词，反过来不行。
    /// 3. **绝不让播放失败影响功能**：任何异常都吞掉并记日志。没有声音
    ///    只是少了点趣味，不该让桌宠崩掉或卡住。
    ///
    /// ── 静音与节流 ────────────────────────────────────────────────────────────
    ///
    /// · `Enabled=false` → 全部不播（设置页的语音总开关）。
    /// · 高频道事件（点击）**最小间隔**：连点十下不该叠十条语音。
    /// </summary>
    internal sealed class PetVoicePlayer : IDisposable
    {
        /// <summary>高频道事件的最小间隔（ms）。低于这个间隔的重复触发被丢弃。</summary>
        public const int MinRepeatMs = 900;

        private readonly Dispatcher _ui;
        private readonly string _cacheDir;
        private MediaPlayer _player;
        private bool _disposed;

        /// <summary>语音总开关（由设置驱动）。</summary>
        public bool Enabled = true;

        /// <summary>当前播放到什么时刻（`Environment.TickCount` 口径）；0 = 空闲。</summary>
        private int _playingUntil;

        /// <summary>每个事件上次触发时刻（节流用）。</summary>
        private readonly Dictionary<string, int> _lastFired = new Dictionary<string, int>(StringComparer.Ordinal);

        /// <summary>轮换种子（同名事件多条时换着播）。</summary>
        private int _seed;

        /// <summary>诊断：已播放条数 / 丢弃条数 / 抢占条数（自检与日志用）。</summary>
        public int PlayedCount { get; private set; }
        public int DroppedCount { get; private set; }
        /// <summary>被"动态回复"抢占而中断的条数（固定台词居多）。</summary>
        public int PreemptedCount { get; private set; }
        /// <summary>因"换了一句新回复"而被打断的条数（含上一条回复的剩余分片）。</summary>
        public int InterruptedCount { get; private set; }

        /// <summary>正在播的是不是"回复分片"（决定新分片是排队还是抢占）。</summary>
        private bool _playingIsReply;

        /// <summary>待播的回复分片（同一次回复的后续段，按序播完）。</summary>
        private readonly Queue<byte[]> _replyQueue = new Queue<byte[]>();
        private readonly Queue<int> _replyDurations = new Queue<int>();
        /// <summary>当前队列属于哪一次回复（换号 = 新的一句 → 清空）。</summary>
        private long _replyUtterance = -1;

        public PetVoicePlayer(Dispatcher ui, string cacheDir)
        {
            _ui = ui;
            _cacheDir = cacheDir;
        }

        /// <summary>当前是否正在播（`_playingUntil` 未过期）。纯读，可在任意线程调。</summary>
        public bool IsPlaying
        {
            get
            {
                int until = _playingUntil;
                return until != 0 && unchecked(Environment.TickCount - until) < 0;
            }
        }

        /// <summary>自检诊断用：注入"正在播到某时刻"。</summary>
        internal void DiagSetPlayingUntil(int tick)
        {
            _playingUntil = tick;
        }

        /// <summary>自检诊断用：读节流表。</summary>
        internal int DiagLastFired(string evt)
        {
            int v;
            return _lastFired.TryGetValue(evt ?? "", out v) ? v : 0;
        }

        /// <summary>
        /// 播放一条语音（字节已经在手上）。
        ///
        /// @param bytes mp3 字节
        /// @param eventKey 触发事件（节流与轮换用；null = 不节流）
        /// @param durationMs 预期时长（清单给的实测值；≤0 时用 3 秒兜底）
        /// @param interrupt 忙时是否**抢占**（固定台词传 false，AI 回复传 true —— 见类头注释）
        /// @returns 是否真的开始播放（false = 被开关/节流/占用挡下）
        /// </summary>
        public bool Play(byte[] bytes, string eventKey, int durationMs, bool interrupt = false)
        {
            if (_disposed) { DroppedCount++; return false; }
            if (!Enabled) { DroppedCount++; return false; }
            if (bytes == null || bytes.Length == 0) { DroppedCount++; return false; }

            int now = Environment.TickCount;

            // ① 上一句还没播完。
            //
            // `interrupt=false`（固定台词）→ 丢弃：给点击/状态配的拟声词迟几秒
            //   再响毫无意义，排队只会让它滞后于事件。
            // `interrupt=true` → **抢占**（回复语音专用路径，见 `DeliverReply`）。
            if (IsPlaying)
            {
                if (!interrupt)
                {
                    DroppedCount++;
                    return false;
                }
                PreemptedCount++;
                // 让出槽位：下面的 `start` 会先 `_player.Stop()` 再播新的。
                // 这里同步清掉，否则并发的第二次 Play 会看到"还在播"。
                _playingUntil = 0;
                PetLog.Info("语音抢占：动态回复打断上一条（第 " + PreemptedCount + " 次）");
            }

            return StartCore(bytes, eventKey, durationMs, now, reply: false);
        }

        /// <summary>
        /// 交付**一段**回复语音（AI 回答的分片）。
        ///
        /// ── 为什么要"队列"而不是"每段都抢占" ─────────────────────────────────
        ///
        /// 用户问"为什么一次只能念 60 个字，别限制啊" —— 去掉总长度限制的办法是
        /// **按句分段、边合成边播**（见 `chunkForSpeech`）。于是同一句回复会
        /// 陆续到达好几段。如果每段都当"新的一句话"去抢占，第 2 段一到就把
        /// 还在播的第 1 段打断 —— 听起来就是**每句只念开头几个字**。
        ///
        /// 所以用 `utterance` 区分：
        ///   · **同一个 utterance** → 入队，等上一段播完自动续播；
        ///   · **换了 utterance**（用户又发了新消息）→ 清空队列并立刻播新的
        ///     （旧的答案已经没意义了）。
        ///
        /// 固定台词不管哪种情况都让位（回复优先）—— 那是"嗯哼"式的点缀。
        /// </summary>
        /// <param name="bytes">mp3/wav 字节</param>
        /// <param name="durationMs">预期时长（≤0 用 3 秒兜底）</param>
        /// <param name="utterance">回复编号；同一条回复的所有分片相同</param>
        public void DeliverReply(byte[] bytes, int durationMs, long utterance)
        {
            if (_disposed) { DroppedCount++; return; }
            if (!Enabled) { DroppedCount++; return; }
            if (bytes == null || bytes.Length == 0) { DroppedCount++; return; }

            // `utterance <= 0` = 上游没给这个字段（旧 Host，或"试一句"探针）——
            // 这时**当成每次都换句**，保持与从前一致（单条替换），
            // 免得把互不相干的两条当成"同一句的后续分片"排队等着。
            if (utterance <= 0 || utterance != _replyUtterance)
            {
                _replyUtterance = utterance;
                _replyQueue.Clear();
                _replyDurations.Clear();
                // 新的一句：打断正在播的（无论是上一条回复还是固定台词）。
                if (IsPlaying)
                {
                    InterruptedCount++;
                    _playingUntil = 0;
                    PetLog.Info("语音换句：清空队列并打断上一条（第 " + InterruptedCount + " 次）");
                }
            }
            _replyQueue.Enqueue(bytes);
            _replyDurations.Enqueue(durationMs);
            DrainReplies();
        }

        /// <summary>
        /// 队列非空且当前空闲 → 播下一片。
        ///
        /// ⚠️ 必须由**定时器**周期性调用（见 `Program`），不能只靠"下一帧"：
        /// 上游只在状态变化时推帧，桌宠 idle 之后就没有帧了 ——
        /// 只依赖帧会让队列永远排不出去（这正是"回复语音被拖 51 秒/
        /// 永久丢失"那个 bug 的成因）。
        /// </summary>
        public void DrainReplies()
        {
            if (_disposed || !Enabled) return;
            if (IsPlaying) return;                 // 还在播：等播完，定时器会再来
            if (_replyQueue.Count == 0) return;
            byte[] bytes = _replyQueue.Dequeue();
            int ms = _replyDurations.Dequeue();
            if (!StartCore(bytes, "speech", ms, Environment.TickCount, reply: true))
            {
                // 起播失败（落盘失败等）→ 这一片丢掉，但**不能卡住队列**：
                // 剩下的分片仍然要能播，否则整段回复只念第一句。
                DroppedCount++;
                PetLog.Warn("回复分片起播失败（已跳过，队列继续）");
            }
        }

        /// <summary>待播的回复分片数（自检/诊断用）。</summary>
        public int PendingReplies { get { return _replyQueue.Count; } }

        /// <summary>②③④ 的实际动作：节流 → 落盘 → 派发到 UI 线程起播。</summary>
        private bool StartCore(byte[] bytes, string eventKey, int durationMs, int now, bool reply)
        {
            // ② 高频道事件节流：连点十下不该叠十条。
            //    （回复分片不走节流：同一次回复的每段都是必须念的内容。）
            if (!reply && eventKey != null)
            {
                int last;
                if (_lastFired.TryGetValue(eventKey, out last) &&
                    unchecked(now - last) >= 0 && unchecked(now - last) < MinRepeatMs)
                {
                    DroppedCount++;
                    return false;
                }
                _lastFired[eventKey] = now;
            }

            // ③ 落盘到缓存目录：`MediaPlayer.Open()` 只吃 URI，
            //    不能直接喂内存字节。文件名带上序号，避免"同一文件被占用时
            //    覆盖失败"（MediaPlayer 打开后会一直持有那个文件句柄）。
            string path;
            try
            {
                path = Path.Combine(_cacheDir, "voice-" + (++_seed % 4) + ".mp3");
                Directory.CreateDirectory(_cacheDir);
                File.WriteAllBytes(path, bytes);
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音落盘失败: " + PetLog.Describe(ex));
                DroppedCount++;
                return false;
            }

            int dur = durationMs > 0 ? durationMs : 3000;
            // 预留 120ms 余量：`durationMs` 是 ffprobe 的实测值，
            // 但解码起播有延迟，不留余量会把"刚播完"误判成"还在播"。
            _playingUntil = unchecked(now + dur + 120);
            _playingIsReply = reply;

            try
            {
                Action start = delegate
                {
                    try
                    {
                        if (_disposed) return;
                        if (_player == null) _player = new MediaPlayer();
                        _player.Stop();
                        _player.Open(new Uri(path, UriKind.Absolute));
                        _player.Play();
                        PlayedCount++;
                        if (_playingIsReply)
                        {
                            PetLog.Info("回复分片起播（队列剩 " + _replyQueue.Count + "）");
                        }
                    }
                    catch (Exception ex)
                    {
                        // 播放失败不该影响任何功能（也许没装音频设备）。
                        PetLog.Warn("语音播放失败: " + PetLog.Describe(ex));
                        _playingUntil = 0;
                        _playingIsReply = false;
                    }
                };
                if (_ui != null && !_ui.CheckAccess()) _ui.BeginInvoke(DispatcherPriority.Normal, start);
                else start();
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音派发失败: " + PetLog.Describe(ex));
                _playingUntil = 0;
                _playingIsReply = false;
                DroppedCount++;
                return false;
            }
            return true;
        }

        /// <summary>停止当前播放（退出/静音时用）。</summary>
        public void Stop()
        {
            _playingUntil = 0;
            // 一并清掉"正在播的是回复分片"这个标记：否则停掉之后
            // 新来的分片会被当成"续播"而排队等着一条已经不存在的音频。
            _playingIsReply = false;
            try
            {
                if (_player != null)
                {
                    if (_ui != null && !_ui.CheckAccess())
                    {
                        _ui.BeginInvoke(DispatcherPriority.Normal, new Action(delegate
                        {
                            try { if (_player != null) _player.Stop(); } catch { }
                        }));
                    }
                    else
                    {
                        _player.Stop();
                    }
                }
            }
            catch { /* 停不下来也不该影响退出 */ }
        }

        public void Dispose()
        {
            _disposed = true;
            _playingUntil = 0;
            try
            {
                if (_player != null)
                {
                    // ⚠️ 必须在 UI 线程上 Close：MediaPlayer 是 DispatcherObject，
                    // 跨线程 Close 会抛 InvalidOperationException。
                    MediaPlayer p = _player;
                    _player = null;
                    if (_ui != null && !_ui.CheckAccess())
                    {
                        try { _ui.Invoke(DispatcherPriority.Send, new Action(delegate { try { p.Close(); } catch { } })); }
                        catch { try { p.Close(); } catch { } }
                    }
                    else
                    {
                        p.Close();
                    }
                }
            }
            catch { }
        }
    }
}
