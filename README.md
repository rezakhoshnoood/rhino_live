# Rhino Live Bridge v2.6.4

Real-time bridge between the AI chatbots you already use (ChatGPT, Claude, Gemini,
DeepSeek, Grok, Qwen, Mistral, Poe, Perplexity, Copilot ...) and **Rhino 7 / Rhino 8**.

The Chrome extension finds Rhino Python code in any chat answer, cleans it, sends it to
Rhino and runs it **step by step**. While it runs you see the **live Rhino viewport**,
a real progress bar, and a **verification report** that proves the code actually worked.

Designer: **Reza Khoshnood**

---

## What is new in 2.6.4

### The synced live viewport — now WITHOUT any .rhp plugin

Until now the live viewport only existed on the embedded-plugin path; with the
stand-alone server the panel answered `live view not supported here / live
viewport needs the embedded plugin`. That restriction is gone:

* The Rhino worker script (`rhino-plugin/install_plugin.py`) already runs
  **inside Rhino** — it is the thing executing your code. Since 2.6.4 it also
  captures the active view **on Rhino's main thread** (the same Idle event as
  code execution, three capture strategies, JPEG/PNG encode) and uploads the
  frames to the server (`POST /viewport_frame`, about one frame per second,
  and a fresh one after every executed step).
* The server caches the newest frame and serves it to the panel
  (`GET /viewport`), and tells the worker — inside every `/get_task` answer —
  when a panel is waiting, which width it wants, and whether **Fit** or the
  **⟳ refresh** button was pressed (Fit runs `ZoomExtents` in Rhino, then a
  new frame comes back).
* So the full setup with a synced live viewport is now just:
  `server/start_server.bat` + `install_plugin.py` in Rhino
  (EditPythonScript → open → F5) + the Chrome extension. **No plugin
  installation, no PluginManager.**

The embedded `.rhp` path keeps working exactly as before (same `/viewport`
shape), `/verify` and `/retry` still live there; on the server path `/status`
now reports viewport health (`frames`, `rev`, `age`, last capture `error`).

---

## What is new in 2.6.3

### 1. The live viewport heals itself (the fix you asked for)

In 2.6.2 the panel could stay black forever: the **first** failed frame capture
marked the viewport "unsupported" on the Rhino side, and the panel then **stopped
asking**. One transient hiccup — Rhino still starting, the view not painted yet,
the JPEG encoder busy — and the synced viewport was gone until Rhino restarted.

2.6.3 removes every one of those dead ends:

* **Retries, never surrender (bridge):** a failed capture is only counted.
  Captures keep being retried with backoff (`VIEWPORT_FAIL_INTERVAL`), the panel
  backs off to a slow retry instead of stopping the stream, and the first
  success flips everything back to healthy — no Rhino restart, no toggle dance.
* **Three capture strategies:** `RhinoView.CaptureToBitmap(Size)` →
  `Rhino.Display.ViewCapture` (plain int width/height, no `System.Drawing`
  needed) → native `CaptureToBitmap()` + resize. On Rhino 8 (.NET Core) the
  bridge explicitly loads `System.Drawing.Common` first, and every encode
  attempt (JPEG-quality → JPEG → PNG) gets a fresh stream.
* **Any view counts:** if Rhino reports no `ActiveView`, the first open model
  view is captured instead of nothing.
* **No more request pile-up (panel):** only one `/viewport` request is in
  flight at a time (the old 320 ms loop overlapped 1.5 s long-polls).
* **Never a silent black box:** until the first real frame arrives, the
  viewport area shows what is happening — "waiting for the first frame…",
  Rhino offline, or **Rhino's own error text** returned by `/viewport`.
  A frame is also accepted when its revision did not change but the panel
  was rebuilt (theme/language switch), which used to repaint nothing.
* **⟳ refresh button** in the viewport bar forces a fresh capture
  (`POST /viewport {"action":"capture"}`), next to Fit.

