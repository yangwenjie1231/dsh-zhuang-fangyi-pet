/**
 * 庄方宜桌宠 · 手势调试日志（"面包屑"）
 *
 * 用户原话：**"手势的目前触发判定还是很奇怪。能不能加入类似可选的开关，
 * 就是比如说开启调试模式，用面包屑记录更详细的日志"**。
 *
 * ── 为什么需要它（这已经是第四次调手势了）────────────────────────────────
 *
 * 前三次修手势（v12 死区、v13 容差随增益、v13 可恢复的 `_holdStill`）
 * 都是**靠读代码猜**：手边只有"成功的手势"留下的日志，
 * 而用户真正遇到的是"**按了没反应**" —— 那种情况下日志里**什么都没有**。
 * 拿"没有日志"去推原因，只能猜。
 *
 * 这个模块解决的就是那件事：把**每一次按下/移动/松手**都记下来，
 * 包括**被吞掉的那些**（点在透明像素上、右键菜单期间、抛掷动画期间……），
 * 并明确写出"**为什么没触发**"。
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────
 *
 * 1. **默认关闭**。面包屑是**高频**的（每次鼠标移动都可能记一行），
 *    常态开着会把日志淹掉、也会拖慢交互。所以它是一个用户可见的开关
 *    （设置页 + 右键菜单都能开），而不是一个恒开的调试输出。
 *
 * 2. **环形缓冲**（`_ring`）。开开关之前发生的事也要能看到：
 *    用户的开法是"我按了几下没反应 → 去打开调试 → 再按几下"，
 *    此时**之前那几下**正是最有价值的证据。所以无论如何都往环形缓冲里写，
 *    只是在关闭时**不落盘**；一旦打开，连缓冲里的历史一起倒出来。
 *
 * 3. **单行、可 grep**。每条面包屑一行、固定前缀 `[手势]`，
 *    字段用 `k=v` 排列，方便直接 `Select-String '\[手势\]'` 捞出来看。
 *
 * 4. **纯逻辑，无 IO**。落盘由 `PetLog` 负责，这样自检能直接驱动它
 *    （本项目对"可测"的一贯要求：判定必须能被断言，不能只长在事件处理器里）。
 *
 * ⚠️ 本文件必须保持 **C# 5 兼容**：不用字符串插值、`?.`、表达式体成员、`out var`。
 */
