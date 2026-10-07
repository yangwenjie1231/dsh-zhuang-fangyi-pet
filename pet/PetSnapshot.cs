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
        /// <summary>契约 §2 v8：语音总开关。旧快照缺省 = false（**默认静音**）。</summary>
        public bool HasVoice;        public bool Voice;
        /// <summary>契约 §2 v7：番茄钟倒计时是否常显。旧快照缺省 = false。</summary>
        public bool HasPomodoroCountdown; public bool PomodoroCountdown;
        /// <summary>
        /// 契约 §2 v-next：状态文字**字号倍率**（1.0 = 基准）。
        /// 旧快照缺省 = 1.0（不动现状）。用户点名"字太小了，想调大"。
        /// </summary>
        public bool HasStatusFontScale; public double StatusFontScale;
        /// <summary>
        /// 契约 §2 v-next：**气泡正文**字号倍率（1.0 = 基准）。
        /// 旧快照缺省 = 1.0（不动现状）。用户点名"对话里的文字大小也要能调"。
        /// </summary>
        public bool HasChatFontScale; public double ChatFontScale;

        /**
         * ── 契约 §2 v10：三个手势开关 ────────────────────────────────────
         *
         * ⚠️ **缺省值必须与宿主 `src/settings.js` 一致**，而且**不是同一个方向**：
         *   · `longPress` / `flingEnabled` 默认 **true**（要主动做手势才触发，不是骚扰）；
         *   · `hoverReact` 默认 **false**（唯一"她主动找你"的互动，默认开就是骚扰）。
         *
         * `Has*` 标记存在的理由与其它字段相同：旧 Host 的快照里根本没有这三个键，
         * 而"缺省"与"用户显式设成 false"是**两回事** —— 没有标记的话，
         * 旧 Host 会把 `flingEnabled` 当成 false，于是**手势整个失灵**
         *（用户升级插件后甩不动她，且没有任何报错）。
         */
        public bool HasLongPress;   public bool LongPress;
        public bool HasFling;       public bool FlingEnabled;
        public bool HasHoverReact;  public bool HoverReact;
        /// <summary>契约 §2 v10：专注时显示呼吸引导。旧快照缺省 = false。</summary>
        public bool HasPomodoroBreath; public bool PomodoroBreath;

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

        /**
         * ── 三个手势开关的**缺省值**（v10，唯一真相）──────────────────────
         *
         * ⚠️ 为什么要有这几个函数，而不是直接在 `Bool(key, true)` 里写常量：
         *
         * 回滚验证抓到了我的一个**假断言** —— 我断言"把 hoverReact 的缺省值
         * 写成 true 会让自检变红"，结果把它改坏之后**自检仍然全绿**。
         * 原因是那段代码长这样：
         *
         *     if (st.Get("hoverReact") != null && Kind == TBool) { Bool("hoverReact", X) }
         *
         * —— `X` **永远用不到**（进到那一支时键一定存在、且一定是布尔）。
         * 也就是说：**缺省值其实活在 `Program` 的字段初始化里**
         *（`_hoverReactOn = false`），快照解析里的那个常量是**死代码**。
         * 同一个语义写了两份，其中一份还不可达 —— 这正是本项目反复踩的
         * "两个真相"。
         *
         * 所以：缺省值收进这里，解析与 `Program` 的字段初始化**都读它**。
         * 这样自检能直接断言它们，回滚验证才真的有意义。
         */
        public static bool DefaultLongPress() { return true; }
        public static bool DefaultFlingEnabled() { return true; }
        public static bool DefaultHoverReact() { return false; }
        public static bool DefaultPomodoroBreath() { return false; }
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

    /// <summary>
    /// 契约 §2（v10，additive）：snapshot.today —— 今日番茄统计。
    ///
    /// 用途：右键菜单顶部的"今天"一行（exe 只**显示**，绝不自算 ——
    /// 与番茄钟同一条纪律）。块缺失（旧 Host）→ `Today=null` → 菜单不显示那一行。
    /// </summary>
    internal sealed class PetTodayInfo
    {
        /// <summary>今日完成的番茄数。</summary>
        public int PomodoroCount;
        /// <summary>今日专注总时长（ms）。</summary>
        public long FocusMs;
        /// <summary>今日被打断（摸鱼）次数。</summary>
        public int Interrupts;
        /// <summary>连续专注天数（**今天还没开始不算断签**，Host 判定）。</summary>
        public int StreakDays;
        /// <summary>今日目标个数（0 = 没设目标）。</summary>
        public int GoalCount;

        /// <summary>值是否相同（Program diff 用，值没变零日志）。</summary>
        public static bool Same(PetTodayInfo a, PetTodayInfo b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            return a.PomodoroCount == b.PomodoroCount && a.FocusMs == b.FocusMs &&
                   a.Interrupts == b.Interrupts && a.StreakDays == b.StreakDays &&
                   a.GoalCount == b.GoalCount;
        }

        /// <summary>
        /// 菜单里那一行的文本（**纯函数**，自检直接断言）。
        ///
        /// 为什么格式化放在 exe 而不是 Host：它要跟着 `goalCount` 变（进度），
        /// 而 Host 每帧给的是**数字**。若让 Host 拼字符串，同一个数字就有
        /// "快照里的数字"与"快照里的字符串"两份真相 —— 改一处忘一处时，
        /// 菜单显示 3/8、面板显示 2/8，谁也说不清哪个对。
        ///
        /// 时长按"小时+分钟"给：`25 分` / `1 小时 5 分`。只说分钟的话，
        /// 专注 3 小时会显示 `180 分` —— 读不出量级。
        /// </summary>
        public string MenuLine()
        {
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            sb.Append("今天：");
            if (GoalCount > 0) sb.Append(PomodoroCount).Append('/').Append(GoalCount).Append(" 个番茄");
            else sb.Append(PomodoroCount).Append(" 个番茄");
            if (FocusMs > 0) sb.Append(" · ").Append(FormatDuration(FocusMs));
            if (Interrupts > 0) sb.Append(" · 摸鱼 ").Append(Interrupts).Append(" 次");
            if (StreakDays > 1) sb.Append(" · 连续 ").Append(StreakDays).Append(" 天");
            return sb.ToString();
        }

        /// <summary>把毫秒格式化成 `25 分` / `1 小时 5 分` / `2 小时`。纯函数。</summary>
        internal static string FormatDuration(long ms)
        {
            if (ms <= 0) return "0 分";
            long totalMin = ms / 60000;
            // 不足一分钟但确实有专注 → 显示"1 分"而不是"0 分"：
            // 显示 0 分而番茄数 +1，用户会以为统计坏了。
            if (totalMin <= 0) return "1 分";
            long h = totalMin / 60;
            long m = totalMin % 60;
            if (h <= 0) return m + " 分";
            if (m <= 0) return h + " 小时";
            return h + " 小时 " + m + " 分";
        }
    }

    /// <summary>
    /// 契约 §2（v9，additive）：snapshot.chat —— 聊天能力位。
    ///
    /// 块缺失（旧 Host）→ `Chat=null` → 输入窗只显示"指定对话"（零回归）。
    /// </summary>
    internal sealed class PetChatInfo
    {
        /// <summary>能不能聊（宿主装配了 sessionController **且**用户没关）。</summary>
        public bool Available;
        /// <summary>用户设置里的开关（与 Available 分开：一个"宿主不行"、一个"用户不要"）。</summary>
        public bool Enabled;
        public string Reason;
        /// <summary>当前人设名（提示语里可以显示）。</summary>
        public string Persona;

        /// <summary>纯函数：输入窗该不该显示"聊天"选项。</summary>
        public static bool ShouldShowChat(PetChatInfo chat)
        {
            return chat != null && chat.Available;
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
        /// <summary>契约 §2 v9（additive）：好感度块。块缺失 = null（旧 Host）。</summary>
        public PetAffectionInfo Affection;
        /// <summary>契约 §2 v9（additive）：聊天能力位。块缺失 = null（按不可用处理）。</summary>
        public PetChatInfo Chat;
        /// <summary>契约 §2 v10（additive）：今日番茄统计。块缺失 = null（菜单不显示那一行）。</summary>
        public PetTodayInfo Today;
        /// <summary>
        /// 契约 §2 v9（additive）：最近一次互动（一次性信号）。
        ///
        /// exe 靠 `seq` 判"这是新的一次"从而**恰好播一次**语音。
        /// 用递增序号而不是时间戳：同一毫秒两次互动时间戳相同，会漏掉第二次。
        /// </summary>
        public long InteractSeq;
        public string InteractKind;
        public string InteractVoice;
        /// <summary>
        /// 动态语音（AI 回答的合成音频）：`seq` 递增，exe 据此**恰好播一次**。
        ///
        /// `name` 是缓存键，去 `/pet/speech/<name>` 取 WAV 字节。
        /// 与 `interact` 同一模式（seq 去重而不是时间戳 —— 同一毫秒两句话不会漏）。
        /// 没开动态语音 / 还没合成好时为 null → exe 保持沉默，退回固定台词。
        /// </summary>
        public long SpeakSeq;
        public string SpeakName;
        public long SpeakDurationMs;
        /// <summary>
        /// 回复编号：**同一条回复的所有分片相同**，换一句就变。
        ///
        /// exe 靠它区分"这是同一句的下一段（排队续播）"与"这是新的一句
        ///（清空队列、立刻播）"。没有它，分段播会退化成每段互相抢占 ——
        /// 听起来就是每句只念开头几个字。
        ///
        /// 旧 Host 没这个字段 → 恒为 0 → 所有分片都被当成同一句排队，
        /// 但旧 Host 每条回复只发一个分片，所以行为与从前一致。
        /// </summary>
        public long SpeakUtterance;

        /// <summary>
        /// **动态语音没兜住时的固定台词提示**（契约 §2 `speak.fallback`）。
        ///
        /// Host 只在"确实想说话、但运行时合成不可用"时填它：TTS 子插件没装、
        /// 超时、或合成失败。于是「聊天回复到达」这个时刻即使没有音频，
        /// exe 也会说一句固定台词（`chat/reply`）—— 否则那个时刻**完全无声**。
        ///
        /// 为什么需要它：`art/voice/voice.json` 里 `chat/reply` 有 12 条台词，
        /// 而 exe 此前**没有任何地方** `Speak("chat/reply")` —— 也就是说
        /// TTS 一关，这 12 条就是死资源（"闲置台词"，见
        /// <see cref="PetVoiceTrigger"/> 的说明）。
        ///
        /// 去重按 `FallbackSeq`：每次需要兜底就递增；exe 见到新值才播一次。
        /// 旧 Host 没这个字段 → 恒为 0 → 保持沉默（与从前一致）。
        /// </summary>
        public long FallbackSeq;
        public string FallbackEvent;

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
                // 契约 §2 v8：语音开关（缺省不动现状 = 保持启动时的值，默认静音）
                if (st.Get("voice") != null && st.Get("voice").Kind == PetJson.JVal.TBool)
                {
                    si.HasVoice = true;
                    si.Voice = st.Bool("voice", false);
                }
                // 契约 §2 v7：番茄钟倒计时常显
                if (st.Get("pomodoroCountdown") != null && st.Get("pomodoroCountdown").Kind == PetJson.JVal.TBool)
                {
                    si.HasPomodoroCountdown = true;
                    si.PomodoroCountdown = st.Bool("pomodoroCountdown", true);
                }
                // 契约 §2 v-next：状态文字字号倍率（缺省 1.0 = 不动现状）
                if (st.Get("statusFontScale") != null && st.Get("statusFontScale").Kind == PetJson.JVal.TNum)
                {
                    double fs = st.Num("statusFontScale", 1.0);
                    if (fs < 0.5) fs = 0.5;
                    if (fs > 3.0) fs = 3.0;
                    si.HasStatusFontScale = true;
                    si.StatusFontScale = fs;
                }
                // 契约 §2 v-next：**气泡正文**字号倍率（同范围 0.5~3.0）
                if (st.Get("chatFontScale") != null && st.Get("chatFontScale").Kind == PetJson.JVal.TNum)
                {
                    double cfs = st.Num("chatFontScale", 1.0);
                    if (cfs < 0.5) cfs = 0.5;
                    if (cfs > 3.0) cfs = 3.0;
                    si.HasChatFontScale = true;
                    si.ChatFontScale = cfs;
                }
                // ── 契约 §2 v10：三个手势开关 + 呼吸引导 ──────────────────
                //
                // ⚠️ 三个 `Bool(key, 缺省)` 的缺省值**刻意不同**（见字段注释）：
                // 前两个缺省 true、hoverReact 缺省 false。但真正的守卫是
                // `Has*` 标记 —— 旧 Host 的帧里**根本没有这些键**，
                // 而"没有键"必须解释成"不动现状"，不是"用户设成了 false"。
                if (st.Get("longPress") != null && st.Get("longPress").Kind == PetJson.JVal.TBool)
                {
                    si.HasLongPress = true;
                    si.LongPress = st.Bool("longPress", PetSettingsInfo.DefaultLongPress());
                }
                if (st.Get("flingEnabled") != null && st.Get("flingEnabled").Kind == PetJson.JVal.TBool)
                {
                    si.HasFling = true;
                    si.FlingEnabled = st.Bool("flingEnabled", PetSettingsInfo.DefaultFlingEnabled());
                }
                if (st.Get("hoverReact") != null && st.Get("hoverReact").Kind == PetJson.JVal.TBool)
                {
                    si.HasHoverReact = true;
                    si.HoverReact = st.Bool("hoverReact", PetSettingsInfo.DefaultHoverReact());
                }
                if (st.Get("pomodoroBreath") != null && st.Get("pomodoroBreath").Kind == PetJson.JVal.TBool)
                {
                    si.HasPomodoroBreath = true;
                    si.PomodoroBreath = st.Bool("pomodoroBreath", PetSettingsInfo.DefaultPomodoroBreath());
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

            // 契约 §2 v9（additive）：聊天能力位。**块缺失 → null → 按不可用处理**
            //（旧 Host 没有这个功能，输入窗就不显示"聊天"选项）。
            PetJson.JVal chatv = root.Get("chat");
            if (chatv != null && chatv.IsObj)
            {
                PetChatInfo ci = new PetChatInfo();
                ci.Available = chatv.Bool("available", false);
                ci.Enabled = chatv.Bool("enabled", false);
                ci.Reason = chatv.Str("reason", null);
                ci.Persona = chatv.Str("persona", null);
                s.Chat = ci;
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

            // 契约 §2 v10（additive）：今日番茄统计。块缺失 → Today=null。
            //
            // ⚠️ 每个数字都夹到非负：`Math.Max(0, …)`。坏值（负数/NaN）若透传，
            // 菜单会显示"今天：-3 个番茄"，而那是**统计坏了**的信号 ——
            // 与其显示一个荒唐的数字，不如显示 0（至少不误导）。
            PetJson.JVal today = root.Get("today");
            if (today != null && today.IsObj)
            {
                PetTodayInfo ti = new PetTodayInfo();
                ti.PomodoroCount = Math.Max(0, today.Int("pomodoroCount", 0));
                ti.FocusMs = Math.Max(0, (long)today.Num("focusMs", 0));
                ti.Interrupts = Math.Max(0, today.Int("interrupts", 0));
                ti.StreakDays = Math.Max(0, today.Int("streakDays", 0));
                ti.GoalCount = Math.Max(0, today.Int("goalCount", 0));
                s.Today = ti;
            }

            // 契约 §2 v9（additive）：好感度 + 最近一次互动。
            PetJson.JVal aff = root.Get("affection");
            if (aff != null && aff.IsObj)
            {
                s.Affection = PetAffectionInfo.Parse(aff);
            }
            PetJson.JVal act = root.Get("interact");
            if (act != null && act.IsObj)
            {
                s.InteractSeq = (long)act.Num("seq", 0);
                s.InteractKind = act.Str("kind", null);
                s.InteractVoice = act.Str("voice", null);
            }

            // 动态语音（AI 回答的合成音频）。旧 Host 没这个块 → 全 0，
            // exe 不发请求也不出声（与"没开动态语音"行为一致）。
            PetJson.JVal spk = root.Get("speak");
            if (spk != null && spk.IsObj)
            {
                s.SpeakSeq = (long)spk.Num("seq", 0);
                s.SpeakName = spk.Str("name", null);
                s.SpeakDurationMs = (long)spk.Num("durationMs", 0);
                s.SpeakUtterance = (long)spk.Num("utterance", 0);
                // `fallback` 是**可选**子块：Host 只在"想说话但合成没兜住"时才给。
                PetJson.JVal fb = spk.Get("fallback");
                if (fb != null && fb.IsObj)
                {
                    s.FallbackSeq = (long)fb.Num("seq", 0);
                    s.FallbackEvent = fb.Str("event", null);
                }
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