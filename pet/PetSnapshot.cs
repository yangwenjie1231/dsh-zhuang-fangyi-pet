using System;
using System.Collections.Generic;
using System.Globalization;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §2 的快照 payload（Host → exe）。字段名严格按契约，未知字段忽略。
    /// rev 单调递增：客户端丢弃 rev 更旧的帧。
    /// </summary>
    internal sealed class PetBubbleInfo
    {
        public long Id;
        public string Kind = "text";     // 'image' | 'text' | 'both'
        public string Image;             // 相对 /pet/art/ 的路径；kind 含 image 时必有
        public string Text;
        /// <summary>契约 §4：不透明满幅贴纸（imageOpaque === true）。缺字段 = false（透明抠图，保持原呈现）。</summary>
        public bool Opaque;
        /// <summary>契约 §4：深色模式变体（imageDark，相对 /pet/art/ 的路径）。缺字段 = null（用原图）。</summary>
        public string ImageDark;
        public int DurationMs = 4000;
        public int Priority;
        /// <summary>契约 §2 attention（task-8）：常亮气泡（不按 durationMs 收，以 attention 块为准）。缺省 false。</summary>
        public bool Sticky;
        /// <summary>契约 §2 attention（task-8）：待处理会话数（≥2 时渲染红色计数徽标）。缺省 1。</summary>
        public int AttentionCount = 1;

        public bool WantsImage { get { return Kind == "image" || Kind == "both"; } }
        public bool WantsText { get { return Kind == "text" || Kind == "both"; } }
    }

    internal sealed class PetSessionInfo
    {
        public string SessionId;
        public string State = "idle";
        public int ToolsInFlight;
        /// <summary>契约 §2 v5：可读名字（Host 已回退：标题 → 目录名 → id 前缀）。旧快照缺省 = null。</summary>
        public string Title;
        /// <summary>契约 §2 v5：是否在跑。旧快照缺省 = false。</summary>
        public bool Running;
        /// <summary>契约 §2 v5：所属项目（工作目录名），供选择器做层级分组。</summary>
        public string Project;
    }

    /// <summary>
    /// 契约 §2（新增，additive）：snapshot.settings。
    /// **每个字段都 optional**：Has* 为 false 表示本帧没给 → exe 对该字段「不动现状」。
    /// 整个 settings 块缺失 → Settings = null → 全部不动（旧 Host 快照零回归）。
    /// </summary>
    internal sealed class PetSettingsInfo
    {
        public bool HasScale;        public double Scale;
        public bool HasOpacity;      public double Opacity;
        public bool HasClickThrough; public bool ClickThrough;
        public bool HasTopmost;      public bool Topmost;
        public bool HasBubble;       public bool Bubble;
        public bool HasDoubleClick;  public string DoubleClick;  // 'focus-dsh'(默认) | 'emote' | 'none'
        public bool HasTheme;        public string Theme;        // 'auto'(默认) | 'light' | 'dark'
        /// <summary>契约 §2 v6：悬停本体时显示状态文字。旧快照缺省 = false（不改变现状）。</summary>
        public bool HasHint;         public bool Hint;
        /// <summary>契约 §2 v6：状态文字常驻本体下方。旧快照缺省 = false。</summary>
        public bool HasStatusAlways; public bool StatusAlways;

        /// <summary>非法/缺省值一律回落 focus-dsh（task-6 验收点）。</summary>
        public static string NormalizeDoubleClick(string v)
        {
            if (v == "emote" || v == "none") return v;
            return "focus-dsh";
        }

        /// <summary>非法/缺省值一律回落 auto（= 跟随注册表）。</summary>
        public static string NormalizeTheme(string v)
        {
            if (v == "light" || v == "dark") return v;
            return "auto";
        }
    }

    /// <summary>
    /// 契约 §2（task-7，additive）：snapshot.send 能力位。
    /// 块缺失（旧 Host 快照）→ **按不可用处理**（不显示 ✎，点了会报错像坏了）。
    /// </summary>
    internal sealed class PetSendInfo
    {
        public bool Available;
        public string Reason;   // 不可用原因（可选，供日志）

        /// <summary>
        /// 纯函数：是否显示 ✎ 入口。**旧快照（sendInfo==null）= false**；
        /// available=false = false（Host 明确说不可用，别让人点了报错）。
        /// </summary>
        public static bool ShouldShowSendButton(PetSendInfo sendInfo)
        {
            return sendInfo != null && sendInfo.Available;
        }
    }

    /// <summary>
    /// 契约 §2（task-8，additive）：snapshot.attention —— 授权/提问常亮提醒。
    /// 块缺失 / 显式 null（旧 Host 或 attentionReminder:false）→ Attention=null（无提醒，零回归）。
    /// **存续判定完全以本块为准**：null → 收起气泡；exe 绝不自算超时
    /// （30 分钟兜底上限 attentionMaxMs 在 Host 状态机里，两侧口径必须一致）。
    /// </summary>
    internal sealed class PetAttentionInfo
    {
        public string Kind;         // 'approval'（等审批，优先）| 'question'（等回答）
        public string SessionId;
        public string Text;         // Host 已本地化，exe 直接显示
        public long Since;          // 待处理起始时刻（Host 计上限用）
        public int Count = 1;       // 待处理会话总数（≥2 → 红色计数徽标）

        public bool IsApproval { get { return Kind == "approval"; } }

        /// <summary>纯函数：两块 attention 是否"值相同"（Program diff 用，值没变零日志）。</summary>
        public static bool Same(PetAttentionInfo a, PetAttentionInfo b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.Kind == b.Kind && a.SessionId == b.SessionId &&
                   a.Text == b.Text && a.Since == b.Since && a.Count == b.Count;
        }
    }

    /// <summary>
    /// 契约 §2（v7，additive）：snapshot.pomodoro —— 番茄钟状态。
    ///
    /// 块缺失（旧 Host 快照）→ Pomodoro=null → exe 完全不显示倒计时（零回归）。
    ///
    /// ⚠️ **exe 绝不自算"该提醒了"**：阶段结束的判定与提醒都在 Host 里
    ///（它是唯一真相）。exe 只用 `EndsAt` 做**显示**用的本地插值 ——
    /// 每秒推一帧太重，而让两边各判一次必然分叉（DSH 重启/断线时口径就不同了）。
    /// </summary>
    internal sealed class PetPomodoroInfo
    {
        /// <summary>总开关。false → 不显示（用户没开番茄钟）。</summary>
        public bool Enabled;
        /// <summary>'focus' | 'break' | 'long-break'</summary>
        public string Phase = "focus";
        /// <summary>是否正在计时。false = 暂停/未开始（倒计时不跳）。</summary>
        public bool Running;
        /// <summary>剩余毫秒（Host 计算值；断线/暂停时的权威值）。</summary>
        public long RemainingMs;
        /// <summary>本阶段总时长（进度显示用）。</summary>
        public long TotalMs;
        /// <summary>阶段结束的绝对时刻（epoch ms，UTC）；未运行时为 0（= 无）。</summary>
        public long EndsAt;
        /// <summary>已完成的专注轮数（累计）。</summary>
        public int Completed;
        /// <summary>当前是第几轮专注（1-based）。</summary>
        public int Round = 1;
        /// <summary>每几轮一次长休。</summary>
        public int RoundsPerLongBreak = 4;
        /// <summary>Host 已格式化好的 `24:59`（**两端同一套格式化**，exe 不自己算字符串）。</summary>
        public string Text;
        /// <summary>是否显示倒计时（= enabled，但由 Host 给，语义单一）。</summary>
        public bool Show;

        /// <summary>块是否"值相同"（Program diff 用，值没变零日志）。</summary>
        public static bool Same(PetPomodoroInfo a, PetPomodoroInfo b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.Enabled == b.Enabled && a.Phase == b.Phase && a.Running == b.Running &&
                   a.RemainingMs == b.RemainingMs && a.TotalMs == b.TotalMs &&
                   a.EndsAt == b.EndsAt && a.Completed == b.Completed &&
                   a.Round == b.Round && a.RoundsPerLongBreak == b.RoundsPerLongBreak &&
                   a.Show == b.Show;
        }

        /// <summary>
        /// 本地插值出"此刻还剩多少毫秒"。
        ///
        /// ⚠️ 只在 **Running 且 EndsAt 有效** 时用 `EndsAt - now`；否则用 Host 给的
        /// `RemainingMs`。理由：
        ///   · 暂停时 `EndsAt` 为 0（Host 不给），用它会算出荒唐的负数；
        ///   · 时钟不同步时 `EndsAt` 可能偏差，但**同一台机器上**两个进程读的是
        ///     同一个系统时钟，所以插值是安全的（这也正是敢用绝对时刻的前提）。
        /// 下限夹 0：负数会让显示出现 "-00:03"。
        /// </summary>
        /// <param name="nowMs">当前 epoch 毫秒</param>
        public long RemainingAt(long nowMs)
        {
            if (!Running || EndsAt <= 0) return RemainingMs < 0 ? 0 : RemainingMs;
            long remain = EndsAt - nowMs;
            return remain < 0 ? 0 : remain;
        }
    }

    internal sealed class PetSnapshot
    {
        public long Rev = -1;
        public string PetState = "idle";
        public string Label = "";
        public long Since;
        public PetBubbleInfo Bubble;
        public PetSettingsInfo Settings;
        public PetSendInfo Send;
        public PetAttentionInfo Attention;
        /// <summary>契约 §2 v7（additive）：番茄钟块。块缺失 = null（旧 Host）。</summary>
        public PetPomodoroInfo Pomodoro;
        public List<PetSessionInfo> Sessions = new List<PetSessionInfo>();
        public bool NativeAvailable = true;
        public string NativeError;

        public static PetSnapshot Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            PetJson.JVal root = PetJson.Parse(json);
            if (root == null || !root.IsObj) return null;

            PetSnapshot s = new PetSnapshot();
            s.Rev = (long)root.Num("rev", -1);
            s.PetState = PetJson.NormalizeState(root.Str("petState", "idle"));
            s.Label = root.Str("label", "");
            s.Since = (long)root.Num("since", 0);
            s.NativeAvailable = root.Bool("nativeAvailable", true);
            s.NativeError = root.Str("nativeError", null);

            PetJson.JVal b = root.Get("bubble");
            if (b != null && b.IsObj)
            {
                PetBubbleInfo bi = new PetBubbleInfo();
                bi.Id = (long)b.Num("id", 0);
                bi.Kind = b.Str("kind", "text");
                bi.Image = b.Str("image", null);
                bi.Text = b.Str("text", null);
                // 契约 §4 新增（附加字段，向后兼容）：缺字段按 Opaque=false / ImageDark=null，
                // 旧快照（Host 旧版本）不含这两个键 → 一切照旧。
                bi.Opaque = b.Bool("imageOpaque", false);
                bi.ImageDark = b.Str("imageDark", null);
                if (string.IsNullOrEmpty(bi.ImageDark)) bi.ImageDark = null;
                bi.DurationMs = b.Int("durationMs", 4000);
                if (bi.DurationMs < 500) bi.DurationMs = 500;
                if (bi.DurationMs > 600000) bi.DurationMs = 600000;
                bi.Priority = b.Int("priority", 0);
                // 契约 §2 attention（task-8，additive）：sticky / attentionCount，缺省 false/1。
                bi.Sticky = b.Bool("sticky", false);
                bi.AttentionCount = b.Int("attentionCount", 1);
                if (bi.AttentionCount < 1) bi.AttentionCount = 1;
                if (bi.WantsImage && string.IsNullOrEmpty(bi.Image)) bi.Image = null;
                s.Bubble = bi;
            }

            // 契约 §2（task-8，additive）：attention 块。**显式 null 或块缺失 → Attention=null**
            //（旧 Host / attentionReminder:false → 无提醒，零回归）。
            PetJson.JVal at = root.Get("attention");
            if (at != null && at.IsObj)
            {
                PetAttentionInfo ai = new PetAttentionInfo();
                ai.Kind = at.Str("kind", null);
                if (ai.Kind != "approval" && ai.Kind != "question") ai.Kind = "question"; // 非法回落，不崩
                ai.SessionId = at.Str("sessionId", "");
                ai.Text = at.Str("text", null);
                ai.Since = (long)at.Num("since", 0);
                ai.Count = at.Int("count", 1);
                if (ai.Count < 1) ai.Count = 1;
                s.Attention = ai;
            }

            // 契约 §2 新增（additive）：settings 块。全部 optional，
            // 块缺失 → null → ApplySnapshot 对所有设置「不动现状」。
            PetJson.JVal st = root.Get("settings");
            if (st != null && st.IsObj)
            {
                PetSettingsInfo si = new PetSettingsInfo();
                if (st.Get("scale") != null && st.Get("scale").Kind == PetJson.JVal.TNum)
                {
                    si.Scale = st.Num("scale", 1);
                    si.HasScale = true;
                }
                if (st.Get("opacity") != null && st.Get("opacity").Kind == PetJson.JVal.TNum)
                {
                    si.Opacity = st.Num("opacity", 1);
                    si.HasOpacity = true;
                }
                if (st.Get("clickThrough") != null)
                {
                    si.ClickThrough = st.Bool("clickThrough", false);
                    si.HasClickThrough = true;
                }
                if (st.Get("topmost") != null)
                {
                    si.Topmost = st.Bool("topmost", true);
                    si.HasTopmost = true;
                }
                if (st.Get("bubble") != null)
                {
                    si.Bubble = st.Bool("bubble", true);
                    si.HasBubble = true;
                }
                if (st.Get("doubleClick") != null && st.Get("doubleClick").IsStr)
                {
                    si.HasDoubleClick = true;
                    si.DoubleClick = PetSettingsInfo.NormalizeDoubleClick(st.Str("doubleClick", null));
                }
                if (st.Get("theme") != null && st.Get("theme").IsStr)
                {
                    si.HasTheme = true;
                    si.Theme = PetSettingsInfo.NormalizeTheme(st.Str("theme", null));
                }
                // 契约 §2 v6：状态显示（布尔字段，缺省不动现状）
                if (st.Get("hint") != null && st.Get("hint").Kind == PetJson.JVal.TBool)
                {
                    si.HasHint = true;
                    si.Hint = st.Bool("hint", false);
                }
                if (st.Get("statusAlways") != null && st.Get("statusAlways").Kind == PetJson.JVal.TBool)
                {
                    si.HasStatusAlways = true;
                    si.StatusAlways = st.Bool("statusAlways", false);
                }
                s.Settings = si;
            }

            // task-7（additive）：send 能力位。块缺失 → Send 保持 null → 按不可用处理。
            PetJson.JVal send = root.Get("send");
            if (send != null && send.IsObj)
            {
                PetSendInfo pi = new PetSendInfo();
                pi.Available = send.Bool("available", false);
                pi.Reason = send.Str("reason", null);
                s.Send = pi;
            }

            // 契约 §2 v7（additive）：番茄钟块。**块缺失 → Pomodoro=null**，
            // exe 据此完全不显示倒计时（旧 Host 快照零回归）。
            PetJson.JVal pomo = root.Get("pomodoro");
            if (pomo != null && pomo.IsObj)
            {
                PetPomodoroInfo pi = new PetPomodoroInfo();
                pi.Enabled = pomo.Bool("enabled", false);
                pi.Phase = pomo.Str("phase", "focus");
                if (pi.Phase != "focus" && pi.Phase != "break" && pi.Phase != "long-break")
                {
                    pi.Phase = "focus";   // 非法回落，不崩
                }
                pi.Running = pomo.Bool("running", false);
                pi.RemainingMs = (long)pomo.Num("remainingMs", 0);
                if (pi.RemainingMs < 0) pi.RemainingMs = 0;
                pi.TotalMs = (long)pomo.Num("totalMs", 0);
                if (pi.TotalMs < 0) pi.TotalMs = 0;
                pi.EndsAt = (long)pomo.Num("endsAt", 0);
                pi.Completed = pomo.Int("completed", 0);
                if (pi.Completed < 0) pi.Completed = 0;
                pi.Round = pomo.Int("round", 1);
                if (pi.Round < 1) pi.Round = 1;
                pi.RoundsPerLongBreak = pomo.Int("roundsPerLongBreak", 4);
                if (pi.RoundsPerLongBreak < 1) pi.RoundsPerLongBreak = 4;
                pi.Text = pomo.Str("text", null);
                // `show` 缺省跟随 enabled（旧 Host 若只给 enabled 也能工作）。
                pi.Show = pomo.Get("show") != null ? pomo.Bool("show", pi.Enabled) : pi.Enabled;
                s.Pomodoro = pi;
            }

            PetJson.JVal sess = root.Get("sessions");
            if (sess != null && sess.IsArr)
            {
                for (int i = 0; i < sess.Arr.Count; i++)
                {
                    PetJson.JVal sv = sess.Arr[i];
                    if (sv == null || !sv.IsObj) continue;
                    PetSessionInfo si = new PetSessionInfo();
                    si.SessionId = sv.Str("sessionId", "");
                    si.State = PetJson.NormalizeState(sv.Str("state", "idle"));
                    si.ToolsInFlight = sv.Int("toolsInFlight", 0);
                    // v5：标题与运行位（旧 Host 没有这两个字段 → null/false，向后兼容）。
                    si.Title = sv.Str("title", null);
                    si.Running = sv.Bool("running", false);
                    si.Project = sv.Str("project", null);
                    s.Sessions.Add(si);
                }
            }
            return s;
        }

        /// <summary>
        /// 契约 §1 优先级：跨会话取最大值。Host 已给出 petState，但 exe 侧
        /// 仍按 sessions 复核一次，保证 overlay/exe 判定一致。
        /// </summary>
        public string EffectiveState()
        {
            string best = PetJson.NormalizeState(PetState);
            int bestP = PetJson.Priority(best);
            for (int i = 0; i < Sessions.Count; i++)
            {
                int p = PetJson.Priority(Sessions[i].State);
                if (p > bestP) { bestP = p; best = Sessions[i].State; }
            }
            return best;
        }
    }

    /// <summary>契约 §2 的 SSE 帧。data 必须是单行压缩 JSON。</summary>
    internal sealed class SseFrame
    {
        public string Event = "message";
        public string Data;
        /// <summary>
        /// 契约 §2：服务端建议的重连间隔（`retry: 3000` 帧）。
        /// 0 = 本帧没给，由调用方沿用上次的值/默认退避。
        /// </summary>
        public int RetryMs;

        public override string ToString()
        {
            return "event=" + Event + " data=" + (Data == null ? "(null)" : (Data.Length + "B")) +
                   (RetryMs > 0 ? (" retry=" + RetryMs) : "");
        }
    }
}