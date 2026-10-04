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

    internal sealed class PetSnapshot
    {
        public long Rev = -1;
        public string PetState = "idle";
        public string Label = "";
        public long Since;
        public PetBubbleInfo Bubble;
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
                bi.DurationMs = b.Int("durationMs", 4000);
                if (bi.DurationMs < 500) bi.DurationMs = 500;
                if (bi.DurationMs > 600000) bi.DurationMs = 600000;
                bi.Priority = b.Int("priority", 0);
                if (bi.WantsImage && string.IsNullOrEmpty(bi.Image)) bi.Image = null;
                s.Bubble = bi;
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
        public int RetryMs;

        public override string ToString()
        {
            return "event=" + Event + " data=" + (Data == null ? "(null)" : (Data.Length + "B"));
        }
    }
}