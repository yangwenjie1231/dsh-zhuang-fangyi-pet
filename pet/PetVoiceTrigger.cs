using System;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 状态变化 → 该说哪句固定台词（**纯函数，无 IO**）。
    ///
    /// ── 为什么抽出来 ────────────────────────────────────────────────────────
    ///
    /// 原先这段判断直接写在 <see cref="Program"/> 的 <c>SpeakForSnapshot</c> 里，
    /// 于是"哪个状态该说什么"只能靠**通读整个方法**才能确认，而它周围还塞着
    /// attention 分支、番茄钟分支、空闲计时分支。于是漏一处的代价是：
    /// <b>台词表里有这个事件、运行时却永远不播</b>，而且**没有任何报错**
    ///（<c>Speak()</c> 找不到语音就静默返回 false）。
    ///
    /// 实测这类"闲置台词"曾经攒到 27 条（137 条里的 20%）：
    /// <c>pet/wake</c>、<c>pet/sleeping</c>、<c>chat/reply</c>、<c>pomodoro/start</c>
    /// 四个事件在台词表里躺着，代码里却一个 <c>Speak()</c> 都没有。
    /// 现在这张表既能被单测逐行钉住，也能被自检反向检查（清单里的每个事件
    /// 都必须出现在 <see cref="SpokenEvents"/> 里）。
    /// </summary>
    internal static class PetVoiceTrigger
    {
        /// <summary>
        /// exe **可能**说出口的全部事件（契约：<c>art/voice/voice.json</c> 的 <c>event</c>）。
        ///
        /// ⚠️ 这份名单是"可达性"的事实：<c>SelfTest</c> 会反向断言
        /// **清单里的每个事件都必须在此列**，多一个就红。
        /// 新增触发点时，**两处一起改**（这里 + <see cref="ForStateTransition"/> 或调用处）。
        ///
        /// ⚠️ 别加清单里没有的事件（比如 <c>agent/status</c> —— 那是状态机的
        /// 事件名，不是台词事件）；加了会被反向断言抓住。
        /// </summary>
        internal static readonly string[] SpokenEvents = new string[] {
            // 互动（Host 用 interact.voice 告知"这次互动算数了"）
            "pet/click", "pet/pet-head", "pet/feed", "pet/praise",
            // v10 手势互动（同样是 Host 用 interact.voice 告知 —— 判定在宿主，
            // exe 只负责"收到就播"。所以它们**不需要** ForStateTransition 里的分支，
            // 只需要在这里登记：SelfTest 会反向断言"清单里的事件都在这张表里"）
            "pet/pat", "pet/fling", "pet/hover",
            // 状态（PetVoiceTrigger.ForStateTransition）
            "pet/wake", "pet/sleeping", "agent/working", "agent/thinking",
            "agent/error", "turn/complete",
            // 提醒（attention）
            "attention/approval", "attention/cleared",
            // 番茄钟（阶段切换 + ForPomodoroStart）
            "pomodoro/start", "pomodoro/focus-end", "pomodoro/break-end",
            "pomodoro/long-end", "pomodoro/long-start",
            // v10：专注结束的两个极端档（零摸鱼 / 摸鱼太多）—— 见 index.js 的
            // `pomodoro/focus-end-clean` / `-busted`。它们与 `pomodoro/focus-end`
            // **三选一**，由宿主按 `interrupts` 决定，所以 exe 侧只是"能播"。
            "pomodoro/focus-end-clean", "pomodoro/focus-end-busted",
            // v10：里程碑达成（宿主通过气泡的 key `milestone/<key>` 驱动）。
            "pet/milestone",
            // 其它时机
            "chat/reply", "session/start", "pet/idle-long"
        };

        /// <summary>
        /// 状态切换 <c>(prev → next)</c> 时该说的台词事件；不该说话时返回 <c>null</c>。
        ///
        /// 规则（按优先级从高到低）：
        /// <list type="bullet">
        /// <item><description>出错 → <c>agent/error</c>（最需要被注意到）</description></item>
        /// <item><description>完成 → <c>turn/complete</c></description></item>
        /// <item><description>开始干活 → <c>agent/working</c>（只从"想"或"闲"切过来才算开始）</description></item>
        /// <item><description>开始思考 → <c>agent/thinking</c>（「让我想想……」的正确位置；
        ///   v1 把它放在**回复到达**时，时序倒置：话都说完了才说这句）</description></item>
        /// <item><description>刚醒 → <c>pet/wake</c>（亮相窗口内一次）</description></item>
        /// <item><description>睡着 → <c>pet/sleeping</c></description></item>
        /// </list>
        ///
        /// <c>idle</c> / <c>listening</c> 不出声：前者是最常见的状态（会变成复读机），
        /// 后者 2026-10-07 起已降级为纯气泡、不再作为主体状态。
        ///
        /// ⚠️ 调用方只在 <c>next != prev</c> 时调用本函数（<c>SpeakForSnapshot</c> 里
        /// 有外层判断），所以这里不必重复比较。
        /// </summary>
        /// <param name="prev">上一个显示的状态；首帧为 <c>null</c></param>
        /// <param name="next">当前显示的状态</param>
        /// <returns>清单里的事件名；不该出声时 <c>null</c></returns>
        internal static string ForStateTransition(string prev, string next)
        {
            if (string.IsNullOrEmpty(next)) return null;
            if (next == "error") return "agent/error";
            if (next == "happy" && prev != "happy") return "turn/complete";
            if (next == "working" && (prev == "thinking" || prev == "idle" || prev == null))
                return "agent/working";
            if (next == "thinking" && prev != "working") return "agent/thinking";
            // 亮相：刚出现/刚醒。prev 为 null 时（启动第一帧）也在这里响。
            if (next == "waking") return "pet/wake";
            // 睡着的那一刻。
            if (next == "sleeping" && prev != "sleeping") return "pet/sleeping";
            return null;
        }

        /// <summary>
        /// 番茄钟「未运行 → 运行中」时该说的台词（v3 之前缺这个时机）。
        ///
        /// 为什么单独一个函数：番茄钟分支里已经有四个"阶段切换"事件
        /// （focus-end / break-end / long-start / long-end），**唯独没有"开始"** ——
        /// 于是台词表里的 <c>pomodoro/start</c> 是一条永远不会被播的闲置台词。
        /// </summary>
        internal static string ForPomodoroStart(bool wasRunning)
        {
            return wasRunning ? null : "pomodoro/start";
        }
    }
}