/* ================================================================
   RHINO LIVE BRIDGE - POPUP SCRIPT
   Version: 2.6.4  |  Designer: Reza Khoshnood
   ----------------------------------------------------------------
   Written in defensive legacy style:
     - DOMContentLoaded initialisation (guarded against double wiring)
     - var (never const/let)
     - function declarations (never arrow functions)
     - .then() promise chains (never async/await)
   ================================================================ */

/* ---------------- CONSTANTS ---------------- */

var TEST_CODE = "import rhinoscriptsyntax as rs\n" +
                "import Rhino\n" +
                "center = Rhino.Geometry.Point3d(0, 0, 0)\n" +
                "rs.AddSphere(center, 8.0)";

var DEFAULT_PROMPT = [
  "[RHINO LIVE BRIDGE - EXPERT MODE]",
  "[CLEAN CODE MODE v2 - verified live execution]",
  "",
  "You are an expert Rhino 3D Python programmer. Generate code that runs flawlessly inside Rhino's Python Editor.",
  "",
  "STRICT RULES:",
  "",
  "ALLOWED imports ONLY:",
  "- import rhinoscriptsyntax as rs",
  "- import Rhino",
  "- import scriptcontext as sc",
  "- import math",
  "- import random",
  "",
  "PURITY RULES - the code must be the cleanest possible form:",
  "- ONE single python code block, nothing else in the answer except one short sentence.",
  "- No markdown inside the code, no line numbers, no comments explaining the answer.",
  "- No placeholder comments, no TODO, no pseudo code, no ellipses.",
  "- Code must run top to bottom in ONE pass, no prompts, no waiting for the user.",
  "- Define every function before it is called and never rely on variables from earlier answers.",
  "- Keep each logical block short (max 25 lines) so it can run step by step.",
  "",
  "FORBIDDEN - NEVER use (these break Rhino or the live bridge):",
  "- ANY import that is not in the ALLOWED list (numpy, scipy, pandas, matplotlib, PIL, cv2,",
  "  tkinter, PyQt, PySide, wx, requests, urllib, socket, flask, subprocess, os.system)",
  "- clr.AddReference, System.Windows.*, System.Drawing.* (use RGB tuples)",
  "- rs.GetPoint, rs.GetReal, rs.GetString, rs.GetObject, rs.GetInteger, rs.GetBoolean,",
  "  rs.GetLayer, rs.ListBox, rs.OpenFileName, rs.MessageBox, rs.EditBox (NO user dialogs)",
  "- input(), raw_input(), print() spam, infinite loops, while True",
  "- degenerate geometry (zero length curves, zero radius circles, NaN coordinates)",
  "",
  "MANDATORY RULES:",
  "1. Start with: import rhinoscriptsyntax as rs",
  "2. Use HARDCODED, deterministic values (no user input, no random unless asked)",
  "3. Wrap the code in a python code block delimited by three backtick characters",
  "4. For colors use RGB tuples: rs.ObjectColor(obj, (255,0,0))",
  "5. For points use [x,y,z] or Rhino.Geometry.Point3d(x,y,z)",
  "6. Build from the world origin (0,0,0) and keep names meaningful",
  "7. Never delete or undo geometry that already exists",
  "8. Guard every division and every list index (no ZeroDivisionError, no IndexError)",
  "9. Keep the script self contained: it may be executed twice by the verification loop",
  "10. Never create more than a few hundred objects per script",
  "",
  "USER REQUEST:"
].join("\n");

var CHATBOT_MAP = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "copilot.microsoft.com": "Copilot",
  "poe.com": "Poe",
  "perplexity.ai": "Perplexity",
  "www.perplexity.ai": "Perplexity",
  "chat.deepseek.com": "DeepSeek",
  "deepseek.com": "DeepSeek",
  "chat.mistral.ai": "Mistral",
  "you.com": "You.com",
  "huggingface.co": "HuggingChat",
  "pi.ai": "Pi.ai",
  "grok.com": "Grok",
  "x.com": "Grok",
  "chat.qwen.ai": "Qwen",
  "meta.ai": "Meta AI",
  "duckduckgo.com": "DuckDuckGo AI",
  "phind.com": "Phind"
};

/* ---------------- TRANSLATIONS ---------------- */

