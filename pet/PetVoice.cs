using System;
using System.Collections.Generic;
using System.Globalization;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §3：`GET /pet/voices` 的清单（Host 侧由 `src/pet/voice.js` 产出）。
    ///
    /// ── exe 为什么需要它 ──────────────────────────────────────────────────────
    ///
    /// 1. **只对清单里存在的名字发请求** —— 不硬编码、不猜。这样"台词改名"
    ///    只改构建脚本，exe 不用动。
    /// 2. **用真实时长做播放去重**：`durationMs` 由 ffprobe 实测（构建期），
    ///    exe 靠它判断"上一句还没播完" —— 写死一个猜的时长会让短句被误判成
    ///    还在播、或长句被截断。
    ///
    /// 清单缺失/坏掉一律当作"没有语音"（`Count == 0`），**绝不抛** ——
    /// 语音是可选的，没有它桌宠其它功能必须照常。
    /// </summary>
    internal sealed class PetVoiceLine
    {
        public string Name;
        public string File;
        /// <summary>触发时机，如 `pet/click`、`pomodoro/focus-end`。</summary>
        public string Event;
        /// <summary>`real`（官方配音）| `synth`（合成）。</summary>
        public string Source = "synth";
        /// <summary>实测时长（ms）。</summary>
        public int DurationMs;
        public int Bytes;
    }

    internal sealed class PetVoiceManifest
    {
        public int Version;
        public string GeneratedAt;
        public int Count;
        public List<PetVoiceLine> Lines = new List<PetVoiceLine>();

        /// <summary>name → 条目（查白名单用，O(1)）。</summary>
        private Dictionary<string, PetVoiceLine> _byName;

        /// <summary>按事件分组（同名事件多条时轮换）。</summary>
        private Dictionary<string, List<PetVoiceLine>> _byEvent;

        public static PetVoiceManifest Parse(string json)
        {
            PetVoiceManifest m = new PetVoiceManifest();
            if (string.IsNullOrEmpty(json)) return m;
            PetJson.JVal root = PetJson.Parse(json);
            if (root == null || !root.IsObj) return m;

            m.Version = root.Int("version", 0);
            m.GeneratedAt = root.Str("generatedAt", null);
            PetJson.JVal arr = root.Get("lines");
            if (arr != null && arr.IsArr)
            {
                for (int i = 0; i < arr.Arr.Count; i++)
                {
                    PetJson.JVal it = arr.Arr[i];
                    if (it == null || !it.IsObj) continue;
                    PetVoiceLine l = new PetVoiceLine();
                    l.Name = it.Str("name", null);
                    l.File = it.Str("file", null);
                    l.Event = it.Str("event", null);
                    l.Source = it.Str("source", "synth");
                    l.DurationMs = it.Int("durationMs", 0);
                    if (l.DurationMs < 0) l.DurationMs = 0;
                    l.Bytes = it.Int("bytes", 0);
                    if (l.Bytes < 0) l.Bytes = 0;
                    // 名字/文件为空或含路径分隔符 → 丢弃。
                    // ⚠️ 这是**第二层**：Host 侧已经过滤过，但清单是网络来的，
                    // 而 exe 会拿这个名字去拼 URL —— 两层都要有。
                    if (!IsSafeVoiceName(l.Name) || !IsSafeVoiceName(l.File)) continue;
                    m.Lines.Add(l);
                }
            }
            m.Count = m.Lines.Count;
            m.BuildIndex();
            return m;
        }

        private void BuildIndex()
        {
            _byName = new Dictionary<string, PetVoiceLine>(StringComparer.Ordinal);
            _byEvent = new Dictionary<string, List<PetVoiceLine>>(StringComparer.Ordinal);
            for (int i = 0; i < Lines.Count; i++)
            {
                PetVoiceLine l = Lines[i];
                if (!_byName.ContainsKey(l.Name)) _byName[l.Name] = l;
                if (l.Event == null) continue;
                List<PetVoiceLine> bucket;
                if (!_byEvent.TryGetValue(l.Event, out bucket))
                {
                    bucket = new List<PetVoiceLine>();
                    _byEvent[l.Event] = bucket;
                }
                bucket.Add(l);
            }
        }

        /// <summary>
        /// 语音名是否安全（只允许 `[A-Za-z0-9._-]`，且不许含 `..`）。
        ///
        /// 与 Host 的 `isSafeName` **同规则**（故意重复一份：exe 不能依赖 Host
        /// 的校验，那是跨进程的信任边界）。纯函数，自检直接断言。
        /// </summary>
        public static bool IsSafeVoiceName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (name.Length > 64) return false;
            if (name == "." || name == "..") return false;
            if (name.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
            char c0 = name[0];
            bool firstOk = (c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z') || (c0 >= '0' && c0 <= '9');
            if (!firstOk) return false;
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                          (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
                if (!ok) return false;
            }
            return true;
        }

        /// <summary>清单里是否有这个名字（**exe 侧白名单**）。</summary>
        public bool Has(string name)
        {
            if (_byName == null) return false;
            return name != null && _byName.ContainsKey(name);
        }

        /// <summary>取条目；不在清单里返回 null。</summary>
        public PetVoiceLine Get(string name)
        {
            if (_byName == null || name == null) return null;
            PetVoiceLine l;
            return _byName.TryGetValue(name, out l) ? l : null;
        }

        /// <summary>
        /// 按事件挑一条（同名事件多条时用 `seed` 轮换，避免每次点击都一样）。
        /// 该事件没有语音 → null。
        /// </summary>
        public PetVoiceLine PickForEvent(string evt, int seed)
        {
            if (_byEvent == null || evt == null) return null;
            List<PetVoiceLine> bucket;
            if (!_byEvent.TryGetValue(evt, out bucket) || bucket.Count == 0) return null;
            int start = seed % bucket.Count;
            if (start < 0) start += bucket.Count;
            return bucket[start];
        }

        /// <summary>诊断摘要（日志用，别每帧拼）。</summary>
        public string Describe()
        {
            return Count.ToString(CultureInfo.InvariantCulture) + " 条 / " +
                   (_byEvent == null ? 0 : _byEvent.Count).ToString(CultureInfo.InvariantCulture) + " 类事件";
        }
    }
}