So the panel now shows the synced Rhino viewport continuously — while code
runs and while Rhino sits idle — and if a frame cannot be produced, it tells
you exactly why instead of showing nothing.

### 2. About tab: contact email

The popup About tab now shows **Email: [reza.khoshnoood@gmail.com](mailto:reza.khoshnoood@gmail.com)**
under the designer line.

---

## What is new in 2.6.2

### 1. "Download" can no longer break a run (the fix you asked for)

Some chat pages draw the code toolbar **inside the `<pre>`** - or as plain text
right before the code - so the block really does contain the words of the buttons:

```
Download
Copy code
Python
import rhinoscriptsyntax as rs       <-- the code starts only on line 4
```

Those words were carried into the **Manual Python Execution** box and Rhino died on
line 1 (`NameError: name 'Download' is not defined`) while the code *below* them was
perfect. 2.6.2 removes them before anything is sent:

* a whole line that is only a toolbar label is dropped (Copy, Copy code, Copy to
  clipboard, Download, Download code, Download file, Edit, Run, Save, Share, the
  language label Python / Python 3 / py / RhinoScript, `Python 3 ⤴`, `📋 Copy code`,
  `دانلود`, `کپی کد`, ... - 60+ labels in several languages, icons ignored);
* a label **glued** onto the code (`Downloadimport rhinoscriptsyntax...`,
  `rs.AddPoint((0,0,0))Copy code`) is cut off without touching quotes, so
  `name = "download"` and `download_file = open(path)` are never damaged;
* **indentation is preserved** while cutting, so a block never turns into an
  `IndentationError`;
* the count is visible: the box says `🧹 2 toolbar removed · 14 lines · 9 steps`.

The exact code the chat generated is what the box holds, and that is what is sent:
`POST /command {"type": "python", "code": <the box>}` — nothing is added.

Proof: `_test_extract.js` now renders the *same* script in **17 page shapes**
(9 renderers x toolbar variants) and asserts the extracted text is byte-identical
to the clean one and valid Python: **97 checks**.

### 2. A smarter panel

| New | What it does |
| --- | --- |
| **🧹 Clean** button | cleans the box on demand (same cleaner the automatic path uses) |
| **📋 Copy** button | puts the exact box content on the clipboard |
| **Run button states** | disabled while the box is empty, and labelled `▶ Run in Rhino · 4 ~steps` so you know what you are launching |
| **Live meta line** | `14 lines · 421 chars · 4 ~steps · auto-filled from the page` (or `edited by you`), plus `🧹 2 toolbar removed` when the cleaner had to work |
| **Toasts** | short, self-hiding confirmation for executed / failed / stopped / cleaned / copied - the status line stays for the detail |
| **Step + line range** | during a run the status reads `step 3/12 · lines 41-66` instead of a bare fraction |
| **Ctrl+Enter** | shown in the manual card header, runs the box |

The popup got the same treatment: `🧹 Clean`, `📋 Copy` and a live `lines · chars`
counter on its Code tab. It borrows the *same* cleaner from the page through a
message, so there is exactly one implementation and both boxes always agree.

### 3. Everything from 2.6.1 is still here

---

## What was new in 2.6.1

### 1. The automatic path sends exactly the code you see

Many chat pages draw a code block as **one `<div>` (or one `<br>`) per line**.
Those elements carry no newline characters, so reading their text produced a
script glued into a **single line**: it looked perfect on screen, but the code
that reached Rhino was not the code on the page, and it failed - while the very
same code pasted into the *Manual Python Execution* box ran fine.

2.6.1 rebuilds the line structure from the DOM (blocks, `<br>`, one-child-per-line
renderers, highlighted token spans, gutter columns) so all renderers produce the
identical, valid script, and the line detector also honours **computed styles**:
a `<span>` or `<div>` styled `display:block` / `flex` / `grid` starts a new line,
exactly as `innerText` would treat it.

