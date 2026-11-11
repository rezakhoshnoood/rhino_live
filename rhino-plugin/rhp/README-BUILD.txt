================================================================
  RHINO LIVE BRIDGE - RHINO PLUGIN (.rhp)
  Version 2.6.4        Designer: Reza Khoshnood
================================================================

  What this is
  ------------
  A real Rhino plugin. Install it once, and from then on the bridge
  between your Chrome extension and Rhino starts BY ITSELF whenever
  Rhino starts.

  There is no background server to launch, no black console window,
  no start_server.bat to keep open. The whole bridge (the HTTP server
  on 127.0.0.1:8765 and the code execution engine) runs INSIDE Rhino,
  in the plugin, on Rhino's main thread.

  Old way:  start a server  ->  keep it open  ->  send code
  New way:  Rhino is open   ->  send code        (that is all)

  What is new in 2.6.3
  --------------------
   * LIVE VIEWPORT SELF HEALING - a failed frame capture no longer
     marks the viewport unsupported forever: captures are retried with
     backoff and the first success restores the stream. Three capture
     strategies (CaptureToBitmap(Size), ViewCapture, native size +
     resize) and three encoders (JPEG quality, JPEG, PNG) are tried,
     System.Drawing.Common is loaded explicitly on .NET Core
     (Rhino 8), and /viewport explains why no frame is available yet.
   * The Chrome panel shows that explanation inside the viewport area,
     keeps polling at a slow rate instead of stopping, accepts a frame
     whose revision did not change after a panel rebuild, and has a
     refresh (capture now) button next to Fit.
   * About tab of the popup now shows the contact email:
     Email: reza.khoshnoood@gmail.com

  What is new in 2.6.2
  --------------------
   * The C# shell is unchanged apart from the version stamp: the fix
     for the automatic path lives in the Chrome extension (a code
     block drawn as one <div> per line lost its newlines and reached
     Rhino as a single unusable line). The panel now also carries the
     same Manual Python Execution box as the popup and sends exactly
     the same request - the two paths can no longer differ.
   * LIVE VIEWPORT - GET /viewport returns a JPEG frame of the active
     view, captured on Rhino's main thread (RhinoView.CaptureToBitmap)
     at most a few times per second. The Chrome panel shows Rhino live
     while the script is running; POST /viewport {"action":"fit"}
     performs ZoomExtents and returns the new frame.
   * CODE CLEANUP - fences, line numbers, REPL prompts, chat chrome,
     curly quotes and imports that cannot work inside Rhino (numpy,
     tkinter, PyQt, requests, clr.AddReference, ...) are removed, and a
     missing "import rhinoscriptsyntax as rs" is injected.
   * SELF HEALING - a step that raises is repaired on the spot (missing
     import, stray indent, unavailable module) and retried, twice.
   * VERIFICATION - every run reports objects created, object validity,
     steps done, repairs and warnings: GET /verify.
   * RETRY - POST /retry deletes the geometry of the failed run, repairs
     the script and runs it again (max 2 attempts).
   * DIALOG GUARD - rs.GetPoint / rs.GetObject / rs.MessageBox and
     friends are refused before execution instead of freezing Rhino.

  Files in this folder
  --------------------
    build_rhp.bat          one click build for Windows
    build_rhp.sh           one click build for macOS / Linux
    RhinoLiveBridge.csproj the plugin project (net48 by default)
    RhinoLiveBridgePlugIn.cs the plugin source (C#)
    built/RhinoLiveBridge.rhp the compiled plugin - already built
    tools/RhpVerifier.cs   optional checker for a built .rhp
    tools/RhpVerifier.csproj
    README-BUILD.txt       this file

  HTTP endpoints served by the plugin (127.0.0.1:8765 only)
  ---------------------------------------------------------
    GET  /status     liveness, busy flag, viewport + capabilities
    POST /command    run a script step by step (auto_repair/auto_clean)
    GET  /progress   live step, lines, repairs, elapsed
    POST /cancel     stop the running script
    GET  /viewport   one JPEG frame (base64) of the active view
    POST /viewport   {"action":"fit"} | {"action":"capture"}
    GET  /verify     verification report of the last run
    POST /retry      clean the failed run, repair, run again
    GET  /get_task   compatibility shim (always "no task")
    POST /send_result compatibility shim

  The bridge itself (RhinoLiveBridge.py) sits one folder up. It is
  embedded inside the .rhp as a resource, so the .rhp file alone is
  everything that has to be installed - you never copy the .py file
  by hand.


================================================================
  1) INSTALL THE PLUGIN IN RHINO  (do this once)
