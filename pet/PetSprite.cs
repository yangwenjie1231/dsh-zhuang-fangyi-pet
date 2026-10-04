using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §4/§6 的精灵条带：横向条带（frames × frameHeight 宽），
    /// 用 CroppedBitmap 取帧（v4.8 实测可用），懒加载（一次只解码当前状态那一张）。
    /// 同时构建 alpha 命中表供 WM_NCHITTEST 做点击穿透判定。
    /// </summary>
    internal sealed class SpriteSheet
    {
        public string State;
        public string File;
        public BitmapSource Strip;
        public int FrameW;
        public int FrameH;
        public int Frames;
        public int FrameMs;
        public double AnchorY = 1.0;

        private CroppedBitmap[] _cropped;

        // 命中表：单槽缓存（只对当前显示帧有意义）
        private int _maskIndex = -1;
        private byte[] _mask;
        private int _maskMinX, _maskMinY, _maskMaxX, _maskMaxY;

        public const byte AlphaThreshold = 16;

        public CroppedBitmap Frame(int index)
        {
            if (Frames <= 0) return null;
            if (index < 0) index = 0;
            index = index % Frames;
            if (_cropped == null)
            {
                _cropped = new CroppedBitmap[Frames];
            }
            CroppedBitmap c = _cropped[index];
            if (c != null) return c;
            try
            {
                Int32Rect r = new Int32Rect(index * FrameW, 0, FrameW, FrameH);
                c = new CroppedBitmap(Strip, r);
                c.Freeze();
            }
            catch (Exception ex)
            {
                PetLog.Warn("CroppedBitmap 失败 " + State + "#" + index + ": " + PetLog.Describe(ex));
                return null;
            }
            _cropped[index] = c;
            return c;
        }

        /// <summary>返回 frameW*frameH 的 alpha 平面（BGRA32 第 4 字节）。</summary>
        public byte[] Mask(int frameIndex)
        {
            if (Frames <= 0) return null;
            if (frameIndex < 0) frameIndex = 0;
            frameIndex = frameIndex % Frames;
            if (_mask != null && _maskIndex == frameIndex) return _mask;

            CroppedBitmap c = Frame(frameIndex);
            if (c == null) return null;

            int w = c.PixelWidth, h = c.PixelHeight;
            if (w <= 0 || h <= 0) return null;
            int stride = w * 4;
            byte[] px = new byte[stride * h];
            try
            {
                c.CopyPixels(px, stride, 0);
            }
            catch (Exception ex)
            {
                PetLog.Warn("CopyPixels 失败: " + PetLog.Describe(ex));
                return null;
            }

            byte[] a = new byte[w * h];
            int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int src = y * stride;
                int dst = y * w;
                for (int x = 0; x < w; x++)
                {
                    byte al = px[src + x * 4 + 3];
                    a[dst + x] = al;
                    if (al > AlphaThreshold)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            _mask = a;
            _maskIndex = frameIndex;
            _maskMinX = minX; _maskMinY = minY; _maskMaxX = maxX; _maskMaxY = maxY;
            return a;
        }

        /// <summary>非透明像素的紧致包围盒（归一化 0~1）；无内容时返回 false。</summary>
        public bool ContentBounds(int frameIndex, out double l, out double t, out double r, out double b)
        {
            l = t = 0; r = b = 1;
            byte[] m = Mask(frameIndex);
            if (m == null || _maskMaxX < 0) return false;
            l = (double)_maskMinX / FrameW;
            t = (double)_maskMinY / FrameH;
            r = (double)(_maskMaxX + 1) / FrameW;
            b = (double)(_maskMaxY + 1) / FrameH;
            return true;
        }

        /// <summary>
        /// u,v ∈ [0,1]（相对精灵显示矩形）。radius 为容错半径（像素），
        /// 默认 1 —— 让边缘更好点中，但不至于把大片透明区变成可点区。
        /// </summary>
        public bool HitTest(int frameIndex, double u, double v, int radius)
        {
            if (u < 0 || u > 1 || v < 0 || v > 1) return false;
            byte[] m = Mask(frameIndex);
            if (m == null) return false;
            int x = (int)(u * FrameW);
            int y = (int)(v * FrameH);
            if (x < 0) x = 0; else if (x >= FrameW) x = FrameW - 1;
            if (y < 0) y = 0; else if (y >= FrameH) y = FrameH - 1;
            if (radius <= 0) return m[y * FrameW + x] > AlphaThreshold;

            int x0 = Math.Max(0, x - radius), x1 = Math.Min(FrameW - 1, x + radius);
            int y0 = Math.Max(0, y - radius), y1 = Math.Min(FrameH - 1, y + radius);
            for (int yy = y0; yy <= y1; yy++)
            {
                int row = yy * FrameW;
                for (int xx = x0; xx <= x1; xx++)
                {
                    if (m[row + xx] > AlphaThreshold) return true;
                }
            }
            return false;
        }

        /// <summary>整帧是否几乎全透明（全透明帧在 WM_NCHITTEST 里直接穿透）。</summary>
        public bool IsBlankFrame(int frameIndex)
        {
            byte[] m = Mask(frameIndex);
            if (m == null) return true;
            for (int i = 0; i < m.Length; i++) if (m[i] > AlphaThreshold) return false;
            return true;
        }
    }

    /// <summary>
    /// 素材仓库：清单解析、按状态懒加载条带、宿主不可用时回落本地缓存。
    /// 线程模型：字节下载可在后台线程；解码/构建必须在 UI 线程（WPF BitmapSource 亲和性），
    /// 构建完成后 Freeze() 以便跨线程使用。
    /// </summary>
    internal sealed class PetSpriteStore : IDisposable
    {
        public const string CacheFolderName = "cache";

        private readonly PetOptions _opt;
        private readonly PetHttp _http;
        private readonly string _cacheDir;
        private readonly object _gate = new object();

        private PetJson.Atlas _atlas;
        private readonly Dictionary<string, SpriteSheet> _sheets = new Dictionary<string, SpriteSheet>(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _variantCursor = new Dictionary<string, int>(StringComparer.Ordinal);
        private readonly Dictionary<string, BitmapSource> _bubbleCache = new Dictionary<string, BitmapSource>(StringComparer.Ordinal);
        private readonly Dictionary<string, byte[]> _remoteCache = new Dictionary<string, byte[]>(StringComparer.Ordinal);

        public string CacheDir { get { return _cacheDir; } }
        public PetJson.Atlas Atlas { get { return _atlas; } }
        public string AtlasError { get; private set; }

        public PetSpriteStore(PetOptions opt, PetHttp http, string cacheDir)
        {
            _opt = opt;
            _http = http;
            _cacheDir = cacheDir;
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _sheets.Clear();
                _bubbleCache.Clear();
                _remoteCache.Clear();
            }
        }

        // ------------------------------------------------------------------
        // 清单
        // ------------------------------------------------------------------

        /// <summary>拉取并解析 pet.json。失败返回 false 并设置 AtlasError。</summary>
        public bool LoadAtlas()
        {
            string json = null;
            string src = null;

            if (_http != null && _opt.Url != null)
            {
                try
                {
                    json = _http.GetString("/api/zhuang-fangyi/pet/atlas", 8000);
                    if (!string.IsNullOrEmpty(json)) src = "host";
                }
                catch (Exception ex) { PetLog.Info("atlas 拉取失败: " + PetLog.Describe(ex)); }
            }

            if (string.IsNullOrEmpty(json) && !string.IsNullOrEmpty(_opt.ArtDir))
            {
                try
                {
                    string p = Path.Combine(_opt.ArtDir, "pet.json");
                    if (File.Exists(p)) { json = File.ReadAllText(p); src = "local:" + p; }
                }
                catch (Exception ex) { PetLog.Info("本地 pet.json 读取失败: " + PetLog.Describe(ex)); }
            }

            if (string.IsNullOrEmpty(json))
            {
                try
                {
                    string p = Path.Combine(_cacheDir, "pet.json");
                    if (File.Exists(p)) { json = File.ReadAllText(p); src = "cache:" + p; }
                }
                catch (Exception ex) { PetLog.Info("缓存 pet.json 读取失败: " + PetLog.Describe(ex)); }
            }

            if (string.IsNullOrEmpty(json))
            {
                AtlasError = "找不到 pet.json（宿主不可用且无本地素材）";
                return false;
            }

            PetJson.Atlas a = PetJson.ParseAtlas(json);
            if (a == null)
            {
                AtlasError = "pet.json 解析失败 (" + src + ")";
                return false;
            }

            lock (_gate) { _atlas = a; }
            AtlasError = null;
            PetLog.Startup("素材清单 OK: " + a.States.Count + " 状态 / " + a.Bubble.Count +
                           " 气泡 / frameHeight=" + a.FrameHeight + " (来源 " + src + ")");

            if (src == "host")
            {
                try { File.WriteAllText(Path.Combine(_cacheDir, "pet.json"), json); }
                catch (Exception ex) { PetLog.Info("pet.json 写缓存失败: " + PetLog.Describe(ex)); }
            }
            return true;
        }

        // ------------------------------------------------------------------
        // 字节获取（宿主优先 → 本地 art 目录 → 缓存）
        // ------------------------------------------------------------------

        private byte[] FetchBytes(string rel)
        {
            lock (_gate)
            {
                byte[] cached;
                if (_remoteCache.TryGetValue(rel, out cached)) return cached;
            }

            byte[] data = null;
            string origin = null;

            if (_http != null && _opt.Url != null)
            {
                try
                {
                    byte[] b;
                    int code = _http.GetRaw("/api/zhuang-fangyi/pet/art/" + Uri.EscapeDataString(rel), 15000, out b);
                    if (code == 200 && b != null && b.Length > 0) { data = b; origin = "host"; }
                    else if (code != 0) PetLog.Info("art " + rel + " → HTTP " + code);
                }
                catch (Exception ex) { PetLog.Info("art " + rel + " 下载失败: " + PetLog.Describe(ex)); }
            }

            if (data == null && !string.IsNullOrEmpty(_opt.ArtDir))
            {
                try
                {
                    string p = Path.Combine(_opt.ArtDir, rel.Replace('/', Path.DirectorySeparatorChar));
                    if (File.Exists(p)) { data = File.ReadAllBytes(p); origin = "local"; }
                }
                catch (Exception ex) { PetLog.Info("art " + rel + " 本地读取失败: " + PetLog.Describe(ex)); }
            }

            if (data == null)
            {
                try
                {
                    string p = Path.Combine(_cacheDir, rel.Replace('/', Path.DirectorySeparatorChar));
                    if (File.Exists(p)) { data = File.ReadAllBytes(p); origin = "cache"; }
                }
                catch (Exception ex) { PetLog.Info("art " + rel + " 缓存读取失败: " + PetLog.Describe(ex)); }
            }

            if (data == null) return null;

            lock (_gate) { _remoteCache[rel] = data; }

            if (origin == "host")
            {
                try
                {
                    string p = Path.Combine(_cacheDir, rel.Replace('/', Path.DirectorySeparatorChar));
                    string d = Path.GetDirectoryName(p);
                    if (!string.IsNullOrEmpty(d) && !Directory.Exists(d)) Directory.CreateDirectory(d);
                    File.WriteAllBytes(p, data);
                }
                catch (Exception ex) { PetLog.Info("art " + rel + " 写缓存失败: " + PetLog.Describe(ex)); }
            }
            return data;
        }

        private BitmapSource Decode(byte[] data, string what)
        {
            try
            {
                using (MemoryStream ms = new MemoryStream(data, false))
                {
                    BitmapDecoder dec = BitmapDecoder.Create(
                        ms, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                    if (dec.Frames.Count == 0) return null;
                    BitmapSource src = dec.Frames[0];
                    src = EnsureBgra32(src);
                    src.Freeze();
                    return src;
                }
            }
            catch (Exception ex)
            {
                PetLog.Warn("解码 " + what + " 失败: " + PetLog.Describe(ex));
                return null;
            }
        }

        /// <summary>统一到 Bgra32，保证第 4 字节就是 alpha（无 alpha 的图变成全不透明）。</summary>
        public static BitmapSource EnsureBgra32(BitmapSource src)
        {
            if (src == null) return null;
            PixelFormat f = src.Format;
            if (f == PixelFormats.Bgra32 || f == PixelFormats.Pbgra32) return src;
            try
            {
                FormatConvertedBitmap fc = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
                fc.Freeze();
                return fc;
            }
            catch (Exception ex)
            {
                PetLog.Warn("像素格式转换失败(" + f + "): " + PetLog.Describe(ex));
                return src;
            }
        }

        // ------------------------------------------------------------------
        // 条带
        // ------------------------------------------------------------------

        /// <summary>
        /// 取得某状态的条带。必须在 UI 线程调用（解码 + 创建 CroppedBitmap）。
        /// 状态缺失时按契约 §4 回落 idle；再缺失则返回 null。
        /// </summary>
        public SpriteSheet GetSheet(string state)
        {
            PetJson.Atlas a;
            lock (_gate) { a = _atlas; }
            if (a == null) return null;

            string key = PetJson.NormalizeState(state);
            if (!a.States.ContainsKey(key) && a.States.ContainsKey("idle")) key = "idle";
            if (!a.States.ContainsKey(key)) return null;

            lock (_gate)
            {
                SpriteSheet hit;
                if (_sheets.TryGetValue(key, out hit)) return hit;
            }

            PetJson.StateEntry e = a.States[key];
            string file = PickVariant(a, key, e.File);

            byte[] data = FetchBytes(file);
            if (data == null)
            {
                PetLog.Warn("状态 " + key + " 的条带 " + file + " 取不到（宿主/本地/缓存均无）");
                return null;
            }

            BitmapSource strip = Decode(data, file);
            if (strip == null) return null;

            int fw = strip.PixelWidth / e.Frames;
            if (fw <= 0)
            {
                PetLog.Warn("条带 " + file + " 宽 " + strip.PixelWidth + " 不足 " + e.Frames + " 帧，按单帧处理");
                fw = strip.PixelWidth;
            }
            SpriteSheet sh = new SpriteSheet();
            sh.State = key;
            sh.File = file;
            sh.Strip = strip;
            sh.FrameW = fw;
            sh.FrameH = strip.PixelHeight;
            sh.Frames = Math.Max(1, strip.PixelWidth / Math.Max(1, fw));
            sh.FrameMs = e.FrameMs;
            sh.AnchorY = e.AnchorY;

            lock (_gate) { _sheets[key] = sh; }
            PetLog.Startup("条带 " + key + " ← " + file + "  " + sh.Frames + " 帧 " +
                           sh.FrameW + "x" + sh.FrameH + " @" + sh.FrameMs + "ms");
            return sh;
        }

        private string PickVariant(PetJson.Atlas a, string state, string dflt)
        {
            List<string> vs;
            if (!a.Variants.TryGetValue(state, out vs) || vs == null || vs.Count <= 1) return dflt;
            int cur;
            lock (_gate)
            {
                _variantCursor.TryGetValue(state, out cur);
                _variantCursor[state] = cur + 1;
            }
            return vs[Math.Abs(cur) % vs.Count];
        }

        // ------------------------------------------------------------------
        // 气泡图
        // ------------------------------------------------------------------

        public BitmapSource GetBubbleImage(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return null;
            lock (_gate)
            {
                BitmapSource b;
                if (_bubbleCache.TryGetValue(rel, out b)) return b;
            }
            byte[] data = FetchBytes(rel);
            if (data == null) return null;
            BitmapSource img = Decode(data, rel);
            if (img == null) return null;
            lock (_gate) { _bubbleCache[rel] = img; }
            return img;
        }

        /// <summary>按清单里的 bubble 池随机取一张（供无 text 的气泡兜底）。</summary>
        public string RandomBubbleFile()
        {
            PetJson.Atlas a;
            lock (_gate) { a = _atlas; }
            if (a == null || a.Bubble.Count == 0) return null;
            int i = Math.Abs(Environment.TickCount) % a.Bubble.Count;
            return a.Bubble[i].File;
        }
    }
}