### 2. One execution path: the manual box

The floating panel has its own **Manual Python Execution** box - the same box as the
popup Code tab, on the page itself.

* Detected code is placed in it, unchanged, the moment it is fetched.
* The automatic run and the ▶ button send **the same request**:
  `POST /command {"type": "python", "code": <what the box shows>}`.
* You may edit the box and press ▶ Run in Rhino (or Ctrl+Enter) - whatever is in the
  box is what runs. Both boxes (popup and panel) stay in sync.
* A successful run is never turned into a "failure" by verification: verification
  problems show as a ⚠️ warning instead of triggering a repair loop.

### 3. Long scripts are never cut off

A 40-step script can run longer than an HTTP request should stay open. The worker
gives `/command` and `/retry` a **240 s** budget (other calls stay at 12-40 s). If
that budget still ends first, the extension does **not** report a failure: it adopts
the running job, follows `/progress` every second, keeps the step counter and the
progress bar live, and finishes with the bridge's own `/verify` verdict.

### 4. Themes

Settings → 🎨 **Theme** offers **Dark**, **Light**, Midnight, Nord, Dracula and
Solarized. The choice applies to the popup *and* the floating panel (six palettes,
one setting, stored in `chrome.storage.local` under `theme`).

---

## What was new in 2.6.0

| Feature | What it does |
| --- | --- |
| **Live viewport** | The floating panel streams the active Rhino viewport (JPEG, ~3 fps) from `GET /viewport`, so you watch the model being built while the script runs. `Fit` button = `ZoomExtents`. |
| **Docking** | Drag the floating panel to the left or right edge of the browser and it snaps there. The dock button cycles `right → left → undocked`. |
| **Minimize / maximize / resize** | Header buttons collapse the panel to its title bar or expand it to a large layout; the corner grip changes width and height. Every state is remembered per browser. |
| **Cleanest possible code** | Every answer is cleaned before it is chunked: fences, line numbers, REPL prompts, chat chrome, curly quotes, `input()` calls and imports that cannot exist inside Rhino (`numpy`, `tkinter`, `PyQt`, `requests`, ...) are removed, and missing `import rhinoscriptsyntax as rs` is injected. |
| **Smart Prompt v2** | The 🧠 prompt now forces a single pure code block, forbids every extra module and every interactive call, and asks for short deterministic blocks that survive step-by-step execution. |
| **Self healing** | If a step raises (missing import, stray indent, unavailable module) the bridge repairs that step and retries it immediately - twice - without bothering you. |
| **Verification loop** | After every run the bridge checks the document: how many objects were created, whether they are valid, which steps ran, what was repaired. The panel shows `✅ Verified · objects 7 · 🔧 1 · ↻ 2/2`. |
| **Retry** | If a run still fails, the extension calls `POST /retry`: the bridge deletes the geometry the failed run left behind, repairs the script and runs it again (max 2 attempts). |
| **Dialog guard** | Scripts that call `rs.GetPoint`, `rs.GetObject`, `rs.MessageBox`, ... are refused **before** execution instead of freezing Rhino. |

Nothing else changed: the same panel ids, the same protocol, the same step-by-step engine.

---

## Install (5 minutes)

### 1. The Rhino plug-in (this is what talks to Chrome)

1. Open Rhino.
2. Command line: `PluginManager` → `Install...` → pick
   `rhino-plugin/rhp/built/RhinoLiveBridge.rhp`.
3. Restart Rhino once.

From now on the bridge starts **automatically with every Rhino session** - no console
window, no `start_server.bat`, no pip packages.

Commands inside Rhino:

| Command | Effect |
| --- | --- |
| `RhinoLiveBridge` | start / restart the bridge |
| `RhinoLiveBridgeStop` | stop it |
| `RhinoLiveBridgeStatus` | show bridge state, address, viewport and verification info |

