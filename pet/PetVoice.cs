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

    /// <summary>
    /// 契约 §3（v9）：`GET /pet/interact` 的响应 —— 互动动作表 + 好感度。
    ///
    /// ── 为什么菜单项由 Host 给（而不是 exe 硬编码）──────────────────────────
    ///
    /// 加一个互动动作时，只改 `src/pet/interactions.js`（Host 侧），
    /// exe **不用重新编译**。而且"哪些动作合法"只有一份真相 ——
    /// 硬编码两份的话，早晚出现"菜单里能点、点了 400"这种自相矛盾的界面
    ///（发消息的会话选择器就踩过这个：列表里能选、选了却 409）。
    /// </summary>
    internal sealed class PetInteractMenu
    {
        /// <summary>可用动作（Host 给的，exe 只显示）。</summary>
        public List<PetInteractKind> Kinds = new List<PetInteractKind>();
        /// <summary>当前好感度。</summary>
        public PetAffectionInfo Affection;

        public static PetInteractMenu Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            PetJson.JVal root = PetJson.Parse(json);
            if (root == null || !root.IsObj) return null;
            // ⚠️ **必须检查 `kinds` 真的存在且是数组** —— 不能只看"root 是对象"。
            // `PetJson.Parse` 是**容错解析器**：它遇到残缺 JSON 会返回已解析到的
            // 部分（`"{ not json"` → 一个空对象），而不是 null。
            // 于是"坏 JSON"会被当成"合法但没动作的菜单"，界面上表现为
            // 一个**空的互动子菜单** —— 用户右键看到空白，不知道发生了什么。
            // 自检实测抓到这条：断言"坏 JSON → null"失败。
            PetJson.JVal arr = root.Get("kinds");
            if (arr == null || !arr.IsArr) return null;

            PetInteractMenu m = new PetInteractMenu();
            for (int i = 0; i < arr.Arr.Count; i++)
            {
                PetJson.JVal it = arr.Arr[i];
                if (it == null || !it.IsObj) continue;
                PetInteractKind k = new PetInteractKind();
                k.Kind = it.Str("kind", null);
                k.Label = it.Str("label", null);
                k.HasText = it.Bool("hasText", false);
                // 与 Host 侧白名单**同集合**（exe 侧也挡一层，跨进程信任边界）。
                if (!PetHttp.IsKnownInteractKind(k.Kind)) continue;
                if (string.IsNullOrEmpty(k.Label)) k.Label = k.Kind;
                m.Kinds.Add(k);
            }
            PetJson.JVal aff = root.Get("affection");
            if (aff != null && aff.IsObj)
            {
                m.Affection = PetAffectionInfo.Parse(aff);
            }
            return m;
        }
    }

    /// <summary>一个可用的互动动作（菜单项）。</summary>
    internal sealed class PetInteractKind
    {
        public string Kind;
        public string Label;
        /// <summary>该动作有没有气泡文案（click 没有 —— 它太频繁）。</summary>
        public bool HasText;
    }

    /// <summary>
    /// 契约 §2（v9，additive）：`snapshot.affection` —— 好感度。
    ///
    /// 块缺失（旧 Host）→ `Affection=null` → exe 不显示档位（零回归）。
    /// </summary>
    internal sealed class PetAffectionInfo
    {
        public int Points;
        /// <summary>档位 key（`stranger`/`familiar`/`close`/`trusted`）。</summary>
        public string Tier = "stranger";
        /// <summary>档位显示名（Host 已本地化，exe 直接显示）。</summary>
        public string TierLabelZh;
        /// <summary>下一档门槛；已满级为 0（= 无）。</summary>
        public int NextMin;
        /// <summary>距下一档的进度 0~1。</summary>
        public double Progress;

        public static PetAffectionInfo Parse(PetJson.JVal v)
        {
            if (v == null || !v.IsObj) return null;
            PetAffectionInfo a = new PetAffectionInfo();
            a.Points = v.Int("points", 0);
            if (a.Points < 0) a.Points = 0;
            a.Tier = v.Str("tier", "stranger");
            PetJson.JVal lbl = v.Get("tierLabel");
            if (lbl != null && lbl.IsObj) a.TierLabelZh = lbl.Str("zh", null);
            a.NextMin = v.Int("nextMin", 0);
            if (a.NextMin < 0) a.NextMin = 0;
            PetJson.JVal pr = v.Get("progress");
            a.Progress = pr == null ? 0 : v.Num("progress", 0);
            if (a.Progress < 0) a.Progress = 0;
            if (a.Progress > 1) a.Progress = 1;
            return a;
        }

        /// <summary>档位显示名（Host 没给就回落 key，绝不显示空白）。</summary>
        public string Label()
        {
            return string.IsNullOrEmpty(TierLabelZh) ? Tier : TierLabelZh;
        }

        /// <summary>是否"值相同"（diff 用，值没变零日志）。</summary>
        public static bool Same(PetAffectionInfo a, PetAffectionInfo b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.Points == b.Points && a.Tier == b.Tier && a.NextMin == b.NextMin;
        }
    }
}