var T = {
  en: {
    tabMain: "🏠 Main",
    tabCode: "💻 Code",
    tabSettings: "⚙️ Settings",
    tabAbout: "ℹ️ About",

    progressTitle: "📈 Activity",
    idle: "Idle — waiting for code",
    waitingRhino: "Code sent, waiting for Rhino...",
    running: "Building in Rhino",
    lblStep: "Step",
    done: "Finished",
    cancelled: "Cancelled",
    failed: "Failed",
    busy: "Rhino is busy with another script",
    btnStop: "⏹ Stop",
    btnRunNewest: "▶ Run newest on page",

    t1name: "⚡ Main Service",
    t1desc: "🔴 MASTER OFF SWITCH: Turning this OFF completely disables the extension.",
    t2name: "🔴 Live Sync Mode",
    t2desc: "Auto-detect and execute AI-generated Rhino Python code in real-time.",
    t3name: "🧠 Smart Prompt",
    t3desc: "When ON, a 🧠 button appears on the Rhino Live floating panel. Type your request in the chatbox, click the 🧠 button on the panel, and your message gets enhanced with an engineered prompt that forces AI to generate ONLY clean, error-free Rhino Python code.",
    t4name: "👁️ Show Floating Panel",
    t4desc: "Show or hide the floating status panel on chatbot pages.",
    themeTitle: "🎨 Theme",
    themeDesc: "Pick the look of both the popup and the floating panel on the page.",
    themeDark: "Dark",
    themeLight: "Light",
    themeMidnight: "Midnight",
    themeNord: "Nord",
    themeDracula: "Dracula",
    themeSolarized: "Solarized",
    manualAutoHint: "The same box lives on the floating panel: detected code is placed there automatically and sent exactly as you see it.",
    t5name: "🦏 Live Rhino Viewport",
    t5desc: "Stream the active Rhino viewport into the floating panel, in sync with the running script.",
    lblVerify: "Verify",
    btnFitView: "🔍 Fit Rhino view",
    btnDockPanel: "⇤ Dock panel",

    statusTitle: "📡 Connection Status",
    lblServer: "Server:",
    lblRhino: "Rhino:",
    lblChatbot: "Chatbot:",
    connected: "Connected ✅",
    disconnected: "Disconnected ❌",
    waiting: "Server on, Rhino silent ⏳",

    logTitle: "📋 Live Log",
    btnClear: "Clear",
    logEmpty: "No log entries yet.",

    testTitle: "⚡ Quick Test",
    testDesc: "Sends a small test script to Rhino: a sphere of radius 8 at the world origin. Nothing is saved to your model until Rhino runs it.",
    btnTest: "🧪 Draw Test Sphere in Rhino",
    btnSending: "⏳ Sending...",

    pageTitle: "🌐 Code on this page",
    pageDesc: "Runs the newest Rhino Python block found in the chatbot page — perfect when Live Sync is paused or the code was generated before the extension was loaded.",
    btnPageRun: "▶ Run newest code block on the page",
    pageSent: "Asked the page to run its newest code block.",

    manualTitle: "Manual Python Execution",
    manualPh: "import rhinoscriptsyntax as rs\nrs.AddSphere((0,0,0), 5)",
    btnRun: "🚀 Run in Rhino",
    manualHint: "Long scripts are executed step by step, so Rhino stays responsive and never freezes.",

    langLabel: "Language",
    srvLabel: "Server URL",
    btnClean: "🧹 Clean",
    btnCopyCode: "📋 Copy",
    cleanHint: "Clean removes toolbar words that some chat pages glue onto the code (Download, Copy code, a language label) - those words are not Python and break the run.",
    cleanDone: "Toolbar words removed: ",
    cleanNone: "Nothing to clean - the code is already exact.",
    copied: "The code is on your clipboard.",
    manualStat: "lines",
    manualChars: "chars",
    btnSave: "Save",
    promptTitle: "🧠 Smart Prompt Template",
    btnSave2: "Save",
    btnReset: "Reset to Default",
    promptHint: "The template also tells the AI to keep the code modular, so step-by-step execution stays smooth.",
    saved: "Settings saved.",
    promptSaved: "Smart prompt template saved.",
    promptReset: "Smart prompt template reset to default.",
    logCleared: "Log cleared.",

    aboutDesc: "A live bridge between AI chatbots and McNeel Rhino 3D. It watches the chatbot page for Rhino Python code, sends it to a local bridge server, and Rhino executes it instantly — no copy-paste needed.",
    aboutFoot: "Built with a FastAPI bridge server + Rhino polling worker.",

    logSent: "Sending code to Rhino...",
    logOk: "Executed successfully!",
    logFail: "Rhino error: ",
    logTimeout: "Rhino timeout (no answer in time).",
    logOffline: "Server unreachable. Is start_server.bat running?",
    needCode: "Write some Python code first.",
    logCancelled: "Run cancelled."
  },

  fa: {
    tabMain: "🏠 اصلی",
    tabCode: "💻 کد",
    tabSettings: "⚙️ تنظیمات",
    tabAbout: "ℹ️ درباره",

    progressTitle: "📈 فعالیت",
    idle: "بی‌کار — در انتظار کد",
    waitingRhino: "کد ارسال شد، در انتظار راینو...",
    running: "در حال ساخت در راینو",
    lblStep: "مرحله",
    done: "پایان یافت",
    cancelled: "لغو شد",
    failed: "ناموفق",
    busy: "راینو با اسکریپت دیگری مشغول است",
    btnStop: "⏹ توقف",
    btnRunNewest: "▶ اجرای آخرین کد صفحه",

    t1name: "⚡ سرویس اصلی",
    t1desc: "🔴 کلید اصلی خاموش/روشن: کل اکستنشن را غیرفعال می‌کند.",
    t2name: "🔴 همگام‌سازی زنده",
    t2desc: "تشخیص و اجرای خودکار کدهای پایتون راینو تولید شده توسط AI به صورت بلادرنگ.",
    t3name: "🧠 پرامپت هوشمند",
    t3desc: "وقتی روشن است، یک دکمه 🧠 روی پنل شناور Rhino Live ظاهر می‌شود. درخواست خود را در باکس چت تایپ کنید، روی دکمه 🧠 کلیک کنید، پیام شما با یک پرامپت مهندسی‌شده قوی جایگزین می‌شود.",
    t4name: "👁️ نمایش پنل شناور",
    t4desc: "نمایش یا پنهان کردن پنل وضعیت شناور.",
    themeTitle: "🎨 تم",
    themeDesc: "ظاهر پاپ‌آپ و پنل شناور روی صفحه را انتخاب کنید.",
    themeDark: "تیره",
    themeLight: "روشن",
    themeMidnight: "نیمه‌شب",
    themeNord: "نورد",
    themeDracula: "دراکولا",
    themeSolarized: "سولاریزه",
    manualAutoHint: "همین باکس روی پنل شناور هم هست: کد تشخیص‌داده‌شده خودکار آنجا قرار می‌گیرد و دقیقاً همان‌طور که می‌بینید ارسال می‌شود.",
    t5name: "🦏 ویوپورت زنده راینو",
    t5desc: "ویوپورت فعال راینو به صورت زنده و همگام با اجرای کد در پنل شناور نمایش داده می‌شود.",
    lblVerify: "بررسی",
    btnFitView: "🔍 فیت ویو راینو",
    btnDockPanel: "⇤ چسباندن پنل",

    statusTitle: "📡 وضعیت اتصال",
    lblServer: "سرور:",
    lblRhino: "راینو:",
    lblChatbot: "چت‌بات:",
    connected: "متصل ✅",
    disconnected: "قطع ❌",
    waiting: "سرور روشن، راینو ساکت ⏳",

    logTitle: "📋 گزارش زنده",
    btnClear: "پاک کردن",
    logEmpty: "هنوز گزارش‌ی ثبت نشده است.",

    testTitle: "⚡ تست سریع",
    testDesc: "یک اسکریپت آزمایشی به راینو ارسال می‌کند: یک کره با شعاع ۸ در مبدأ مختصات. تا زمانی که راینو آن را اجرا نکند چیزی در مدل شما ذخیره نمی‌شود.",
    btnTest: "🧪 رسم کره آزمایشی در راینو",
    btnSending: "⏳ در حال ارسال...",

    pageTitle: "🌐 کد موجود در این صفحه",
    pageDesc: "آخرین بلوک کد پایتون راینو موجود در صفحه چت را اجرا می‌کند — عالی برای زمانی که همگام‌سازی زنده خاموش است یا کد قبل از بارگذاری اکستنشن تولید شده.",
    btnPageRun: "▶ اجرای آخرین بلوک کد صفحه",
    pageSent: "درخواست اجرای آخرین بلوک کد به صفحه ارسال شد.",

    manualTitle: "اجرای دستی پایتون",
    manualPh: "import rhinoscriptsyntax as rs\nrs.AddSphere((0,0,0), 5)",
    btnRun: "🚀 اجرا در راینو",
    manualHint: "اسکریپت‌های طولانی مرحله‌به‌مرحله اجرا می‌شوند تا راینو پایدار بماند و هرگز هنگ نکند.",

    langLabel: "زبان",
    srvLabel: "آدرس سرور",
    btnClean: "🧹 پاک‌سازی",
    btnCopyCode: "📋 کپی",
    cleanHint: "پاک‌سازی، کلمه‌های نوار ابزار را که بعضی صفحه‌های چت به کد می‌چسبانند (Download، Copy code، نام زبان) حذف می‌کند؛ این کلمه‌ها پایتون نیستند و اجرا را خراب می‌کنند.",
    cleanDone: "کلمه‌های نوار ابزار حذف شد: ",
    cleanNone: "چیزی برای پاک‌سازی نبود - کد از قبل دقیق است.",
    copied: "کد در حافظه کپی شد.",
    manualStat: "خط",
    manualChars: "کاراکتر",
    btnSave: "ذخیره",
    promptTitle: "🧠 قالب پرامپت هوشمند",
    btnSave2: "ذخیره",
    btnReset: "بازگشت به پیش‌فرض",
    promptHint: "این قالب به هوش مصنوعی می‌گوید کد را ماژولار بنویسد تا اجرای مرحله‌به‌مرحله روان بماند.",
    saved: "تنظیمات ذخیره شد.",
    promptSaved: "قالب پرامپت هوشمند ذخیره شد.",
    promptReset: "قالب پرامپت هوشمند به حالت پیش‌فرض بازگشت.",
    logCleared: "گزارش پاک شد.",

    aboutDesc: "پلی زنده بین چت‌بات‌های هوش مصنوعی و نرم‌افزار McNeel Rhino 3D. کدهای پایتون راینو در صفحه چت شناسایی می‌شوند، به سرور محلی ارسال می‌گردند و راینو آن‌ها را فوراً اجرا می‌کند — بدون کپی و پیست دستی.",
    aboutFoot: "ساخته‌شده با سرور پل FastAPI و وورکر پولینگ راینو.",

    logSent: "ارسال کد به راینو...",
    logOk: "با موفقیت اجرا شد!",
    logFail: "خطای راینو: ",
    logTimeout: "مهلت تمام شد (پاسخی از راینو دریافت نشد).",
    logOffline: "سرور در دسترس نیست. آیا start_server.bat اجرا شده است؟",
    needCode: "ابتدا چند خط کد پایتون بنویسید.",
    logCancelled: "اجرا لغو شد."
  }
};

