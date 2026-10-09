using System;
using System.Collections.Generic;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 桌宠手势（**纯函数，无窗口、无定时器、无 IO**）。
    ///
    /// ── 为什么单独一个文件 ──────────────────────────────────────────────────
    ///
    /// v10 之前"点击"的判定（`PetWindow.IsClickGesture`）是**唯一**的手势，
    /// 于是"怎么碰她"只有一个维度。现在要区分四种：点击 / 长按摸头 / 挪位置 /
    /// 抛掷 —— 判据一旦多于一个，就不能再散在窗口的事件处理器里：那些函数
    /// 拿不到鼠标、跑不了自检，只能靠**真机上手动甩**来验证，而"手甩"既
    /// 不可复现也不覆盖边界。
    ///
    /// 所以：所有阈值与判定集中在这里，`SelfTest.cs` 直接断言边界值。
    /// `PetWindow` 只负责**采集原始数据**（位移、时长、速度样本）并调用这里。
    ///
    /// ── 三条设计约束 ───────────────────────────────────────────────────────
    ///
    /// 1. **坏数据一律回落"点击"**，绝不回落"抛掷"。
    ///    抛掷会让窗口沿抛物线飞出去 —— 拿 NaN/Inf 去算落点，得到的是
    ///    NaN 坐标，而 `Left = NaN` 在 WPF 上**抛异常**（或窗口消失）。
    ///    保守方向必须选"不动的那个"。
    /// 2. **抛掷与挪位置用"速度"区分，不用"距离"**。
    ///    距离阈值会把"快速拖到另一个显示器"判成抛掷；而速度只在**松手瞬间**
    ///    看一次，与用户预期一致（慢慢挪 = 挪位置，甩一下 = 飞出去）。
    /// 3. **轨迹预先算完**（`PlanFling`），动画只是回放。
    ///    边飞边算的话，"落到哪"与"会不会飞出屏幕"就没有单一真相，
    ///    自检也无从断言 —— 而飞出屏幕是这类动画最典型的缺陷。
    ///
    /// ⚠️ 本文件必须保持 **C# 5 兼容**（`tools/build-pet.ps1` 的 in-box csc
    /// 回落路径是 C# 5）：不用字符串插值、`?.`、表达式体成员、`out var`。
    /// </summary>
    internal enum PetGestureKind
    {
        /// <summary>单击（打招呼）。</summary>
        Click,
        /// <summary>按住不动（摸头）。</summary>
        Pat,
        /// <summary>慢速拖动（挪位置，不触发互动）。</summary>
        Drag,
        /// <summary>快速甩出（抛掷）。</summary>
        Fling
    }

    /// <summary>一个鼠标位置样本（屏幕物理像素 + 时刻 ms）。</summary>
    internal struct GestureSample
    {
        public double T;
        public double X;
        public double Y;

        public GestureSample(double t, double x, double y)
        {
            T = t;
            X = x;
            Y = y;
        }
    }

    /// <summary>
    /// 屏幕坐标（**物理像素，整数**）。
    ///
    /// 为什么不用 `System.Windows.Point` 或 `System.Drawing.Point`：
    /// 本文件同时被 `PetWindow`（WPF，`System.Windows`）与 `SelfTest`
    /// （两个命名空间都 using 了）引用 —— 借用任何一个都会在另一边变成
    /// "Point 是不明确的引用"（编译期实测踩过）。而且语义上这两个都不对：
    /// 抛掷轨迹是**屏幕物理像素**，不是 WPF 的 DIP，也不是 GDI+ 的坐标。
    /// </summary>
    internal struct ScreenPoint
    {
        public int X;
        public int Y;

        public ScreenPoint(int x, int y)
        {
            X = x;
            Y = y;
        }
    }

    /// <summary>抛掷轨迹（预先算完，动画只回放）。</summary>
    internal sealed class FlingPlan
    {
        /// <summary>逐帧的窗口左上角屏幕坐标（第一帧就是起点）。</summary>
        public List<ScreenPoint> Points = new List<ScreenPoint>();
        /// <summary>是否撞到了工作区边界（撞到就要给"哎"那条反应）。</summary>
        public bool HitEdge;
        /// <summary>总时长（ms）= (帧数 - 1) * StepMs。</summary>
        public int DurationMs;
        /// <summary>松手时的初速（px/s），仅用于日志与诊断。</summary>
        public double Speed;
    }

    /// <summary>
    /// 一次手势判定实际使用的容差（v13）。**全部是屏幕物理像素**。
    ///
    /// ── 为什么需要这个类型（用户 2026-10-09 报的真 bug）───────────────────
    ///
    /// 用户原话："我鼠标DPI平时开的比较高，所以很多手势触发不了，怎么回事"。
    ///
    /// 根因：容差原先写死成**绝对物理像素**（点击 4px / 摸头 6px），
    /// 而它要吸收的量是"按住鼠标时手抖了多少**像素**"：
    ///
    ///     手抖像素 = 手抖的物理距离 × 鼠标硬件 DPI × **指针增益**
    ///
    /// 硬件 DPI 读不到，但**指针增益可以读**（`SPI_GETMOUSESPEED`）——
    /// 而且它正是用户会主动调大的那一半。增益 1.5 时，同一只手、同样的抖动，
    /// 落到屏幕上多 50%：**4px 的容差实际只剩 2.7px**。
    ///
    /// 于是出现一个完全反直觉的结果：**鼠标越灵敏，手势越难触发**。
    /// 而且它不报错、不崩溃，只是"点了没反应" —— 实测日志里 54 次按下-抬起
    /// 只有 4 次被认成单击、2 次摸头，其余全部落进 `Drag`。
    ///
    /// 修法：把容差从"像素"改写成"**手**"的尺度 —— 系统默认速度下的像素数
    /// 乘以指针增益。这样同一只手在 1.0× 与 1.5× 下做出同样的动作，
    /// 判定结果**一致**。
    ///
    /// ⚠️ 下限是常量本身（**绝不让容差变小**）：低增益下不能反而更难点击。
    /// 上限是防止某个荒唐的系统读数把容差放大到"真拖动也被当成点击"。
    /// </summary>
    internal sealed class GestureTolerance
    {
        /// <summary>单击允许的最大位移（px）。</summary>
        public double ClickMaxPx;
        /// <summary>摸头/按住不动允许的最大位移（px）。</summary>
        public double PatMaxPx;
        /// <summary>抛掷的最低速度（px/s）。</summary>
        public double FlingMinSpeedPx;
        /// <summary>算出这套容差的指针增益（诊断用）。</summary>
        public double Gain;
        /// <summary>用户手动追加的灵敏度倍率（诊断用）。</summary>
        public double Sensitivity;

        /// <summary>容差上限：超过它就"真拖动也能算点击"了，宁可保守。</summary>
        public const double ClickCapPx = 24.0;
        public const double PatCapPx = 36.0;

        /// <summary>系统默认速度（1.0×）下的容差 —— 与 v12 及之前**完全一致**。</summary>
        public static GestureTolerance Default()
        {
            return _def;
        }

        /// <summary>
        /// 缓存默认容差：旧签名的 `IsClick`/`IsPatMove` 每次鼠标移动都会调它
        /// （拖动时 125~500 次/秒），不能每次 new 一个对象。
        /// 本类型的字段构造后不再修改，共享是安全的。
        /// </summary>
        private static readonly GestureTolerance _def = FromGain(1.0, 1.0);

        /// <summary>
        /// 由**指针增益 × 用户灵敏度**推出容差。
        ///
        /// ── 为什么是两个因子（而不是只读系统增益）──────────────────────────
        ///
        /// 增益只能修"系统那一半"。真正决定手抖落成多少像素的是：
        ///
        ///     手抖像素 = 手抖的物理距离 × **鼠标硬件 DPI** × 指针增益
        ///
        /// 而**硬件 DPI 没有任何 API 能读到** —— 用户说的"我鼠标 DPI 平时开的
        /// 比较高"恰好就在这个读不到因子里。所以自动检测**不可能**独自修好它，
        /// 必须给用户一个能自己拧的旋钮（`gestureSensitivity`）。
        /// 只做自动检测的话，我只是把"完全没救"换成了"救一半"。
        ///
        /// 坏数据（NaN / Inf / ≤0）→ 该因子按 1.0 处理（= 不放大，安全侧）：
        /// 容差算大只会让拖动被误判成点击，算小则让手势失灵 —— 但两者都不如
        /// "退回已知正确的默认值"安全。
        /// </summary>
        public static GestureTolerance FromGain(double gain, double sensitivity)
        {
            GestureTolerance t = new GestureTolerance();
            if (double.IsNaN(gain) || double.IsInfinity(gain) || gain <= 0) gain = 1.0;
            if (double.IsNaN(sensitivity) || double.IsInfinity(sensitivity) || sensitivity <= 0)
                sensitivity = 1.0;

            double k = gain * sensitivity;
            t.Gain = gain;
            t.Sensitivity = sensitivity;
            t.ClickMaxPx = Scale(PetGesture.ClickMaxMovePx, k, ClickCapPx);
            t.PatMaxPx = Scale(PetGesture.PatMaxMovePx, k, PatCapPx);
            // ⚠️ 抛掷阈值**同向放大**：高增益下同一个"甩"的手部动作会产生更大的
            // 屏幕速度，阈值不跟着走就会"轻轻一碰就飞出去"（与容差同一条道理）。
            t.FlingMinSpeedPx = Scale(PetGesture.FlingMinSpeed, k, double.PositiveInfinity);
            return t;
        }

        /// <summary>base × k，下限 base（**绝不更小**：低增益不能反而更难触发）、上限 cap。</summary>
        private static double Scale(double basePx, double k, double capPx)
        {
            double v = basePx * k;
            if (v < basePx) v = basePx;
            if (v > capPx) v = capPx;
            return v;
        }

        /// <summary>诊断用的一行摘要（日志里要能一眼看出"这次判定用的什么容差"）。</summary>
        public string Describe()
        {
            return "gain=" + Fmt(Gain) + " sens=" + Fmt(Sensitivity) +
                   " click<=" + Fmt(ClickMaxPx) + "px pat<=" + Fmt(PatMaxPx) +
                   "px fling>=" + Fmt(FlingMinSpeedPx) + "px/s";
        }

        private static string Fmt(double v)
        {
            return v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    internal static class PetGesture
    {
        // ── 阈值（**唯一真相**，PetWindow 的常量引用这里）──────────────────

        /// <summary>单击允许的最大位移（物理像素）。4px 容纳 150% DPI 下的手抖。</summary>
        internal const double ClickMaxMovePx = 4.0;
        /// <summary>单击允许的最长按下时长（ms）。</summary>
        internal const int ClickMaxMs = 300;

        /// <summary>长按摸头允许的最大位移。比点击松（手会轻微漂），但远小于真拖动。</summary>
        internal const double PatMaxMovePx = 6.0;
        /// <summary>长按的下限：短于它就还是点击（<see cref="ClickMaxMs"/> 之后到这里之间是"按住"）。</summary>
        internal const int PatMinMs = 350;
        /// <summary>
        /// 长按的上限：再久就不再升级。
        ///
        /// 不是"超时作废"—— 用户按住不放是**允许**的，只是不再加级：
        /// 一直按住就能一直刷反应的话，"按住"会变成刷好感的路子。
        /// </summary>
        internal const int PatMaxMs = 4000;
        /// <summary>
        /// 摸头每升一级的间隔（ms）。
        ///
        /// ⚠️ v13.1：**600 → 1200**。用户反馈"摸头的逐级反应太快了"。
        ///
        /// 原先 600ms 一级，三级在 **1.8 秒**内全部走完 —— 按住之后还没来得及
        /// 看清第 1 级，就已经跳到第 3 级了，然后就静止到 `PatMaxMs` 上限。
        /// 那不像"一级一级地摸"，像"按下去就被连戳三下"。
        ///
        /// 1200ms 的取法：三级铺开到约 **2.9 秒**（见 `PatLevel`），
        /// 每一级都留得下"看清反应 → 期待下一级"的时间，
        /// 同时仍在 `PatMaxMs`(4000) 之内 —— 若步长大于 1/3 的窗口，
        /// 第 3 级就永远到不了了。
        ///
        /// ⚠️ 这个约束是**结构性**的，不是审美：
        /// `PatMaxMs` 必须 ≥ `PatMinMs + (PatMaxLevels-1) × PatStepMs`，
        /// 否则最后一级永远触发不了（自检有一条专门断言它，见 `SelfTest`）。
        /// </summary>
        internal const int PatStepMs = 1200;
        /// <summary>一次按下最多升到几级。</summary>
        internal const int PatMaxLevels = 3;

        /// <summary>
        /// 抛掷的最低速度（px/s）。
        ///
        /// 800 的来历：慢速拖动挪位置约 100~300 px/s，一次正常的"甩"约
        /// 1500~4000 px/s，两者之间有一个数量级的空档，取中间偏低的位置，
        /// 既不会把挪位置误判成甩，也不需要"很用力"才能甩动。
        /// </summary>
        internal const double FlingMinSpeed = 800.0;
        /// <summary>速度取样窗口：松手前这么多毫秒内的样本。</summary>
        internal const int FlingWindowMs = 100;
        /// <summary>
        /// 抛掷要求的最短按下时长（ms）。
        ///
        /// 两个样本的时间差太小时，速度估计会被**毫秒级的采样抖动**放大
        /// （差 1ms 就能让速度翻倍）。60ms 保证窗口里至少有 3~4 个样本。
        /// </summary>
        internal const int FlingMinElapsedMs = 60;

        // ── 抛掷轨迹参数 ────────────────────────────────────────────────────

        /// <summary>动画帧间隔（ms）。约 60fps。</summary>
        internal const int FlingStepMs = 16;
        /// <summary>动画最长帧数（40 × 16ms ≈ 640ms）。</summary>
        internal const int FlingMaxSteps = 40;
        /// <summary>每帧速度衰减系数（指数衰减，手感上像空气阻力）。</summary>
        internal const double FlingDamping = 0.94;
        /// <summary>重力（px/s²）。加一点下坠才像"被扔出去"，而不是匀速平移。</summary>
        internal const double FlingGravity = 900.0;
        /// <summary>速度低于它就不再前进（否则会永远飘一点点）。</summary>
        internal const double FlingStopSpeed = 40.0;

        // ── 判定 ────────────────────────────────────────────────────────────

        /// <summary>
        /// 是不是"单击"。纯函数。
        ///
        /// ⚠️ 这里对 NaN/Inf 的处理是**显式**的，不依赖比较运算符的 NaN 语义。
        /// 回退验证抓到过：把 `IsNaN` 判断删掉、同时把比较写成 `!(dist &gt; 4)`
        /// （一个看起来很自然的等价变形），NaN 就会**通过** —— 自检立刻失败。
        /// 所以"算不出坐标时保守处理"这条**语义**要写死在这里。
        /// </summary>
        internal static bool IsClick(double dx, double dy, int elapsedMs)
        {
            return IsClick(dx, dy, elapsedMs, GestureTolerance.Default());
        }

        /// <summary>
        /// 同上，但用**指定的容差**（v13：容差随指针增益放大）。
        ///
        /// 保留上面那个三参数重载是为了**不破坏既有语义与断言**：
        /// 它等价于"系统默认速度"（增益 1.0），也就是 v12 的行为。
        /// </summary>
        internal static bool IsClick(double dx, double dy, int elapsedMs, GestureTolerance tol)
        {
            if (tol == null) tol = GestureTolerance.Default();
            if (elapsedMs < 0 || elapsedMs > ClickMaxMs) return false;
            if (double.IsNaN(dx) || double.IsNaN(dy)) return false;
            if (double.IsInfinity(dx) || double.IsInfinity(dy)) return false;
            return Math.Sqrt(dx * dx + dy * dy) <= tol.ClickMaxPx;
        }

        /// <summary>
        /// 位移是否还在"按住不动"的量级（摸头的容差）。
        ///
        /// ⚠️⚠️ **这个函数存在的唯一理由是修一个真 bug**（用户 2026-10-08：
        /// "手势没法正常触发"）。原先有两套不同的容差：
        ///   · `PetWindow._movedSincePress` 用 **`ClickMaxMovePx`(4px)** 置位，
        ///     一旦置位就**永久停掉长按计时器**；
        ///   · 而 `Classify` 判摸头用的是 **`PatMaxMovePx`(6px)**。
        /// 于是位移落在 **4~6px 之间**时两边结论相反：
        /// `Classify` 说"这是摸头"，计时器却已经被掐死 → **松手什么都不发生**。
        ///
        /// 而"按住鼠标时手漂 4~6 像素"是**常态**（尤其在高 DPI + 玻璃鼠标垫上），
        /// 所以这不是边角情况 —— 它是"摸头大部分时候不灵"的主因。
        ///
        /// 现在两处都调这个函数，**单一真相**。
        /// </summary>
        internal static bool IsPatMove(double dx, double dy)
        {
            return IsPatMove(dx, dy, GestureTolerance.Default());
        }

        /// <summary>
        /// 同上，但用**指定的容差**（v13）。
        ///
        /// ⚠️ 这是本 bug 的**主要现场**：`PetWindow.TrackMove` 用它判"手有没有动"，
        /// 而高指针增益下 6px 实际只剩 4px —— 用户按住她时手一抖就被记成"移动过"，
        /// 于是长按计时器被掐死，摸头整个失灵。
        /// </summary>
        internal static bool IsPatMove(double dx, double dy, GestureTolerance tol)
        {
            if (tol == null) tol = GestureTolerance.Default();
            if (double.IsNaN(dx) || double.IsNaN(dy)) return false;
            if (double.IsInfinity(dx) || double.IsInfinity(dy)) return false;
            return Math.Sqrt(dx * dx + dy * dy) <= tol.PatMaxPx;
        }

        /// <summary>
        /// 松手时"还差一点点才到摸头"的那段空档，算作**单击**。
        ///
        /// 由来：`ClickMaxMs`(300) 到 `PatMinMs`(350) 之间原先是一个**死区** ——
        /// 位移很小、按住 0.32 秒、松手：既不算点击（超过 300ms）
        /// 也不算摸头（不到 350ms）→ **什么都不发生**。
        /// 对用户来说就是"我明明按了，她没反应"，而这恰恰是最容易复现的
        /// 误操作（想点一下，手按久了一点）。
        ///
        /// ⚠️ 这里**推翻了** SelfTest 里原先那条"300~350ms 是**故意的**死区"
        /// 的断言。它给的理由是"两个判据紧贴时，采样抖动会让同一次按下在两条
        /// 路径里各自命中一次"。**那个理由不成立**：
        ///   · `Classify` 是**单值函数**，一次调用只可能返回一个 kind，
        ///     结构上就不可能出现"同时判出 Click 和 Pat"；
        ///   · 真正会重复上报的是**长按计时器**与松手路径这两条独立通道，
        ///     而它们由 `PatLevelOnRelease` 的"已上报就不再补"来保证唯一
        ///     （计时器要到 `PatMinMs` 之后才可能报级数）。
        /// 所以空档唯一的实际效果就是"按了没反应"。
        ///
        /// 位移容差用 `PatMaxMovePx`(6px) 而不是点击的 4px：进到这个时间窗口
        /// 说明用户本意可能是长按，只是没按够 —— 此时 6px 才是"没在拖"的口径。
        /// </summary>
        internal static bool ClosesGapAsClick(double dx, double dy, int elapsedMs)
        {
            return ClosesGapAsClick(dx, dy, elapsedMs, GestureTolerance.Default());
        }

        /// <summary>同上，但用**指定的容差**（v13）。</summary>
        internal static bool ClosesGapAsClick(double dx, double dy, int elapsedMs, GestureTolerance tol)
        {
            if (tol == null) tol = GestureTolerance.Default();
            if (elapsedMs <= ClickMaxMs || elapsedMs >= PatMinMs) return false;
            if (double.IsNaN(dx) || double.IsNaN(dy)) return false;
            if (double.IsInfinity(dx) || double.IsInfinity(dy)) return false;
            return Math.Sqrt(dx * dx + dy * dy) <= tol.PatMaxPx;
        }

        /// <summary>
        /// 松手时该补报的摸头级数（0 = 不用补）。
        ///
        /// ⚠️ 又一个真 bug 的修法：摸头**完全**由长按计时器驱动
        /// （`OnHoldTick` → `PatInvoked`），而松手路径**没有处理 Pat 分支** ——
        /// 它只管 Click 与 Fling。于是只要计时器出于任何原因没走成
        /// （被漂移掐死、被 UI 线程卡住、消息循环刚好忙），
        /// `Classify` 明确判出 `Pat`，**却没有任何人响应它**。
        ///
        /// 所以松手时补一次下限：已经报过级就别重复（那只会上报两次），
        /// 一级都没报过就补第 1 级。
        /// </summary>
        /// <param name="reportedLevel">本次按下已经上报到第几级</param>
        /// <param name="elapsedMs">按下到松手的时长</param>
        internal static int PatLevelOnRelease(int reportedLevel, int elapsedMs)
        {
            if (reportedLevel > 0) return 0;
            if (elapsedMs < PatMinMs) return 0;
            return 1;
        }

        /// <summary>两点距离；任一坐标坏掉返回 NaN（调用方必须自己挡）。</summary>
        private static double Distance(double dx, double dy)
        {
            if (double.IsNaN(dx) || double.IsNaN(dy)) return double.NaN;
            if (double.IsInfinity(dx) || double.IsInfinity(dy)) return double.PositiveInfinity;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        /// <summary>
        /// 判定一次"按下 → 抬起"属于哪种手势。
        ///
        /// 顺序**重要**，每一步都是"更宽松的排除更严格的"：
        ///   1. 单击 —— 位移与时长都极小；
        ///   2. 长按 —— 时长够、位移仍小（按住不动）；
        ///   3. 抛掷 —— 松手瞬间速度够大（**与位移无关**：甩一小段也算甩）；
        ///   4. 其余 = 挪位置。
        ///
        /// @param dx,dy 按下到抬起的屏幕位移（物理像素）
        /// @param elapsedMs 按下到抬起的时长
        /// @param speedPxPerSec 松手前 <see cref="FlingWindowMs"/> 内的平均速度（见 <see cref="FlingSpeed"/>）
        /// </summary>
        internal static PetGestureKind Classify(double dx, double dy, int elapsedMs, double speedPxPerSec)
        {
            return Classify(dx, dy, elapsedMs, speedPxPerSec, GestureTolerance.Default());
        }

        /// <summary>
        /// 同上，但用**指定的容差**（v13：容差随指针增益放大）。
        ///
        /// 保留四参数重载 = 增益 1.0，也就是 v12 的行为**逐位不变** ——
        /// 既有断言（`Classify(4,0,300,0) == Click` 之类）继续有效。
        /// </summary>
        internal static PetGestureKind Classify(double dx, double dy, int elapsedMs,
                                                double speedPxPerSec, GestureTolerance tol)
        {
            if (tol == null) tol = GestureTolerance.Default();
            // 坏数据 → 点击（见文件头约束 1：保守方向必须是"不动"）。
            // ── 坏数据 → Drag（**什么都不做**）──────────────────────────────
            //
            // 为什么不是 Click：v9 的行为是"坐标算不出来就当没点过"
            // （`IsClickGesture` 对 NaN 返回 false → 不触发互动）。回落 Click 会
            // **改变**那个行为 —— 一次坐标异常变成一次打招呼。无害，但那是
            // 静默的行为回归，而"静默"正是本项目最贵的一类 bug。
            // 为什么不是 Fling：见文件头约束 1（拿 NaN 算落点会让窗口消失）。
            if (double.IsNaN(dx) || double.IsNaN(dy) ||
                double.IsInfinity(dx) || double.IsInfinity(dy))
            {
                return PetGestureKind.Drag;
            }
            if (elapsedMs < 0) return PetGestureKind.Drag;

            if (IsClick(dx, dy, elapsedMs, tol)) return PetGestureKind.Click;

            // v12：300~350ms 的**空档归入单击**（见 `ClosesGapAsClick`）。
            //
            // ⚠️ 这一支必须在这里，而不是只写在 `PetWindow` 的松手路径里：
            // `Classify` 是手势判定的**唯一真相**，而窗口那边会
            // `if (isClick || kind == PetGestureKind.Click)`。
            // 如果只在窗口里补 `isClick`，就会出现**两个互相矛盾的结论**
            // （`Classify` 说 Drag、窗口说 Click），下次谁读 `kind` 谁就错。
            if (ClosesGapAsClick(dx, dy, elapsedMs, tol)) return PetGestureKind.Click;

            double dist = Distance(dx, dy);

            // 长按：时长在窗口内、位移仍在"手抖"量级。
            //
            // ⚠️ 这一支**不看速度** —— 按住不动时速度天然是 0（甚至因为
            // 没有 MouseMove 事件而根本没有样本），拿速度去要求它，等于
            // 把"摸头"整个功能废掉。
            if (elapsedMs >= PatMinMs && elapsedMs <= PatMaxMs && dist <= tol.PatMaxPx)
            {
                return PetGestureKind.Pat;
            }

            // 抛掷：速度达标 **且** 按下时长够（速度估计才有意义）。
            //
            // v13：阈值同样乘增益 —— 高增益下同一个"甩"的手部动作会产生
            // 更大的屏幕速度，阈值不跟着走就会"轻轻一甩就飞出去"。
            if (elapsedMs >= FlingMinElapsedMs &&
                !double.IsNaN(speedPxPerSec) &&
                !double.IsInfinity(speedPxPerSec) &&
                speedPxPerSec >= tol.FlingMinSpeedPx)
            {
                return PetGestureKind.Fling;
            }

            return PetGestureKind.Drag;
        }

        /// <summary>
        /// 按住 `heldMs` 之后应该升到第几级摸头（0 = 还没到第一级）。
        ///
        /// 级数封顶在 <see cref="PatMaxLevels"/>：一次按下最多给 3 次反应，
        /// 再多就腻了（而且"按住不放"会变成刷互动的手段）。
        /// </summary>
        internal static int PatLevel(int heldMs)
        {
            if (heldMs < PatMinMs) return 0;
            // 第一级在 PatMinMs 到达，之后每 PatStepMs 一级。
            int level = 1 + (heldMs - PatMinMs) / PatStepMs;
            if (level > PatMaxLevels) return PatMaxLevels;
            return level;
        }

        /// <summary>
        /// 松手前 <see cref="FlingWindowMs"/> 内的平均速度（px/s）。
        ///
        /// ⚠️ 用**首末两点**的位移除以时间差，不是逐段速度的平均：
        /// 用户感知的是"松手那一刻还在不在动"，而逐段平均会把一次
        /// "先慢后快"的甩动摊平（慢的那几段把平均值拉下来）→ 该飞的时候不飞。
        ///
        /// 样本不足 / 时间差为 0 / 坐标坏掉 → 返回 0（= 不甩，安全侧）。
        ///
        /// @param samples 环形缓冲里的样本（可能含窗口外的旧样本）
        /// @param count 有效样本数（从 0 开始）
        /// @param at 松手时刻（ms）
        /// </summary>
        internal static double FlingSpeed(GestureSample[] samples, int count, double at)
        {
            double vx, vy;
            FlingVelocity(samples, count, at, out vx, out vy);
            double sp = Math.Sqrt(vx * vx + vy * vy);
            if (double.IsNaN(sp) || double.IsInfinity(sp)) return 0;
            return sp;
        }

        /// <summary>
        /// 松手前 <see cref="FlingWindowMs"/> 内的平均速度**向量**（px/s）。
        ///
        /// 与 <see cref="FlingSpeed"/> 共用同一个窗口 —— 这一点是刻意的：
        /// 若"判定该不该飞"与"往哪个方向飞"各取一段，会出现"判定说速度够、
        /// 飞行方向却取到了几乎静止的那一段"，表现为她**原地抖一下**。
        /// 所以两个函数必须由同一段代码算出来（这里是 `FlingSpeed` 反过来调它）。
        ///
        /// 坏数据 / 样本不足 → 输出 (0,0)（= 不动，安全侧）。
        /// </summary>
        internal static void FlingVelocity(GestureSample[] samples, int count, double at,
                                           out double vx, out double vy)
        {
            vx = 0;
            vy = 0;
            if (samples == null || count <= 0) return;
            if (count > samples.Length) count = samples.Length;
            if (double.IsNaN(at) || double.IsInfinity(at)) return;

            double windowStart = at - FlingWindowMs;
            // 样本按时间递增：第一个 T >= windowStart 的就是窗口内最早的。
            int first = -1;
            int last = -1;
            for (int i = 0; i < count; i++)
            {
                double t = samples[i].T;
                if (double.IsNaN(t) || double.IsInfinity(t)) return;
                if (t > at) break;
                if (t < windowStart) continue;
                if (first < 0) first = i;
                last = i;
            }
            if (first < 0 || last < 0 || first == last) return;

            double dt = samples[last].T - samples[first].T;
            if (dt <= 0) return;

            double dx = samples[last].X - samples[first].X;
            double dy = samples[last].Y - samples[first].Y;
            if (double.IsNaN(dx) || double.IsNaN(dy)) return;
            if (double.IsInfinity(dx) || double.IsInfinity(dy)) return;

            double seconds = dt / 1000.0;
            vx = dx / seconds;
            vy = dy / seconds;
        }

        /// <summary>
        /// 预先算出整条抛掷轨迹。纯函数（自检直接断言"绝不飞出边界"）。
        ///
        /// 物理：每帧 `v *= Damping`，再 `v.y += Gravity * dt`，然后按 v 前进，
        /// **每帧都夹进工作区**（撞到边界就贴着走，不反弹 —— 反弹会让它
        /// 在屏幕边缘来回弹，那是弹球不是桌宠）。
        ///
        /// 提前结束的三个条件（任一）：
        ///   · 帧数到 <see cref="FlingMaxSteps"/>（时长有上限，不能一直飘）；
        ///   · 速度低于 <see cref="FlingStopSpeed"/>；
        ///   · 初速坏掉（NaN/Inf）→ 直接返回**原地不动**的单个点。
        ///
        /// @param x,y 松手时窗口左上角的屏幕坐标
        /// @param vx,vy 初速（px/s，屏幕坐标系：y 向下为正）
        /// @param minX,minY,maxX,maxY 允许的左上角范围（来自 PetNative 的工作区）
        /// </summary>
        internal static FlingPlan PlanFling(double x, double y, double vx, double vy,
                                            int minX, int minY, int maxX, int maxY)
        {
            FlingPlan plan = new FlingPlan();

            // 坏数据 → 原地不动（见文件头约束 1）。绝不返回 NaN 坐标：
            // `Left = NaN` 会让窗口从屏幕上消失。
            if (double.IsNaN(x) || double.IsNaN(y) || double.IsInfinity(x) || double.IsInfinity(y) ||
                double.IsNaN(vx) || double.IsNaN(vy) || double.IsInfinity(vx) || double.IsInfinity(vy))
            {
                plan.Points.Add(new ScreenPoint(ClampInt(x, minX, maxX), ClampInt(y, minY, maxY)));
                plan.DurationMs = 0;
                plan.Speed = 0;
                return plan;
            }

            // 边界本身坏掉（min > max）→ 退化成"只允许这个点"，别让夹取算出荒唐值。
            if (minX > maxX) { int t = minX; minX = maxX; maxX = t; }
            if (minY > maxY) { int t = minY; minY = maxY; maxY = t; }

            double px = ClampDouble(x, minX, maxX);
            double py = ClampDouble(y, minY, maxY);
            plan.Points.Add(new ScreenPoint((int)Math.Round(px), (int)Math.Round(py)));

            double speed = Math.Sqrt(vx * vx + vy * vy);
            plan.Speed = speed;
            if (speed < FlingStopSpeed)
            {
                plan.DurationMs = 0;
                return plan;
            }

            double dt = FlingStepMs / 1000.0;
            double cvx = vx;
            double cvy = vy;

            for (int step = 0; step < FlingMaxSteps; step++)
            {
                cvx *= FlingDamping;
                cvy = cvy * FlingDamping + FlingGravity * dt;

                double nx = px + cvx * dt;
                double ny = py + cvy * dt;

                // 夹进工作区，并记下"撞过墙"（撞墙要额外给一次反应）。
                double cx = ClampDouble(nx, minX, maxX);
                double cy = ClampDouble(ny, minY, maxY);
                if (cx != nx || cy != ny) plan.HitEdge = true;

                px = cx;
                py = cy;
                plan.Points.Add(new ScreenPoint((int)Math.Round(px), (int)Math.Round(py)));

                if (Math.Sqrt(cvx * cvx + cvy * cvy) < FlingStopSpeed) break;
            }

            plan.DurationMs = (plan.Points.Count - 1) * FlingStepMs;
            return plan;
        }

        private static double ClampDouble(double v, double lo, double hi)
        {
            if (double.IsNaN(v)) return lo;
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        private static int ClampInt(double v, int lo, int hi)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return lo;
            if (v < lo) return lo;
            if (v > hi) return hi;
            return (int)Math.Round(v);
        }

        // ── 自检用的诊断入口（保持与内部同一实现，避免"测的和用的不是一套"）──

        internal static string DiagClassify(double dx, double dy, int ms, double speed)
        {
            return Classify(dx, dy, ms, speed).ToString();
        }

        internal static int DiagPatLevel(int heldMs)
        {
            return PatLevel(heldMs);
        }

        internal static FlingPlan DiagPlanFling(double x, double y, double vx, double vy,
                                               int minX, int minY, int maxX, int maxY)
        {
            return PlanFling(x, y, vx, vy, minX, minY, maxX, maxY);
        }

        internal static double DiagFlingSpeed(GestureSample[] samples, int count, double at)
        {
            return FlingSpeed(samples, count, at);
        }
    }
}
