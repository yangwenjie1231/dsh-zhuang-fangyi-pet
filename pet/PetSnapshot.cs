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

        public bool WantsImage { get { return Kind == "image" || Kind == "both"; } }
        public bool WantsText { get { return Kind == "text" || Kind == "both"; } }
    }

    internal sealed class PetSessionInfo
    {
        public string SessionId;
        public string State = "idle";
        public int ToolsInFlight;
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

    internal sealed class PetSnapshot
    {
        public long Rev = -1;
        public string PetState = "idle";
        public string Label = "";
        public long Since;
        public PetBubbleInfo Bubble;
        public PetSettingsInfo Settings;
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
                if (bi.WantsImage && string.IsNullOrEmpty(bi.Image)) bi.Image = null;
                s.Bubble = bi;
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
                s.Settings = si;
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