================================================================

  Fastest path - the ready made plugin (Windows, Rhino 7 and 8):

   1. open Rhino
   2. type this command:            PluginManager
   3. press the button:             Install...
   4. pick this file:
          built\RhinoLiveBridge.rhp
   5. restart Rhino

  Restarting is important: the plugin loads at startup, and from that
  moment the bridge is already up. You do not have to run anything.

  On macOS (Rhino 8 for Mac) the prebuilt file will not load, because
  Mac Rhino runs plugins on a newer runtime. Build it once with
  build_rhp.sh - see section 2 - and install the file it produces.


================================================================
  2) BUILD IT YOURSELF  (optional, ~1 minute)
================================================================

  Windows:
      double click   build_rhp.bat

  macOS / Linux:
      open a terminal in this folder and run:   bash build_rhp.sh

  Both scripts:
    - check that RhinoLiveBridge.py exists one folder up
    - check that the free .NET SDK is installed, and tell you where
      to get it if it is not (https://dotnet.microsoft.com/download -
      the ".NET SDK", no Visual Studio needed)
    - download RhinoCommon from NuGet, so Rhino itself does not have
      to be installed on the build machine
    - produce   built/RhinoLiveBridge.rhp

  Windows builds target .NET Framework 4.8 (loads in Rhino 7 AND
  Rhino 8). The macOS script automatically targets net7.0 for
  Rhino 8 for Mac. You can force either one by hand:

      dotnet build RhinoLiveBridge.csproj -c Release -p:RhinoTarget=net48
      dotnet build RhinoLiveBridge.csproj -c Release -p:RhinoTarget=net7.0

  Want proof that the built file is a well formed Rhino plugin without
  opening Rhino? Run:

      dotnet run --project tools/RhpVerifier.csproj -c Release

  It reads the .rhp at the byte level and checks the same facts Rhino
  checks when loading a plugin: valid PE/CLR image, class derived
  from Rhino.PlugIns.PlugIn, [Guid] present, OnLoad and LoadTime are
  true overrides (that is what auto starts the bridge), the commands
  derive from Rhino.Commands.Command, and the embedded copy of
  RhinoLiveBridge.py is identical to the one in the repository.


================================================================
  3) USING IT
================================================================

  After the one time install, every time Rhino starts you will see
  this line in the command line:

      Rhino Live Bridge: bridge started in this Rhino session.

  The bridge is now listening on http://127.0.0.1:8765 and the Chrome
  extension connects to it by itself. Open your AI chat, and the code
  blocks it finds are implemented in Rhino step by step.

  Commands added to Rhino:

      RhinoLiveBridge         start or restart the bridge
      RhinoLiveBridgeStop     stop the bridge (frees port 8765)
      RhinoLiveBridgeStatus   show the current state

  Quick check that it is alive - open this in a browser:

      http://127.0.0.1:8765/status

  You should get JSON containing:

      "server": "running",  "rhino_connected": true,  "engine": "embedded"

  "engine": "embedded" means exactly what it says: the bridge is
  running inside Rhino, not in a separate program.

  A note about how code runs: a long script is cut into small,
  syntax safe steps, and exactly one step runs per idle tick of the
  Rhino main thread. That is why long code can never freeze or crash
  Rhino, and why the viewport stays responsive while a script runs.


================================================================
  4) UNINSTALL
================================================================

   1. in Rhino run:   PluginManager
   2. select "Rhino Live Bridge"
   3. press Uninstall, then restart Rhino

  Optional cleanup: the plugin extracts its python bridge to
      %APPDATA%\RhinoLiveBridge\
  Deleting that folder is harmless - it is recreated on the next load.


================================================================
  5) IF SOMETHING IS NOT RIGHT
================================================================

  Port 8765 is already in use
      Something else holds the port - usually an older bridge is still
      running from a previous setup (start_server.bat, or the old
      install_plugin.py). Close that window / stop that process, then
      run the RhinoLiveBridge command in Rhino to start the bridge
      again. RhinoLiveBridgeStatus shows the state.

  The extension says "Server offline"
      - run RhinoLiveBridgeStatus in Rhino and check "bridge started".
      - open http://127.0.0.1:8765/status in Chrome; if the JSON is
        there, the bridge is fine and the extension side needs a
        reload (chrome://extensions -> reload the Rhino extension).
      - if the JSON is missing, run the command RhinoLiveBridge.

  Rhino asks for confirmation about running a script
      That is Rhino's normal Python script prompt, shown once. Accept
      it; it will not ask again for this file.

  Nothing happens on a very old Rhino
      The plugin needs Rhino 7 or Rhino 8. In Rhino 6 the Python
      command set is different, so use the fallback path in
      ../install_plugin.py instead.

  Does this work on Rhino 7 and Rhino 8?
      Yes. The plugin is one file that works on both, and the python
      bridge inside it is written for IronPython 2.7 (Rhino 7) and
      CPython 3 (Rhino 8) at the same time. It uses no external
      packages - only what Rhino already ships with - so there is
      nothing to pip install and no admin rights needed.


================================================================
  6) خلاصه فارسی
