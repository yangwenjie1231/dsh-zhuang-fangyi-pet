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

        private static void Write(bool force, string level, string msg)
        {
            string line = DateTime.Now.ToString("HH:mm:ss.fff") + " [" + level + "] " + msg;
            lock (Gate)
            {
                if (_mirror || force)
                {
                    try
                    {
                        Console.Out.WriteLine(line);
                        Console.Out.Flush();
                    }
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