/* ---------------- MODULE STATE ---------------- */

var lang = "en";
var srvUrl = "http://127.0.0.1:8765";
var serviceOn = true;
var liveOn = true;
var smartOn = true;
var panelOn = true;
var viewOn = true;          /* live Rhino viewport in the floating panel */
var customPrompt = DEFAULT_PROMPT;
var statusTimer = null;
var progressTimer = null;
var lastActivity = { active: false, step: 0, total: 0 };

/* ================================================================
   HELPERS
   ================================================================ */

function $(id) {
  return document.getElementById(id);
}

function t(key) {
  var pack = T[lang] ? T[lang] : T.en;
  if (pack[key] !== undefined) {
    return pack[key];
  }
  if (T.en[key] !== undefined) {
    return T.en[key];
  }
  return key;
}

function applyLang() {
  var body = document.body;
  body.className = (lang === "fa") ? "rtl" : "ltr";
  body.setAttribute("dir", (lang === "fa") ? "rtl" : "ltr");

  var nodes = document.querySelectorAll("[data-i18n]");
  var i;
  for (i = 0; i < nodes.length; i++) {
    nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
  }

  var ph = document.querySelectorAll("[data-i18n-ph]");
  for (i = 0; i < ph.length; i++) {
    ph[i].setAttribute("placeholder", t(ph[i].getAttribute("data-i18n-ph")));
  }

  document.title = "Rhino Live Bridge";
  renderActivity(lastActivity);
}