Quick check: open <http://127.0.0.1:8765/status> - you should see
`"server": "running"`, `"engine": "embedded"`, `"version": "2.6.0"`.

### 2. The Chrome extension

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open any chat (for example <https://chatgpt.com>) - the floating panel appears.

---

## Use it

1. Ask the AI for Rhino Python code (or type your request and press 🧠 first).
2. The extension detects the code block, waits until it is stable, cleans it and sends it.
3. Rhino executes one step per idle tick - the progress bar and the live viewport follow.
4. When it finishes you get one of:
   * `✅ Verified in Rhino · objects N · ↻ 1/2` - everything ran, geometry is valid.
   * `⚠️ Verification failed` → the retry loop runs automatically (max 2 attempts).
   * `⛔ rs.GetPoint` → the script needs user input and cannot run live.

Panel controls:

* **Manual Python Execution box**: shows the detected script, editable, ▶ runs it.
* **Drag the header** to move, **drag to a browser edge** to dock.
* **—** minimize, **⤢** maximize, **⇢/⇠** dock cycle, **✕** close.
* **Corner grip** to resize; the live viewport keeps its aspect ratio.
* **▶ Run newest** re-runs the newest code block, **⏹ Stop** cancels the run.

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | liveness, busy flag, viewport + capabilities |
| POST | `/command` | `{"code": "...", "auto_repair": true, "auto_clean": true}` |
| GET | `/progress` | step, total, line range, repairs, elapsed |
| POST | `/cancel` | stop the running script |
| GET | `/viewport?rev=N&w=480` | one JPEG frame of the active view (base64) |
| POST | `/viewport` | `{"action":"fit"}` or `{"action":"capture"}` |
| GET | `/verify` | verification report of the last run |
| POST | `/retry` | clean the failed run, repair, run again |

`/verify` and `/retry` are answered by the embedded plugin. `/viewport` is answered
by both paths: the embedded plugin captures directly, the stand-alone server serves
the frames its Rhino worker script uploads (`POST /viewport_frame`).

---

## Verification loop (why you can trust it)

```
AI answer ──► clean ──► chunker ──► step 1 ─► step 2 ─► ... ─► check document
                 │                    │  (main thread, one step per idle tick)   │
                 │                    └── repair + retry the step if it raises ┘
                 └── forbidden imports removed, imports injected, dialogs refused
                                        │
                             objects created? valid? steps done?
                                        │
                          ✅ verified      or      ⚠️ /retry (max 2)
```

## No-plugin setup (server + worker script)

`server/start_server.bat` + `rhino-plugin/install_plugin.py` (open it in Rhino with
EditPythonScript and press F5) provide everything, **including the synced live
viewport**: the worker executes code on Rhino's main thread and uploads viewport
frames to the server. Only `/verify` and `/retry` remain exclusive to the embedded
`.rhp` plugin.

## Rebuild the plug-in

```
rhino-plugin/rhp/build_rhp.bat          (Windows: Rhino 7 + 8, net48)
rhino-plugin/rhp/build_rhp.sh           (macOS Rhino 8, net7.0)
dotnet run --project rhino-plugin/rhp/tools/RhpVerifier.csproj -c Release
```

---

## خلاصه فارسی

**Rhino Live Bridge نسخه ۲.۶.۴** کد پایتونی که هوش مصنوعی در چت تولید می‌کند را پیدا
می‌کند، تمیز می‌کند و مرحله‌به‌مرحله داخل راینو اجرا می‌کند.

* **پنل ویو (نمایش زنده ویوپورت):** تصویر ویوپورت راینو به صورت زنده و همگام با اجرای کد
  داخل پنل شناور نشان داده می‌شود؛ دکمه «فیت» هم دارد.
* **داک شدن:** پنل را به لبه چپ یا راست مرورگر بکشید تا بچسبد؛ دکمه داک هم چرخه‌ای کار می‌کند.
* **کوچک/بزرگ کردن و تغییر اندازه:** دکمه‌های هدر برای مینیمایز و مکسیمایز و گیره گوشه برای
  تغییر اندازه؛ همه تنظیمات ذخیره می‌شوند.
* **پرامپت هوشمند نسخه ۲:** ماژول‌های اضافی ممنوع، فقط یک بلوک کد تمیز و کوتاه، بدون دیالوگ.
* **اجرای مرحله‌به‌مرحله با نوار پیشرفت** در همان پنل.
* **حلقه اطمینان:** بعد از اجرا بررسی می‌شود چند آبجکت ساخته شده و آیا سالم هستند؛ اگر
  مرحله‌ای خطا بدهد، خودکار تعمیر و دوباره اجرا می‌شود (حداکثر ۲ بار) و هندسه ناقص پاک می‌شود.
* **محافظ دیالوگ:** کدی که منتظر ورودی کاربر است (مثل `rs.GetPoint`) قبل از اجرا رد می‌شود
  تا راینو قفل نشود.

**تازه‌های نسخه ۲.۶.۴:**

* **ویوپورت سینک‌شده بدون نصب هیچ پلاگینی:** تا حالا نمایش زنده فقط با پلاگین
  داخلی (‎.rhp) کار می‌کرد و با سرور جداگانه خطای «live view not supported» و
  «needs embedded plugin» می‌دادید. حالا همان اسکریپت ورکری که داخل راینو اجرا
  می‌شود (`install_plugin.py` — با EditPythonScript و F5) خودش تصویر نمای فعال
  راینو را روی نخ اصلی می‌گیرد، به سرور می‌فرستد (حدود یک فریم در ثانیه و یک
  فریم تازه بعد از هر مرحله از اجرا) و پنل همان را زنده و سینک نشان می‌دهد.
  دکمه‌های Fit و ⟳ هم از همین مسیر کار می‌کنند. یعنی برای ویوپورت زنده کافی
  است: `start_server.bat` + اجرای `install_plugin.py` در راینو + افزونهٔ کروم؛
  **بدون PluginManager و بدون نصب پلاگین.**

**تازه‌های نسخه ۲.۶.۳:**

* **ویوپورت زنده خودش را ترمیم می‌کند:** در نسخه قبل، اگر همان فریم اول گرفته نمی‌شد
  (راینو هنوز کامل بالا نیامده، نما هنوز رسم نشده، انکودر شلوغ)، ویوپورت برای همیشه
  «پشتیبانی نمی‌شود» علامت می‌خورد و پنل سیاه می‌ماند تا راینو ری‌استارت شود. حالا
  خطا فقط شمرده می‌شود؛ گرفتن فریم با فاصله دوباره تلاش می‌شود و اولین موفقیت، نمایش
  زنده را برمی‌گرداند. سه روش گرفتن تصویر امتحان می‌شود (`CaptureToBitmap` با اندازه،
  `ViewCapture` و گرفتن با اندازه اصلی + تغییر اندازه) و در راینو ۸ هم اسمبلی
  `System.Drawing.Common` صریحاً لود می‌شود.
* **دیگر جعبهٔ سیاهِ ساکت نداریم:** تا وقتی اولین فریم واقعی برسد، روی قسمت ویوپورت
  نوشته می‌شود چه خبر است: «در انتظار اولین فریم…»، در دسترس نبودن راینو، یا متن
  خطای خود راینو. دکمهٔ **⟳** هم کنار Fit اضافه شد تا هر لحظه یک فریم تازه بگیرید.
  فقط یک درخواست ویوپورت در هر لحظه در راه است و بعد از بازسازی پنل (تغییر تم یا
  زبان) هم همان فریم دوباره رسم می‌شود.
* **ایمیل در بخش About:** در تب «درباره» پاپ‌آپ، زیر نام طراح این خط اضافه شد:
  **Email: reza.khoshnoood@gmail.com**

**تازه‌های نسخه ۲.۶.۲:**

* **کلمهٔ «Download» دیگر اجرا را خراب نمی‌کند:** بعضی صفحه‌ها نوار ابزار کد (Download،
  Copy code، نام زبان) را *داخل* خود بلوک کد می‌کشند؛ این کلمه‌ها وارد باکس «اجرای دستی»
  می‌شدند و راینو روی خط اول خطا می‌داد. حالا قبل از ارسال حذف می‌شوند: خط‌هایی که فقط
  برچسب نوار ابزار هستند، برچسبی که به کد چسبیده (`Downloadimport ...`،
  `...AddPoint(...)Copy code`) و حتی شکل‌های آیکون‌دار یا فارسی (`دانلود`، `کپی کد`).
  تو رفتگی (indent) کد هرگز دست نمی‌خورد و رشته‌هایی مثل `"download"` هم سالم می‌مانند.
  هر بار حذف، در خط وضعیت با 🧹 شمرده می‌شود.
* **همان کدی که چت نوشته، همان چیزی که اجرا می‌شود:** باکس «اجرای دستی» عیناً همان کد
  تمیزشده را نگه می‌دارد و همان را می‌فرستد؛ هیچ چیزی اضافه یا بازنویسی نمی‌شود.
* **رابط کاربری هوشمندتر:** دکمهٔ **🧹 Clean**، دکمهٔ **📋 Copy**، دکمهٔ اجرا که تا
  خالی بودن جعبه غیرفعال است و تعداد مرحله را نشان می‌دهد (`▶ اجرا · ۴ مرحله`)، خط
  وضعیت زنده (`۱۴ خط · ۴۲۱ کاراکتر · ۴ مرحله · پر شده از صفحه`)، پیام‌های کوتاه
  Toast برای اجرا/خطا/توقف/پاک‌سازی، و نمایش مرحله همراه با محدودهٔ خطوط
  (`مرحله ۳/۱۲ · خط ۴۱-۶۶`). پاپ‌آپ هم همین دکمه‌ها و شمارنده را دارد.

**تازه‌های نسخه ۲.۶.۱:**

* **ریشه مشکل اجرای خودکار پیدا و رفع شد:** بعضی چت‌ها هر خط کد را در یک `div` جدا
  (یا با `<br>`) می‌کشند؛ این عناصر هیچ کاراکتر «خط جدید» ندارند، پس کدی که به راینو
  می‌رسید به هم چسبیده و تک‌خطی بود — ظاهر صفحه درست بود ولی کد اجراشدنی نبود. حالا
  ساختار خطوط از DOM بازسازی می‌شود و همهٔ رندرها همان کد سالم را می‌دهند.
* **باکس «اجرای دستی پایتون» روی پنل شناور:** کد تشخیص‌داده‌شده همان‌جا قرار می‌گیرد،
  قابل ویرایش است و با ▶ (یا Ctrl+Enter) اجرا می‌شود. مسیر خودکار و مسیر دستی **دقیقاً
  یک درخواست** می‌فرستند، پس هر چیزی که با پیست دستی کار می‌کند، خودکار هم کار می‌کند.
* **تم‌های متنوع:** در تنظیمات، تم را انتخاب کنید — تیره، روشن، نیمه‌شب، نورد، دراکولا و
  سولاریزه؛ هم روی پاپ‌آپ و هم روی پنل شناور اعمال می‌شود.

نصب (بدون پلاگین): `server/start_server.bat` را اجرا کنید، در راینو با
`EditPythonScript` فایل `rhino-plugin/install_plugin.py` را باز کنید و F5 بزنید،
سپس افزونه را در کروم لود کنید. مسیر پلاگین هم مثل قبل هست: یک بار `PluginManager`
در راینو و نصب `built/RhinoLiveBridge.rhp` تا پل خودش با باز شدن راینو روشن شود.
