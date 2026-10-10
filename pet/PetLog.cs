using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 极简日志。Host 用 stdio.stdout/stderr='pipe' 收集输出，所以：
    ///  - 启动后**前若干行**无条件写 stdout（Host 的 collected 里能看到）；
    ///  - 之后按 --verbose 决定是否继续写；
    ///  - 所有行同时落盘 %LOCALAPPDATA%\DSH-ZhuangFangyi-Pet\pet.log（滚动）。
    /// 不依赖 Console 编码之外的任何东西。
    /// </summary>
    internal static class PetLog
    {
        private static readonly object Gate = new object();
        private static string _logPath;
        private static bool _mirror = true;
        private static int _startupBudget = 60;
        private static long _written;
        private const long MaxBytes = 1024 * 1024;

        public static string LogPath { get { return _logPath; } }

        public static void Init(string logPath, bool mirrorToStdout)
        {
            lock (Gate)
            {
                _logPath = logPath;
                _mirror = mirrorToStdout;
                try
                {
                    if (!string.IsNullOrEmpty(_logPath))
                    {
                        string dir = Path.GetDirectoryName(_logPath);
                        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                        if (File.Exists(_logPath) && new FileInfo(_logPath).Length > MaxBytes)
                        {
                            string old = _logPath + ".1";
                            try { if (File.Exists(old)) File.Delete(old); } catch { }
                            try { File.Move(_logPath, old); } catch { }
                        }
                    }
                }
                catch { }
            }
        }

        /// <summary>Host 侧要看到的「永不静音」窗口：启动阶段关键行。</summary>
        public static void Startup(string msg)
        {
            bool force;
            lock (Gate)
            {
                force = _startupBudget > 0;
                if (force) _startupBudget--;
            }
            Write(force, "BOOT", msg);
        }

        public static void Info(string msg) { Write(false, "INFO", msg); }
        public static void Warn(string msg) { Write(true, "WARN", msg); }
        public static void Error(string msg) { Write(true, "ERR ", msg); }

        /// <summary>
        /// 调试开关（v13.7）。打开后 `Debug()` 才会落盘。
        ///
        /// 用户原话：**"所有日志最好都能用面包屑"**。
        ///
        /// ── 为什么需要分级（实测数据）───────────────────────────────────────
        ///
        /// 打开手势面包屑后，日志里 `[手势]` 只有 **38 条**，而同一份日志共 **4616 行** ——
        /// 最吵的两类占了一半以上：
        ///   · `贴纸圆角裁剪 …`  **1310 条**（每次气泡尺寸变化都记一行）
        ///   · `回复分片起播 …`  **1140 条**（每个语音分片都记一行）
        /// 用户想看面包屑，得在这 2400+ 行噪音里翻 —— 这正是"所有日志最好都能用面包屑"
        /// 这句诉求的实质：**不是"多记"，而是"该记的别被淹掉"**。
        ///
        /// 所以高频的"过程日志"降级到 `Debug()`（默认不落盘、开关打开才落），
        /// 而**真正的异常仍然走 `Warn`/`Error`（永远落盘）** ——
        /// 不能因为降噪把"出错了"也一起藏起来。
        /// </summary>
        public static void SetDebugEnabled(bool on)
        {
            lock (Gate) { _debugEnabled = on; }
        }

        private static bool _debugEnabled;

        /// <summary>诊断用：调试日志是否在落盘。</summary>
        public static bool DebugEnabled { get { lock (Gate) { return _debugEnabled; } } }

        /// <summary>
        /// 高频"过程日志"：**只有调试开关打开时才落盘**。
        ///
        /// ⚠️ 用它的时候要自问一句：这行是"出问题时必须有的证据"，
        /// 还是"看着舒服的进度条"？前者用 `Info`，后者用 `Debug`。
        /// 判据：**默认关闭时，日志里还找不找得到定位问题所需的全部信息**。
        /// </summary>
        public static void Debug(string msg)
        {
            bool on;
            lock (Gate) { on = _debugEnabled; }
            if (!on) return;
            Write(false, "DBG ", msg);
        }

        private static void Write(bool force, string level, string msg)
        {
            string line = DateTime.Now.ToString("HH:mm:ss.fff") + " [" + level + "] " + msg;
            lock (Gate)
            {
                if (_mirror || force)
                {
                    try { WriteStdoutUtf8(line); }
                    catch { }
                }
                if (string.IsNullOrEmpty(_logPath)) return;
                try
                {
                    _written++;
                    File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }

        /// <summary>
        /// 把一行以**确定的 UTF-8 字节**写到 stdout。
        ///
        /// 为什么不直接用 Console.Out.WriteLine：本 exe 是 -target:winexe（没有附加控制台），
        /// 此时 Console.OutputEncoding 的设置不一定生效，写入会退回 ANSI/GBK 代码页 ——
        /// 宿主（Node）按 UTF-8 解 stdout，中文就变成 � 乱码（实测复现过）。
        /// 直接写 OpenStandardOutput() 的字节流可以完全绕开代码页问题。
        /// 日志文件本来就用 Encoding.UTF8，所以文件侧一直是对的。
        /// </summary>
        private static void WriteStdoutUtf8(string line)
        {
            StdoutUtf8(line);
        }

        /// <summary>
        /// 以确定的 UTF-8 字节写一行到 stdout（供日志与自检共用）。
        /// 见 WriteStdoutUtf8 的说明：winexe 下不能依赖 Console.OutputEncoding。
        /// </summary>
        public static void StdoutUtf8(string line)
        {
            Stream s = null;
            try
            {
                s = Console.OpenStandardOutput();
                byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
                s.Write(bytes, 0, bytes.Length);
                s.Flush();
            }
            finally
            {
                // 不能 Dispose/Close 标准输出流（会关掉宿主读的那一端）。
                // OpenStandardOutput 每次返回新的包装流，靠 GC 回收即可。
            }
        }

        /// <summary>把未捕获异常写成可诊断的一行。</summary>
        public static string Describe(Exception ex)
        {
            if (ex == null) return "(null)";
            return ex.GetType().Name + ": " + ex.Message + " @ " + FirstFrame(ex);
        }

        private static string FirstFrame(Exception ex)
        {
            try
            {
                StackTrace st = new StackTrace(ex, true);
                for (int i = 0; i < st.FrameCount; i++)
                {
                    StackFrame f = st.GetFrame(i);
                    if (f == null) continue;
                    string file = f.GetFileName();
                    if (string.IsNullOrEmpty(file)) continue;
                    return Path.GetFileName(file) + ":" + f.GetFileLineNumber();
                }
            }
            catch { }
            return "(no frame)";
        }
    }
}