function timeStamp() {
  var d = new Date();
  return d.toLocaleTimeString();
}

/* Append a line to chrome.storage.local "logs" (keeps the last 15). */
function addLog(msg) {
  var line = "[" + timeStamp() + "] " + msg;
  chrome.storage.local.get(["logs"], function (data) {
    var logs = (data && data.logs) ? data.logs : [];
    logs.push(line);
    while (logs.length > 15) {
      logs.shift();
    }
    chrome.storage.local.set({ logs: logs }, function () {
      renderLogs(logs);
    });
  });
}

function renderLogs(logs) {
  var box = $("logBox");
  if (!box) {
    return;
  }
  if (!logs || logs.length === 0) {
    box.textContent = t("logEmpty");
    return;
  }
  box.textContent = logs.join("\n");
  box.scrollTop = box.scrollHeight;
}

/* Send a message to the content script of the active tab. */
function sendToContent(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      return;
    }
    var tabId = tabs[0].id;
    if (tabId === undefined || tabId === null) {
      return;
    }
    chrome.tabs.sendMessage(tabId, message, function () {
      /* Reading lastError silences "no receiving end" errors on
         pages where the content script is not injected. */
      if (chrome.runtime.lastError) {
        /* silently ignored */
      }
    });
  });
}

/* ================================================================
   BRIDGE TRANSPORT
   ----------------------------------------------------------------
   The popup is an extension page, so a direct fetch to 127.0.0.1 is
   allowed. It still prefers the background service worker, because
   that keeps one single code path for every request in the extension
   and survives Chrome's local network restrictions on some builds.
   ================================================================ */

function bridgeFetch(path, method, body, onDone) {
  var answered = false;

  function finish(error, data) {
    if (answered) {
      return;
    }
    answered = true;
    onDone(error, data);
  }

  function direct(reason) {
    var options = { method: method, cache: "no-store" };
    if (body !== undefined && body !== null && method !== "GET") {
      options.headers = { "Content-Type": "application/json" };
      options.body = (typeof body === "string") ? body : JSON.stringify(body);
    }
    fetch(srvUrl + path, options)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        finish(null, data);
      })
      .catch(function (err) {
        finish(reason ? reason : new Error(String((err && err.message) ? err.message : err)), null);
      });
  }

  try {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      direct(new Error("no runtime"));
      return;
    }
    chrome.runtime.sendMessage(
      { type: "bridge", path: path, method: method, body: body, server: srvUrl },
      function (response) {
        if (chrome.runtime.lastError) {
          direct(new Error("worker unavailable"));
          return;
        }
        if (!response) {
          direct(new Error("empty worker answer"));
          return;
        }
        if (response.ok) {
          finish(null, response.data);
        } else {
          finish(new Error(response.error ? response.error : "worker error"), null);
        }
      }
    );
  } catch (e) {
    direct(new Error(String(e && e.message ? e.message : e)));
  }
}

/* ================================================================
   CHATBOT DETECTION  (from the active tab URL, not from content.js)
   ================================================================ */