================================================================

  این پوشه، پلاگین واقعی راینو با پسوند rhp است. یک بار نصبش کنید
  و از آن به بعد، هر وقت راینو باز می‌شود، پل ارتباطی بین افزونه
  کروم و راینو خودش روشن می‌شود.

  یعنی دیگر نه سرور در پس‌زمینه لازم است، نه پنجره مشکی کنسول، و نه
  فایل start_server.bat. کل سرور (پورت 8765) و اجرای کد، داخل خود
  راینو و روی ترد اصلی اجرا می‌شود.

  نصب یک‌باره:
     1) راینو را باز کنید
     2) دستور PluginManager را اجرا کنید
     3) دکمه Install... را بزنید
     4) فایل  built\RhinoLiveBridge.rhp  را انتخاب کنید
     5) راینو را یک بار بستن و باز کردن
  تمام. از این به بعد فقط راینو را باز کنید و کد را از چت بفرستید.

  دستورهای داخل راینو:
     RhinoLiveBridge        روشن / ری‌استارت پل
     RhinoLiveBridgeStop    خاموش کردن پل
     RhinoLiveBridgeStatus  نمایش وضعیت

  تست سریع: آدرس  http://127.0.0.1:8765/status  را در مرورگر باز
  کنید؛ باید در جواب، عبارت  "engine": "embedded"  را ببینید.

  اگر خواستید خودتان کامپایل کنید (اختیاری): در ویندوز فایل
  build_rhp.bat را دوبار کلیک کنید. اگر SDK دات‌نت نصب نباشد،
  خودش آدرس دانلود را نشان می‌دهد.

  نکته: کدهای طولانی به قطعه‌های کوچک و ایمن تقسیم می‌شوند و در هر
  تیک بیکاری راینو فقط یک قطعه اجرا می‌شود؛ به همین دلیل کد طولانی
  هرگز باعث هنگ کردن یا کرش راینو نمی‌شود.

  تازه‌های نسخه 2.6.3:
     - ویوپورت زنده خودترمیم: اگر گرفتن فریم یک بار خطا بدهد، دیگر
       برای همیشه «پشتیبانی نمی‌شود» نمی‌ماند؛ با فاصله دوباره تلاش
       می‌شود و اولین موفقیت نمایش زنده را برمی‌گرداند. سه روش گرفتن
       تصویر و سه روش انکود امتحان می‌شود و پنل علت نبودن فریم را روی
       همان قسمت ویوپورت می‌نویسد. دکمه تازه‌سازی (⟳) هم اضافه شد.
     - ایمیل طراح در تب «درباره» پاپ‌آپ: reza.khoshnoood@gmail.com

  تازه‌های نسخه 2.6.2:
     - نمایش زنده ویوپورت: مسیر /viewport تصویر ویوپورت فعال را به
       صورت JPEG می‌دهد و پنل کروم آن را زنده نشان می‌دهد. دکمه فیت
       هم کاری که می‌کند ZoomExtents است.
     - تمیزکاری کد: نام ماژول‌های غیرممکن (numpy، tkinter، PyQt، ...)
       حذف می‌شود، ایمپورت‌های لازم اضافه می‌شود و شماره‌خط‌ها، فنس‌های
       مارک‌داون و کاراکترهای عجیب پاک می‌شوند.
     - تعمیر خودکار: اگر یک مرحله خطا بدهد، همان‌جا تعمیر و دوباره
       اجرا می‌شود (حداکثر ۲ بار).
     - بررسی نتیجه: مسیر /verify گزارش می‌دهد چند آبجکت ساخته شده و
       آیا هندسه سالم است.
     - تلاش مجدد: مسیر /retry هندسه ناقص اجرای ناموفق را پاک می‌کند،
       کد را تعمیر می‌کند و دوباره اجرا می‌کند (حداکثر ۲ بار).
     - محافظ دیالوگ: کدی که منتظر ورودی کاربر است (rs.GetPoint و ...)
       قبل از اجرا رد می‌شود تا راینو قفل نشود.

================================================================
