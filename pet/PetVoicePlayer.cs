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

        /// <summary>诊断：已播放条数 / 丢弃条数（自检与日志用）。</summary>
        public int PlayedCount { get; private set; }
        public int DroppedCount { get; private set; }

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
        /// @returns 是否真的开始播放（false = 被开关/节流/占用挡下）
        /// </summary>
        public bool Play(byte[] bytes, string eventKey, int durationMs)
        {
            if (_disposed) { DroppedCount++; return false; }
            if (!Enabled) { DroppedCount++; return false; }
            if (bytes == null || bytes.Length == 0) { DroppedCount++; return false; }

            int now = Environment.TickCount;

            // ① 上一句还没播完 → 丢弃（不排队：排队会让语音滞后于事件）。
            if (IsPlaying) { DroppedCount++; return false; }

            // ② 高频道事件节流：连点十下不该叠十条。
            if (eventKey != null)
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
                    }
                    catch (Exception ex)
                    {
                        // 播放失败不该影响任何功能（也许没装音频设备）。
                        PetLog.Warn("语音播放失败: " + PetLog.Describe(ex));
                        _playingUntil = 0;
                    }
                };
                if (_ui != null && !_ui.CheckAccess()) _ui.BeginInvoke(DispatcherPriority.Normal, start);
                else start();
            }
            catch (Exception ex)
            {
                PetLog.Warn("语音派发失败: " + PetLog.Describe(ex));
                _playingUntil = 0;
                DroppedCount++;
                return false;
            }
            return true;
        }

        /// <summary>停止当前播放（退出/静音时用）。</summary>
        public void Stop()
        {
            _playingUntil = 0;
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