function chatbotFromUrl(url) {
  var hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return "—";
  }
  if (CHATBOT_MAP[hostname]) {
    return CHATBOT_MAP[hostname];
  }
  var lower = hostname.toLowerCase();
  if (lower.indexOf("chat") >= 0 || lower.indexOf("ai") >= 0 || lower.indexOf("gpt") >= 0) {
    return "AI(" + hostname + ")";
  }
  return hostname;
}

function refreshChatbotBadge() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var name = "—";
    if (tabs && tabs.length > 0 && tabs[0].url) {
      name = chatbotFromUrl(tabs[0].url);
    }
    var el = $("txtChatbot");
    if (el) {
      el.textContent = name;
    }
  });
}

/* ================================================================
   SERVER STATUS  (polled every 2 seconds)
   ================================================================ */

function setDot(dotId, txtId, state, text) {
  var dot = $(dotId);
  var txt = $(txtId);
  if (dot) {
    dot.className = "dot " + state;
  }
  if (txt) {
    txt.textContent = text;
  }
}

function checkStatus() {
  bridgeFetch("/status", "GET", null, function (error, data) {
    if (error) {
      setDot("dotServer", "txtServer", "bad", t("disconnected"));
      setDot("dotRhino", "txtRhino", "bad", t("disconnected"));
      return;
    }
    applyStatus(data);
  });
}

function applyStatus(data) {
  setDot("dotServer", "txtServer", "ok", t("connected"));

  /* rhino_seen is true when the Rhino worker polled recently */
  var rhinoAlive = data && (data.rhino_seen === true ||
                            (data.rhino_seen === undefined && data.rhino_connected === true));
  if (rhinoAlive) {
    setDot("dotRhino", "txtRhino", "ok", t("connected"));
  } else {
    setDot("dotRhino", "txtRhino", "warn", t("waiting"));
  }
}

/* ================================================================
   ACTIVITY / PROGRESS  (polled every 700 ms)
   ================================================================ */

function setProgress(ratio) {
  var fill = $("progressFill");
  if (!fill) {
    return;
  }
  var safe = ratio;
  if (!safe || safe < 0) {
    safe = 0;
  }
  if (safe > 1) {
    safe = 1;
  }
  fill.style.width = Math.round(safe * 100) + "%";
}

function renderActivity(data) {
  var text = $("activityText");
  var stop = $("btnStop");
  if (!text) {
    return;
  }

  lastActivity = data ? data : { active: false, step: 0, total: 0 };

  if (data && data.active) {
    var total = data.total ? data.total : 0;
    var step = data.step ? data.step : 0;
    if (total > 1) {
      text.className = "activity-text busy";
      text.textContent = t("running") + " — " + t("lblStep") + " " + step + "/" + total;
      setProgress(step / total);
    } else {
      text.className = "activity-text busy";
      text.textContent = t("waitingRhino");
      setProgress(0.2);
    }
    if (stop) {
      stop.disabled = false;
    }
    return;
  }

  if (stop) {
    stop.disabled = true;
  }

  if (data && data.success === true) {
    text.className = "activity-text ok";
    text.textContent = t("done") + " ✅" + (data.total > 1 ? " (" + data.total + " steps)" : "");
    setProgress(1);
    return;
  }

  if (data && data.cancelled) {
    text.className = "activity-text";
    text.textContent = t("cancelled") + " ⏹";
    setProgress(0);
    return;
  }

  if (data && data.success === false && data.error) {
    text.className = "activity-text bad";
    text.textContent = t("failed") + " ❌ " + data.error;
    setProgress(0);
    return;
  }

  text.className = "activity-text";
  text.textContent = t("idle");
  setProgress(0);
}

function pollProgress() {
  bridgeFetch("/progress", "GET", null, function (error, data) {
    if (error) {
      /* keep the last known state when the server is unreachable */
      return;
    }
    renderActivity(data);
  });

  /* 2.6.2: the verification report of the last run */
  verifyTick = verifyTick + 1;
  if (verifyTick % 3 === 0) {
    bridgeFetch("/verify", "GET", null, function (error, data) {
      if (!error) {
        paintVerifyText(data);
      }
    });
  }
}

var verifyTick = 0;

/* ================================================================
   EXECUTION VIA THE BRIDGE SERVER
   ================================================================ */

function runOnServer(code, onDone) {
  addLog(t("logSent"));
  bridgeFetch("/command", "POST", { type: "python", code: code },
    function (error, data) {
      if (error) {
        addLog(t("logOffline"));
        if (onDone) {
          onDone();
        }
        return;
      }
      {
        paintVerifyText(data && data.verify ? data.verify : null);
        if (data && data.success) {
        addLog(t("logOk"));
      } else {
        var err = (data && data.error) ? data.error : "";
        if (err.indexOf("Cancelled") >= 0) {
          addLog(t("logCancelled"));
        } else if (err.toLowerCase().indexOf("timeout") >= 0) {
          addLog(t("logTimeout"));
        } else if (err) {
          addLog(t("logFail") + err);
        }
      }
      pollProgress();
      if (onDone) {
        onDone();
      }
    }
  });
}

