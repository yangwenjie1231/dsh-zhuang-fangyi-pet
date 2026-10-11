/**
 * 庄方宜桌宠 · 窗口可见性自愈（v13.8）
 *
 * 用户原话：**"计算机在休眠后，又启动之后，主体和气泡消失了"**（附截图：只剩状态文字）。
 *
 * ── 现场证据（枚举该进程的顶层窗口，实测）────────────────────────────────
 *
 *     hwnd=0xF00594 visible=False rect=1155,43  103x103  'DSH 庄方宜桌宠'       ← 本体
 *     hwnd=0xDA075E visible=False rect=1079,3    72x72   'DSH 庄方宜桌宠-气泡'  ← 气泡
 *     hwnd=0x720B64 visible=True  rect=1166,150  80x17   'DSH 庄方宜桌宠-状态'  ← 状态
 *
 * 三个窗口**都存在、都在屏幕内、尺寸都正常**，只是前两个的 `WS_VISIBLE` 没了。
 * 而进程活着（pid 未变）、日志里**没有任何"隐藏"记录**、
 * `VisibilityChanged(false)` 若跑过会**连状态一起藏**（它还可见）——
 * 所以**不是我们自己的代码藏的**，是系统在休眠/唤醒期间清掉了 `WS_VISIBLE`。
 *
 * ── 为什么现有代码自愈不了 ──────────────────────────────────────────────
 *
 * 气泡与本体都有 `if (!IsVisible) Show()` 这类自愈，但：
 *
 *     WPF 的 `Window.IsVisible` 看的是**它自己记的状态**，不是 `WS_VISIBLE`。
 *
 * 系统单方面清掉 `WS_VISIBLE` 时，WPF 仍认为"我是可见的" →
 * `IsVisible == true` → **那句 `Show()` 根本不会执行**。
 * 于是窗口永远回不来，直到用户手动去托盘切一次显隐。
 *
 * 为什么**状态窗**活了下来：`PetStatusLabel.ApplyVisibility` 每次刷新都会
 * `if (!IsVisible) Show()`，而且它的刷新由**快照/悬停**驱动 —— 休眠期间快照
 * 仍在推，某一次它恰好在"系统清掉可见性之前"或"之后真的调用了 Show()"，
 * 所以它回来了。这不矛盾，只是**它的刷新时机碰巧覆盖了**。
 *
 * ── 修法：拿真实窗口状态对齐 ────────────────────────────────────────────
 *
 * 定时（复用既有的 15s 诊断 tick）检查一次：
 *   · 我们希望它可见（WPF `IsVisible == true`）而**系统说不可见** → 重新 `Show()`；
 *   · 我们希望它隐藏而系统说可见 → 不主动藏（可能是用户/系统的正常行为，保守）。
 *
 * ⚠️ 判据是 **`PetNative.IsWindowVisible(hwnd)`（系统真值）**，
 * 不是 `Window.IsVisible`（WPF 的信念）—— 这个 bug 的本质就是两者不一致。
 *
 * ⚠️ 本文件必须保持 **C# 5 兼容**。
 */
using System;
using System.Windows;

namespace DshZhuangFangyiPet
{
    /// <summary>窗口可见性自愈（休眠唤醒后 `WS_VISIBLE` 被系统清掉）。</summary>
    internal static class PetVisibilityHeal
    {
        /// <summary>
        /// 把"WPF 认为可见、但系统说不可见"的窗口重新显示出来。
        ///
        /// @param win 目标窗口（null 或未创建 hwnd 时安全返回 false）
        /// @param hwnd 该窗口的原生句柄（**必须由调用方给**：本类不认识各窗口类型）
        /// @return 是否**真的执行了修复**（true = 检测到不一致并重新 Show）
        /// </summary>
        internal static bool HealIfHidden(Window win, IntPtr hwnd)
        {
            if (win == null || hwnd == IntPtr.Zero) return false;
            bool wpfThinksVisible;
            try { wpfThinksVisible = win.IsVisible; }
            catch { return false; }
            // 我们本来就希望它藏着 → 不动（用户/系统的正常隐藏，不该抢回来）
            if (!wpfThinksVisible) return false;

            bool osSaysVisible;
            try { osSaysVisible = PetNative.IsWindowVisible(hwnd); }
            catch { return false; }
            if (osSaysVisible) return false;   // 一致，无需动作

            // ── 不一致：WPF 说可见、系统说不可见 → 重新显示 ────────────────
            //
            // ⚠️ 光调 `Show()` **不够**：WPF 认为它已经显示，`Show()` 可能
            // 只做"激活"而不再置 `WS_VISIBLE`（这正是它自愈不了的同一个原因）。
            // 所以**两条都做**：先 `Show()`（让 WPF 的状态与我们的意图一致），
            // 再直接用 `ShowWindow(SW_SHOW)` 把系统那一位补回来。
            try { win.Show(); } catch { }
            try { PetNative.ShowWindow(hwnd, PetNative.SW_SHOW); } catch { }
            return true;
        }

        /// <summary>
        /// 诊断/自检用：窗口"WPF 认为可见"与"系统说可见"是否不一致。
        ///
        /// 分开暴露是为了让自检能**分别断言两个真值**，
        /// 而不是只断言"修复函数被调过"（那样改坏它也看不出来）。
        /// </summary>
        internal static bool IsMismatched(Window win, IntPtr hwnd)
        {
            if (win == null || hwnd == IntPtr.Zero) return false;
            try
            {
                if (!win.IsVisible) return false;
                return !PetNative.IsWindowVisible(hwnd);
            }
            catch { return false; }
        }
    }
}
