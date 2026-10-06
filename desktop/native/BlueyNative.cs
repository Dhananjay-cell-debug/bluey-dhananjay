// Bluey's hands and eyes on Windows: screen capture, Windows OCR, UI Automation controls,
// mouse and keyboard input, app launching and the push-to-talk key hook.
// A small persistent process: one JSON request per stdin line, one JSON reply per stdout line.
// Events (like the push-to-talk key) are written as {"event": ...} lines at any time.
//
// Built with Roslyn against .NET Framework 4.8, which ships with Windows, so nothing extra is needed to run it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace Bluey
{
    static class Program
    {
        static readonly object OutLock = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

        [STAThread]
        static int Main(string[] args)
        {
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: every coordinate is a physical pixel
            Console.InputEncoding = new UTF8Encoding(false);
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            Console.SetOut(stdout);

            if (args.Length > 0 && args[0] == "--selftest") return SelfTest();

            Hook.Start(Emit);
            string line;
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            while ((line = stdin.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                Dictionary<string, object> req;
                try { req = Json.Deserialize<Dictionary<string, object>>(line); }
                catch (Exception e) { Emit(new Dictionary<string, object> { { "ok", false }, { "error", "bad json: " + e.Message } }); continue; }
                object id; req.TryGetValue("id", out id);
                Dictionary<string, object> reply;
                try { reply = Handle(req); }
                catch (Exception e) { reply = new Dictionary<string, object> { { "ok", false }, { "error", e.GetType().Name + ": " + e.Message } }; }
                reply["id"] = id;
                if (!reply.ContainsKey("ok")) reply["ok"] = true;
                Emit(reply);
            }
            Hook.Stop();
            return 0;
        }

        public static void Emit(Dictionary<string, object> message)
        {
            var text = Json.Serialize(message);
            lock (OutLock) { Console.Out.WriteLine(text); }
        }

        static string S(Dictionary<string, object> r, string key, string fallback = "")
        {
            object v; return r.TryGetValue(key, out v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : fallback;
        }
        static double D(Dictionary<string, object> r, string key, double fallback = 0)
        {
            object v; if (!r.TryGetValue(key, out v) || v == null) return fallback;
            try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return fallback; }
        }
        static bool B(Dictionary<string, object> r, string key, bool fallback = false)
        {
            object v; if (!r.TryGetValue(key, out v) || v == null) return fallback;
            return v is bool ? (bool)v : S(r, key) == "true";
        }

        static Dictionary<string, object> Handle(Dictionary<string, object> r)
        {
            var cmd = S(r, "cmd");
            switch (cmd)
            {
                case "ping": return Ok("pong", true);
                case "screens": return Screens();
                case "snapshot": return Snapshot.Take(B(r, "ocr", true), B(r, "controls", true), (int)D(r, "maxEdge", 1280), (int)D(r, "quality", 72));
                case "focused": return Controls.Focused();
                case "mouse":
                    {
                        Native.POINT p; Native.GetCursorPos(out p);
                        return Ok("x", p.X, "y", p.Y);
                    }
                case "warp": Input.Warp((int)D(r, "x"), (int)D(r, "y")); return Ok();
                case "click": Input.Click((int)D(r, "x"), (int)D(r, "y"), S(r, "button", "left"), (int)D(r, "count", 1), B(r, "restore", true)); return Ok();
                case "down": Input.Down((int)D(r, "x"), (int)D(r, "y")); return Ok();
                case "dragmove": Input.Warp((int)D(r, "x"), (int)D(r, "y")); return Ok();
                case "up": Input.Up((int)D(r, "x"), (int)D(r, "y")); return Ok();
                case "scroll": Input.Scroll((int)D(r, "x"), (int)D(r, "y"), (int)D(r, "dx"), (int)D(r, "dy"), B(r, "restore", true)); return Ok();
                case "type": Input.Type(S(r, "text"), (int)D(r, "delay", 0)); return Ok();
                case "keys":
                    {
                        string label, error;
                        if (!Input.Keys(S(r, "keys"), out label, out error)) return Fail(error);
                        return Ok("label", label);
                    }
                case "openApp": return Ok("text", Apps.Open(S(r, "name")));
                case "apps": return Ok("apps", Apps.List().Select(a => a.Key).ToArray());
                case "foreground": return Foreground();
                case "rects":
                    {
                        var all = new List<object>();
                        Native.EnumWindows((h, l) =>
                        {
                            if (!Native.IsWindowVisible(h)) return true;
                            Native.RECT rr; if (!Native.GetWindowRect(h, out rr)) return true;
                            all.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "x", rr.Left }, { "y", rr.Top }, { "w", rr.Right - rr.Left }, { "h", rr.Bottom - rr.Top }, { "title", Native.WindowTitle(h) }, { "app", Apps.ProcessName(h) ?? "" } });
                            return true;
                        }, IntPtr.Zero);
                        return Ok("windows", all.ToArray());
                    }
                case "focusHwnd": Native.Focus(new IntPtr((long)D(r, "hwnd"))); return Ok();
                case "frontRect":
                    {
                        Native.RECT rc; var fgw = Native.GetForegroundWindow();
                        if (!Native.GetWindowRect(fgw, out rc)) return Fail("no window");
                        return Ok("x", rc.Left, "y", rc.Top, "w", rc.Right - rc.Left, "h", rc.Bottom - rc.Top, "title", Native.WindowTitle(fgw), "app", Apps.ProcessName(fgw));
                    }
                case "windows": return Program.Ok("windows", Switcher.Windows());
                case "tabs": return Program.Ok("tabs", Switcher.Tabs((long)D(r, "hwnd", 0)));
                case "switchTo": return Program.Ok("text", Switcher.SwitchTo(S(r, "name"), S(r, "kind", "any")));
                case "hook": Hook.Configure(B(r, "enabled", true), S(r, "chord", "ctrl+alt+space")); return Ok();
                default: return Fail("unknown cmd " + cmd);
            }
        }

        public static Dictionary<string, object> Ok(params object[] kv)
        {
            var d = new Dictionary<string, object> { { "ok", true } };
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }

        public static Dictionary<string, object> Fail(string error)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", error } };
        }

        static Dictionary<string, object> Screens()
        {
            var list = System.Windows.Forms.Screen.AllScreens.Select(s => (object)new Dictionary<string, object> {
                { "x", s.Bounds.X }, { "y", s.Bounds.Y }, { "width", s.Bounds.Width }, { "height", s.Bounds.Height },
                { "primary", s.Primary }, { "name", s.DeviceName } }).ToArray();
            return Ok("screens", list);
        }

        static Dictionary<string, object> Foreground()
        {
            var fg = Native.GetForegroundWindow();
            return Ok("app", Apps.ProcessName(fg), "title", Native.WindowTitle(fg));
        }

        static int SelfTest()
        {
            var sw = Stopwatch.StartNew();
            var snap = Snapshot.Take(true, true, 1280, 72);
            var lines = (object[])snap["lines"];
            var controls = (object[])snap["controls"];
            Console.Out.WriteLine("snapshot " + snap["width"] + "x" + snap["height"] + " lines=" + lines.Length + " controls=" + controls.Length
                + " app=" + snap["app"] + " ms=" + sw.ElapsedMilliseconds + " timings=" + Json.Serialize(snap["timings"]));
            foreach (var l in lines.Take(8)) Console.Out.WriteLine("  L " + ((Dictionary<string, object>)l)["text"]);
            foreach (var c in controls.Take(8)) { var d = (Dictionary<string, object>)c; Console.Out.WriteLine("  C " + d["kind"] + " \"" + d["label"] + "\""); }
            Console.Out.WriteLine("apps=" + Apps.List().Count);
            var wins = Switcher.WindowList();
            Console.Out.WriteLine("windows=" + wins.Count + " " + string.Join(" | ", wins.Take(6).Select(w => w["app"] + ": " + w["title"])));
            Console.Out.WriteLine("tabs in front window=" + Switcher.Tabs(0).Length);
            return lines.Length > 0 ? 0 : 1;
        }
    }

    // ───────────────────────────── Screen capture + OCR ─────────────────────────────

    static class Snapshot
    {
        public static Dictionary<string, object> Take(bool ocr, bool controls, int maxEdge, int quality)
        {
            var timings = new Dictionary<string, object>();
            var sw = Stopwatch.StartNew();
            var screen = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
            var bitmap = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bitmap))
                g.CopyFromScreen(screen.X, screen.Y, 0, 0, screen.Size, CopyPixelOperation.SourceCopy);
            timings["capture"] = sw.ElapsedMilliseconds;

            // Read the front app's controls while OCR runs.
            Task<Dictionary<string, object>> controlsTask = null;
            if (controls) controlsTask = Task.Factory.StartNew(() => Controls.Read(screen, 160, 700), CancellationToken.None,
                TaskCreationOptions.LongRunning, TaskScheduler.Default);

            object[] lines = new object[0];
            string ocrNote = null;
            if (ocr)
            {
                sw.Restart();
                try { lines = Ocr.Read(bitmap, screen.X, screen.Y); }
                catch (Exception e) { ocrNote = e.Message; }
                timings["ocr"] = sw.ElapsedMilliseconds;
            }

            sw.Restart();
            string jpeg = Encode(bitmap, maxEdge, quality);
            timings["jpeg"] = sw.ElapsedMilliseconds;
            bitmap.Dispose();

            var result = Program.Ok("width", screen.Width, "height", screen.Height, "left", screen.X, "top", screen.Y,
                "jpeg", jpeg, "lines", lines, "timings", timings);
            if (ocrNote != null) result["ocrError"] = ocrNote;
            var fg = Native.GetForegroundWindow();
            result["app"] = Apps.ProcessName(fg);
            result["title"] = Native.WindowTitle(fg);
            result["controls"] = new object[0];
            if (controlsTask != null)
            {
                sw.Restart();
                if (controlsTask.Wait(1200))
                {
                    var c = controlsTask.Result;
                    result["controls"] = c["controls"];
                }
                else result["controlsNote"] = "timed out";
                timings["controlsWait"] = sw.ElapsedMilliseconds;
            }
            return result;
        }

        static string Encode(Bitmap source, int maxEdge, int quality)
        {
            double scale = Math.Min(1.0, (double)maxEdge / Math.Max(source.Width, source.Height));
            int w = (int)Math.Round(source.Width * scale), h = (int)Math.Round(source.Height * scale);
            using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(small))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(source, 0, 0, w, h);
                }
                var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                using (var ms = new MemoryStream())
                {
                    small.Save(ms, codec, parameters);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
    }

    static class Ocr
    {
        static Windows.Media.Ocr.OcrEngine engine;

        public static object[] Read(Bitmap bitmap, int offsetX, int offsetY)
        {
            if (engine == null)
            {
                engine = Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages()
                    ?? Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"));
                if (engine == null) throw new Exception("Windows OCR isn't available (no OCR language installed).");
            }
            // OCR has a maximum image size; scale down only when needed (small text reads better at full size).
            double scale = Math.Min(1.0, (double)Windows.Media.Ocr.OcrEngine.MaxImageDimension / Math.Max(bitmap.Width, bitmap.Height));
            Bitmap work = bitmap;
            if (scale < 1.0)
            {
                work = new Bitmap((int)(bitmap.Width * scale), (int)(bitmap.Height * scale), PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(work)) g.DrawImage(bitmap, 0, 0, work.Width, work.Height);
            }
            var rect = new Rectangle(0, 0, work.Width, work.Height);
            var data = work.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var bytes = new byte[data.Stride * data.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            work.UnlockBits(data);
            var buffer = Windows.Security.Cryptography.CryptographicBuffer.CreateFromByteArray(bytes);
            var soft = Windows.Graphics.Imaging.SoftwareBitmap.CreateCopyFromBuffer(buffer,
                Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, work.Width, work.Height, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied);
            var result = Wait(engine.RecognizeAsync(soft));
            if (work != bitmap) work.Dispose();

            var lines = new List<object>();
            foreach (var line in result.Lines)
            {
                var words = new List<object>();
                double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
                foreach (var word in line.Words)
                {
                    var b = word.BoundingRect;
                    double x = b.X / scale + offsetX, y = b.Y / scale + offsetY, w = b.Width / scale, h = b.Height / scale;
                    minX = Math.Min(minX, x); minY = Math.Min(minY, y); maxX = Math.Max(maxX, x + w); maxY = Math.Max(maxY, y + h);
                    words.Add(Box(word.Text, x, y, w, h));
                }
                if (words.Count == 0) continue;
                var entry = Box(line.Text, minX, minY, maxX - minX, maxY - minY);
                entry["words"] = words.ToArray();
                lines.Add(entry);
            }
            return lines.ToArray();
        }

        /// Waits for a WinRT async call without needing the System.Runtime.WindowsRuntime projection helpers.
        static T Wait<T>(Windows.Foundation.IAsyncOperation<T> op)
        {
            var deadline = DateTime.UtcNow.AddSeconds(15);
            while (op.Status == Windows.Foundation.AsyncStatus.Started)
            {
                if (DateTime.UtcNow > deadline) { op.Cancel(); throw new TimeoutException("OCR took too long."); }
                Thread.Sleep(5);
            }
            if (op.Status == Windows.Foundation.AsyncStatus.Error) throw new Exception("OCR failed: " + op.ErrorCode.Message);
            return op.GetResults();
        }

        public static Dictionary<string, object> Box(string text, double x, double y, double w, double h)
        {
            return new Dictionary<string, object> { { "text", text }, { "x", Math.Round(x) }, { "y", Math.Round(y) }, { "w", Math.Round(w) }, { "h", Math.Round(h) } };
        }
    }

    // ───────────────────────────── UI Automation controls ─────────────────────────────

    static class Controls
    {
        static readonly Dictionary<ControlType, string> Kinds = new Dictionary<ControlType, string> {
            { ControlType.Button, "button" }, { ControlType.SplitButton, "button" }, { ControlType.CheckBox, "checkbox" },
            { ControlType.RadioButton, "option" }, { ControlType.Edit, "text field" }, { ControlType.ComboBox, "combo box" },
            { ControlType.Hyperlink, "link" }, { ControlType.Slider, "slider" }, { ControlType.TabItem, "tab" },
            { ControlType.MenuItem, "menu item" }, { ControlType.ListItem, "list item" }, { ControlType.TreeItem, "tree item" },
            { ControlType.Spinner, "stepper" }, { ControlType.Document, "document" },
        };
        static readonly HashSet<string> FieldKinds = new HashSet<string> { "text field", "combo box", "document" };

        static CacheRequest MakeCache()
        {
            var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsOffscreenProperty);
            cache.Add(AutomationElement.HelpTextProperty);
            cache.Add(AutomationElement.IsPasswordProperty);
            cache.Add(ValuePattern.ValueProperty);
            return cache;
        }

        /// The foreground window's clickable controls in reading order, within a time budget.
        public static Dictionary<string, object> Read(Rectangle screen, int limit, int budgetMs)
        {
            var found = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>();
            try
            {
                var fg = Native.GetForegroundWindow();
                if (fg == IntPtr.Zero) return Program.Ok("controls", new object[0]);
                var deadline = DateTime.UtcNow.AddMilliseconds(budgetMs);
                var cache = MakeCache();
                var walker = TreeWalker.ControlViewWalker;
                using (cache.Activate())
                {
                    var root = AutomationElement.FromHandle(fg).GetUpdatedCache(cache);
                    var queue = new Queue<AutomationElement>();
                    queue.Enqueue(root);
                    int visited = 0;
                    while (queue.Count > 0 && visited < 4000 && DateTime.UtcNow < deadline)
                    {
                        var element = queue.Dequeue();
                        visited++;
                        try
                        {
                            var info = element.Cached;
                            string kind;
                            if (info.ControlType != null && Kinds.TryGetValue(info.ControlType, out kind) && !info.IsOffscreen)
                            {
                                var r = info.BoundingRectangle;
                                if (!r.IsEmpty && r.Width > 3 && r.Height > 3 && r.IntersectsWith(new System.Windows.Rect(screen.X, screen.Y, screen.Width, screen.Height)))
                                {
                                    var label = Describe(element, kind);
                                    if (label.Length > 0 || FieldKinds.Contains(kind))
                                    {
                                        var key = (int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height;
                                        if (seen.Add(key))
                                        {
                                            var d = Ocr.Box(label, r.X, r.Y, r.Width, r.Height);
                                            d["kind"] = kind;
                                            d["label"] = label;
                                            d.Remove("text");
                                            found.Add(d);
                                        }
                                    }
                                }
                            }
                            // Don't walk into big lists' every row forever; the budget also protects us.
                            var child = walker.GetFirstChild(element, cache);
                            int children = 0;
                            while (child != null && children < 300)
                            {
                                queue.Enqueue(child);
                                children++;
                                child = walker.GetNextSibling(child, cache);
                            }
                        }
                        catch (ElementNotAvailableException) { }
                        catch (Exception) { }
                    }
                }
            }
            catch (Exception) { }
            var sorted = found.OrderBy(d => Math.Round(Convert.ToDouble(d["y"]) / 8)).ThenBy(d => Convert.ToDouble(d["x"])).Take(limit).Select(d => (object)d).ToArray();
            return Program.Ok("controls", sorted);
        }

        static string Describe(AutomationElement element, string kind)
        {
            var info = element.Cached;
            var parts = new List<string>();
            var name = (info.Name ?? "").Trim();
            if (name.Length > 0) parts.Add(name);
            else if (!string.IsNullOrWhiteSpace(info.HelpText)) parts.Add(info.HelpText.Trim());
            if (!info.IsPassword)
            {
                try
                {
                    var value = element.GetCachedPropertyValue(ValuePattern.ValueProperty) as string;
                    if (!string.IsNullOrWhiteSpace(value))
                    {
                        value = value.Trim().Replace("\r", " ").Replace("\n", " ");
                        if (value.Length > 40) value = value.Substring(0, 40);
                        if (FieldKinds.Contains(kind)) parts.Add("contains: " + value);
                        else if (parts.Count == 0) parts.Add(value);
                    }
                }
                catch { }
            }
            else parts.Add("password");
            var text = string.Join(", ", parts).Replace("\n", " ");
            return text.Length > 80 ? text.Substring(0, 80) : text;
        }

        /// Where typing will go, and whether it's a password field.
        public static Dictionary<string, object> Focused()
        {
            try
            {
                var task = Task.Factory.StartNew(() =>
                {
                    var el = AutomationElement.FocusedElement;
                    if (el == null) return Program.Ok("found", false);
                    var r = el.Current.BoundingRectangle;
                    var d = Program.Ok("found", true, "password", el.Current.IsPassword, "kind", el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""));
                    if (!r.IsEmpty) { d["x"] = r.X; d["y"] = r.Y; d["w"] = r.Width; d["h"] = r.Height; }
                    return d;
                });
                return task.Wait(600) ? task.Result : Program.Ok("found", false);
            }
            catch (Exception) { return Program.Ok("found", false); }
        }
    }

    // ───────────────────────────── Mouse and keyboard ─────────────────────────────

    static class Input
    {
        public static void Warp(int x, int y) { Native.SetCursorPos(x, y); }

        static void MouseEvent(uint flags, int data = 0)
        {
            var input = new Native.INPUT { type = 0 };
            input.u.mi = new Native.MOUSEINPUT { dwFlags = flags, mouseData = data };
            Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
        }

        public static void Click(int x, int y, string button, int count, bool restore)
        {
            Native.POINT saved; Native.GetCursorPos(out saved);
            Native.SetCursorPos(x, y);
            Thread.Sleep(15);
            bool right = button == "right", middle = button == "middle";
            uint down = right ? 0x0008u : middle ? 0x0020u : 0x0002u;
            uint up = right ? 0x0010u : middle ? 0x0040u : 0x0004u;
            for (int i = 0; i < Math.Max(1, Math.Min(count, 3)); i++)
            {
                MouseEvent(down); Thread.Sleep(12); MouseEvent(up);
                if (i + 1 < count) Thread.Sleep(60);
            }
            if (restore) { Thread.Sleep(40); Native.SetCursorPos(saved.X, saved.Y); }
        }

        public static void Down(int x, int y) { Native.SetCursorPos(x, y); Thread.Sleep(10); MouseEvent(0x0002); }
        public static void Up(int x, int y) { Native.SetCursorPos(x, y); Thread.Sleep(10); MouseEvent(0x0004); }

        public static void Scroll(int x, int y, int dx, int dy, bool restore)
        {
            Native.POINT saved; Native.GetCursorPos(out saved);
            Native.SetCursorPos(x, y);
            Thread.Sleep(15);
            // dy > 0 scrolls down (content moves up): the wheel wants negative for that. Send in notches for smoothness.
            int steps = Math.Max(1, (Math.Abs(dy) + Math.Abs(dx)) / 120);
            for (int i = 0; i < steps; i++)
            {
                if (dy != 0) MouseEvent(0x0800, -Math.Sign(dy) * 120);
                if (dx != 0) MouseEvent(0x1000, Math.Sign(dx) * 120);
                Thread.Sleep(16);
            }
            if (restore) { Thread.Sleep(30); Native.SetCursorPos(saved.X, saved.Y); }
        }

        static void Key(ushort vk, bool up, bool unicode = false, char ch = '\0')
        {
            var input = new Native.INPUT { type = 1 };
            uint flags = up ? 0x0002u : 0u;
            if (unicode) flags |= 0x0004u;
            if (!unicode && IsExtended(vk)) flags |= 0x0001u;
            input.u.ki = new Native.KEYBDINPUT { wVk = unicode ? (ushort)0 : vk, wScan = unicode ? ch : (ushort)Native.MapVirtualKey(vk, 0), dwFlags = flags };
            Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
        }

        static bool IsExtended(ushort vk)
        {
            return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x28
                || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5 || vk == 0x6F || vk == 0x90;
        }

        public static void Type(string text, int delay)
        {
            foreach (var c in text.Replace("\r\n", "\n"))
            {
                if (c == '\n') { Key(0x0D, false); Key(0x0D, true); }
                else if (c == '\t') { Key(0x09, false); Key(0x09, true); }
                else { Key(0, false, true, c); Key(0, true, true, c); }
                if (delay > 0) Thread.Sleep(delay);
            }
        }

        static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort> {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "cmd", 0x11 }, { "command", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "option", 0x12 },
            { "win", 0x5B }, { "windows", 0x5B }, { "super", 0x5B }, { "meta", 0x5B },
            { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B }, { "tab", 0x09 }, { "space", 0x20 },
            { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
            { "pageup", 0x21 }, { "pgup", 0x21 }, { "pagedown", 0x22 }, { "pgdn", 0x22 },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
            { "plus", 0xBB }, { "minus", 0xBD }, { "comma", 0xBC }, { "period", 0xBE }, { "slash", 0xBF }, { "backslash", 0xDC },
            { "semicolon", 0xBA }, { "quote", 0xDE }, { "backquote", 0xC0 }, { "bracketleft", 0xDB }, { "bracketright", 0xDD },
            { "printscreen", 0x2C }, { "capslock", 0x14 }, { "menu", 0x5D }, { "apps", 0x5D },
            { "volumeup", 0xAF }, { "volumedown", 0xAE }, { "mute", 0xAD }, { "playpause", 0xB3 }, { "nexttrack", 0xB0 }, { "prevtrack", 0xB1 },
        };
        static readonly Dictionary<char, ushort> Punct = new Dictionary<char, ushort> {
            { '=', 0xBB }, { '-', 0xBD }, { ',', 0xBC }, { '.', 0xBE }, { '/', 0xBF }, { '\\', 0xDC }, { ';', 0xBA }, { '\'', 0xDE },
            { '`', 0xC0 }, { '[', 0xDB }, { ']', 0xDD },
        };

        static int FunctionKey(string p)
        {
            int f;
            return p.StartsWith("f") && p.Length <= 3 && int.TryParse(p.Substring(1), out f) && f >= 1 && f <= 24 ? f : 0;
        }

        public static bool Parse(string combo, out List<ushort> keys, out string label, out string error)
        {
            keys = new List<ushort>(); error = null;
            var labels = new List<string>();
            var raw = (combo ?? "").Trim().ToLowerInvariant();
            if (raw.Length == 0) { label = ""; error = "Which keys?"; return false; }
            var parts = raw == "+" ? new[] { "plus" } : raw.Replace(" ", "").Split('+').Where(p => p.Length > 0).ToArray();
            foreach (var p in parts)
            {
                ushort vk;
                if (Named.TryGetValue(p, out vk)) { }
                else if (p.Length == 1 && char.IsLetterOrDigit(p[0])) vk = (ushort)char.ToUpperInvariant(p[0]);
                else if (p.Length == 1 && Punct.ContainsKey(p[0])) vk = Punct[p[0]];
                else if (FunctionKey(p) > 0) vk = (ushort)(0x70 + FunctionKey(p) - 1);
                else { label = ""; error = "I don't know the key \"" + p + "\"."; return false; }
                keys.Add(vk);
                labels.Add(p == "cmd" || p == "command" || p == "control" ? "Ctrl" : p == "option" ? "Alt" : p.Length == 1 ? p.ToUpperInvariant()
                    : char.ToUpperInvariant(p[0]) + p.Substring(1));
            }
            label = string.Join("+", labels);
            return true;
        }

        public static bool Keys(string combo, out string label, out string error)
        {
            List<ushort> keys;
            if (!Parse(combo, out keys, out label, out error)) return false;
            foreach (var k in keys) { Key(k, false); Thread.Sleep(8); }
            Thread.Sleep(20);
            for (int i = keys.Count - 1; i >= 0; i--) { Key(keys[i], true); Thread.Sleep(6); }
            return true;
        }
    }

    // ───────────────────────────── Apps ─────────────────────────────

    /// Open windows and the tabs inside browsers (Chrome, Edge, Firefox, Explorer, Terminal...), and switching to one.
    static class Switcher
    {
        static readonly HashSet<string> Skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            "Program Manager", "Windows Input Experience", "Microsoft Text Input Application" };

        public static List<Dictionary<string, object>> WindowList()
        {
            var list = new List<Dictionary<string, object>>();
            var fg = Native.GetForegroundWindow();
            Native.EnumWindows((h, l) =>
            {
                if (!Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return true;
                if (Native.GetWindow(h, 4) != IntPtr.Zero) return true;  // owned popups
                int cloaked; Native.DwmGetWindowAttribute(h, 14, out cloaked, 4);
                if (cloaked != 0) return true;  // hidden app frames and other desktops
                var title = Native.WindowTitle(h);
                if (Skip.Contains(title)) return true;
                list.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "title", title }, { "app", Apps.ProcessName(h) ?? "" }, { "front", h == fg } });
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static object[] Windows() { return WindowList().Cast<object>().ToArray(); }

        static List<AutomationElement> TabItems(IntPtr hwnd)
        {
            var result = new List<AutomationElement>();
            var task = Task.Factory.StartNew(() =>
            {
                try
                {
                    var root = AutomationElement.FromHandle(hwnd);
                    var items = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
                    foreach (AutomationElement e in items) lock (result) result.Add(e);
                }
                catch { }
            });
            task.Wait(2500);
            lock (result) return result.ToList();
        }

        public static object[] Tabs(long hwnd)
        {
            var h = hwnd != 0 ? new IntPtr(hwnd) : Native.GetForegroundWindow();
            return TabItems(h).Select((e, i) =>
            {
                bool selected = false;
                try { object p; if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) selected = ((SelectionItemPattern)p).Current.IsSelected; } catch { }
                string name = ""; try { name = e.Current.Name; } catch { }
                return (object)new Dictionary<string, object> { { "index", i + 1 }, { "name", name }, { "selected", selected } };
            }).ToArray();
        }

        static int Score(string text, string want)
        {
            var t = (text ?? "").ToLowerInvariant(); var w = (want ?? "").ToLowerInvariant().Trim();
            if (t.Length == 0 || w.Length == 0) return 0;
            if (t == w) return 100;
            if (t.StartsWith(w)) return 80;
            if (t.Contains(w)) return 60;
            var words = w.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            int hit = words.Count(x => x.Length > 1 && t.Contains(x));
            return words.Length > 0 && hit == words.Length ? 50 : hit > 0 ? 20 * hit / words.Length : 0;
        }

        static bool Activate(AutomationElement tab)
        {
            try { object p; if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return true; } } catch { }
            try { object p; if (tab.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return true; } } catch { }
            try
            {
                var r = tab.Current.BoundingRectangle;
                if (!r.IsEmpty) { Input.Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", 1, true); return true; }
            }
            catch { }
            return false;
        }

        /// Switches to the best match among browser tabs and windows. kind: any | tab | window.
        public static string SwitchTo(string name, string kind)
        {
            name = (name ?? "").Trim();
            if (name.Length == 0) return "Switch to what?";
            var windows = WindowList();
            if (kind != "window")
            {
                AutomationElement bestTab = null; IntPtr bestWin = IntPtr.Zero; int bestScore = 0; string bestName = null;
                foreach (var w in windows.OrderByDescending(x => (bool)x["front"]).Take(8))
                {
                    var h = new IntPtr((long)w["hwnd"]);
                    foreach (var tab in TabItems(h))
                    {
                        string tabName = ""; try { tabName = tab.Current.Name; } catch { }
                        int sc = Score(tabName, name);
                        if (sc > bestScore) { bestScore = sc; bestTab = tab; bestWin = h; bestName = tabName; }
                    }
                    if (bestScore >= 80) break;
                }
                int winScore = windows.Count == 0 ? 0 : windows.Max(w => Math.Max(Score((string)w["title"], name), Score((string)w["app"], name)));
                if (bestTab != null && bestScore >= 50 && (bestScore >= winScore || kind == "tab"))
                {
                    Native.Focus(bestWin);
                    Thread.Sleep(150);
                    return Activate(bestTab) ? "Switched to the \"" + bestName + "\" tab." : "Found the \"" + bestName + "\" tab but couldn't select it.";
                }
                if (kind == "tab") return "I couldn't find a tab called \"" + name + "\".";
            }
            var win = windows.Select(w => new { w, sc = Math.Max(Score((string)w["title"], name), Score((string)w["app"], name)) })
                .Where(x => x.sc > 0).OrderByDescending(x => x.sc).FirstOrDefault();
            if (win == null) return "I couldn't find a window or tab called \"" + name + "\".";
            Native.Focus(new IntPtr((long)win.w["hwnd"]));
            return "Switched to " + win.w["app"] + " (\"" + win.w["title"] + "\").";
        }
    }

    static class Apps
    {
        static Dictionary<string, string> cache;
        static DateTime cachedAt;

        public static string ProcessName(IntPtr hwnd)
        {
            try
            {
                uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
                var p = Process.GetProcessById((int)pid);
                try { var d = p.MainModule.FileVersionInfo.FileDescription; if (!string.IsNullOrWhiteSpace(d)) return d.Trim(); } catch { }
                return p.ProcessName;
            }
            catch { return null; }
        }

        /// Start menu apps: display name -> AppsFolder id.
        public static Dictionary<string, string> List()
        {
            if (cache != null && (DateTime.UtcNow - cachedAt).TotalMinutes < 10) return cache;
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var thread = new Thread(() =>
            {
                try
                {
                    var shellType = Type.GetTypeFromProgID("Shell.Application");
                    dynamic shell = Activator.CreateInstance(shellType);
                    dynamic folder = shell.NameSpace("shell:::{4234d49b-0245-4df3-b780-3893943456e1}");
                    foreach (dynamic item in folder.Items())
                    {
                        string name = item.Name, path = item.Path;
                        if (!string.IsNullOrEmpty(name) && !result.ContainsKey(name)) result[name] = path;
                    }
                }
                catch { }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join(8000);
            cache = result;
            cachedAt = DateTime.UtcNow;
            return result;
        }

        static string Norm(string s) { return new string((s ?? "").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray()); }

        static readonly Dictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { "chrome", "Google Chrome" }, { "edge", "Microsoft Edge" }, { "browser", "Microsoft Edge" }, { "word", "Word" }, { "excel", "Excel" },
            { "powerpoint", "PowerPoint" }, { "vscode", "Visual Studio Code" }, { "vs code", "Visual Studio Code" }, { "code", "Visual Studio Code" },
            { "explorer", "File Explorer" }, { "files", "File Explorer" }, { "finder", "File Explorer" }, { "terminal", "Terminal" },
            { "cmd", "Command Prompt" }, { "notes", "Sticky Notes" }, { "settings", "Settings" }, { "system settings", "Settings" },
            { "safari", "Microsoft Edge" }, { "calculator", "Calculator" }, { "paint", "Paint" }, { "spotify", "Spotify" },
        };

        public static string Open(string name)
        {
            name = (name ?? "").Trim();
            if (name.Length == 0) return "Which app?";
            string target;
            var wanted = Aliases.TryGetValue(name, out target) ? target : name;
            var key = Norm(wanted);

            // Already running? Bring its window to the front.
            IntPtr best = IntPtr.Zero; int bestScore = 0;
            Native.EnumWindows((h, l) =>
            {
                if (!Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return true;
                var title = Norm(Native.WindowTitle(h));
                var proc = Norm(ProcessName(h));
                int score = proc == key ? 3 : proc.Contains(key) || (key.Length > 3 && key.Contains(proc) && proc.Length > 3) ? 2 : title.EndsWith(key) ? 1 : 0;
                if (score > bestScore) { bestScore = score; best = h; }
                return true;
            }, IntPtr.Zero);
            if (best != IntPtr.Zero && bestScore >= 2)
            {
                Native.Focus(best);
                return "Switched to " + wanted + ".";
            }

            var apps = List();
            string id = null, display = null;
            foreach (var pair in apps)
            {
                var n = Norm(pair.Key);
                if (n == key) { id = pair.Value; display = pair.Key; break; }
            }
            if (id == null)
            {
                var match = apps.Where(p => Norm(p.Key).StartsWith(key)).OrderBy(p => p.Key.Length).FirstOrDefault();
                if (match.Key == null) match = apps.Where(p => Norm(p.Key).Contains(key)).OrderBy(p => p.Key.Length).FirstOrDefault();
                if (match.Key != null) { id = match.Value; display = match.Key; }
            }
            if (id == null)
            {
                if (best != IntPtr.Zero) { Native.Focus(best); return "Switched to " + wanted + "."; }
                return "I couldn't find an app called \"" + name + "\".";
            }
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + id) { UseShellExecute = true });
                return "Opened " + display + ".";
            }
            catch (Exception e) { return "I couldn't open " + display + ": " + e.Message; }
        }
    }

    // ───────────────────────────── Push-to-talk key hook ─────────────────────────────

    static class Hook
    {
        static Action<Dictionary<string, object>> emit;
        static Thread thread;
        static uint threadId;
        static Native.LowLevelKeyboardProc proc;
        static IntPtr handle;
        static volatile bool enabled = true;
        static volatile bool ctrl, alt, shift, win;
        static ushort chordKey = 0x20;
        static bool needCtrl = true, needAlt = true, needShift = false, needWin = false;
        static bool down;
        static DateTime downAt;

        public static void Start(Action<Dictionary<string, object>> e)
        {
            emit = e;
            thread = new Thread(Run) { IsBackground = true, Name = "hook" };
            thread.Start();
        }

        public static void Stop()
        {
            if (threadId != 0) Native.PostThreadMessage(threadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
        }

        public static void Configure(bool on, string chord)
        {
            enabled = on;
            List<ushort> keys; string label, error;
            if (!Input.Parse(chord, out keys, out label, out error) || keys.Count == 0) return;
            needCtrl = keys.Contains(0x11); needAlt = keys.Contains(0x12); needShift = keys.Contains(0x10); needWin = keys.Contains(0x5B);
            chordKey = keys.Last(k => k != 0x11 && k != 0x12 && k != 0x10 && k != 0x5B);
        }

        static void Run()
        {
            threadId = Native.GetCurrentThreadId();
            proc = Callback;
            handle = Native.SetWindowsHookEx(13, proc, Native.GetModuleHandle(null), 0);
            Native.MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { Native.TranslateMessage(ref msg); Native.DispatchMessage(ref msg); }
            Native.UnhookWindowsHookEx(handle);
        }

        static IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var info = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                int msg = wParam.ToInt32();
                bool isDown = msg == 0x0100 || msg == 0x0104, isUp = msg == 0x0101 || msg == 0x0105;
                uint vk = info.vkCode;
                bool injected = (info.flags & 0x10) != 0;
                if (vk == 0xA2 || vk == 0xA3 || vk == 0x11) ctrl = isDown || (!isUp && ctrl);
                if (vk == 0xA4 || vk == 0xA5 || vk == 0x12) alt = isDown || (!isUp && alt);
                if (vk == 0xA0 || vk == 0xA1 || vk == 0x10) shift = isDown || (!isUp && shift);
                if (vk == 0x5B || vk == 0x5C) win = isDown || (!isUp && win);
                if (enabled && !injected && vk == chordKey)
                {
                    bool mods = ctrl == needCtrl && alt == needAlt && (!needShift || shift) && (!needWin || win);
                    if (isDown && (mods || down))
                    {
                        if (!down)
                        {
                            down = true;
                            downAt = DateTime.UtcNow;
                            emit(new Dictionary<string, object> { { "event", "ptt" }, { "phase", "down" } });
                        }
                        return new IntPtr(1);  // swallow, including auto-repeat
                    }
                    if (isUp && down)
                    {
                        down = false;
                        emit(new Dictionary<string, object> { { "event", "ptt" }, { "phase", "up" }, { "ms", (DateTime.UtcNow - downAt).TotalMilliseconds } });
                        return new IntPtr(1);
                    }
                }
            }
            return Native.CallNextHookEx(handle, code, wParam, lParam);
        }
    }

    // ───────────────────────────── Win32 ─────────────────────────────

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
        [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, LowLevelKeyboardProc f, IntPtr mod, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);

        public static string WindowTitle(IntPtr h)
        {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        /// Windows only lets the foreground app hand focus away; a tap of Alt makes it allowed.
        public static void Focus(IntPtr h)
        {
            if (IsIconic(h)) ShowWindow(h, 9);
            keybd_event(0x12, 0, 0, IntPtr.Zero);
            keybd_event(0x12, 0, 2, IntPtr.Zero);
            SetForegroundWindow(h);
        }
    }
}