function stopRun() {
  /* tell the page immediately (it drops its waiting queue right away),
     then tell the bridge server (it tells Rhino to stop) */
  sendToContent({ action: "cancel" });

  bridgeFetch("/cancel", "POST", {}, function (error) {
    if (error) {
      addLog(t("logOffline"));
      return;
    }
    addLog(t("logCancelled"));
    pollProgress();
  });
}

/* ================================================================
   TOGGLES
   ================================================================ */

function paintToggle(el, on, purple) {
  if (!el) {
    return;
  }
  if (on) {
    el.className = purple ? "toggle on-purple" : "toggle on";
  } else {
    el.className = "toggle";
  }
}

function initToggles() {
  var elService = $("tService");
  var elLive = $("tLive");
  var elSmart = $("tSmart");
  var elPanel = $("tPanel");

  elService.addEventListener("click", function () {
    serviceOn = !serviceOn;
    paintToggle(elService, serviceOn, false);
    chrome.storage.local.set({ service: serviceOn });
    sendToContent({ action: "setService", value: serviceOn });
    addLog("Main Service: " + (serviceOn ? "ON" : "OFF"));
  });

  elLive.addEventListener("click", function () {
    liveOn = !liveOn;
    paintToggle(elLive, liveOn, false);
    chrome.storage.local.set({ live: liveOn });
    sendToContent({ action: "setLive", value: liveOn });
    addLog("Live Sync: " + (liveOn ? "ON" : "OFF"));
  });

  elSmart.addEventListener("click", function () {
    smartOn = !smartOn;
    paintToggle(elSmart, smartOn, true);
    chrome.storage.local.set({ smart: smartOn });
    sendToContent({ action: "setSmart", value: smartOn });
    addLog("Smart Prompt: " + (smartOn ? "ON" : "OFF"));
  });

  elPanel.addEventListener("click", function () {
    panelOn = !panelOn;
    paintToggle(elPanel, panelOn, false);
    chrome.storage.local.set({ panel: panelOn });
    sendToContent({ action: "setPanel", value: panelOn });
    addLog("Floating Panel: " + (panelOn ? "ON" : "OFF"));
  });

  var elView = $("tView");
  if (elView) {
    elView.addEventListener("click", function () {
      viewOn = !viewOn;
      paintToggle(elView, viewOn, false);
      chrome.storage.local.set({ viewEnable: viewOn });
      sendToContent({ action: "setView", value: viewOn });
      addLog("Live Viewport: " + (viewOn ? "ON" : "OFF"));
    });
  }
}

/* ----------------------------------------------------------------
   2.6.2 controls: fit the Rhino view and dock the panel
   ---------------------------------------------------------------- */
function initViewControls() {
  var fitBtn = $("btnFitView");
  if (fitBtn) {
    fitBtn.addEventListener("click", function () {
      sendToContent({ action: "fitView" });
      addLog("Asked Rhino to fit the view.");
    });
  }

  var dockBtn = $("btnDockPanel");
  if (dockBtn) {
    dockBtn.addEventListener("click", function () {
      var next = (dockCycle === "" || dockCycle === "right") ? "left" : "";
      dockCycle = next;
      chrome.storage.local.set({ panelDock: next });
      sendToContent({ action: "setDock", value: next });
      addLog(next ? ("Panel docked to the " + next + " edge.") : "Panel undocked.");
    });
  }
}

var dockCycle = "";

var THEME_NAMES = ["dark", "light", "midnight", "nord", "dracula", "solarized"];
var theme = "dark";
var manualDirty = false;

/* Apply a theme to the popup and tell the floating panel to follow. */
function applyTheme(name) {
  theme = (THEME_NAMES.indexOf(name) >= 0) ? name : "dark";
  try {
    document.body.setAttribute("data-theme", theme);
  } catch (e) {
    /* the popup still works without theming */
  }
  var chips = document.querySelectorAll(".theme-chip");
  var i;
  for (i = 0; i < chips.length; i++) {
    if (chips[i].getAttribute("data-theme") === theme) {
      chips[i].className = "theme-chip active";
    } else {
      chips[i].className = "theme-chip";
    }
  }
}

function initThemePicker() {
  var chips = document.querySelectorAll(".theme-chip");
  var i;
  for (i = 0; i < chips.length; i++) {
    chips[i].addEventListener("click", function (ev) {
      var chosen = ev.currentTarget.getAttribute("data-theme");
      applyTheme(chosen);
      chrome.storage.local.set({ theme: chosen });
      sendToContent({ action: "setTheme", value: chosen });
      addLog("Theme: " + chosen);
    });
  }
}

/* The floating panel fills the shared manual box; this keeps the popup
   copy identical so the user always sees the code that is being run. */
function setManualCode(code) {
  var area = $("manualCode");
  if (!area) {
    return;
  }
  area.value = code ? code : "";
  manualDirty = false;
  updateManualMeta();
}

/* lines / characters / approximate steps of the box, so the user can
   see at a glance that a short "code" is really a toolbar accident */