using System;
using System.Collections.Generic;
using System.Text;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 手势面包屑记录器。
    ///
    /// 用法：`PetBreadcrumb.Trace(...)` 记一条；`PetBreadcrumb.Enabled = true` 才开始落盘。
    /// 关闭期间仍然写环形缓冲（见文件头第 2 点）。
    /// </summary>
    internal static class PetBreadcrumb
    {
        /// <summary>日志行前缀（grep 用，**不要改**：文档与排障步骤都按它写）。</summary>
        internal const string Prefix = "[手势]";

        /// <summary>环形缓冲容量。约 200 条够覆盖"用户发现问题→去开开关"这段。</summary>
        internal const int RingCapacity = 200;

        /// <summary>
        /// 开关。默认 **false**（见文件头第 1 点：面包屑是高频的）。
        /// 由 `settings.debugGestures` 驱动（设置页 / 右键菜单都能改）。
        /// </summary>
        private static bool _enabled;

        /// <summary>落盘回调。默认什么都不做 —— 由 `PetLog` 在启动时接上。</summary>
        private static Action<string> _sink = delegate { };

        /// <summary>环形缓冲（关闭期间也写，开启时倒出来）。</summary>
        private static readonly string[] _ring = new string[RingCapacity];
        private static int _ringCount;     // 已写入的总条数（用于算下标）
        private static int _dropped;       // 因缓冲满而丢弃的条数（要告诉用户，不能假装没发生）

        /// <summary>落盘总条数（诊断/自检用）。</summary>
        private static int _written;

        /// <summary>缓冲被覆盖掉的条数（诊断/自检用）。</summary>
        internal static int DiagDropped { get { return _dropped; } }
        /// <summary>已落盘条数（诊断/自检用）。</summary>
        internal static int DiagWritten { get { return _written; } }
        /// <summary>当前开关（诊断/自检用）。</summary>
        internal static bool DiagEnabled { get { return _enabled; } }

        /// <summary>接上落盘通道（`PetLog.Info`）。</summary>
        internal static void SetSink(Action<string> sink)
        {
            _sink = sink == null ? (Action<string>)delegate { } : sink;
        }

        /// <summary>
        /// 开/关调试模式。
        ///
        /// ⚠️ 打开时会把**环形缓冲里的历史**先倒出来（文件头第 2 点）——
        /// 那正是"按了几下没反应之后才去开开关"这个真实流程里最有用的部分。
        /// </summary>
        internal static void SetEnabled(bool on)
        {
            if (on == _enabled) return;
            _enabled = on;
            if (!on)
            {
                Flush("[手势] 调试模式关闭（此后不再记录面包屑）");
                return;
            }
            // 先把"开之前"的历史倒出来，再报一句自己
            Flush("[手势] 调试模式开启 —— 下面是**开启之前**最后 " +
                  Math.Min(_ringCount, RingCapacity) + " 条面包屑（按时间先后）");
            int n = Math.Min(_ringCount, RingCapacity);
            int start = _ringCount - n;
            for (int i = 0; i < n; i++)
            {
                int idx = ((start + i) % RingCapacity + RingCapacity) % RingCapacity;
                string line = _ring[idx];
                if (line == null) continue;
                _written++;
                try { _sink(line); } catch { }
            }
            if (_dropped > 0)
            {
                Flush("[手势] 注意：缓冲曾溢出，更早的 " + _dropped + " 条已丢失");
            }
        }

        /// <summary>
        /// 记一条面包屑。
        ///
        /// ⚠️ **无论开关是否打开都会写环形缓冲**（只是不落盘）——
        /// 这是"开开关之前那几下也能看到"的前提。不要为了省一点内存
        /// 改成 `if (!_enabled) return;`，那会让这个功能失去最主要的用途。
        /// </summary>
        internal static void Trace(string msg)
        {
            if (msg == null) return;
            string line = Prefix + " " + msg;
            int slot = _ringCount % RingCapacity;
            if (_ringCount >= RingCapacity && _ring[slot] != null) _dropped++;
            _ring[slot] = line;
            _ringCount++;
            if (_enabled) Flush(line);
        }

        private static void Flush(string line)
        {
            _written++;
            try { _sink(line); } catch { }
        }

        /// <summary>
        /// 判定结果的**一句话解释**：为什么这次按下没有变成某个手势。
        ///
        /// 这是整个模块的**核心价值** —— 用户要的不是"一串数字"，
        /// 而是"我按了，为什么没反应"。
        ///
        /// ⚠️⚠️ **解释必须由 `Classify` 的结果推出来，不能自己重排一遍判据顺序。**
        ///
        /// 我第一版就是自己重写的顺序，结果自检当场抓到它**自相矛盾**：
        /// 对 `(dx=30, dy=20, ms=800, v=5000)` 它说"按拖动处理"，
        /// 而 `Classify` 在同一组输入上返回的是 **Fling** ——
        /// 因为我的分支里"时长落在摸头窗口但位移超了"排在抛掷之前就 return 了。
        ///
        /// 一份**与判定不一致的解释**比没有解释更糟：它会把人引到错的方向。
        /// 所以这里先调 `Classify` 拿到 kind，再**只解释那个 kind** ——
        /// 结构上就不可能矛盾。
        ///
        /// 纯函数（自检直接断言），不读任何窗口状态。
        /// </summary>
        /// <param name="dx">按下到松手的位移（物理像素）</param>
        /// <param name="dy">同上（纵向）</param>
        /// <param name="elapsedMs">按下到松手的时长</param>
        /// <param name="speed">松手前窗口内的速度（px/s）</param>
        /// <param name="tol">本次判定用的容差</param>
        /// <param name="movedSincePress">按下期间是否曾越出容差</param>
        /// <param name="holdStill">松手瞬间是否仍在容差内</param>
        /// <param name="patReported">本次按下已上报的摸头级数</param>
        /// <param name="longPressOn">摸头开关</param>
        /// <param name="flingOn">抛掷开关</param>
        internal static string Explain(double dx, double dy, int elapsedMs, double speed,
                                       GestureTolerance tol, bool movedSincePress, bool holdStill,
                                       int patReported, bool longPressOn, bool flingOn)
        {
            if (tol == null) tol = GestureTolerance.Default();

            // 与产品**同一条判定**（唯一真相）。解释从它推出来。
            PetGestureKind kind = PetGesture.Classify(dx, dy, elapsedMs, speed, tol);

            double dist = Math.Sqrt(dx * dx + dy * dy);
            bool bad = double.IsNaN(dist) || double.IsInfinity(dist);

            StringBuilder sb = new StringBuilder();

            if (kind == PetGestureKind.Click)
            {
                if (bad)
                {
                    // Classify 在坏数据上给 Drag，走不到这里；保底不撒谎。
                    sb.Append("命中**单击**");
                }
                else if (elapsedMs > PetGesture.ClickMaxMs)
                {
                    sb.Append("落在 " + PetGesture.ClickMaxMs + "~" + PetGesture.PatMinMs +
                              "ms 空档 → 按**单击**兜底（位移 " + Fmt(dist) +
                              "px ≤ " + Fmt(tol.PatMaxPx) + "px）");
                }
                else
                {
                    sb.Append("命中**单击**（位移 " + Fmt(dist) + "px ≤ " + Fmt(tol.ClickMaxPx) +
                              "px，时长 " + elapsedMs + "ms ≤ " + PetGesture.ClickMaxMs + "ms）");
                }
                if (movedSincePress)
                {
                    // 事实陈述，不是判断：按下期间确实动过，但判定仍是单击
                    //（`Classify` 独立给出了 Click —— 见 `ResolveRelease`）。
                    sb.Append("；按下期间手曾越出容差（记录用，不影响本次判定）");
                }
                return sb.ToString();
            }

            if (kind == PetGestureKind.Pat)
            {
                if (!longPressOn)
                {
                    sb.Append("满足**摸头**条件，但「长按摸头」开关是**关的** → 不触发");
                    return sb.ToString();
                }
                if (patReported > 0)
                {
                    sb.Append("满足摸头条件，但本次按下**已经报到第 " + patReported +
                              " 级**（长按计时器已报过）→ 不重复上报");
                    return sb.ToString();
                }
                sb.Append("命中**摸头**（位移 " + Fmt(dist) + "px ≤ " + Fmt(tol.PatMaxPx) +
                          "px，时长 " + elapsedMs + "ms）");
                if (!holdStill)
                {
                    sb.Append("；注意松手瞬间手在容差外（计时器已暂停报级）");
                }
                return sb.ToString();
            }

            if (kind == PetGestureKind.Fling)
            {
                if (!flingOn)
                {
                    sb.Append("速度够**抛掷**（" + Fmt(speed) + "px/s ≥ " + Fmt(tol.FlingMinSpeedPx) +
                              "px/s），但「抛掷」开关是**关的** → 当作普通拖动（她停在松手处）");
                    return sb.ToString();
                }
                sb.Append("命中**抛掷**（松手速度 " + Fmt(speed) + "px/s ≥ " +
                          Fmt(tol.FlingMinSpeedPx) + "px/s）");
                return sb.ToString();
            }

            // ── Drag：用户最需要的一段（"我按了，什么都没发生"）──────────────
            sb.Append("**什么都没命中** → 按拖动处理（不触发互动）。");
            if (bad)
            {
                sb.Append(" 坐标算不出来（PointToScreen 失败）");
                return sb.ToString();
            }
            if (elapsedMs < 0)
            {
                sb.Append(" 时长为负（时钟异常）");
                return sb.ToString();
            }

            // 差在哪 —— 逐条说清"离命中还差多少"
            if (dist > tol.PatMaxPx)
            {
                sb.Append(" 位移 " + Fmt(dist) + "px 超过摸头容差 " + Fmt(tol.PatMaxPx) + "px；");
            }
            if (elapsedMs > PetGesture.PatMaxMs && dist <= tol.PatMaxPx)
            {
                sb.Append(" 按得比摸头上限 " + PetGesture.PatMaxMs + "ms 还久（" + elapsedMs +
                          "ms），不再升级；");
            }
            if (elapsedMs < PetGesture.FlingMinElapsedMs)
            {
                sb.Append(" 时长 " + elapsedMs + "ms 太短，速度不可信（需 ≥ " +
                          PetGesture.FlingMinElapsedMs + "ms）；");
            }
            else if (double.IsNaN(speed) || double.IsInfinity(speed))
            {
                sb.Append(" 速度算不出来（样本不足或时间差为 0）；");
            }
            else if (speed < tol.FlingMinSpeedPx)
            {
                sb.Append(" 松手速度 " + Fmt(speed) + "px/s 低于抛掷门槛 " +
                          Fmt(tol.FlingMinSpeedPx) + "px/s；");
            }
            return sb.ToString();
        }

        private static string Fmt(double v)
        {
            if (double.IsNaN(v)) return "NaN";
            if (double.IsInfinity(v)) return "Inf";
            return v.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>自检用：清空缓冲与计数（避免测试之间互相污染）。</summary>
        internal static void DiagReset()
        {
            for (int i = 0; i < _ring.Length; i++) _ring[i] = null;
            _ringCount = 0;
            _dropped = 0;
            _written = 0;
        }

        /// <summary>自检用：把缓冲里的历史取出来（不落盘）。</summary>
        internal static List<string> DiagRing()
        {
            List<string> outList = new List<string>();
            int n = Math.Min(_ringCount, RingCapacity);
            int start = _ringCount - n;
            for (int i = 0; i < n; i++)
            {
                int idx = ((start + i) % RingCapacity + RingCapacity) % RingCapacity;
                if (_ring[idx] != null) outList.Add(_ring[idx]);
            }
            return outList;
        }
    }
}
