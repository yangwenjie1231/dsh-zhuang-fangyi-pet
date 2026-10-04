using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DshZhuangFangyiPet
{
    /// <summary>
    /// 契约 §4/§6 的精灵条带：**横向条带**，总宽 = frames × frameWidth，总高 = frameHeight。
    /// 注意单帧**不是方形**（frameWidth ≠ frameHeight，实测单帧宽 239~288px、帧高统一 256px），
    /// 所以绝不能拿 frameHeight 当宽度用，也绝不能用「总宽 / 帧数」之外的假设。
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
        /// <summary>清单声明的单帧宽（0=未声明）。与 FrameW 不一致时以 FrameW（实测）为准。</summary>
        public int DeclaredFrameW;
        /// <summary>几何来源："files" | "states"（诊断用）。</summary>
        public string GeometrySource = "states";

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
        private readonly Dictionary<string, DateTime> _negativeCache = new Dictionary<string, DateTime>(StringComparer.Ordinal);
        private const int NegativeCacheSeconds = 30;
        /// <summary>
        /// 已被判定「几何不可用」的变体文件名 → 判定时间。
        /// 避免每次轮换到坏变体都重走一遍「下载 + 解码 + 告警」：
        /// 实测合成素材里那个坏变体在每次 GetSheet 时都会重复告警两次（日志/HTTP 噪音）。
        /// 清单重新加载（LoadAtlas）时清空。
        /// </summary>
        private readonly Dictionary<string, DateTime> _badVariants = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

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
                _negativeCache.Clear();
                _badVariants.Clear();
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

            lock (_gate)
            {
                _atlas = a;
                // 清单换了（可能新增了 files 几何）→ 之前的「坏变体」判定作废，重新给机会
                _badVariants.Clear();
                _sheets.Clear();
            }
            AtlasError = null;
            PetLog.Startup("素材清单 OK: " + a.States.Count + " 状态 / " + a.Bubble.Count +
                           " 气泡 / " + a.Files.Count + " 个 files 几何 / frameHeight=" + a.FrameHeight +
                           " (来源 " + src + ")");

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
                // 负缓存：取不到的素材在 TTL 内不再重试。
                // 否则动画每帧都会重新拉一遍（宿主未起时会把日志刷爆、并造成无谓的 HTTP 风暴）。
                DateTime until;
                if (_negativeCache.TryGetValue(rel, out until) && DateTime.UtcNow < until) return null;
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

            if (data == null)
            {
                lock (_gate) { _negativeCache[rel] = DateTime.UtcNow.AddSeconds(NegativeCacheSeconds); }
                return null;
            }

            lock (_gate)
            {
                _remoteCache[rel] = data;
                _negativeCache.Remove(rel);
            }

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
        ///
        /// 每次调用都会推进该状态的 variants 游标（契约 §4「同状态多素材轮换，防呆板」）。
        /// 缓存按**文件名**而不是状态名：变体各有各的几何（可能帧数/帧宽都不同），
        /// 若按状态缓存，第一次加载后永远命中同一个条带，variants 就等于没用。
        /// </summary>
        public SpriteSheet GetSheet(string state)
        {
            PetJson.Atlas a;
            lock (_gate) { a = _atlas; }
            if (a == null) return null;

            string key = PetJson.NormalizeState(state);
            if (!a.States.ContainsKey(key) && a.States.ContainsKey("idle")) key = "idle";
            if (!a.States.ContainsKey(key)) return null;

            PetJson.StateEntry e = a.States[key];
            string file = PickVariant(a, key, e.File);

            // 几何来源优先级（契约 §4）：
            //   files[<该文件名>]  →  states[state]  →  图片实测
            // files 是「每个文件自己的几何」，变体靠它才能正确播放
            // （实测真实素材：happy-4.png 是 1 帧 239px，而 happy 声明 33 帧 256px；
            //  没有 files 时按 33 帧切会得到 239/33 = 7px 的碎条）。
            //
            // 只有当**既没有 files 条目、实测又与 states 声明不符**时才拒收变体并回落
            // canonical —— 这是给旧清单（无 files）留的兜底。
            SpriteSheet hit;
            lock (_gate)
            {
                if (_sheets.TryGetValue(file, out hit)) return hit;
            }

            bool isVariant = !string.Equals(file, e.File, StringComparison.OrdinalIgnoreCase);

            // 已判定坏掉的变体：直接跳过，不再重复「下载+解码+告警」
            if (isVariant)
            {
                lock (_gate)
                {
                    if (_badVariants.ContainsKey(file))
                    {
                        if (_sheets.TryGetValue(e.File, out hit)) return hit;
                        SpriteSheet canon = TryLoadSheet(key, e.File, e, a.GeomFor(e.File), false);
                        if (canon != null) { lock (_gate) { _sheets[canon.File] = canon; } }
                        return canon;
                    }
                }
            }

            SpriteSheet sh = TryLoadSheet(key, file, e, a.GeomFor(file), isVariant);
            if (sh == null && isVariant)
            {
                PetLog.Warn("变体 " + file + " 不可用（无 files 几何且与声明不符，或取不到）→ 退回 canonical " + e.File);
                lock (_gate) { _badVariants[file] = DateTime.UtcNow; }
                lock (_gate)
                {
                    if (_sheets.TryGetValue(e.File, out hit)) return hit;
                }
                sh = TryLoadSheet(key, e.File, e, a.GeomFor(e.File), false);
            }
            if (sh == null) return null;

            lock (_gate) { _sheets[sh.File] = sh; }
            PetLog.Startup("条带 " + key + " ← " + sh.File + "  " + sh.Frames + " 帧 " +
                           sh.FrameW + "x" + sh.FrameH + " @" + sh.FrameMs + "ms" +
                           " [几何来源:" + sh.GeometrySource + "]");
            return sh;
        }

        /// <summary>
        /// 载入并校验一个条带文件。几何按 files → states → 实测 的优先级取。
        ///
        /// strict（仅对 variants 文件有意义）：
        ///   - 有 files 几何 → 用 files 的 frames/frameWidth（**接受**，这正是新契约的用法）；
        ///   - 无 files 几何且实测与 states 声明不符 → 返回 null，由调用方回落 canonical；
        ///   - canonical 文件（strict=false）永远不拒收，声明不符时以实测为准
        ///     （否则整只宠物会不显示）。
        /// </summary>
        private SpriteSheet TryLoadSheet(string key, string file, PetJson.StateEntry e,
                                         PetJson.FileGeom geom, bool strict)
        {
            PetJson.Atlas a;
            lock (_gate) { a = _atlas; }

            byte[] data = FetchBytes(file);
            if (data == null)
            {
                PetLog.Warn("状态 " + key + " 的条带 " + file + " 取不到（宿主/本地/缓存均无）");
                return null;
            }

            BitmapSource strip = Decode(data, file);
            if (strip == null) return null;

            // ---- 1) files[file]：该文件自己的几何（最高优先级）----
            int frames = 0;
            int declaredFw = 0;
            int frameMs = 0;
            string src;
            if (geom != null && geom.HasFrames)
            {
                frames = geom.Frames;
                declaredFw = geom.FrameWidth;
                frameMs = geom.HasFrameMs ? geom.FrameMs : e.FrameMs;
                src = "files";
            }
            else
            {
                // ---- 2) states[state] 的声明 ----
                frames = e.Frames;
                declaredFw = e.FrameWidth;
                frameMs = e.FrameMs;
                src = "states";
            }
            if (frames < 1) frames = 1;

            // ---- 3) 图片实测推导单帧宽（契约 §4：exe 不得假设固定值）----
            int measuredFw = strip.PixelWidth / frames;
            if (measuredFw <= 0)
            {
                PetLog.Warn("条带 " + file + " 宽 " + strip.PixelWidth + " 不足 " + frames + " 帧，按单帧处理");
                measuredFw = strip.PixelWidth;
            }

            // 一致性：files/states 声明的 frameWidth 与实测不符时怎么处理
            if (declaredFw > 0 && declaredFw != measuredFw)
            {
                if (strict && src == "states")
                {
                    // 旧清单里的坏变体：无 files 条目，实测与声明不符 → 拒收，让调用方回落
                    PetLog.Warn("几何不符（变体，无 files 条目）：" + file + " 声明 frameWidth=" + declaredFw +
                                "，实测单帧宽=" + measuredFw + "（" + strip.PixelWidth + "px / " + frames +
                                " 帧）→ 拒收该变体");
                    return null;
                }
                if (strict && src == "files")
                {
                    // files 里给了几何但仍与实测不符 → 以 files 为准？还是实测？
                    // 取实测（图片是最终事实），只告警。这样至少不会碎条。
                    PetLog.Warn("清单与素材不一致：" + file + " 的 files.frameWidth=" + declaredFw +
                                "，实测单帧宽=" + measuredFw + " → 以实测为准");
                }
                else
                {
                    PetLog.Warn("清单与素材不一致：" + key + " 声明 frameWidth=" + declaredFw +
                                "，但 " + file + " 实测单帧宽=" + measuredFw +
                                "（" + strip.PixelWidth + "px / " + frames + " 帧）→ 以实测为准");
                }
            }

            if (a != null && a.FrameHeight > 0 && strip.PixelHeight != a.FrameHeight)
            {
                if (strict && src == "states")
                {
                    PetLog.Warn("几何不符（变体，无 files 条目）：" + file + " 高 " + strip.PixelHeight +
                                "px ≠ 清单 frameHeight=" + a.FrameHeight + "px → 拒收该变体");
                    return null;
                }
                PetLog.Warn("清单与素材不一致：" + file + " 高 " + strip.PixelHeight +
                            "px ≠ 清单 frameHeight=" + a.FrameHeight + "px → 以实测为准");
            }

            SpriteSheet sh = new SpriteSheet();
            sh.State = key;
            sh.File = file;
            sh.Strip = strip;
            // 单帧宽以**实测**为准（图片是最终事实）；声明只用于校验与预排尺寸。
            sh.FrameW = measuredFw;
            sh.FrameH = strip.PixelHeight;
            sh.Frames = Math.Max(1, strip.PixelWidth / Math.Max(1, measuredFw));
            sh.FrameMs = frameMs;
            sh.AnchorY = e.AnchorY;
            sh.DeclaredFrameW = declaredFw;
            sh.GeometrySource = src;
            return sh;
        }

        /// <summary>
        /// 图片加载前的预估尺寸（契约 §4 frameWidth/frameHeight）。
        /// 命中则可用于「先摆好窗口再解码」，避免首帧尺寸闪动；未命中返回 false。
        /// 几何来源与取帧一致：files[该文件] → states[state]。
        /// </summary>
        public bool TryGetDeclaredSize(string state, out int w, out int h)
        {
            w = h = 0;
            PetJson.Atlas a;
            lock (_gate) { a = _atlas; }
            if (a == null) return false;

            string key = PetJson.NormalizeState(state);
            if (!a.States.ContainsKey(key) && a.States.ContainsKey("idle")) key = "idle";
            PetJson.StateEntry e;
            if (!a.States.TryGetValue(key, out e) || e == null) return false;
            if (a.FrameHeight <= 0) return false;

            // 先看 variants 里**下一个**要播的文件有没有 files 几何（它可能和 canonical 尺寸不同）
            string next = PeekVariant(a, key, e.File);
            PetJson.FileGeom g = a.GeomFor(next);
            if (g != null && g.HasFrameWidth)
            {
                w = g.FrameWidth;
                h = a.FrameHeight;
                return true;
            }
            // 再看 canonical 自己的 files 几何
            g = a.GeomFor(e.File);
            if (g != null && g.HasFrameWidth)
            {
                w = g.FrameWidth;
                h = a.FrameHeight;
                return true;
            }
            // 最后回落到 states 声明
            if (e.FrameWidth <= 0) return false;
            w = e.FrameWidth;
            h = a.FrameHeight;
            return true;
        }

        /// <summary>只看下一个变体是谁，不推进游标（供尺寸预估用）。</summary>
        private string PeekVariant(PetJson.Atlas a, string state, string dflt)
        {
            List<string> vs;
            if (!a.Variants.TryGetValue(state, out vs) || vs == null || vs.Count == 0) return dflt;
            int cur;
            lock (_gate) { _variantCursor.TryGetValue(state, out cur); }
            return vs[Math.Abs(cur) % vs.Count];
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