function updateManualMeta() {
  var area = $("manualCode");
  var meta = $("manualMeta");
  if (!meta) {
    return;
  }
  var text = area && area.value ? area.value : "";
  if (text.replace(/\s/g, "").length === 0) {
    meta.textContent = "0 " + t("manualStat");
    meta.className = "manual-meta";
    return;
  }
  var lines = text.split("\n").length;
  meta.textContent = lines + " " + t("manualStat") + " · " + text.length + " " + t("manualChars");
  meta.className = "manual-meta";
}

/* The cleaner lives in content.js (one implementation). The popup asks
   the page for it; if no chat tab is open it cleans nothing and says so. */
function cleanManualBox() {
  var area = $("manualCode");
  if (!area) {
    return;
  }
  var text = area.value ? area.value : "";
  if (text.replace(/\s/g, "").length === 0) {
    addLog(t("needCode"));
    return;
  }
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = (tabs && tabs.length) ? tabs[0] : null;
      if (!tab || !tab.id) {
        addLog(t("cleanNone"));
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: "cleanCode", value: text }, function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          addLog(t("cleanNone"));
          return;
        }
        if (response.removed > 0) {
          area.value = response.code;
          manualDirty = true;
          chrome.storage.local.set({ manualCode: response.code, manualStamp: new Date().getTime() });
          sendToContent({ action: "setManualCode", value: response.code });
          addLog(t("cleanDone") + response.removed);
        } else {
          addLog(t("cleanNone"));
        }
        updateManualMeta();
      });
    });
  } catch (e) {
    addLog(t("cleanNone"));
  }
}

function copyManualBox() {
  var area = $("manualCode");
  var text = area && area.value ? area.value : "";
  if (text.replace(/\s/g, "").length === 0) {
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      addLog(t("copied"));
      return;
    }
  } catch (e) {
    /* fall through */
  }
  try {
    area.select();
    document.execCommand("copy");
    addLog(t("copied"));
  } catch (e2) {
    /* clipboard blocked - nothing else to try */
  }
}

/* Show the verification report of the last run in the popup. */
function paintVerifyText(verify) {
  var el = $("txtVerify");
  if (!el) {
    return;
  }
  if (!verify || verify.available === false) {
    el.textContent = "—";
    return;
  }
  var parts = [];
  parts.push(verify.ok ? "✅ " + (verify.objects_created !== null &&
                                  verify.objects_created !== undefined
                                  ? verify.objects_created + " obj" : "ok")
                       : "⚠️ failed");
  if (verify.repairs && verify.repairs.length) {
    parts.push("🔧 " + verify.repairs.length);
  }
  if (verify.attempt) {
    parts.push("↻ " + verify.attempt + "/" + (verify.max_attempts ? verify.max_attempts : 2));
  }
  el.textContent = parts.join(" · ");
}

/* ================================================================
   TABS
   ================================================================ */

function initTabs() {
  var buttons = document.querySelectorAll(".tab-btn");
  var i;
  for (i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (ev) {
      var btn = ev.currentTarget;
      var targetId = btn.getAttribute("data-tab");

      var all = document.querySelectorAll(".tab-btn");
      var k;
      for (k = 0; k < all.length; k++) {
        all[k].className = "tab-btn";
      }
      btn.className = "tab-btn active";

      var panels = document.querySelectorAll(".tab-panel");
      for (k = 0; k < panels.length; k++) {
        panels[k].className = "tab-panel";
      }
      var panel = document.getElementById(targetId);
      if (panel) {
        panel.className = "tab-panel active";
      }
    });
  }
}

/* ================================================================
   TAB 1 - MAIN TAB (activity controls)
   ================================================================ */

function initMainTab() {
  $("btnStop").addEventListener("click", function () {
    stopRun();
  });

  $("btnRunNewest").addEventListener("click", function () {
    sendToContent({ action: "runNewest" });
    addLog(t("pageSent"));
  });

  $("btnClearLog").addEventListener("click", function () {
    chrome.storage.local.set({ logs: [] }, function () {
      renderLogs([]);
      addLog(t("logCleared"));
    });
  });
}

/* ================================================================
   TAB 2 - CODE TAB
   ================================================================ */

function initCodeTab() {
  var btnTest = $("btnTest");
  var btnRun = $("btnRun");

  btnTest.addEventListener("click", function () {
    var original = t("btnTest");
    btnTest.textContent = t("btnSending");
    btnTest.disabled = true;
    runOnServer(TEST_CODE, function () {
      btnTest.textContent = original;
      btnTest.disabled = false;
    });
  });

  btnRun.addEventListener("click", function () {
    var area = $("manualCode");
    var code = area.value ? area.value : "";
    if (code.replace(/\s/g, "").length < 2) {
      addLog(t("needCode"));
      return;
    }
    manualDirty = false;
    /* both boxes stay in sync: the panel mirrors what was run here */
    chrome.storage.local.set({ manualCode: code, manualStamp: new Date().getTime() });
    sendToContent({ action: "setManualCode", value: code });
    runOnServer(code, null);
  });

  var area2 = $("manualCode");
  if (area2) {
    area2.addEventListener("input", function () {
      manualDirty = true;
      updateManualMeta();
      chrome.storage.local.set({ manualCode: area2.value });
    });
  }

  if ($("btnClean")) {
    $("btnClean").addEventListener("click", function () {
      cleanManualBox();
    });
  }
  if ($("btnCopyCode")) {
    $("btnCopyCode").addEventListener("click", function () {
      copyManualBox();
    });
  }
  updateManualMeta();

  $("btnPageRun").addEventListener("click", function () {
    sendToContent({ action: "runNewest" });
    addLog(t("pageSent"));
  });
}

/* ================================================================
   TAB 3 - SETTINGS TAB
   ================================================================ */

function initSettingsTab() {
  var langSel = $("langSel");
  var urlInput = $("srvUrlInput");
  var promptArea = $("promptArea");

  langSel.value = lang;
  langSel.addEventListener("change", function () {
    lang = langSel.value;
    chrome.storage.local.set({ lang: lang }, function () {
      applyLang();
      renderLogs(null);
      checkStatus();
      pollProgress();
      refreshChatbotBadge();
      /* the floating panel re-labels itself too */
      sendToContent({ action: "setLang", value: lang });
    });
  });

  urlInput.value = srvUrl;
  $("btnSaveUrl").addEventListener("click", function () {
    var value = urlInput.value ? urlInput.value.trim() : "";
    if (value.length === 0) {
      return;
    }
    while (value.length > 0 && value.charAt(value.length - 1) === "/") {
      value = value.substring(0, value.length - 1);
    }
    srvUrl = value;
    urlInput.value = value;
    chrome.storage.local.set({ srvUrl: srvUrl }, function () {
      addLog(t("saved"));
      checkStatus();
      pollProgress();
    });
  });

  promptArea.value = customPrompt;
  $("btnSavePrompt").addEventListener("click", function () {
    customPrompt = promptArea.value;
    chrome.storage.local.set({ customPrompt: customPrompt }, function () {
      sendToContent({ action: "setPrompt", value: customPrompt });
      addLog(t("promptSaved"));
    });
  });

  $("btnResetPrompt").addEventListener("click", function () {
    customPrompt = DEFAULT_PROMPT;
    promptArea.value = DEFAULT_PROMPT;
    chrome.storage.local.set({ customPrompt: DEFAULT_PROMPT }, function () {
      sendToContent({ action: "setPrompt", value: DEFAULT_PROMPT });
      addLog(t("promptReset"));
    });
  });
}

/* ================================================================
   BOOTSTRAP
   ================================================================ */

function restoreSettingsAndStart() {
  chrome.storage.local.get(
    ["lang", "service", "live", "smart", "panel", "srvUrl", "customPrompt", "logs",
     "viewEnable", "panelDock", "theme", "manualCode"],
    function (data) {
      if (data) {
        lang = data.lang ? data.lang : "en";
        if (typeof data.service === "boolean") { serviceOn = data.service; }
        if (typeof data.live === "boolean") { liveOn = data.live; }
        if (typeof data.smart === "boolean") { smartOn = data.smart; }
        if (typeof data.panel === "boolean") { panelOn = data.panel; }
        if (typeof data.viewEnable === "boolean") { viewOn = data.viewEnable; }
        if (typeof data.panelDock === "string") { dockCycle = data.panelDock; }
        if (data.theme) { applyTheme(data.theme); }
        if (data.manualCode && $("manualCode")) { setManualCode(data.manualCode); }
        srvUrl = data.srvUrl ? data.srvUrl : "http://127.0.0.1:8765";
        customPrompt = data.customPrompt ? data.customPrompt : DEFAULT_PROMPT;

        paintToggle($("tService"), serviceOn, false);
        paintToggle($("tLive"), liveOn, false);
        paintToggle($("tSmart"), smartOn, true);
        paintToggle($("tPanel"), panelOn, false);
        if ($("tView")) {
          paintToggle($("tView"), viewOn, false);
        }

        $("srvUrlInput").value = srvUrl;
        $("promptArea").value = customPrompt;
        $("langSel").value = lang;

        applyLang();
        renderLogs(data.logs);
      }

      refreshChatbotBadge();
      checkStatus();
      pollProgress();

      if (statusTimer) {
        clearInterval(statusTimer);
      }
      statusTimer = setInterval(checkStatus, 2000);

      if (progressTimer) {
        clearInterval(progressTimer);
      }
      progressTimer = setInterval(pollProgress, 700);
    }
  );
}

var popupReady = false;

function onReady() {
  if (popupReady) {
    return;   /* never wire the UI twice (double-firing toggles) */
  }
  popupReady = true;

  applyTheme("dark");
  initTabs();
  initToggles();
  initThemePicker();
  initMainTab();
  initViewControls();
  initCodeTab();
  initSettingsTab();

  /* Keep the log box live while the popup is open. */
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes) {
      return;
    }
    if (changes.logs) {
      renderLogs(changes.logs.newValue);
    }
    if (changes.theme && changes.theme.newValue) {
      applyTheme(changes.theme.newValue);
      sendToContent({ action: "setTheme", value: changes.theme.newValue });
    }
    if (changes.manualCode && !manualDirty) {
      setManualCode(changes.manualCode.newValue);
    }
  });

  restoreSettingsAndStart();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onReady);
} else {
  onReady();
}
