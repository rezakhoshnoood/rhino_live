/* ================================================================
   RHINO LIVE BRIDGE - CONTENT SCRIPT
   Version: 2.6.4  |  Designer: Reza Khoshnood
   ----------------------------------------------------------------
   Injected into every page. Finds AI-generated Rhino Python code on
   ANY chatbot page, normalises it, and hands it to the local bridge
   server, which executes it in Rhino STEP BY STEP.

   ES5 ONLY - do NOT introduce ES6+ syntax here.
   Forbidden in this file: const, let, arrow functions, async/await,
   template literals, default parameters, spread, destructuring.
   Use: var, function declarations, .then() chains, string joining.
   ================================================================ */

/* ================================================================
   0) SETTINGS STATE
   ================================================================ */

var SERVER = "http://127.0.0.1:8765";
var serviceOn = true;
var liveOn = true;
var smartOn = true;
var panelOn = true;
var customPrompt = "";
var panelPos = null;
var panelDock = "";          /* "" | "left" | "right"   (2.6.0)  */
var panelSize = null;        /* { w, h }                (2.6.0)  */
var panelMin = false;        /* collapsed to the header (2.6.0)  */
var panelMax = false;        /* large mode              (2.6.0)  */
var viewOn = true;           /* live Rhino viewport     (2.6.0)  */

/* ----------------------------------------------------------------
   Single-instance guard.
   Reloading the unpacked extension re-injects content.js into every
   open tab. Without this, two instances would scan the same page and
   send each code block to Rhino twice. The newest instance disposes
   the previous one and takes over its state.
   ---------------------------------------------------------------- */
var BRIDGE_GLOBAL_KEY = "__rhinoLiveBridge";

var bridgePrevious = null;

try {
  if (window[BRIDGE_GLOBAL_KEY] && window[BRIDGE_GLOBAL_KEY].dispose) {
    bridgePrevious = window[BRIDGE_GLOBAL_KEY];
    bridgePrevious.dispose();
  }
} catch (e) {
  /* ignore */
}

/* Runtime state */
var scanTimer = null;
var progressTimer = null;
var revertTimer = null;
var firstScanDone = false;

/* Shared with the previous instance (if any) so that reloading the
   extension does NOT re-execute code that is already on the page and
   does NOT reset the success counter. */
var bridgeState = (bridgePrevious && bridgePrevious.state)
  ? bridgePrevious.state
  : { executed: {}, count: 0, running: false, activeHash: null };

var executed = bridgeState.executed;   /* hash -> true, prevents duplicate sends */
var executedOrder = [];                /* insertion order, for the memory cap */
var pendingHashes = new Map();         /* hash -> { code, count, time } */
var dragState = null;
var isDragging = false;
var dockCandidate = "";
var resizeState = null;
var isResizing = false;
var viewTimer = null;
var viewRev = 0;
var viewFps = 0;
var viewFrames = 0;
var viewLastFrameAt = 0;
var viewSupported = true;
var viewErrors = 0;
var viewTicks = 0;
var viewInFlight = false;      /* 2.6.3: only one /viewport request at a time */
var viewBackoffUntil = 0;      /* 2.6.3: slow retry after capture failures    */
var viewHasFrame = false;      /* 2.6.3: a real frame is on screen           */
var currentAttempt = 0;
var retryTimer = null;
var manualDirty = false;          /* the user edited the manual box  */
var manualSource = "empty";       /* "auto" | "manual" | "popup"     */
var manualSaveTimer = null;
var pendingManualCode = "";
var runQueue = [];                     /* [{code, hash, source}] sequential queue */

var lastScanCounts = { all: 0, rhino: 0 };
var settleTimer = null;

var SCAN_INTERVAL = 1500;
var STABLE_CYCLES = 2;
/* The stability rule is BOTH "seen in two consecutive scans" AND "the
   text has not changed for this long". The observer fires scans on DOM
   mutations, so counting ticks alone would let half-typed code through
   while the AI is still streaming. */
var STABLE_MS = 2500;
var HASH_TTL = 10000;
var EXECUTED_CAP = 200;
var MAX_CANDIDATE_NODES = 400;
var MUTATION_DEBOUNCE = 400;
var MAX_TEXT_NODES = 20000;
var MAX_ANCHORS = 10;
var QUEUE_CAP = 4;
var PROGRESS_INTERVAL = 700;
var STATUS_REVERT_MS = 4000;

/* ---- 2.6.0 ---- */
var VIEW_INTERVAL = 320;          /* ms between live viewport requests */
var VIEW_MAX_PX = 900;            /* widest frame the bridge may render */
var DOCK_SNAP = 52;               /* px from a browser edge -> dock     */
var PANEL_MIN_W = 232;
var PANEL_MIN_H = 150;
var PANEL_MAX_W = 760;
var PANEL_MAX_H = 820;
var RETRY_MAX = 2;                /* automatic retries after a failure  */
var RETRY_DELAY = 700;            /* ms between two attempts            */
var RETRY_MAX_AGE = 60000;        /* never retry a run older than this  */

var PANEL_ID = "rhinoLivePanel";
var BADGE_ID = "rhinoLiveBadge";
var STATUS_ID = "rhinoLiveStatus";
var COUNTER_ID = "rhinoLiveCounter";
var SMART_AREA_ID = "rhinoLiveSmartArea";
var SMART_BTN_ID = "rhinoLiveSmartBtn";
var RUN_BTN_ID = "rhinoLiveRunBtn";
var STOP_BTN_ID = "rhinoLiveStopBtn";
var PROGRESS_WRAP_ID = "rhinoLiveProgressWrap";
var PROGRESS_BAR_ID = "rhinoLiveProgressBar";
var DIAG_ID = "rhinoLiveDiag";
var HEADER_ID = "rhinoLiveHeader";
var CLOSE_ID = "rhinoLiveClose";
var PANEL_BODY_ID = "rhinoLiveBody";
var DOCK_BTN_ID = "rhinoLiveDockBtn";
var MIN_BTN_ID = "rhinoLiveMinBtn";
var MAX_BTN_ID = "rhinoLiveMaxBtn";
var GRIP_ID = "rhinoLiveGrip";
var VIEW_ID = "rhinoLiveViewport";
var VIEW_IMG_ID = "rhinoLiveViewportImg";
var VIEW_BAR_ID = "rhinoLiveViewportBar";
var VIEW_FPS_ID = "rhinoLiveViewportFps";
var VIEW_FIT_ID = "rhinoLiveViewportFit";
var VIEW_REFRESH_ID = "rhinoLiveViewportRefresh";
var VIEW_MSG_ID = "rhinoLiveViewportMsg";
var VIEW_TOGGLE_ID = "rhinoLiveViewBtn";
var PROGRESS_TEXT_ID = "rhinoLiveProgressText";
var MANUAL_ID = "rhinoLiveManualBox";
var MANUAL_RUN_ID = "rhinoLiveManualRun";
var MANUAL_META_ID = "rhinoLiveManualMeta";
var MANUAL_CLEAR_ID = "rhinoLiveManualClear";
var MANUAL_WRAP_ID = "rhinoLiveManualWrap";
var MANUAL_TITLE_ID = "rhinoLiveManualTitle";
var MANUAL_CLEAN_ID = "rhinoLiveManualClean";
var MANUAL_COPY_ID = "rhinoLiveManualCopy";
var TOAST_ID = "rhinoLiveToast";
var VERIFY_ID = "rhinoLiveVerify";

/* ================================================================
   1) DEFAULT SMART PROMPT
   ----------------------------------------------------------------
   Fallback used when chrome.storage.local has no "customPrompt"
   yet (e.g. the popup was never opened). popup.js owns the editable
   copy in the Settings tab; this one only guarantees the 🧠 button
   works out of the box.
   ================================================================ */

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

/* ================================================================
   2) BILINGUAL LABELS FOR THE FLOATING PANEL
   ================================================================ */

var PANEL_I18N = {
  en: {
    title: "🦏 Rhino Live",
    idle: "🟢 Waiting for AI code...",
    paused: "🟡 Live Sync Paused",
    sending: "🟡 Sending to Rhino...",
    running: "🔵 Building step by step...",
    success: "✅ Executed in Rhino!",
    cancelled: "⏹ Cancelled",
    error: "🔴 Error - check server",
    busy: "🟠 Rhino is busy",
    offline: "🔌 Server offline - retrying...",
    off: "⚪ Service OFF",
    counter: "Codes executed: ",
    step: "Step ",
    smart: "🧠 Smart",
    smartDone: "✓ Enhanced!",
    smartHint: "Click to enhance your chatbox message with an optimized prompt",
    run: "▶ Run newest",
    stop: "⏹ Stop",
    diagBlocks: "Blocks",
    diagRhino: "Rhino",
    diagServer: "Server",
    diagQueue: "queued",
    footer: "💡 Drag the header to move",
    badgeLive: "LIVE",
    badgePaused: "PAUSED",
    badgeOff: "OFF",
    viewOn: "👁 Live view ON",
    viewOff: "👁 Live view OFF",
    viewLive: "LIVE",
    viewWaiting: "waiting for Rhino...",
    viewFit: "Fit",
    viewFitBusy: "fitting view...",
    viewOffline: "Rhino not reachable",
    viewUnsupported: "live view not supported here",
    viewRefresh: "refresh the live view now",
    viewMsgWaiting: "Waiting for the first frame from Rhino…\nKeep Rhino open and make sure a model view is open.",
    viewMsgOffline: "Rhino is not reachable.\nIs Rhino open and the bridge running?",
    viewMsgBlocked: "The page blocked the live image.\nTry the ⟳ button or another chat tab.",
    viewToggle: "👁 Viewport",
    manualTitle: "⌨ Manual Python Execution",
    manualRun: "▶ Run in Rhino",
    manualClear: "Clear",
    manualEmpty: "waiting for code - detected code is placed here",
    manualAuto: "auto-filled from the page",
    manualEdited: "edited by you",
    manualLines: "lines",
    manualChars: "chars",
    manualSteps: "~steps",
    manualClean: "🧹 Clean",
    manualCopy: "📋 Copy",
    manualRunSteps: "▶ Run in Rhino",
    manualCleanHint: "removes toolbar words such as Download / Copy code",
    manualCleaned: "toolbar removed",
    toastCleaned: "🧹 removed from the code: ",
    toastCopied: "📋 The code is on your clipboard.",
    toastEmpty: "The box is empty - there is nothing to run.",
    toastOnlyChrome: "The box holds only toolbar words - paste the code itself.",
    toastDone: "✅ Executed in Rhino",
    toastFailed: "❌ Rhino reported an error",
    toastStopped: "⏹ Stopped",
    verifying: "Verifying the result...",
    retrying: "Retrying...",
    retry: "Retry",
    verOk: "Verified in Rhino",
    verFailed: "Verification failed",
    dockHint: "Dock the panel to a browser edge",
    minHint: "Minimize",
    maxHint: "Maximize",
    restoreHint: "Restore",
    resizeHint: "Drag to resize",
    closeHint: "Close",
    diagLines: "lines",
    diagObjects: "objects"
  },
  fa: {
    title: "🦏 راینو لایو",
    idle: "🟢 در انتظار کد AI...",
    paused: "🟡 همگام‌سازی غیرفعال",
    sending: "🟡 ارسال به راینو...",
    running: "🔵 ساخت مرحله‌به‌مرحله...",
    success: "✅ در راینو اجرا شد!",
    cancelled: "⏹ لغو شد",
    error: "🔴 خطا - سرور را بررسی کنید",
    busy: "🟠 راینو مشغول است",
    offline: "🔌 سرور خاموش است - تلاش مجدد...",
    off: "⚪ سرویس خاموش",
    counter: "تعداد اجراها: ",
    step: "مرحله ",
    smart: "🧠 هوشمند",
    smartDone: "✓ اعمال شد!",
    smartHint: "برای تقویت پیام چت‌باکس با پرامپت بهینه کلیک کنید",
    run: "▶ اجرای آخرین کد",
    stop: "⏹ توقف",
    diagBlocks: "بلوک",
    diagRhino: "راینو",
    diagServer: "سرور",
    diagQueue: "در صف",
    footer: "💡 برای جابه‌جایی هدر را بکشید",
    badgeLive: "LIVE",
    badgePaused: "PAUSED",
    badgeOff: "OFF",
    viewOn: "👁 نمایش زنده روشن",
    viewOff: "👁 نمایش زنده خاموش",
    viewLive: "زنده",
    viewWaiting: "در انتظار راینو...",
    viewFit: "فیت",
    viewFitBusy: "در حال فیت کردن...",
    viewOffline: "راینو در دسترس نیست",
    viewUnsupported: "نمایش زنده در این سیستم پشتیبانی نمی‌شود",
    viewRefresh: "به‌روزرسانی فوری نمایش زنده",
    viewMsgWaiting: "در انتظار اولین فریم از راینو…\nراینو را باز نگه دارید و مطمئن شوید یک نمای مدل باز است.",
    viewMsgOffline: "راینو در دسترس نیست.\nآیا راینو باز است و بریج در حال اجراست؟",
    viewMsgBlocked: "صفحه تصویر زنده را مسدود کرد.\nدکمه ⟳ یا یک تب چت دیگر را امتحان کنید.",
    viewToggle: "👁 ویوپورت",
    manualTitle: "⌨ اجرای دستی پایتون",
    manualRun: "▶ اجرا در راینو",
    manualClear: "پاک کردن",
    manualEmpty: "در انتظار کد - کد تشخیص‌داده‌شده همین‌جا قرار می‌گیرد",
    manualAuto: "به‌صورت خودکار از صفحه پر شد",
    manualEdited: "دست‌کاری شده توسط شما",
    manualLines: "خط",
    manualChars: "کاراکتر",
    manualSteps: "~مرحله",
    manualClean: "🧹 پاک‌سازی",
    manualCopy: "📋 کپی",
    manualRunSteps: "▶ اجرا در راینو",
    manualCleanHint: "کلمه‌های نوار ابزار مثل Download / Copy code را حذف می‌کند",
    manualCleaned: "نوار ابزار حذف شد",
    toastCleaned: "🧹 از کد حذف شد: ",
    toastCopied: "📋 کد در حافظه کپی شد.",
    toastEmpty: "جعبه خالی است - چیزی برای اجرا نیست.",
    toastOnlyChrome: "جعبه فقط کلمه‌های نوار ابزار دارد - خودِ کد را بچسبانید.",
    toastDone: "✅ در راینو اجرا شد",
    toastFailed: "❌ راینو خطا گزارش کرد",
    toastStopped: "⏹ متوقف شد",
    verifying: "در حال بررسی نتیجه...",
    retrying: "تلاش مجدد...",
    retry: "تلاش مجدد",
    verOk: "در راینو تأیید شد",
    verFailed: "بررسی ناموفق بود",
    dockHint: "چسباندن پنل به لبه مرورگر",
    minHint: "کوچک کردن",
    maxHint: "بزرگ کردن",
    restoreHint: "بازگردانی",
    resizeHint: "برای تغییر اندازه بکشید",
    closeHint: "بستن",
    diagLines: "خط",
    diagObjects: "آبجکت"
  }
};

var panelLang = "en";

function L(key) {
  if (!PANEL_I18N[panelLang]) {
    panelLang = "en";
  }
  if (PANEL_I18N[panelLang][key] !== undefined) {
    return PANEL_I18N[panelLang][key];
  }
  return PANEL_I18N.en[key];
}

/* ================================================================
   2b) THEMES  (shared with the popup since 2.6.1)
   ----------------------------------------------------------------
   The popup stores the chosen theme under "theme"; the floating panel
   reads it and repaints itself with the same palette, so both surfaces
   always look like one product - in a dark, a light or a coloured skin.
   ================================================================ */

var THEMES = {
  dark: {
    label: "Dark",
    bg: "#0d1117", header: "#1c2333", border: "#2a3346", text: "#c9d1d9",
    muted: "#6e7681", accent: "#00d4ff", accent2: "#00ff88", codeBg: "#05070a",
    ok: "#00ff88", warn: "#ffa657", err: "#ff4444", info: "#bb86fc"
  },
  light: {
    label: "Light",
    bg: "#ffffff", header: "#eef2f7", border: "#c9d4e0", text: "#1b2330",
    muted: "#5b6775", accent: "#0a7ea4", accent2: "#0b8f4d", codeBg: "#f6f8fb",
    ok: "#0b8f4d", warn: "#b26a00", err: "#c62828", info: "#6a3fb8"
  },
  midnight: {
    label: "Midnight",
    bg: "#0b1020", header: "#141c33", border: "#243252", text: "#cdd8ef",
    muted: "#7b88a8", accent: "#4da3ff", accent2: "#39e6a0", codeBg: "#070b16",
    ok: "#39e6a0", warn: "#ffb347", err: "#ff5f6d", info: "#b48bff"
  },
  nord: {
    label: "Nord",
    bg: "#2e3440", header: "#3b4252", border: "#4c566a", text: "#e5e9f0",
    muted: "#9aa5b8", accent: "#88c0d0", accent2: "#a3be8c", codeBg: "#272c36",
    ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", info: "#b48ead"
  },
  dracula: {
    label: "Dracula",
    bg: "#282a36", header: "#343746", border: "#44475a", text: "#f8f8f2",
    muted: "#9aa0b5", accent: "#8be9fd", accent2: "#50fa7b", codeBg: "#21222c",
    ok: "#50fa7b", warn: "#f1fa8c", err: "#ff5555", info: "#bd93f9"
  },
  solarized: {
    label: "Solarized Light",
    bg: "#fdf6e3", header: "#eee8d5", border: "#d8cfae", text: "#073642",
    muted: "#6b7b82", accent: "#268bd2", accent2: "#859900", codeBg: "#f7f1e0",
    ok: "#859900", warn: "#b58900", err: "#dc322f", info: "#6c71c4"
  }
};

var currentTheme = "dark";

function themePalette() {
  if (THEMES[currentTheme]) {
    return THEMES[currentTheme];
  }
  return THEMES.dark;
}

function themeBg() { return themePalette().bg; }
function themeHeader() { return themePalette().header; }
function themeBorder() { return themePalette().border; }
function themeText() { return themePalette().text; }
function themeMuted() { return themePalette().muted; }
function themeAccent() { return themePalette().accent; }
function themeAccent2() { return themePalette().accent2; }
function themeCodeBg() { return themePalette().codeBg; }
function themeOk() { return themePalette().ok; }
function themeWarn() { return themePalette().warn; }
function themeErr() { return themePalette().err; }
function themeInfo() { return themePalette().info; }

function setTheme(name, repaint) {
  currentTheme = THEMES[name] ? name : "dark";
  if (repaint === false) {
    return;
  }
  if (!panelExists()) {
    return;
  }
  /* a full rebuild is the cheapest way to restyle every inline rule */
  var panel = panelEl();
  var rect = panel ? panel.getBoundingClientRect() : null;
  if (rect) {
    panelPos = { left: rect.left, top: rect.top };
  }
  var wasDirty = manualDirty;
  var boxValue = document.getElementById(MANUAL_ID) ? document.getElementById(MANUAL_ID).value : "";
  destroyPanel();
  createPanel();
  var box = document.getElementById(MANUAL_ID);
  if (box && boxValue) {
    box.value = boxValue;
  }
  manualDirty = wasDirty;
  updateManualMeta();
}

/* ================================================================
   3) CHATBOT DETECTION
   ================================================================ */

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

function detectChatbot() {
  var hostname = "";
  try {
    hostname = window.location.hostname;
  } catch (e) {
    return "Unknown";
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

/* ================================================================
   4) LOGGING  (shared "logs" array with popup.js, keeps last 15)
   ================================================================ */

function addLog(msg) {
  try {
    var d = new Date();
    var line = "[" + d.toLocaleTimeString() + "] " + msg;
    chrome.storage.local.get(["logs"], function (data) {
      var logs = (data && data.logs) ? data.logs : [];
      logs.push(line);
      while (logs.length > 15) {
        logs.shift();
      }
      chrome.storage.local.set({ logs: logs });
    });
  } catch (e) {
    /* storage may be unavailable in rare sandboxed frames - never break the page */
  }
}

/* One place for every preference write, so a broken storage call can
   never break the page (2.6.0). */
function saveSetting(values) {
  try {
    chrome.storage.local.set(values);
  } catch (e) {
    /* storage unavailable - the panel simply does not remember */
  }
}

/* ================================================================
   5) CODE NORMALISATION
   ----------------------------------------------------------------
   Code copied out of a web page carries UI chrome with it:
   "Copy code" buttons, line numbers, a language label, non breaking
   spaces, zero width characters. All of that is removed here so the
   code that reaches Rhino is clean (and so two visual copies of the
   same block hash to the same string and are executed only once).
   ================================================================ */

/* Every word a chat UI draws around a code block: the language label,
   the Copy button, and - the one that broke runs in 2.6.1 - the
   Download button. A code block whose toolbar is rendered INSIDE the
   <pre> (or as plain text before it) carries those words as the first
   lines of the "code", and "Download" on line 1 is a NameError the
   moment Rhino executes it.

   The list is matched after normalisation (lower case, emoji and
   punctuation removed, spaces collapsed), so "Download ⤓",
   "DOWNLOAD", "Download file" and "دانلود" are the same thing. */
var CHROME_LABELS = {
  "copy": 1, "copy code": 1, "copy to clipboard": 1, "copied": 1, "copy all": 1,
  "download": 1, "download code": 1, "download file": 1, "download python": 1,
  "download script": 1, "download 1": 1,
  "edit": 1, "edit code": 1, "open in editor": 1, "open in playground": 1,
  "run": 1, "run code": 1, "run this code": 1, "execute": 1, "try it": 1,
  "try again": 1, "retry": 1, "regenerate": 1, "regenerate response": 1,
  "save": 1, "share": 1, "insert": 1, "insert code": 1, "use code": 1,
  "preview": 1, "explain": 1, "wrap": 1, "unwrap": 1, "wrap lines": 1,
  "expand": 1, "collapse": 1, "show more": 1, "show less": 1, "show code": 1,
  "hide code": 1, "view raw": 1, "raw": 1, "show raw": 1, "toggle": 1,
  "python": 1, "python 3": 1, "python3": 1, "py": 1, "rhinoscript": 1,
  "ironpython": 1, "cpython": 1, "code": 1, "source": 1, "text": 1,
  "plaintext": 1, "plain text": 1, "markdown": 1, "md": 1, "json": 1,
  "yaml": 1, "xml": 1, "html": 1, "css": 1, "sql": 1, "diff": 1,
  "bash": 1, "shell": 1, "sh": 1, "console": 1, "terminal": 1, "output": 1,
  "result": 1, "javascript": 1, "js": 1, "typescript": 1, "ts": 1,
  "java": 1, "c": 1, "c++": 1, "cpp": 1, "c#": 1, "csharp": 1, "go": 1,
  "rust": 1, "ruby": 1, "php": 1, "r": 1, "matlab": 1, "latex": 1, "tex": 1,
  "کپی": 1, "کپی کد": 1, "دانلود": 1, "دانلود کد": 1, "اجرا": 1,
  "اجرا کد": 1, "ویرایش": 1, "ذخیره": 1, "اشتراک": 1, "پیش‌نمایش": 1,
  "نسخه اصلی": 1
};

/* A toolbar label plus whatever icon the UI glued to it (\u2934 \u2b07
   \u{1F4CB} ...): everything that is not a letter, a digit, + or # is
   dropped, so "Download \u2934", "DOWNLOAD", "Download file" and the
   Persian "\u062f\u0627\u0646\u0644\u0648\u062f" normalise to the same label. */
function chromeLabelOf(text) {
  var t = String(text === null || text === undefined ? "" : text);
  t = t.toLowerCase();
  var out = "";
  var i;
  for (i = 0; i < t.length; i++) {
    var ch = t.charAt(i);
    var code = t.charCodeAt(i);
    var isAsciiWord = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
                      ch === "+" || ch === "#";
    var isPersian = (code >= 0x0600 && code <= 0x06ff);
    if (isAsciiWord || isPersian) {
      out = out + ch;
    } else if (ch === " " || ch === "\t" || ch === "\u00a0" || ch === "-" || ch === "_") {
      out = out + " ";
    } else {
      out = out + " ";
    }
  }
  out = out.replace(/\s+/g, " ");
  out = out.replace(/^\s+|\s+$/g, "");
  return out;
}

function isChromeLine(line) {
  var t = String(line === null || line === undefined ? "" : line);
  if (t.replace(/\s/g, "").length === 0) {
    return false;
  }
  var label = chromeLabelOf(t);
  if (label === "") {
    return false;
  }
  if (CHROME_LABELS[label] === 1) {
    return true;
  }
  return CHROME_LABELS[label.replace(/ \d+$/, "")] === 1;
}

/* A toolbar label glued straight onto the code on the same line,
   e.g. "Downloadimport rhinoscriptsyntax as rs" or "Copy coders.AddPoint(...)".
   The label is only removed when what follows really looks like Python,
   so a line such as "download_file = open(path)" is never touched. */
var CODE_HINT_RE = /(^|\s)(import|from|def|class|for|while|if|elif|else|try|except|finally|with|return|print)\b|^#|^@|[=\[\](){}]|rs\./;

function stripGluedChromePrefix(line) {
  var text = String(line);
  /* the indentation is part of the code: it is measured, removed while
     the label is being cut, and put back - a "    " that disappears
     would turn every block into an IndentationError */
  var indentMatch = /^[ \t]*/.exec(text);
  var indent = indentMatch ? indentMatch[0] : "";
  var probe = text.substring(indent.length);
  var guard = 0;
  while (guard < 6) {
    guard = guard + 1;
    var cut = -1;
    var lower = probe.toLowerCase();
    var labels = ["copy to clipboard", "download code", "download file", "copy code",
                  "python 3", "rhinoscript", "plaintext", "download", "copied",
                  "python", "python3", "copy", "edit", "run code", "run",
                  "save", "share", "code", "text", "preview"];
    var i;
    for (i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (lower.indexOf(label) !== 0) {
        continue;
      }
      var rest = probe.substring(label.length);
      if (rest.length === 0) {
        break;
      }
      var separator = /^[\s:·\-–—|>›»)]+/.exec(rest);
      var stripped = separator ? rest.replace(/^[\s:·\-–—|>›»)]+/, "") : rest;
      if (stripped.length === 0) {
        break;
      }
      if (separator) {
        /* "Download import ..." / "Copy code rs.AddPoint(...)" */
        if (CODE_HINT_RE.test(stripped)) {
          cut = probe.length - stripped.length;
        }
        break;
      }
      /* no separator: the label is glued to the code ("Downloadimport"),
         which only happens with a Python KEYWORD or a comment right after
         it - never with an identifier such as download_file = open(path) */
      if (/^(import|from|def|class|for|while|if|elif|else|try|except|finally|with|return|print)\b/i.test(stripped) ||
          stripped.charAt(0) === "#" || stripped.charAt(0) === "@") {
        cut = label.length;
        break;
      }
      break;
    }
    if (cut < 0) {
      return indent + probe;
    }
    probe = probe.substring(cut);
  }
  return indent + probe;
}

/* ... and the same label glued to the END of the last code line:
   "rs.AddPoint([0, 0, 0])Copy code". Quotes are never crossed, so a
   string such as "download" inside the code survives. */
function stripGluedChromeSuffix(line) {
  var text = String(line);
  var probe = text.replace(/[ \t]+$/, "");
  var labels = ["copy to clipboard", "download code", "download file", "copy code",
                "download", "copied", "copy"];
  var i;
  for (i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (probe.length <= label.length) {
      continue;
    }
    if (probe.toLowerCase().lastIndexOf(label) !== probe.length - label.length) {
      continue;
    }
    var head = probe.substring(0, probe.length - label.length).replace(/[ \t]+$/, "");
    var last = head.charAt(head.length - 1);
    if (last === '"' || last === "'") {
      continue;
    }
    if (/[\)\]\}\w"'#]/.test(last)) {
      return head;
    }
  }
  return probe;
}

/* The result of the last clean: how much UI chrome had to be removed.
   The panel shows it ("🧹 1 toolbar line removed") so nothing happens
   silently - if a real line ever gets eaten the user sees it at once. */
var lastCleanReport = { chrome: 0, glued: 0, lines: 0 };

function normalizeCode(text) {
  return cleanCodeReport(text).code;
}

function cleanCodeReport(text) {
  var report = { code: "", chrome: 0, glued: 0, lines: 0, allChrome: false };
  if (!text) {
    lastCleanReport = report;
    return report;
  }

  var s = String(text);
  s = s.replace(/\u00a0/g, " ");                              /* nbsp         */
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, "");           /* zero width   */
  s = s.replace(/\r\n?/g, "\n");

  var lines = s.split("\n");
  var kept = [];
  var i;

  /* ---- 0) a toolbar label glued onto a code line ---- */
  for (i = 0; i < lines.length; i++) {
    var original = lines[i];
    var stripped = stripGluedChromePrefix(original);
    stripped = stripGluedChromeSuffix(stripped);
    if (stripped !== original) {
      report.glued = report.glued + 1;
    }
    lines[i] = stripped;
  }

  /* ---- 1) remove UI chrome lines ---- */
  for (i = 0; i < lines.length; i++) {
    if (isChromeLine(lines[i])) {
      report.chrome = report.chrome + 1;
      continue;
    }
    kept.push(lines[i].replace(/[ \t]+$/g, ""));
  }

  /* never let the cleaner eat the whole block: if every single line
     looked like chrome, the "code" was only a toolbar. Keep the text so
     nothing is destroyed, but say so, and the run path refuses it
     instead of sending "Download" to Rhino as if it were Python. */
  if (kept.length === 0 && lines.length > 0) {
    kept = lines;
    report.chrome = 0;
    report.glued = 0;
    report.allChrome = true;
  }

  /* ---- 2) remove line numbers (only when most lines carry them) ---- */
  var nonEmpty = 0;
  var numbered = 0;
  var numberRe = /^[ \t]*\d{1,4}([\.\):\|\t ]|$)/;

  for (i = 0; i < kept.length; i++) {
    if (kept[i].replace(/\s/g, "").length === 0) {
      continue;
    }
    nonEmpty = nonEmpty + 1;
    if (numberRe.test(kept[i])) {
      numbered = numbered + 1;
    }
  }

  if (nonEmpty > 2 && (numbered / nonEmpty) > 0.5) {
    for (i = 0; i < kept.length; i++) {
      if (kept[i].replace(/\s/g, "").length === 0) {
        continue;
      }
      kept[i] = kept[i].replace(numberRe, "");
    }
  }

  /* ---- 3) drop a lone language tag on the first line ---- */
  while (kept.length > 0 && kept[0].replace(/\s/g, "").length === 0) {
    kept.shift();
  }
  while (kept.length > 0 && isChromeLine(kept[0])) {
    report.chrome = report.chrome + 1;
    kept.shift();
  }

  /* ---- 4) undo a uniform indent (number stripping can leave one) ---- */
  var minIndent = -1;
  for (i = 0; i < kept.length; i++) {
    if (kept[i].replace(/\s/g, "").length === 0) {
      continue;
    }
    var lead = kept[i].length - kept[i].replace(/^[ \t]+/, "").length;
    if (minIndent === -1 || lead < minIndent) {
      minIndent = lead;
    }
  }
  if (minIndent > 0) {
    for (i = 0; i < kept.length; i++) {
      if (kept[i].replace(/\s/g, "").length === 0) {
        continue;
      }
      kept[i] = kept[i].substring(minIndent);
    }
  }

  /* ---- 5) collapse blank runs, trim the ends ---- */
  var out = [];
  var blanks = 0;
  for (i = 0; i < kept.length; i++) {
    if (kept[i].replace(/\s/g, "").length === 0) {
      blanks = blanks + 1;
      if (blanks > 1) {
        continue;
      }
      out.push("");
    } else {
      blanks = 0;
      out.push(kept[i]);
    }
  }
  while (out.length > 0 && out[0] === "") {
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }

  /* ---- 6) a script always starts at column 0 ----
     stray spaces on the first line (nbsp entities, UI padding) would
     otherwise raise an IndentationError inside Rhino */
  if (out.length > 0) {
    out[0] = out[0].replace(/^[ \t]+/, "");
  }

  report.code = out.join("\n");
  report.lines = out.length;
  lastCleanReport = report;
  return report;
}

/* ================================================================
   6) CODE EXTRACTION
   ----------------------------------------------------------------
   Strategy, tried in order:
     A. the proven selector (fast path, works with ChatGPT)
     B. a wide selector list for other chat UIs
     C. open shadow roots (some chat widgets live in a shadow DOM)
     D. as a last resort: harvest runs of code-like lines out of the
        visible text, for clients that render code without <pre>/<code>
   Results are normalised and de-duplicated, so a <pre> and the
   <code> inside it never both count.
   ================================================================ */

var CODE_SELECTOR = "pre code, pre, [class*='code'] code, [class*='code-block'] code";

var EXTRA_SELECTORS = [
  "code",
  "[class*='highlight']",
  "[class*='language-']",
  "[data-language]",
  "[data-code]",
  "[data-testid*='code']",
  "[data-testid*='Code']",
  "[class*='prism']",
  "[class*='monaco'] .view-lines",
  "[class*='cm-content']",
  "[class*='codeBlock']",
  "[class*='CodeBlock']",
  "[class*='code_block']",
  "[class*='code-block']",
  "[class*='codeblock']",
  "[class*='codeContent']",
  "[class*='code-content']",
  "[class*='CodeMirror']",
  "[class*='ace_editor']"
];

var PREFER_INNER_CODE = "code, [class*='line-content'], [class*='code-line']";

function safeQueryAll(root, selector, bucket) {
  if (!root || !root.querySelectorAll) {
    return;
  }
  var nodes;
  try {
    nodes = root.querySelectorAll(selector);
  } catch (e) {
    return;
  }
  var i;
  for (i = 0; i < nodes.length; i++) {
    bucket.push(nodes[i]);
  }
}

function collectShadowRoots() {
  var roots = [];
  var all;
  try {
    all = document.querySelectorAll("*");
  } catch (e) {
    return roots;
  }

  var depth1 = [];
  var i;
  for (i = 0; i < all.length; i++) {
    var host = all[i];
    if (host.shadowRoot) {
      roots.push(host.shadowRoot);
      depth1.push(host.shadowRoot);
    }
  }

  /* one nesting level deeper (chat widgets inside a widget) */
  var j;
  for (j = 0; j < depth1.length; j++) {
    var inner;
    try {
      inner = depth1[j].querySelectorAll("*");
    } catch (e) {
      continue;
    }
    var k;
    for (k = 0; k < inner.length; k++) {
      if (inner[k].shadowRoot) {
        roots.push(inner[k].shadowRoot);
      }
    }
  }

  return roots;
}

/* Tags that start a new visual line. Every real code renderer uses one of
   these (a <br>, a <div> per line, a <span> per line inside a <pre>, ...).
   2.6.1 fix: textContent alone joins the lines of a div-per-line renderer into
   ONE single line, which produced code that could never run in Rhino even
   though it looked perfect on screen. The walker below rebuilds the line
   structure instead - this is what makes the automatic path as reliable as
   pasting the same code into the Manual Python Execution box. */
var LINE_BLOCK_TAGS = {
  DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, DL: 1, DT: 1, DD: 1, TR: 1, TD: 1, TH: 1,
  TABLE: 1, TBODY: 1, THEAD: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1,
  FOOTER: 1, MAIN: 1, NAV: 1, FIGURE: 1, BLOCKQUOTE: 1, FORM: 1, PRE: 1,
  H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1
};

/* Tags that are inline by default but are frequently styled with
   display:block by chat UIs (one <span> per code line is common). */
var INLINE_TAGS = {
  SPAN: 1, A: 1, LABEL: 1, EM: 1, STRONG: 1, I: 1, B: 1, SMALL: 1, TT: 1,
  KBD: 1, CODE: 1, SAMP: 1, U: 1, S: 1, SUB: 1, SUP: 1, MARK: 1, ABBR: 1,
  TIME: 1, VAR: 1, CITE: 1, Q: 1
};

/* Does this element visually start a new line? (same rule innerText uses) */
function rendersAsBlock(el) {
  try {
    if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) {
      return false;
    }
    var view = el.ownerDocument.defaultView;
    if (!view.getComputedStyle) {
      return false;
    }
    var style = view.getComputedStyle(el);
    if (!style || !style.display) {
      return false;
    }
    var display = String(style.display);
    return display === "block" || display === "flex" || display === "grid" ||
           display === "table" || display === "list-item" || display === "flow-root";
  } catch (e) {
    return false;
  }
}

function walkLines(node, out) {
  var children = node.childNodes;
  if (!children) {
    return;
  }
  var i;
  for (i = 0; i < children.length; i++) {
    var child = children[i];

    if (child.nodeType === 3) {
      /* text node: keep it exactly */
      out.push(child.nodeValue ? child.nodeValue : "");
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }

    var tag = (child.tagName || "").toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
      continue;
    }
    if (tag === "BR") {
      out.push("\n");
      continue;
    }
    if (tag === "BUTTON" || tag === "SVG" || tag === "PATH" || tag === "IMG") {
      continue;
    }

    var isBlock = LINE_BLOCK_TAGS[tag] === 1;
    if (!isBlock && INLINE_TAGS[tag] === 1 && rendersAsBlock(child)) {
      isBlock = true;
    }
    /* one separator per block boundary, never two: a div-per-line renderer
       must produce exactly the same text as the <pre> version of the very
       same code block */
    if (isBlock && out.length > 0 && out[out.length - 1] !== "\n") {
      out.push("\n");
    }
    walkLines(child, out);
  }
}

/* Does this element render one line of code per child block? (Claude-like
   renderers do exactly that: <div class="line">...</div> repeated.) */
function isLinePerBlock(el) {
  var kids = el.children;
  if (!kids || kids.length < 2) {
    return false;
  }
  if ((el.textContent || "").indexOf("\n") >= 0) {
    return false;
  }
  var i;
  for (i = 0; i < kids.length; i++) {
    var tag = (kids[i].tagName || "").toUpperCase();
    if (!LINE_BLOCK_TAGS[tag] || tag === "PRE" || tag === "TABLE") {
      return false;
    }
    var inner = kids[i].children;
    var k;
    for (k = 0; inner && k < inner.length; k++) {
      var innerTag = (inner[k].tagName || "").toUpperCase();
      if (LINE_BLOCK_TAGS[innerTag] && innerTag !== "BR") {
        return false;
      }
    }
  }
  return true;
}

/* The raw text of an element with its line structure preserved. */
function rawTextOf(el) {
  if (!el) {
    return "";
  }

  /* one child block per line: keep every line, including the empty ones */
  if (isLinePerBlock(el)) {
    var lines = [];
    var c;
    for (c = 0; c < el.children.length; c++) {
      var piece = rawTextOf(el.children[c]);
      piece = piece.replace(/\n+$/g, "");
      lines.push(piece);
    }
    var joined = lines.join("\n").replace(/\r\n?/g, "\n");
    while (joined.indexOf("\n\n\n") >= 0) {
      joined = joined.split("\n\n\n").join("\n\n");
    }
    return joined;
  }

  var out = [];
  try {
    walkLines(el, out);
  } catch (e) {
    out = [el.textContent ? el.textContent : ""];
  }
  var text = out.join("");
  text = text.replace(/\r\n?/g, "\n");

  /* collapse the newline runs that the block tags introduce */
  while (text.indexOf("\n\n\n") >= 0) {
    text = text.split("\n\n\n").join("\n\n");
  }
  return text;
}

function textOfElement(el) {
  return rawTextOf(el);
}

/* Words that betray prose rather than code. Used only to reject
   SINGLE-LINE candidates, e.g. inline <code>rs.AddSphere()</code>
   mentioned inside a sentence - those must never auto-execute. */
var PROSE_WORD_RE = /\b(the|is|are|and|or|you|use|using|used|this|that|with|can|will|should|would|returns|creates|function|method|instead|example|python|code|note|means|means|works|like|such|when|then|because|را|که|این|برای|است|می)\b/i;

function addCandidate(list, seen, text, element) {
  var normalized = normalizeCode(text);
  if (normalized.length <= 15) {
    return;
  }

  /* a single line of prose containing a Rhino keyword is an inline
     mention, not a script */
  if (normalized.indexOf("\n") < 0) {
    if (PROSE_WORD_RE.test(normalized)) {
      return;
    }
    if (normalized.replace(/\s/g, "").length < 15) {
      return;
    }
  }
  var key = normalized.replace(/\s+/g, " ");
  if (seen[key]) {
    return;
  }
  seen[key] = true;
  list.push({ code: normalized, el: element });
}

function collectElementCandidates() {
  var found = [];
  var seen = {};
  var nodes = [];
  var i;

  /* ---- A + B: DOM selectors (document + shadow roots) ---- */
  var roots = [document];
  var shadows = collectShadowRoots();
  for (i = 0; i < shadows.length; i++) {
    roots.push(shadows[i]);
  }

  var selectorList = [CODE_SELECTOR];
  for (i = 0; i < EXTRA_SELECTORS.length; i++) {
    selectorList.push(EXTRA_SELECTORS[i]);
  }

  var r;
  var s;
  for (r = 0; r < roots.length; r++) {
    for (s = 0; s < selectorList.length; s++) {
      safeQueryAll(roots[r], selectorList[s], nodes);
    }
  }

  /* very code heavy pages: the newest block is what matters, so look at
     the tail of the document instead of processing thousands of nodes */
  if (nodes.length > MAX_CANDIDATE_NODES) {
    nodes = nodes.slice(nodes.length - MAX_CANDIDATE_NODES);
  }

  for (i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var target = el;

    /* prefer the innermost <code> so "Copy code" chrome around the
       block is not part of the payload */
    try {
      if (el.querySelector) {
        var inner = el.querySelector(PREFER_INNER_CODE);
        if (inner && textOfElement(inner).length > 15) {
          target = inner;
        }
      }
    } catch (e) {
      target = el;
    }

    addCandidate(found, seen, textOfElement(target), target);
  }

  return found;
}

/* ---- D: text harvesting fallback ---- */

var CODE_START_RE = /^(import|from|def|class|for|while|if|elif|else|try|except|finally|with|return|print|raise|assert|del|global|pass|break|continue|lambda|yield|@)\b/;
var RHINO_HINT_RE = /rhinoscriptsyntax|import\s+rs|import\s+Rhino|sc\.doc|scriptcontext|rs\.[A-Za-z]|Rhino\.Geometry|Point3d|WorldXYPlane|NurbsCurve/i;

function looksLikeCodeLine(line) {
  if (!line) {
    return false;
  }
  var raw = line.replace(/[ \t]+$/g, "");
  var t = raw.replace(/^\s+|\s+$/g, "");
  if (t.length === 0) {
    return false;
  }
  if (isChromeLine(raw)) {
    return false;
  }
  if (CODE_START_RE.test(t)) {
    return true;
  }
  if (/^#/.test(t)) {
    return true;
  }
  if (RHINO_HINT_RE.test(t)) {
    return true;
  }
  if (/^[ \t]+\S/.test(raw)) {
    return true;
  }
  if (/[=\[\]\(\)\.]/.test(t) && /[A-Za-z_]/.test(t) && !/[?!]/.test(t) && t.length < 200) {
    return true;
  }
  return false;
}

function isBlankish(line) {
  if (line === null || line === undefined) {
    return true;
  }
  return String(line).replace(/[\s\u00a0\u200b]/g, "").length === 0;
}

function harvestCandidatesFromText(text) {
  var out = [];
  if (!text) {
    return out;
  }
  var lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  var run = [];
  var i;

  function flush() {
    /* drop the blank lines at both ends of the run */
    var start = 0;
    var end = run.length - 1;
    while (start <= end && isBlankish(run[start])) {
      start = start + 1;
    }
    while (end >= start && isBlankish(run[end])) {
      end = end - 1;
    }

    var slice = run.slice(start, end + 1);
    var realLines = 0;
    var k;
    for (k = 0; k < slice.length; k++) {
      if (!isBlankish(slice[k])) {
        realLines = realLines + 1;
      }
    }

    if (realLines >= 2) {
      var block = slice.join("\n");
      if (RHINO_HINT_RE.test(block)) {
        out.push(block);
      }
    }
    run = [];
  }

  for (i = 0; i < lines.length; i++) {
    var line = lines[i];

    /* a blank line INSIDE a code block must not split the block */
    if (isBlankish(line)) {
      if (run.length > 0) {
        run.push("");
      }
      continue;
    }

    if (looksLikeCodeLine(line)) {
      run.push(line);
    } else {
      flush();
    }
  }
  flush();

  return out;
}

var HARVEST_CONTAINERS = [
  "[class*='markdown']",
  "[class*='prose']",
  "[class*='Prose']",
  "[class*='message']",
  "[class*='Message']",
  "[class*='response']",
  "[class*='answer']",
  "[class*='assistant']",
  "[data-message-author-role]",
  "article",
  "main"
];

/* ----------------------------------------------------------------
   Targeted last resort: find the actual text node that contains a
   Rhino keyword (TreeWalker with a text filter), climb to the nearest
   container that spans several lines and run the harvest rules on it.
   This catches renderers where neither <pre>/<code> nor a hopeful
   class name exists, without harvesting the whole page.
   ---------------------------------------------------------------- */
var ANCHOR_TARGET_RE = /rhinoscriptsyntax|rs\.Add|rs\.Create|import\s+rs/i;

function collectAnchorCandidates() {
  var out = [];
  var seen = {};

  if (!document.body || !document.createTreeWalker) {
    return out;
  }

  var walker = null;
  try {
    walker = document.createTreeWalker(
      document.body,
      window.NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (node && node.nodeValue && ANCHOR_TARGET_RE.test(node.nodeValue)) {
            return 1;   /* FILTER_ACCEPT */
          }
          return 2;     /* FILTER_REJECT */
        }
      },
      false
    );
  } catch (e) {
    return out;
  }

  var node = walker.nextNode ? walker.nextNode() : null;
  var anchors = 0;
  var scanned = 0;

  while (node && anchors < MAX_ANCHORS && scanned < MAX_TEXT_NODES) {
    scanned = scanned + 1;

    var el = node.parentNode;
    var hops = 0;
    while (el && el !== document.body && hops < 6) {
      var text = el.textContent ? el.textContent : "";
      if (text.indexOf("\n") >= 0 && text.length > 20) {
        break;
      }
      el = el.parentNode;
      hops = hops + 1;
    }

    if (el) {
      var blocks = harvestCandidatesFromText(textOfElement(el));
      var i;
      for (i = 0; i < blocks.length; i++) {
        addCandidate(out, seen, blocks[i], el);
      }
    }

    anchors = anchors + 1;
    node = walker.nextNode ? walker.nextNode() : null;
  }

  return out;
}

function collectHarvestCandidates() {
  var texts = [];
  var containers = [];
  var i;

  for (i = 0; i < HARVEST_CONTAINERS.length; i++) {
    safeQueryAll(document, HARVEST_CONTAINERS[i], containers);
  }
  if (containers.length === 0 && document.body) {
    containers.push(document.body);
  }
  if (containers.length > 120) {
    containers = containers.slice(containers.length - 120);
  }

  for (i = 0; i < containers.length; i++) {
    var txt = textOfElement(containers[i]);
    if (txt && txt.length > 20 && txt.length < 200000) {
      texts.push(txt);
    }
  }

  var out = [];
  var j;
  var k;
  for (j = 0; j < texts.length; j++) {
    var blocks = harvestCandidatesFromText(texts[j]);
    for (k = 0; k < blocks.length; k++) {
      out.push(blocks[k]);
    }
  }
  return out;
}

/* ---- public extraction API ---- */

/* Is this page plausibly an AI chat? The cheap selector scan runs
   everywhere; the text harvesting fallback (which reads innerText of
   many containers and therefore forces layout) only runs on chat-like
   pages, unless the user asks for it explicitly with the run button. */
function looksLikeChatPage() {
  var host = "";
  try {
    host = window.location.hostname.toLowerCase();
  } catch (e) {
    return false;
  }

  if (CHATBOT_MAP[host]) {
    return true;
  }
  if (host.indexOf("chat") >= 0 || host.indexOf("ai") >= 0 || host.indexOf("gpt") >= 0) {
    return true;
  }

  try {
    if (document.querySelector("#prompt-textarea, rich-textarea, " +
                             "textarea[placeholder*='essage'], textarea[placeholder*='Ask'], " +
                             "textarea[placeholder*='sk ' i], textarea[aria-label*='essage'], " +
                             "div[contenteditable='true'][role='textbox'], " +
                             "div[contenteditable='true'][aria-label*='essage']")) {
      return true;
    }
  } catch (e) {
    /* unsupported selector: fall through */
  }

  return false;
}

function extractAllCodes(forceHarvest) {
  var found = collectElementCandidates();

  /* fallbacks: no usable code container found on this page */
  if (found.length === 0 && (forceHarvest || looksLikeChatPage())) {
    var i;

    /* 1) walk to the text node that mentions Rhino and read its block */
    var anchors = collectAnchorCandidates();
    for (i = 0; i < anchors.length; i++) {
      found.push(anchors[i]);
    }

    /* 2) still nothing: harvest every code-like run on the page */
    if (found.length === 0) {
      var harvested = collectHarvestCandidates();
      for (i = 0; i < harvested.length; i++) {
        found.push({ code: normalizeCode(harvested[i]), el: null });
      }
    }
  }

  var codes = new Set();
  var seen = {};
  var j;
  for (j = 0; j < found.length; j++) {
    var code = found[j].code;
    if (!code || code.length <= 15) {
      continue;
    }
    var key = code.replace(/\s+/g, " ");
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    codes.add(code);
  }

  var list = Array.from(codes);
  var keys = [];
  for (j = 0; j < list.length; j++) {
    keys.push(list[j].replace(/\s+/g, " "));
  }

  /* a partial block next to its full version (harvesting can produce
     both) must not be executed as a second script */
  var kept = [];
  var a;
  var b;
  for (a = 0; a < list.length; a++) {
    var contained = false;
    for (b = 0; b < list.length; b++) {
      if (a === b) {
        continue;
      }
      if (keys[a].length > 20 && keys[b].length > keys[a].length &&
          keys[b].indexOf(keys[a]) >= 0) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      kept.push(list[a]);
    }
  }

  return kept;
}

/* ================================================================
   7) CODE DETECTION
   ================================================================ */

var RHINO_PATTERNS = [
  /rhinoscriptsyntax/i,
  /import\s+rs/i,
  /import\s+Rhino/i,
  /rs\.Add\w+/i,
  /rs\.Create\w+/i,
  /rs\.Get\w+/i,
  /Rhino\.Geometry/i,
  /scriptcontext/i,
  /sc\.doc/i,
  /AddBox|AddSphere|AddCylinder|AddCone|AddTorus|AddCurve|AddLine|AddCircle|AddPolyline|AddSurface|AddMesh|AddExtrusion|AddLoft|AddPipe|AddPoint|AddArc/i,
  /Point3d|Vector3d|Plane\(/,
  /WorldXYPlane|WorldYZPlane|WorldZXPlane/i,
  /NurbsCurve|NurbsSurface|Brep/i
];

function isRhinoCode(code) {
  if (!code || code.length < 15) {
    return false;
  }
  var score = 0;
  var i;
  for (i = 0; i < RHINO_PATTERNS.length; i++) {
    if (RHINO_PATTERNS[i].test(code)) {
      score = score + 1;
    }
  }
  return score >= 1;
}

function hash(s) {
  var h = 0;
  var i;
  for (i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

function rememberExecuted(h) {
  if (!executed[h]) {
    executedOrder.push(h);
  }
  executed[h] = true;
  while (executedOrder.length > EXECUTED_CAP) {
    var oldest = executedOrder.shift();
    if (oldest !== undefined) {
      delete executed[oldest];
    }
  }
}

function newestRhinoCode(forceHarvest) {
  var all = extractAllCodes(forceHarvest);
  var last = null;
  var i;
  for (i = 0; i < all.length; i++) {
    if (isRhinoCode(all[i])) {
      last = all[i];
    }
  }
  return last;
}

/* ================================================================
   8) EXECUTION QUEUE
   ----------------------------------------------------------------
   Codes are executed ONE AT A TIME. Two heavy scripts running at the
   same time inside one Rhino document is a crash risk, and it also
   makes the progress display meaningless.
   ================================================================ */

function isRunning() {
  return bridgeState.running === true;
}

function setRunning(value, hashValue) {
  bridgeState.running = value ? true : false;
  bridgeState.activeHash = value ? hashValue : null;
}

function queueLength() {
  return runQueue.length;
}

function enqueueCode(code, h, source) {
  if (!code) {
    return false;
  }
  if (executed[h]) {
    return false;
  }
  if (isRunning() && bridgeState.activeHash === h) {
    return false;
  }

  var i;
  for (i = 0; i < runQueue.length; i++) {
    if (runQueue[i].hash === h) {
      return false;
    }
  }

  if (runQueue.length >= QUEUE_CAP) {
    runQueue.shift();
    addLog("Queue is full - the oldest waiting code was dropped.");
  }

  runQueue.push({ code: code, hash: h, source: source ? source : "live" });
  updateDiagnostics();
  if (runQueue.length > 1) {
    addLog("Queued (" + runQueue.length + " waiting)");
  }
  pumpQueue();
  return true;
}

function pumpQueue() {
  if (isRunning()) {
    return;
  }
  if (!serviceOn || !liveOn) {
    return;
  }
  if (runQueue.length === 0) {
    return;
  }

  var item = runQueue.shift();
  updateDiagnostics();
  setRunning(true, item.hash);
  rememberExecuted(item.hash);
  item.startedAt = new Date().getTime();

  /* the detected script becomes visible in the manual box, unchanged:
     from here on it travels exactly the same road as a pasted script */
  setManualBox(item.code, "auto");

  addLog("Sending code to Rhino... (" +
         (item.code.split("\n").length) + " lines, " + item.code.length + " chars)");
  setPanelStatus("sending");
  updateVerifyUI(null);
  startProgressPolling();

  sendCommand(item, 1);
}

/* ----------------------------------------------------------------
   EXECUTE -> VERIFY -> RETRY LOOP  (2.6.0)
   ----------------------------------------------------------------
   The bridge answers /command with a `verify` report (objects
   created, validity, repairs). When the report says the run can be
   repaired, the extension asks for /retry automatically - up to
   RETRY_MAX times - and only then tells the user. That is the loop
   that makes sure the code really ran inside Rhino.
   ---------------------------------------------------------------- */
function sendCommand(item, attempt) {
  currentAttempt = attempt;
  bridgeRequest("/command", "POST",
    { type: "python", code: item.code },
    function (error, data) {
      if (error) {
        handleSendFailure(item, error);
        return;
      }
      handleAttemptResult(item, data, attempt);
    });
}

function handleAttemptResult(item, data, attempt) {
  var verify = (data && data.verify) ? data.verify : null;
  var success = (data && data.success) ? true : false;
  var errorText = (data && data.error) ? String(data.error) : "";

  if (verify) {
    updateVerifyUI(verify);
  }

  /* 2.6.1 fix: a run that Rhino executed successfully stays successful.
     Verification problems are shown as a warning (and are retried only
     when the bridge itself says the run failed), so a strict check can
     never turn working code into a "failure" the user has to fight. */
  var verifyWarning = "";
  if (success && verify && verify.ok === false) {
    verifyWarning = L("verFailed");
    addLog("Executed, but verification is not perfect: " +
           ((verify.checks || []).length ? "" : "") + (verify.error || ""));
    showVerifyWarning(verify);
  }

  if (success) {
    handleRunFinished(data);
    return;
  }

  var age = item.startedAt ? (new Date().getTime() - item.startedAt) : 0;
  var retryable = verify ? (verify.retryable === true) : false;
  var cancelled = errorText.indexOf("Cancelled") >= 0 ||
                  (verify && verify.cancelled === true);

  if (retryable && !cancelled && attempt <= RETRY_MAX && age < RETRY_MAX_AGE) {
    var nextAttempt = attempt + 1;
    setPanelStatus("retry", L("retry") + " " + nextAttempt);
    addLog("Run failed - repairing and retrying (" + nextAttempt + "/" + (RETRY_MAX + 1) + ")");
    if (retryTimer) {
      window.clearTimeout(retryTimer);
    }
    retryTimer = window.setTimeout(function () {
      retryTimer = null;
      bridgeRequest("/retry", "POST", { mode: "auto" },
        function (retryError, retryData) {
          if (retryError) {
            handleSendFailure(item, retryError);
            return;
          }
          handleAttemptResult(item, retryData, nextAttempt);
        });
    }, RETRY_DELAY);
    return;
  }

  handleRunFinished(data);
}

/* ----------------------------------------------------------------
   RETRY + SELF HEALING
   ----------------------------------------------------------------
   The old build marked a code block as "already executed" as soon as
   the request left the browser. If the bridge server was not running
   (or the page could not reach localhost at that moment) the block was
   silently lost forever - the number one reason auto-sync appeared to
   be broken. Now a connection failure puts the code back in the queue
   and a health probe keeps retrying until the server appears.
   ---------------------------------------------------------------- */
var MAX_SEND_RETRIES = 8;
var HEALTH_INTERVAL = 4000;
var healthTimer = null;
var serverDown = false;

function handleSendFailure(item, error) {
  var message = error ? String(error.message ? error.message : error) : "unknown";

  /* 2.6.1 fix: a long script can outlive the HTTP budget while Rhino is
     happily working through the steps. That is NOT a failure - the run
     is adopted and followed through /progress instead. */
  if (message.toLowerCase().indexOf("timeout") >= 0) {
    adoptRunningScript(item);
    return;
  }

  stopProgressPolling();
  setRunning(false, null);

  item.attempts = (item.attempts ? item.attempts : 0) + 1;

  if (item.attempts <= MAX_SEND_RETRIES) {
    runQueue.unshift(item);
    serverDown = true;
    addLog("Bridge server unreachable (" + item.attempts + "/" + MAX_SEND_RETRIES +
           ") - will retry automatically until it is up.");
    setPanelStatus("offline");
    startHealthTick();
  } else {
    /* give up, but leave the code detectable again so a later scan,
       the health tick or the run button can still execute it */
    delete executed[item.hash];
    addLog("Gave up reaching the server. Use ▶ after starting the server.");
    setPanelStatus("offline");
  }

  updateCounter();
  updateStopVisibility();
  updateDiagnostics();
}

/* The command call timed out: ask the bridge whether it is still busy,
   follow /progress until it is done, then read /verify. */
function adoptRunningScript(item) {
  addLog("Still running in Rhino - following the progress instead of failing.");

  var polls = 0;
  var maxPolls = 3600;          /* ~1 hour at 1 s */

  function poll() {
    polls = polls + 1;
    bridgeRequest("/progress", "GET", null, function (error, data) {
      if (error || !data) {
        setPanelStatus("offline");
        stopProgressPolling();
        setRunning(false, null);
        return;
      }

      if (data.active) {
        var total = data.total ? data.total : 0;
        var step = data.step ? data.step : 0;
        if (total > 1) {
          setPanelStatus("running", stepLabel(data, step, total));
          setProgressBar(step / total);
        }
        updateProgressText(data);
        if (polls < maxPolls) {
          window.setTimeout(poll, 1000);
        }
        return;
      }

      /* finished while we were not listening: collect the verdict */
      stopProgressPolling();
      setRunning(false, null);
      bridgeRequest("/verify", "GET", null, function (vError, verify) {
        var payload = {
          success: (verify && verify.available !== false)
                     ? (verify.success === true || verify.ok === true)
                     : false,
          steps: data.total ? data.total : 0,
          error: (verify && verify.error) ? verify.error : "",
          engine: "embedded",
          verify: (verify && verify.available !== false) ? verify : null
        };
        handleRunFinished(payload);
      });
    });
  }

  window.setTimeout(poll, 800);
}

function startHealthTick() {
  if (healthTimer) {
    return;
  }
  healthTimer = window.setInterval(function () {
    bridgeRequest("/status", "GET", null, function (error, data) {
      if (error || !data || data.server !== "running") {
        return;
      }
      /* the server is back */
      serverDown = false;
      window.clearInterval(healthTimer);
      healthTimer = null;
      addLog("Bridge server is back online.");
      setPanelStatus("idle");
      updateDiagnostics();
      pumpQueue();
    });
  }, HEALTH_INTERVAL);
}

function stopHealthTick() {
  if (healthTimer) {
    window.clearInterval(healthTimer);
    healthTimer = null;
  }
}

function handleRunFinished(data) {
  stopProgressPolling();
  setRunning(false, null);

  var success = (data && data.success) ? true : false;
  var error = (data && data.error) ? String(data.error) : "";
  var steps = (data && data.steps) ? data.steps : 0;
  var verify = (data && data.verify) ? data.verify : null;

  updateVerifyUI(verify);

  if (success) {
    bridgeState.count = bridgeState.count + 1;
    if (steps > 1) {
      addLog("Executed successfully! (" + steps + " steps)");
    } else {
      addLog("Executed successfully!");
    }
    if (verify && verify.objects_created !== null && verify.objects_created !== undefined) {
      addLog("Verified: " + verify.objects_created + " object(s) created" +
             (verify.repairs && verify.repairs.length ?
              ", " + verify.repairs.length + " repair(s)" : "") + ".");
    }
    setPanelStatus("success");
    injectBadge(true, "");
    showToast(L("toastDone") + (steps > 1 ? " · " + steps + " " + L("manualSteps") : ""), "ok");
  } else if (verify && verify.blocked) {
    addLog("Blocked: " + verify.blocked + " needs user input - not allowed in live mode.");
    setPanelStatus("error");
    injectBadge(false, verify.blocked);
  } else if (error.indexOf("Cancelled") >= 0) {
    addLog("Cancelled.");
    setPanelStatus("cancelled");
    showToast(L("toastStopped"), "warn");
  } else if (error.toLowerCase().indexOf("busy") >= 0) {
    addLog("Rhino is busy with another script.");
    setPanelStatus("busy");
  } else if (error.indexOf("timeout") >= 0) {
    addLog("Rhino timeout - no answer within the time limit.");
    setPanelStatus("error");
    injectBadge(false, "timeout");
  } else if (error.indexOf("Server unreachable") >= 0) {
    addLog("Server unreachable at " + SERVER);
    setPanelStatus("offline");
  } else {
    addLog("Rhino error: " + error);
    setPanelStatus("error");
    injectBadge(false, error);
    showToast(L("toastFailed") + ": " + error.slice(0, 90), "error");
  }

  updateCounter();
  resetProgressUI();

  /* run whatever is still queued, after a short pause */
  if (runQueue.length > 0 && serviceOn && liveOn) {
    window.setTimeout(pumpQueue, 400);
  }
}

/* ---- progress ---- */

function startProgressPolling() {
  stopProgressPolling();
  progressTimer = window.setInterval(pollProgress, PROGRESS_INTERVAL);
  try {
    pollProgress();
  } catch (e) {
    /* progress display is cosmetic: it must never break the run itself */
  }
}

function stopProgressPolling() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

function pollProgress() {
  try {
    bridgeRequest("/progress", "GET", null, function (error, data) {
      if (error || !data || !data.active) {
        return;
      }
      var total = data.total ? data.total : 0;
      var step = data.step ? data.step : 0;
      if (total > 1) {
        setPanelStatus("running", stepLabel(data, step, total));
        setProgressBar(step / total);
      } else {
        setProgressBar(0.15);
      }
      updateProgressText(data);
      if (data.repairs) {
        updateVerifyUI(null);
      }
    });
  } catch (e) {
    /* never let the progress display break the main path */
  }
}

function cancelRun() {
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (runQueue.length > 0) {
    runQueue = [];
    addLog("Waiting queue cleared.");
    updateDiagnostics();
  }
  bridgeRequest("/cancel", "POST", {}, function (error) {
    if (error) {
      addLog("Could not reach the server to cancel.");
    } else {
      addLog("Cancellation requested...");
    }
  });
}

/* ================================================================
   9) TRANSPORT - ALL BRIDGE HTTP GOES THROUGH THE SERVICE WORKER
   ----------------------------------------------------------------
   A content script lives inside the web page. Modern Chrome applies
   Local Network Access rules to page-context requests, so a fetch()
   from chatgpt.com to 127.0.0.1 can be blocked while the very same
   request from the popup works. That is exactly why auto-sync could
   fail silently while manual runs worked.

   Every call below therefore goes through background.js (extension
   context, holds host_permissions). A direct fetch is only used when
   the worker is unavailable.
   ================================================================ */

function bridgeDirect(path, method, body, onDone) {
  var options = { method: method };
  if (body !== undefined && body !== null && method !== "GET") {
    options.headers = { "Content-Type": "application/json" };
    options.body = (typeof body === "string") ? body : JSON.stringify(body);
  }
  try {
    fetch(SERVER + path, options)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        onDone(null, data);
      })
      .catch(function (err) {
        onDone(new Error(String((err && err.message) ? err.message : err)), null);
      });
  } catch (e) {
    onDone(new Error(String(e && e.message ? e.message : e)), null);
  }
}

/* onDone(errorOrNull, dataOrNull) - called exactly once. */
function bridgeRequest(path, method, body, onDone) {
  var answered = false;

  function finish(error, data) {
    if (answered) {
      return;
    }
    answered = true;
    onDone(error, data);
  }

  function fallback(reason) {
    /* The worker could not answer at all: try a direct request. On a
       page that blocks localhost this fails too, and the retry logic
       in the execution queue takes over. */
    bridgeDirect(path, method, body, function (directError, data) {
      if (directError) {
        finish(reason ? reason : directError, null);
      } else {
        finish(null, data);
      }
    });
  }

  try {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      fallback(new Error("no runtime"));
      return;
    }
    chrome.runtime.sendMessage(
      { type: "bridge", path: path, method: method, body: body, server: SERVER },
      function (response) {
        if (chrome.runtime.lastError) {
          fallback(new Error("worker unavailable"));
          return;
        }
        if (!response) {
          fallback(new Error("empty worker answer"));
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
    fallback(new Error(String(e && e.message ? e.message : e)));
  }
}

/* ================================================================
   10) RESULT BADGE INJECTION
   ================================================================ */

function injectBadge(success, message) {
  var pres = document.querySelectorAll("pre");
  if (!pres || pres.length === 0) {
    return;
  }
  var pre = pres[pres.length - 1];
  if (!pre || pre.getAttribute("data-rhinoBadged") === "true") {
    return;
  }
  pre.setAttribute("data-rhinoBadged", "true");

  var badge = document.createElement("div");
  badge.setAttribute("data-rhino-badge", "true");
  badge.style.margin = "6px 0";
  badge.style.padding = "4px 10px";
  badge.style.borderRadius = "6px";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "bold";
  badge.style.display = "inline-block";
  badge.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";

  if (success) {
    badge.textContent = "🦏 Executed in Rhino!";
    badge.style.border = "1px solid #00ff88";
    badge.style.color = "#00ff88";
  } else {
    badge.textContent = "🦏 " + (message ? message : "Execution failed");
    badge.style.border = "1px solid #ff4444";
    badge.style.color = "#ff4444";
  }

  if (pre.parentNode) {
    pre.parentNode.insertBefore(badge, pre.nextSibling);
  }
}

/* ================================================================
   11) FLOATING PANEL
   ----------------------------------------------------------------
   2.6.0 additions:
     * LIVE VIEWPORT - the panel shows the active Rhino view as a
       stream of JPEG frames coming from the bridge (/viewport).
     * DOCKING       - drag the panel near the left or right edge of
                       the browser and it snaps to that edge.
     * MINIMIZE      - the header collapses the panel to a title bar.
     * MAXIMIZE      - one click gives the panel a large, readable
                       size with a taller viewport.
     * RESIZE        - the corner grip changes width and height.
   Every one of those states is persisted in chrome.storage.local, so
   the panel comes back exactly as it was left.
   ================================================================ */

function panelExists() {
  return document.getElementById(PANEL_ID) !== null;
}

function panelEl() {
  return document.getElementById(PANEL_ID);
}

function bodyEl() {
  return document.getElementById(PANEL_BODY_ID);
}

/* One small square button for the header. */
function headerButtonHtml(id, label, title) {
  return '<span id="' + id + '" title="' + title + '" style="' +
         'display:inline-block;min-width:16px;text-align:center;margin-left:4px;' +
         'padding:1px 4px;border:1px solid #2a3346;border-radius:4px;background:#21262d;' +
         'color:#8b949e;font-size:10px;line-height:14px;cursor:pointer;">' + label + '</span>';
}

function createPanel() {
  if (!document.body || panelExists()) {
    if (panelExists()) {
      updateSmartArea();
      updateBadge();
      applyPanelGeometry();
    }
    return;
  }

  var panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("dir", "ltr");
  panel.style.position = "fixed";
  panel.style.bottom = "20px";
  panel.style.right = "20px";
  panel.style.width = "248px";
  panel.style.background = themeBg();
  panel.style.border = "1px solid " + themeBorder();
  panel.style.borderRadius = "10px";
  panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.55)";
  panel.style.zIndex = "2147483647";
  panel.style.fontFamily = "'Segoe UI', Tahoma, sans-serif";
  panel.style.fontSize = "12px";
  panel.style.color = themeText();
  panel.style.overflow = "hidden";
  panel.style.userSelect = "none";
  panel.style.boxSizing = "border-box";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";

  var headerStyle = "display:flex;align-items:center;justify-content:space-between;" +
                    "padding:8px 10px;background:" + themeHeader() + ";border-bottom:1px solid " +
                    themeBorder() + ";cursor:move;flex:0 0 auto;";
  var titleStyle = "font-weight:bold;font-size:13px;color:" + themeAccent() + ";";
  var badgeStyle = "font-size:9px;font-weight:bold;padding:2px 6px;border-radius:8px;" +
                   "background:" + themeAccent2() + ";color:#000000;margin-left:6px;";
  var bodyStyle = "padding:9px 10px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;";
  var statusStyle = "font-size:11px;font-weight:600;color:#00ff88;line-height:1.5;";
  var counterStyle = "font-size:10px;color:" + themeMuted() + ";margin-top:4px;";
  var diagStyle = "font-size:9px;color:" + themeMuted() + ";margin-top:3px;";
  var progressWrapStyle = "display:none;height:5px;background:" + themeCodeBg() + ";border-radius:3px;margin-top:7px;overflow:hidden;";
  var progressBarStyle = "height:100%;width:0%;background:linear-gradient(90deg," +
                         themeAccent() + "," + themeAccent2() + ");" +
                         "border-radius:3px;transition:width 120ms linear;";
  var progressTextStyle = "display:none;font-size:9px;color:" + themeMuted() + ";margin-top:3px;";
  var verifyStyle = "display:none;font-size:9px;line-height:1.5;margin-top:4px;padding:3px 5px;" +
                    "border-radius:4px;background:" + themeCodeBg() + ";color:" + themeMuted() + ";";
  var smartAreaStyle = "border-top:1px solid " + themeBorder() + ";margin-top:8px;padding-top:8px;";
  var btnBase = "border:none;border-radius:6px;cursor:pointer;font-family:'Segoe UI', Tahoma, sans-serif;" +
                "font-weight:bold;color:#0d1117;";
  var smartBtnStyle = btnBase + "width:100%;padding:7px 10px;font-size:12px;" +
                      "background:linear-gradient(135deg,#bb86fc,#8a5cf6);";
  var smartHintStyle = "font-size:10px;color:#bb86fc;text-align:center;line-height:1.5;margin-top:6px;";
  var rowStyle = "display:flex;gap:6px;margin-top:7px;";
  var runBtnStyle = btnBase + "flex:1;padding:6px 8px;font-size:11px;background:linear-gradient(135deg,#00d4ff,#0091c2);";
  var stopBtnStyle = btnBase + "flex:1;padding:6px 8px;font-size:11px;background:#ff4444;color:#ffffff;display:none;";
  var footerStyle = "font-size:9px;color:#6e7681;font-style:italic;text-align:center;margin-top:8px;";
  var viewWrapStyle = "position:relative;display:none;margin:-2px 0 8px 0;border:1px solid " + themeBorder() + ";" +
                      "border-radius:6px;overflow:hidden;background:" + themeCodeBg() + ";";
  var viewImgStyle = "display:block;width:100%;height:auto;min-height:90px;background:" + themeCodeBg() + ";";
  var viewBarStyle = "position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;" +
                     "justify-content:space-between;padding:2px 5px;background:rgba(13,17,23,0.82);" +
                     "font-size:9px;color:#8b949e;";
  var viewDotStyle = "display:inline-block;width:6px;height:6px;border-radius:50%;background:#00ff88;" +
                     "margin-right:4px;vertical-align:middle;";
  var fitBtnStyle = "border:none;border-radius:4px;background:#21262d;color:#00d4ff;font-size:9px;" +
                    "font-weight:bold;padding:2px 6px;cursor:pointer;";
  var iconBtnStyle = "border:none;border-radius:4px;background:#21262d;color:#8b949e;font-size:10px;" +
                     "font-weight:bold;padding:2px 6px;cursor:pointer;";

  var html = "";
  html = html + '<div id="' + HEADER_ID + '" style="' + headerStyle + '">';
  html = html + '<span style="' + titleStyle + '">' + L("title") + '</span>';
  html = html + '<span style="display:flex;align-items:center;">';
  html = html + '<span id="' + BADGE_ID + '" style="' + badgeStyle + '">' + L("badgeLive") + '</span>';
  html = html + headerButtonHtml(DOCK_BTN_ID, "⇤", L("dockHint"));
  html = html + headerButtonHtml(MIN_BTN_ID, "—", L("minHint"));
  html = html + headerButtonHtml(MAX_BTN_ID, "⤢", L("maxHint"));
  html = html + headerButtonHtml(CLOSE_ID, "✕", L("closeHint"));
  html = html + '</span>';
  html = html + '</div>';

  html = html + '<div id="' + PANEL_BODY_ID + '" style="' + bodyStyle + '">';

  /* ---- live viewport ---- */
  var viewMsgStyle = "position:absolute;left:0;right:0;top:0;bottom:18px;display:flex;" +
                     "align-items:center;justify-content:center;text-align:center;" +
                     "white-space:pre-line;padding:8px;font-size:10px;line-height:1.6;color:" +
                     themeMuted() + ";pointer-events:none;";
  html = html + '<div id="' + VIEW_ID + '" style="' + viewWrapStyle + '">';
  html = html + '<img id="' + VIEW_IMG_ID + '" alt="Rhino live view" style="' + viewImgStyle + '">';
  html = html + '<div id="' + VIEW_MSG_ID + '" style="' + viewMsgStyle + '">' + L("viewMsgWaiting") + '</div>';
  html = html + '<div id="' + VIEW_BAR_ID + '" style="' + viewBarStyle + '">';
  html = html + '<span id="' + VIEW_FPS_ID + '"><span style="' + viewDotStyle + '"></span>' + L("viewWaiting") + '</span>';
  html = html + '<span style="display:flex;gap:4px;">';
  html = html + '<button id="' + VIEW_REFRESH_ID + '" title="' + L("viewRefresh") + '" style="' + fitBtnStyle + '">⟳</button>';
  html = html + '<button id="' + VIEW_FIT_ID + '" style="' + fitBtnStyle + '">' + L("viewFit") + '</button>';
  html = html + '</span>';
  html = html + '</div>';
  html = html + '</div>';

  html = html + '<div id="' + STATUS_ID + '" style="' + statusStyle + '">' + L("idle") + '</div>';
  html = html + '<div id="' + PROGRESS_WRAP_ID + '" style="' + progressWrapStyle + '">';
  html = html + '<div id="' + PROGRESS_BAR_ID + '" style="' + progressBarStyle + '"></div>';
  html = html + '</div>';
  html = html + '<div id="' + PROGRESS_TEXT_ID + '" style="' + progressTextStyle + '"></div>';
  html = html + '<div id="' + VERIFY_ID + '" style="' + verifyStyle + '"></div>';
  html = html + '<div id="' + COUNTER_ID + '" style="' + counterStyle + '">' + L("counter") + '0</div>';
  html = html + '<div id="' + DIAG_ID + '" style="' + diagStyle + '"></div>';

  html = html + '<div id="' + SMART_AREA_ID + '" style="' + smartAreaStyle + '">';
  html = html + '<button id="' + SMART_BTN_ID + '" style="' + smartBtnStyle + '">' + L("smart") + '</button>';
  html = html + '<div style="' + smartHintStyle + '">' + L("smartHint") + '</div>';
  html = html + '<div style="' + rowStyle + '">';
  html = html + '<button id="' + RUN_BTN_ID + '" style="' + runBtnStyle + '">' + L("run") + '</button>';
  html = html + '<button id="' + STOP_BTN_ID + '" style="' + stopBtnStyle + '">' + L("stop") + '</button>';
  html = html + '</div>';
  html = html + '</div>';

  html = html + '<div style="' + rowStyle + '">';
  html = html + '<button id="' + VIEW_TOGGLE_ID + '" style="' + iconBtnStyle + 'flex:1;">' + L("viewToggle") + '</button>';
  html = html + '</div>';

  /* ---- MANUAL PYTHON EXECUTION -------------------------------
     The same box as the popup Code tab. Detected code is placed
     here, unchanged, and executed through exactly the same call the
     manual button uses - the path with the fewest moving parts. */
  var manualWrapStyle = "border-top:1px solid " + themeBorder() + ";margin-top:8px;padding-top:8px;";
  var manualTitleStyle = "font-size:10px;font-weight:bold;color:" + themeAccent() + ";margin-bottom:4px;";
  var manualBoxStyle = "width:100%;box-sizing:border-box;height:78px;resize:vertical;" +
                       "background:" + themeCodeBg() + ";color:" + themeText() + ";" +
                       "border:1px solid " + themeBorder() + ";border-radius:6px;padding:5px 6px;" +
                       "font-family:Consolas, 'Courier New', monospace;font-size:10px;line-height:1.45;" +
                       "white-space:pre;overflow:auto;user-select:text;";
  var manualMetaStyle = "font-size:9px;color:" + themeMuted() + ";margin-top:3px;";

  html = html + '<div id="' + MANUAL_WRAP_ID + '" style="' + manualWrapStyle + '">';
  html = html + '<div id="' + MANUAL_TITLE_ID + '" style="' + manualTitleStyle + '">' +
                L("manualTitle") +
                '<span style="float:right;font-weight:normal;color:' + themeMuted() + ';">Ctrl+Enter</span>' +
                '</div>';
  html = html + '<textarea id="' + MANUAL_ID + '" spellcheck="false" style="' + manualBoxStyle + '"></textarea>';
  html = html + '<div id="' + MANUAL_META_ID + '" style="' + manualMetaStyle + '" title="' +
                L("manualCleanHint") + '">' + L("manualEmpty") + '</div>';
  html = html + '<div style="' + rowStyle + '">';
  html = html + '<button id="' + MANUAL_RUN_ID + '" style="' + btnBase + 'flex:2;padding:6px 8px;font-size:11px;' +
                'background:linear-gradient(135deg,#00ff88,#00b35e);color:#062012;">' + L("manualRunSteps") + '</button>';
  html = html + '<button id="' + MANUAL_CLEAN_ID + '" title="' + L("manualCleanHint") + '" style="' +
                btnBase + 'flex:1;padding:6px 6px;font-size:11px;background:' + themeCodeBg() +
                ';color:' + themeText() + ';border:1px solid ' + themeBorder() + ';">' + L("manualClean") + '</button>';
  html = html + '<button id="' + MANUAL_COPY_ID + '" style="' + iconBtnStyle + '">' + L("manualCopy") + '</button>';
  html = html + '<button id="' + MANUAL_CLEAR_ID + '" style="' + iconBtnStyle + '">' + L("manualClear") + '</button>';
  html = html + '</div>';
  html = html + '</div>';

  /* ---- toast: the short answer to "did that work?" ---- */
  var toastStyle = "position:absolute;left:12px;right:12px;bottom:14px;padding:7px 10px;" +
                   "border:1px solid " + themeOk() + ";border-radius:8px;background:" + themeCodeBg() + ";" +
                   "color:" + themeOk() + ";font-size:11px;line-height:1.35;text-align:center;" +
                   "box-shadow:0 6px 18px rgba(0,0,0,0.35);opacity:0;transform:translateY(6px);" +
                   "transition:opacity 0.22s ease, transform 0.22s ease;pointer-events:none;" +
                   "display:none;z-index:5;";
  html = html + '<div id="' + TOAST_ID + '" style="' + toastStyle + '"></div>';

  html = html + '<div style="' + footerStyle + '">' + L("footer") + '</div>';
  html = html + '</div>';   /* body */

  /* ---- resize grip ---- */
  html = html + '<div id="' + GRIP_ID + '" title="' + L("resizeHint") + '" style="' +
         'position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;' +
         'background:linear-gradient(135deg,transparent 45%,#2a3346 45%,#2a3346 55%,transparent 55%,' +
         'transparent 70%,#2a3346 70%,#2a3346 80%,transparent 80%);"></div>';

  panel.innerHTML = html;
  document.body.appendChild(panel);

  applyPanelGeometry();
  wirePanelControls();
  updateSmartArea();
  updateBadge();
  updateCounter();
  updateStopVisibility();
  updateDiagnostics();
  updateViewArea();
  if (pendingManualCode) {
    var box = getManualBox();
    if (box && !box.value) {
      box.value = pendingManualCode;
      updateManualMeta();
    }
  } else {
    updateManualMeta();
  }
}

/* ----------------------------------------------------------------
   All event handlers of the panel, in one place so that a rebuilt
   panel (language switch) is always fully wired again.
   ---------------------------------------------------------------- */
function wirePanelControls() {
  var closeBtn = document.getElementById(CLOSE_ID);
  if (closeBtn) {
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      panelOn = false;
      saveSetting({ panel: false });
      destroyPanel();
      addLog("Floating panel closed.");
    });
    closeBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
  }

  var minBtn = document.getElementById(MIN_BTN_ID);
  if (minBtn) {
    minBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    minBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      toggleMinimize();
    });
  }

  var maxBtn = document.getElementById(MAX_BTN_ID);
  if (maxBtn) {
    maxBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    maxBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      toggleMaximize();
    });
  }

  var dockBtn = document.getElementById(DOCK_BTN_ID);
  if (dockBtn) {
    dockBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    dockBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      cycleDock();
    });
  }

  var smartBtn = document.getElementById(SMART_BTN_ID);
  if (smartBtn) {
    smartBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    smartBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      enhancePrompt();
    });
  }

  var runBtn = document.getElementById(RUN_BTN_ID);
  if (runBtn) {
    runBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    runBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      runNewestOnDemand();
    });
  }

  var stopBtn = document.getElementById(STOP_BTN_ID);
  if (stopBtn) {
    stopBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    stopBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      cancelRun();
    });
  }

  var viewToggle = document.getElementById(VIEW_TOGGLE_ID);
  if (viewToggle) {
    viewToggle.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    viewToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      setViewEnabled(!viewOn);
      saveSetting({ viewEnable: viewOn });
    });
  }

  var fitBtn = document.getElementById(VIEW_FIT_ID);
  if (fitBtn) {
    fitBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    fitBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      fitRhinoView();
    });
  }

  var refreshBtn = document.getElementById(VIEW_REFRESH_ID);
  if (refreshBtn) {
    refreshBtn.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    refreshBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      forceCaptureViewport();
    });
  }

  var viewImg = document.getElementById(VIEW_IMG_ID);
  if (viewImg) {
    viewImg.addEventListener("error", function () {
      /* the page CSP refused the data: image - say so instead of
         leaving a silent black box (2.6.3) */
      if (!viewHasFrame) {
        setViewMessage(L("viewMsgBlocked"));
      }
    });
  }

  var manualBox = document.getElementById(MANUAL_ID);
  if (manualBox) {
    manualBox.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    manualBox.addEventListener("keydown", function (e) {
      e.stopPropagation();
      /* Ctrl+Enter runs, Escape gives the focus back to the page */
      if (e.keyCode === 13 && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runManualFromPanel();
      } else if (e.keyCode === 27) {
        manualBox.blur();
      }
    });
    manualBox.addEventListener("input", function () {
      manualDirty = true;
      manualCleaned = 0;
      updateManualMeta();
      updateRunButton();
      saveManualToStorage(manualBox.value);
    });
  }

  var manualRun = document.getElementById(MANUAL_RUN_ID);
  if (manualRun) {
    manualRun.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    manualRun.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      runManualFromPanel();
    });
  }

  var manualClean = document.getElementById(MANUAL_CLEAN_ID);
  if (manualClean) {
    manualClean.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    manualClean.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      var removed = cleanBoxNow();
      if (removed === 0) {
        showToast(L("toastCleaned") + "0", "info");
      }
    });
  }

  var manualCopy = document.getElementById(MANUAL_COPY_ID);
  if (manualCopy) {
    manualCopy.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    manualCopy.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      copyBoxToClipboard();
    });
  }

  var manualClear = document.getElementById(MANUAL_CLEAR_ID);
  if (manualClear) {
    manualClear.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    manualClear.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      var box = getManualBox();
      if (box) {
        box.value = "";
      }
      manualDirty = false;
      manualCleaned = 0;
      updateManualMeta();
      updateRunButton();
      saveManualToStorage("");
    });
  }

  var header = document.getElementById(HEADER_ID);
  if (header) {
    header.addEventListener("mousedown", function (e) {
      var targetId = (e.target && e.target.id) ? e.target.id : "";
      if (targetId !== HEADER_ID && targetId !== "" && targetId !== HEADER_ID) {
        if (targetId === CLOSE_ID || targetId === MIN_BTN_ID || targetId === MAX_BTN_ID ||
            targetId === DOCK_BTN_ID || targetId === SMART_BTN_ID || targetId === BADGE_ID ||
            targetId === RUN_BTN_ID || targetId === STOP_BTN_ID) {
          return;
        }
      }
      var el = panelEl();
      if (!el) {
        return;
      }
      var rect = el.getBoundingClientRect();
      dragState = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top
      };
      isDragging = true;
      dockCandidate = "";

      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";

      e.preventDefault();
    });

    header.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      e.preventDefault();
      toggleMinimize();
    });
  }

  var grip = document.getElementById(GRIP_ID);
  if (grip) {
    grip.addEventListener("mousedown", function (e) {
      var el = panelEl();
      if (!el) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      resizeState = {
        startX: e.clientX,
        startY: e.clientY,
        width: el.offsetWidth,
        height: el.offsetHeight,
        sign: (panelDock === "right") ? -1 : 1
      };
      isResizing = true;
    });
  }
}

/* ----------------------------------------------------------------
   MANUAL PYTHON EXECUTION  (since 2.6.1, hardened in 2.6.2)
   ----------------------------------------------------------------
   Detected code is inserted into this box EXACTLY as it will be sent
   and is executed with the same call the manual button uses:

       POST /command   { type: "python", code: <what you see> }

   No transform, no extra flags: the automatic path and the manual path
   are literally the same request, so what works when pasted by hand
   also works automatically - that was the whole point of the change.
   ---------------------------------------------------------------- */

function getManualBox() {
  return document.getElementById(MANUAL_ID);
}

/* ----------------------------------------------------------------
   TOAST  (2.6.2)
   ----------------------------------------------------------------
   The status line is a permanent label; a toast is the short, loud
   answer to "did that work?". It never covers the panel controls and
   it disappears by itself after a few seconds.
   ---------------------------------------------------------------- */
var toastTimer = null;

function showToast(text, kind) {
  var el = document.getElementById(TOAST_ID);
  if (!el) {
    return;
  }
  var colour = themeOk();
  if (kind === "error") {
    colour = themeErr();
  } else if (kind === "warn") {
    colour = themeWarn();
  } else if (kind === "info") {
    colour = themeInfo();
  }
  el.textContent = text;
  el.style.borderColor = colour;
  el.style.color = colour;
  el.style.opacity = "1";
  el.style.transform = "translateY(0)";
  el.style.display = "block";
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(function () {
    toastTimer = null;
    var node = document.getElementById(TOAST_ID);
    if (!node) {
      return;
    }
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    window.setTimeout(function () {
      var later = document.getElementById(TOAST_ID);
      if (later && later.style.opacity === "0") {
        later.style.display = "none";
      }
    }, 260);
  }, 3400);
}

/* How many top level statements does this script have? It is only a
   hint for the Run button ("▶ Run · 4 steps"), so an approximation is
   enough - the real split is done by the chunker on the server. */
function estimateSteps(code) {
  if (!code) {
    return 0;
  }
  var lines = String(code).split("\n");
  var steps = 0;
  var i;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.replace(/\s/g, "").length === 0) {
      continue;
    }
    if (line.charAt(0) === " " || line.charAt(0) === "\t") {
      continue;                      /* inside a block */
    }
    if (line.charAt(0) === "#") {
      continue;                      /* comment    */
    }
    if (line.charAt(0) === "@") {
      continue;                      /* decorator  */
    }
    steps = steps + 1;
  }
  return steps < 1 ? (lines.length > 0 ? 1 : 0) : steps;
}

/* Enable / label the Run button so the panel always says what the
   button will do and never invites a click that cannot work. */
function updateRunButton() {
  var button = document.getElementById(MANUAL_RUN_ID);
  var box = getManualBox();
  if (!button) {
    return;
  }
  var text = box ? box.value : "";
  var steps = estimateSteps(text);
  var label = L("manualRunSteps");
  if (steps > 1) {
    label = label + " · " + steps + " " + L("manualSteps");
  }
  button.textContent = label;
  var empty = text.replace(/\s/g, "").length < 2;
  button.disabled = empty;
  button.style.opacity = empty ? "0.45" : "1";
  button.style.cursor = empty ? "not-allowed" : "pointer";
}

function updateManualMeta(extra) {
  var meta = document.getElementById(MANUAL_META_ID);
  var box = getManualBox();
  if (!meta) {
    return;
  }
  var text = box ? box.value : "";
  var lines = text.length ? text.split("\n").length : 0;
  var steps = estimateSteps(text);
  var label = "";
  if (lines === 0) {
    label = L("manualEmpty");
  } else {
    label = lines + " " + L("manualLines") + " · " +
            text.length + " " + L("manualChars") + " · " +
            (steps > 1 ? (steps + " " + L("manualSteps") + " · ") : "") +
            (manualDirty ? L("manualEdited") : L("manualAuto"));
  }
  if (manualCleaned > 0) {
    label = "🧹 " + manualCleaned + " " + L("manualCleaned") + " · " + label;
  }
  if (extra) {
    label = extra + " · " + label;
  }
  meta.textContent = label;
  meta.title = L("manualCleanHint");
  meta.style.color = manualDirty ? themeWarn() : themeMuted();
  updateRunButton();
}

/* ----------------------------------------------------------------
   CLEAN THE BOX NOW  (2.6.2)
   ----------------------------------------------------------------
   A code block whose toolbar lives inside the <pre> starts with words
   like "Download" or "Copy code"; those words are not Python and the
   script dies on line 1. They are removed here, in the box, before
   anything is sent - and the panel says how many lines went away.
   ---------------------------------------------------------------- */
var manualCleaned = 0;

function cleanText(text) {
  var report = cleanCodeReport(text);
  return report;
}

function cleanBoxNow(quiet) {
  var box = getManualBox();
  if (!box) {
    return 0;
  }
  var original = box.value ? box.value : "";
  if (original.replace(/\s/g, "").length === 0) {
    return 0;
  }
  var report = cleanCodeReport(original);
  var removed = report.chrome + report.glued;
  if (removed > 0 && report.code) {
    box.value = report.code;
    manualDirty = true;
    saveManualToStorage(box.value);
    manualCleaned = removed;
    updateManualMeta();
    if (!quiet) {
      showToast(L("toastCleaned") + removed + " " + L("manualLines"), "info");
      addLog("Removed " + removed + " toolbar line(s) from the manual box.");
    }
  }
  return removed;
}

function copyBoxToClipboard() {
  var box = getManualBox();
  var text = box ? box.value : "";
  if (text.replace(/\s/g, "").length === 0) {
    showToast(L("toastEmpty"), "warn");
    return;
  }
  function done() {
    showToast(L("toastCopied"), "info");
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(box, done);
      });
      return;
    }
  } catch (e) {
    /* fall through to the old way */
  }
  legacyCopy(box, done);
}

function legacyCopy(box, done) {
  try {
    if (!box) {
      return;
    }
    box.focus();
    box.select();
    if (document.execCommand && document.execCommand("copy")) {
      done();
    }
  } catch (e) {
    /* the clipboard is not available on this page - say nothing */
  }
}

function setManualBox(code, source) {
  var box = getManualBox();
  if (!box) {
    return;
  }
  var text = code ? code : "";
  if (manualDirty && source !== "manual") {
    /* never overwrite a script the user is editing */
    return;
  }
  box.value = text;
  manualSource = source ? source : "auto";
  manualDirty = false;
  /* the chrome count belongs to THIS exact text, so it is recomputed
     from it instead of trusting whatever was cleaned last */
  if (source !== "manual") {
    var measured = cleanCodeReport(text);
    manualCleaned = measured.chrome + measured.glued;
  }
  updateManualMeta();
  if (text) {
    saveManualToStorage(text);
  }
}

function saveManualToStorage(text) {
  if (manualSaveTimer) {
    window.clearTimeout(manualSaveTimer);
  }
  manualSaveTimer = window.setTimeout(function () {
    manualSaveTimer = null;
    saveSetting({ manualCode: text, manualStamp: new Date().getTime() });
  }, 220);
}

function readManualBox() {
  var box = getManualBox();
  return box && box.value ? box.value : "";
}

/* Run whatever is inside the manual box - the manual path. */
function runManualFromPanel() {
  /* whatever is in the box is what runs - but a toolbar word that
     sneaked in ("Download", "Copy code", a language label) is removed
     first, because it is not part of the code the AI generated and it
     is the first thing that would break the run */
  cleanBoxNow();

  var code = readManualBox();
  if (code.replace(/\s/g, "").length < 2) {
    addLog("The manual box is empty - nothing to run.");
    setPanelStatus("off", L("manualEmpty"));
    showToast(L("toastEmpty"), "warn");
    return;
  }
  if (cleanText(code).allChrome) {
    /* the box holds only toolbar labels: sending that to Rhino would
       fail on line 1 for no reason */
    addLog("The box holds only toolbar words - paste the code itself.");
    showToast(L("toastOnlyChrome"), "warn");
    return;
  }
  if (isRunning()) {
    addLog("Rhino is busy - stop the current run first.");
    return;
  }

  var h = hash(code);
  manualDirty = false;
  updateManualMeta();
  rememberExecuted(h);

  setRunning(true, h);
  currentAttempt = 1;
  addLog("Running the manual box in Rhino...");
  setPanelStatus("sending");
  updateVerifyUI(null);
  startProgressPolling();

  sendCommand({ code: code, hash: h, source: "manual", startedAt: new Date().getTime() }, 1);
}

function destroyPanel() {
  var panel = panelEl();
  if (panel && panel.parentNode) {
    panel.parentNode.removeChild(panel);
  }
  dragState = null;
  isDragging = false;
  resizeState = null;
  isResizing = false;
  stopViewport();
}

/* ----------------------------------------------------------------
   GEOMETRY: position, docking, size, minimize, maximize
   ---------------------------------------------------------------- */

function applyPanelGeometry() {
  var panel = panelEl();
  if (!panel) {
    return;
  }

  var width = (panelSize && panelSize.w) ? panelSize.w : (panelMax ? 430 : 248);
  var height = (panelSize && panelSize.h) ? panelSize.h : 0;
  if (panelMax) {
    width = Math.max(width, 430);
    height = Math.max(height, 620);
  }
  if (width < PANEL_MIN_W) {
    width = PANEL_MIN_W;
  }
  if (width > PANEL_MAX_W) {
    width = PANEL_MAX_W;
  }
  panel.style.width = width + "px";

  if (panelMin) {
    panel.style.height = "auto";
  } else if (height > 0) {
    panel.style.height = Math.min(Math.max(height, PANEL_MIN_H), PANEL_MAX_H) + "px";
  } else {
    panel.style.height = "";
  }

  /* ---- position ---- */
  if (panelDock === "left") {
    panel.style.left = "0px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.top = clampTop(panelPos ? panelPos.top : 80, panel) + "px";
    panel.style.borderRadius = "0 10px 10px 0";
  } else if (panelDock === "right") {
    panel.style.left = "auto";
    panel.style.right = "0px";
    panel.style.bottom = "auto";
    panel.style.top = clampTop(panelPos ? panelPos.top : 80, panel) + "px";
    panel.style.borderRadius = "10px 0 0 10px";
  } else if (panelPos && typeof panelPos.left === "number" && typeof panelPos.top === "number") {
    panel.style.left = clampLeft(panelPos.left, panel) + "px";
    panel.style.top = clampTop(panelPos.top, panel) + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.borderRadius = "10px";
  } else {
    panel.style.left = "auto";
    panel.style.top = "auto";
    panel.style.right = "20px";
    panel.style.bottom = "20px";
    panel.style.borderRadius = "10px";
  }

  applyMinimisedState();
  applyViewAreaSize();
}

function applyPanelPosition() {
  applyPanelGeometry();
}

function applyMinimisedState() {
  var body = bodyEl();
  var grip = document.getElementById(GRIP_ID);
  var minBtn = document.getElementById(MIN_BTN_ID);
  var viewWrap = document.getElementById(VIEW_ID);
  if (viewWrap) {
    viewWrap.style.display = (viewOn && !panelMin) ? "block" : "none";
  }
  if (body) {
    body.style.display = panelMin ? "none" : "block";
  }
  if (grip) {
    grip.style.display = (panelMin || isDocked()) ? "block" : "block";
    grip.style.right = (panelDock === "right") ? "auto" : "0";
    grip.style.left = (panelDock === "right") ? "0" : "auto";
    grip.style.height = panelMin ? "0px" : "14px";
    grip.style.width = panelMin ? "0px" : "14px";
  }
  if (minBtn) {
    minBtn.textContent = panelMin ? "❐" : "—";
    minBtn.title = panelMin ? L("restoreHint") : L("minHint");
  }
  var maxBtn = document.getElementById(MAX_BTN_ID);
  if (maxBtn) {
    maxBtn.textContent = panelMax ? "⤡" : "⤢";
  }
  if (panelMin) {
    stopViewport();
  } else {
    startViewport();
    applyViewAreaSize();
  }
}

function isDocked() {
  return panelDock === "left" || panelDock === "right";
}

function toggleMinimize() {
  panelMin = !panelMin;
  if (panelMin) {
    panelMax = false;
  }
  saveSetting({ panelMin: panelMin, panelMax: panelMax });
  applyPanelGeometry();
}

function toggleMaximize() {
  panelMax = !panelMax;
  if (panelMax) {
    panelMin = false;
  }
  saveSetting({ panelMax: panelMax, panelMin: panelMin });
  applyPanelGeometry();
}

function setDock(side) {
  var previous = panelDock;
  panelDock = side ? side : "";
  var panel = panelEl();
  if (panel) {
    var rect = panel.getBoundingClientRect();
    if (panelDock) {
      panelPos = { left: rect.left, top: rect.top };
    } else if (previous) {
      /* leaving a dock: step away from that edge so the panel is not
         glued to it any more, but keep the vertical position */
      var width = rect.width ? rect.width : 248;
      var offset = 24;
      panelPos = {
        left: (previous === "left") ? offset : Math.max(offset, window.innerWidth - width - offset),
        top: rect.top
      };
      saveSetting({ panelPos: panelPos });
    }
  }
  saveSetting({ panelDock: panelDock });
  applyPanelGeometry();
  addLog(panelDock ? ("Panel docked to the " + panelDock + " edge.") : "Panel undocked.");
}

function cycleDock() {
  if (panelDock === "") {
    setDock("right");
  } else if (panelDock === "right") {
    setDock("left");
  } else {
    setDock("");
  }
}

function clampLeft(left, panel) {
  var width = panel && panel.offsetWidth ? panel.offsetWidth : 248;
  var max = window.innerWidth - width;
  if (max < 0) {
    max = 0;
  }
  if (left < 0) {
    return 0;
  }
  if (left > max) {
    return max;
  }
  return left;
}

function clampTop(top, panel) {
  var height = panel && panel.offsetHeight ? panel.offsetHeight : 170;
  var max = window.innerHeight - height;
  if (max < 0) {
    max = 0;
  }
  if (top < 0) {
    return 0;
  }
  if (top > max) {
    return max;
  }
  return top;
}

function onDragMove(e) {
  if (!isDragging || !dragState) {
    return;
  }
  var panel = panelEl();
  if (!panel) {
    return;
  }

  var left = e.clientX - dragState.offsetX;
  var top = e.clientY - dragState.offsetY;
  panel.style.left = clampLeft(left, panel) + "px";
  panel.style.top = clampTop(top, panel) + "px";
  panel.style.right = "auto";
  panel.style.bottom = "auto";

  /* docking preview: near the left / right edge of the browser? */
  var candidate = "";
  if (e.clientX <= DOCK_SNAP) {
    candidate = "left";
  } else if (e.clientX >= (window.innerWidth - DOCK_SNAP)) {
    candidate = "right";
  }
  if (candidate !== dockCandidate) {
    dockCandidate = candidate;
    panel.style.borderColor = candidate ? "#00d4ff" : "#2a3346";
    panel.style.boxShadow = candidate ? "0 0 0 2px rgba(0,212,255,0.35), 0 8px 24px rgba(0,0,0,0.55)"
                                      : "0 8px 24px rgba(0,0,0,0.55)";
  }
}

function onDragEnd() {
  if (!isDragging) {
    return;
  }
  isDragging = false;
  dragState = null;

  var panel = panelEl();
  if (!panel) {
    dockCandidate = "";
    return;
  }
  panel.style.borderColor = "#2a3346";
  panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.55)";

  if (dockCandidate) {
    var side = dockCandidate;
    dockCandidate = "";
    setDock(side);
    return;
  }

  dockCandidate = "";
  panelDock = "";
  var rect = panel.getBoundingClientRect();
  panelPos = { left: rect.left, top: rect.top };
  saveSetting({ panelPos: panelPos, panelDock: "" });
  applyPanelGeometry();
}

function onResizeMove(e) {
  if (!isResizing || !resizeState) {
    return;
  }
  var panel = panelEl();
  if (!panel) {
    return;
  }
  var width = resizeState.width + resizeState.sign * (e.clientX - resizeState.startX);
  var height = resizeState.height + (e.clientY - resizeState.startY);
  if (width < PANEL_MIN_W) {
    width = PANEL_MIN_W;
  }
  if (width > PANEL_MAX_W) {
    width = PANEL_MAX_W;
  }
  if (height < PANEL_MIN_H) {
    height = PANEL_MIN_H;
  }
  if (height > PANEL_MAX_H) {
    height = PANEL_MAX_H;
  }
  panelSize = { w: Math.round(width), h: Math.round(height) };
  panelMax = false;
  panelMin = false;
  applyPanelGeometry();
}

function onResizeEnd() {
  if (!isResizing) {
    return;
  }
  isResizing = false;
  resizeState = null;
  if (panelSize) {
    saveSetting({ panelSize: panelSize, panelMax: panelMax, panelMin: panelMin });
  }
  pollViewportSoon();
}

document.addEventListener("mousemove", onDragMove, true);
document.addEventListener("mouseup", onDragEnd, true);
document.addEventListener("mousemove", onResizeMove, true);
document.addEventListener("mouseup", onResizeEnd, true);
window.addEventListener("resize", function () {
  applyPanelGeometry();
  pollViewportSoon();
});

/* ----------------------------------------------------------------
   LIVE VIEWPORT
   ----------------------------------------------------------------
   The bridge captures the active Rhino view on Rhino's main thread
   and serves it as a base64 JPEG. The panel asks for the next
   revision every VIEW_INTERVAL ms; when nothing changed the bridge
   answers instantly with the cached frame, so the cost is one tiny
   JSON round trip per tick - and the picture is always in sync with
   what Rhino is doing right now.
   ---------------------------------------------------------------- */

function viewWidth() {
  var panel = panelEl();
  var width = panel && panel.clientWidth ? panel.clientWidth : 248;
  width = Math.round(width);
  if (width < 320) {
    width = 320;
  }
  if (width > VIEW_MAX_PX) {
    width = VIEW_MAX_PX;
  }
  return width;
}

function setViewEnabled(value) {
  viewOn = value ? true : false;
  updateViewArea();
  if (viewOn) {
    viewBackoffUntil = 0;
    viewErrors = 0;
    setViewMessage(L("viewMsgWaiting"));
    startViewport();
    pollViewportSoon();
  } else {
    stopViewport();
    addLog("Live viewport switched off.");
  }
  updateViewToggleLabel();
}

function updateViewArea() {
  var wrap = document.getElementById(VIEW_ID);
  if (!wrap) {
    return;
  }
  wrap.style.display = (viewOn && !panelMin) ? "block" : "none";
  applyViewAreaSize();
  updateViewToggleLabel();
  if (viewOn) {
    startViewport();
  } else {
    stopViewport();
  }
}

function applyViewAreaSize() {
  var wrap = document.getElementById(VIEW_ID);
  var img = document.getElementById(VIEW_IMG_ID);
  if (!wrap) {
    return;
  }
  var height = panelMax ? 300 : (panelSize && panelSize.h ? Math.max(120, Math.round(panelSize.h * 0.42)) : 170);
  wrap.style.height = height + "px";
  if (img) {
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.minHeight = "0";
  }
}

function updateViewToggleLabel() {
  var btn = document.getElementById(VIEW_TOGGLE_ID);
  if (btn) {
    btn.textContent = viewOn ? L("viewOn") : L("viewOff");
    btn.style.color = viewOn ? "#00d4ff" : "#8b949e";
  }
}

function setViewBarText(text, live) {
  var el = document.getElementById(VIEW_FPS_ID);
  if (!el) {
    return;
  }
  var color = live ? "#00ff88" : "#ffa657";
  el.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;' +
                 'background:' + color + ';margin-right:4px;vertical-align:middle;"></span>' + text;
}

function startViewport() {
  if (!viewOn || !serviceOn || !panelOn || panelMin) {
    return;
  }
  if (viewTimer) {
    return;
  }
  viewTimer = window.setInterval(pollViewport, VIEW_INTERVAL);
  pollViewportSoon();
  updateViewBarState();
}

function stopViewport() {
  if (viewTimer) {
    window.clearInterval(viewTimer);
    viewTimer = null;
  }
  viewInFlight = false;
}

function pollViewportSoon() {
  window.setTimeout(function () {
    try {
      pollViewport();
    } catch (e) {
      /* the viewport must never break the page */
    }
  }, 30);
}

/* Show (or hide) the explanation layer over the viewport picture.
   The viewport must never be a silent black box again: while no real
   frame is on screen this layer says exactly what is being waited for
   or what Rhino answered (2.6.3). */
function setViewMessage(text) {
  var el = document.getElementById(VIEW_MSG_ID);
  if (!el) {
    return;
  }
  if (viewHasFrame || !text) {
    el.style.display = "none";
    return;
  }
  el.textContent = text;
  el.style.display = "flex";
}

/* Put one bridge frame on screen. Shared by the poll loop, Fit and the
   manual refresh button. A frame is accepted even when its revision
   equals the last one we saw: after a panel rebuild (theme / language
   switch) the fresh <img> has no src yet, and throwing the frame away
   just because the revision did not change left the viewport black. */
function showFrame(data) {
  if (!data || !data.data) {
    return false;
  }
  var img = document.getElementById(VIEW_IMG_ID);
  if (!img) {
    return false;
  }
  var hasSrc = !!img.getAttribute("src");
  if (data.rev === viewRev && hasSrc && viewHasFrame) {
    return true;   /* this exact frame is already on screen */
  }
  viewRev = data.rev;
  img.src = "data:image/" + (data.format === "png" ? "png" : "jpeg") +
            ";base64," + data.data;
  viewHasFrame = true;
  setViewMessage("");
  var now = new Date().getTime();
  if (viewLastFrameAt > 0) {
    var delta = now - viewLastFrameAt;
    if (delta > 0) {
      viewFps = Math.round((0.65 * viewFps) + (0.35 * (1000 / delta)));
    }
  }
  viewLastFrameAt = now;
  viewFrames = viewFrames + 1;
  updateViewBarState();
  return true;
}

function pollViewport() {
  if (!viewOn || !serviceOn || !panelOn || panelMin) {
    return;
  }
  if (!document.getElementById(VIEW_IMG_ID)) {
    return;
  }
  /* 2.6.3: one request at a time. The old loop fired every 320 ms
     while each answer could take 1.5 s, so half a dozen long polls
     piled up on the bridge and kept clearing each other's wait. */
  if (viewInFlight) {
    return;
  }
  /* after capture failures the bridge retries on its side; on this
     side we simply ask less often for a while - but we DO keep asking,
     so the view heals by itself once Rhino can capture again */
  if (viewBackoffUntil > 0 && new Date().getTime() < viewBackoffUntil) {
    return;
  }
  viewTicks = viewTicks + 1;
  /* when Rhino is closed there is no reason to ask 3 times per second:
     back off to roughly one probe every 3 seconds until a frame arrives */
  if (viewErrors >= 3 && viewTicks % 9 !== 0) {
    return;
  }
  var requested = viewWidth();
  viewInFlight = true;
  bridgeRequest("/viewport?rev=" + viewRev + "&w=" + requested + "&wait=1.5", "GET", null,
    function (error, data) {
      viewInFlight = false;
      if (!viewOn || !panelOn) {
        return;
      }
      if (error || !data) {
        viewErrors = viewErrors + 1;
        setViewBarText(L("viewOffline"), false);
        setViewMessage(L("viewMsgOffline"));
        return;
      }
      viewErrors = 0;
      if (data.ok === false) {
        /* show WHY there is no frame (Rhino's own words) and back off;
           2.6.2 stopped the stream forever at this point */
        var reason = data.error ? String(data.error) : "";
        if (reason.length > 90) {
          reason = reason.substring(0, 90) + "…";
        }
        if (data.supported === false) {
          viewSupported = false;
          viewBackoffUntil = new Date().getTime() + 5000;
          setViewBarText(L("viewUnsupported"), false);
          setViewMessage(L("viewUnsupported") + (reason ? "\n" + reason : ""));
        } else {
          setViewBarText(L("viewWaiting"), false);
          setViewMessage(L("viewMsgWaiting") + (reason ? "\n" + reason : ""));
        }
        return;
      }
      viewSupported = true;
      viewBackoffUntil = 0;
      showFrame(data);
    });
}

/* The ⟳ button: ask Rhino for a brand new frame right now. */
function forceCaptureViewport() {
  viewBackoffUntil = 0;
  viewErrors = 0;
  setViewBarText(L("viewFitBusy"), true);
  bridgeRequest("/viewport", "POST", { action: "capture", rev: 0, width: viewWidth() },
    function (error, data) {
      if (error || !data) {
        setViewBarText(L("viewOffline"), false);
        setViewMessage(L("viewMsgOffline"));
        return;
      }
      if (data.ok && data.data) {
        viewSupported = true;
        showFrame(data);
      } else {
        var reason = data.error ? String(data.error) : "";
        if (reason.length > 90) {
          reason = reason.substring(0, 90) + "…";
        }
        setViewBarText(L("viewWaiting"), false);
        setViewMessage(L("viewMsgWaiting") + (reason ? "\n" + reason : ""));
        pollViewportSoon();
      }
    });
}

function updateViewBarState() {
  var text = L("viewLive") + " · " + viewFps + " fps";
  if (viewRev > 0) {
    text = text + " · #" + viewRev;
  }
  setViewBarText(text, true);
}

function fitRhinoView() {
  setViewBarText(L("viewFitBusy"), true);
  bridgeRequest("/viewport", "POST", { action: "fit", rev: 0, width: viewWidth() },
    function (error, data) {
      if (error || !data) {
        setViewBarText(L("viewOffline"), false);
        setViewMessage(L("viewMsgOffline"));
        return;
      }
      if (data.ok && data.data) {
        viewSupported = true;
        showFrame(data);
      } else if (viewHasFrame) {
        updateViewBarState();
      } else {
        var reason = data.error ? String(data.error) : "";
        if (reason.length > 90) {
          reason = reason.substring(0, 90) + "…";
        }
        setViewBarText(L("viewWaiting"), false);
        setViewMessage(L("viewMsgWaiting") + (reason ? "\n" + reason : ""));
      }
    });
}

/* ---- panel state helpers ---- */

function clearRevertTimer() {
  if (revertTimer) {
    window.clearTimeout(revertTimer);
    revertTimer = null;
  }
}

function scheduleRevert() {
  clearRevertTimer();
  revertTimer = window.setTimeout(function () {
    if (isRunning()) {
      return;
    }
    if (!serviceOn) {
      setPanelStatus("off");
    } else if (!liveOn) {
      setPanelStatus("paused");
    } else {
      setPanelStatus("idle");
    }
  }, STATUS_REVERT_MS);
}

function setPanelStatus(state, customText) {
  var el = document.getElementById(STATUS_ID);
  if (!el) {
    return;
  }

  clearRevertTimer();

  if (state === "sending") {
    el.textContent = L("sending");
    el.style.color = themeWarn();
  } else if (state === "running") {
    el.textContent = customText ? ("🔵 " + customText) : L("running");
    el.style.color = themeAccent();
  } else if (state === "verifying") {
    el.textContent = customText ? ("🔎 " + customText) : L("verifying");
    el.style.color = themeInfo();
  } else if (state === "retry") {
    el.textContent = customText ? ("🔁 " + customText) : L("retrying");
    el.style.color = themeInfo();
  } else if (state === "success") {
    el.textContent = L("success");
    el.style.color = themeOk();
    scheduleRevert();
  } else if (state === "cancelled") {
    el.textContent = L("cancelled");
    el.style.color = themeMuted();
    scheduleRevert();
  } else if (state === "offline") {
    el.textContent = L("offline");
    el.style.color = themeWarn();
    scheduleRevert();
  } else if (state === "busy") {
    el.textContent = L("busy");
    el.style.color = themeWarn();
    scheduleRevert();
  } else if (state === "error") {
    el.textContent = L("error");
    el.style.color = themeErr();
    scheduleRevert();
  } else if (state === "off") {
    el.textContent = L("off");
    el.style.color = themeMuted();
  } else if (state === "paused") {
    el.textContent = L("paused");
    el.style.color = themeWarn();
  } else {
    el.textContent = L("idle");
    el.style.color = themeOk();
  }

  updateStopVisibility();
}

/* "step 3/12 · lines 41-66" - the line range tells the user which part
   of the script Rhino is chewing on right now, which is far more useful
   than a bare fraction when a step is slow. */
function stepLabel(data, step, total) {
  var label = L("step") + step + "/" + total;
  if (data && data.start_line && data.end_line) {
    label = label + " · " + L("diagLines") + " " + data.start_line + "-" + data.end_line;
  }
  return label;
}

function setProgressBar(ratio) {
  var wrap = document.getElementById(PROGRESS_WRAP_ID);
  var bar = document.getElementById(PROGRESS_BAR_ID);
  if (!wrap || !bar) {
    return;
  }
  var safe = ratio;
  if (!safe || safe < 0) {
    safe = 0;
  }
  if (safe > 1) {
    safe = 1;
  }
  wrap.style.display = "block";
  bar.style.width = Math.round(safe * 100) + "%";
}

function updateProgressText(data) {
  var el = document.getElementById(PROGRESS_TEXT_ID);
  if (!el) {
    return;
  }
  if (!data) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  var text = L("step") + (data.step ? data.step : 0) + "/" + (data.total ? data.total : 0);
  if (data.start_line) {
    text = text + " · " + L("diagLines") + " " + data.start_line + "-" + data.end_line;
  }
  if (data.elapsed) {
    text = text + " · " + data.elapsed + "s";
  }
  if (data.repairs) {
    text = text + " · 🔧 " + data.repairs;
  }
  el.textContent = text;
  el.style.display = "block";
}

function resetProgressUI() {
  var wrap = document.getElementById(PROGRESS_WRAP_ID);
  var bar = document.getElementById(PROGRESS_BAR_ID);
  if (wrap) {
    wrap.style.display = "none";
  }
  if (bar) {
    bar.style.width = "0%";
  }
  updateProgressText(null);
}

function updateVerifyUI(verify) {
  var el = document.getElementById(VERIFY_ID);
  if (!el) {
    return;
  }
  if (!verify) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  var text = describeVerify(verify);
  if (!text) {
    el.style.display = "none";
    return;
  }
  el.textContent = text;
  el.style.display = "block";
  if (verify.ok) {
    el.style.color = themeOk();
    el.style.background = themeCodeBg();
  } else {
    el.style.color = themeWarn();
    el.style.background = themeCodeBg();
  }
}

function showVerifyWarning(verify) {
  var el = document.getElementById(VERIFY_ID);
  if (!el) {
    return;
  }
  var text = "⚠️ " + L("verFailed");
  if (verify && verify.invalid_objects && verify.invalid_objects.length) {
    text = text + " · ✖ " + verify.invalid_objects.length;
  }
  if (verify && verify.error) {
    text = text + " · " + String(verify.error).substring(0, 60);
  }
  el.textContent = text;
  el.style.display = "block";
  el.style.color = themeWarn();
  el.style.background = themeCodeBg();
}

function describeVerify(verify) {
  if (!verify) {
    return "";
  }
  var parts = [];
  if (verify.ok) {
    parts.push("✅ " + L("verOk"));
  } else if (verify.blocked) {
    parts.push("⛔ " + verify.blocked);
  } else if (verify.cancelled) {
    parts.push("⏹ " + L("cancelled"));
  } else {
    parts.push("⚠️ " + L("verFailed"));
  }
  if (verify.objects_created !== null && verify.objects_created !== undefined) {
    parts.push(L("diagObjects") + " " + verify.objects_created);
  }
  if (verify.invalid_objects && verify.invalid_objects.length > 0) {
    parts.push("✖ " + verify.invalid_objects.length);
  }
  if (verify.repairs && verify.repairs.length > 0) {
    parts.push("🔧 " + verify.repairs.length);
  }
  if (verify.attempt) {
    parts.push("↻ " + verify.attempt + "/" + (verify.max_attempts ? verify.max_attempts : 2));
  }
  return parts.join(" · ");
}

function updateStopVisibility() {
  var stopBtn = document.getElementById(STOP_BTN_ID);
  if (!stopBtn) {
    return;
  }
  stopBtn.style.display = (isRunning() || runQueue.length > 0) ? "block" : "none";
}

function updateBadge() {
  var el = document.getElementById(BADGE_ID);
  if (!el) {
    return;
  }
  if (!serviceOn) {
    el.textContent = L("badgeOff");
    el.style.background = themeErr();
    el.style.color = "#ffffff";
  } else if (liveOn) {
    el.textContent = L("badgeLive");
    el.style.background = themeAccent2();
    el.style.color = "#000000";
  } else {
    el.textContent = L("badgePaused");
    el.style.background = themeWarn();
    el.style.color = "#000000";
  }
}

function updateSmartArea() {
  var area = document.getElementById(SMART_AREA_ID);
  if (!area) {
    return;
  }
  area.style.display = smartOn ? "block" : "none";
}

/* One compact line that makes auto-sync observable: how many code
   blocks the scanner sees, how many look like Rhino code, whether the
   bridge server answers and how much is waiting in the queue. */
function updateDiagnostics() {
  var el = document.getElementById(DIAG_ID);
  if (!el) {
    return;
  }
  var text = "🔎 " + L("diagBlocks") + " " + lastScanCounts.all +
             " · 🦏 " + L("diagRhino") + " " + lastScanCounts.rhino +
             " · 🔌 " + L("diagServer") + " " + (serverDown ? "✗" : "✓");
  if (runQueue.length > 0) {
    text = text + " · ⏳ " + L("diagQueue") + " " + runQueue.length;
  }
  el.textContent = text;
}

function updateCounter() {
  var el = document.getElementById(COUNTER_ID);
  if (el) {
    el.textContent = L("counter") + bridgeState.count;
  }
}

/* ================================================================
   12) SMART PROMPT
   ================================================================ */

var INPUT_SELECTORS = [
  "textarea[data-id]",
  "textarea[placeholder*=\"Message\"]",
  "#prompt-textarea",
  "div[contenteditable=\"true\"].ProseMirror",
  "div.ProseMirror[contenteditable=\"true\"]",
  "rich-textarea div[contenteditable=\"true\"]",
  "div[contenteditable=\"true\"].ql-editor",
  "textarea#chat-input",
  "textarea[placeholder*=\"Ask\"]",
  "textarea[data-testid*=\"input\"]",
  "textarea[placeholder]:not([readonly])",
  "div[contenteditable=\"true\"][role=\"textbox\"]",
  "div[contenteditable=\"true\"]"
];

function findChatInput() {
  var i;
  var j;
  for (i = 0; i < INPUT_SELECTORS.length; i++) {
    var nodes;
    try {
      nodes = document.querySelectorAll(INPUT_SELECTORS[i]);
    } catch (e) {
      continue;
    }
    for (j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      if (el.disabled || el.readOnly) {
        continue;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 20) {
        return el;
      }
    }
  }
  return null;
}

function getInputValue(el) {
  if (!el) {
    return "";
  }
  var tag = (el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT") {
    return el.value ? el.value : "";
  }
  var txt = el.innerText ? el.innerText : el.textContent;
  return txt ? txt : "";
}

function setInputValue(el, value) {
  if (!el) {
    return;
  }
  var tag = (el.tagName || "").toUpperCase();

  if (tag === "TEXTAREA" || tag === "INPUT") {
    var proto = (tag === "TEXTAREA") ? window.HTMLTextAreaElement.prototype
                                     : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  /* contentEditable (ProseMirror / Quill / rich-textarea) */
  el.focus();
  el.innerHTML = "";
  var lines = String(value).split("\n");
  var i;
  for (i = 0; i < lines.length; i++) {
    if (i > 0) {
      el.appendChild(document.createElement("br"));
    }
    el.appendChild(document.createTextNode(lines[i]));
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function flashSmartButton() {
  var btn = document.getElementById(SMART_BTN_ID);
  if (!btn) {
    return;
  }
  btn.textContent = L("smartDone");
  btn.style.background = "linear-gradient(135deg,#00ff88,#00c46a)";
  window.setTimeout(function () {
    var again = document.getElementById(SMART_BTN_ID);
    if (!again) {
      return;
    }
    again.textContent = L("smart");
    again.style.background = "linear-gradient(135deg,#bb86fc,#8a5cf6)";
  }, 1800);
}

function enhancePrompt() {
  var input = findChatInput();

  if (!input) {
    window.alert("⚠️ Chat input not found on this page.");
    return;
  }

  var current = getInputValue(input);

  if (!current || current.replace(/^\s+|\s+$/g, "").length === 0) {
    window.alert("⚠️ Please type your request in the chatbox first, then click the 🧠 button.");
    return;
  }

  if (current.indexOf("RHINO LIVE BRIDGE") >= 0 || current.indexOf("rhinoscriptsyntax") >= 0) {
    window.alert("✓ Prompt is already enhanced.");
    return;
  }

  setInputValue(input, customPrompt + "\n" + current);

  try {
    input.focus();
  } catch (e) {
    /* ignore */
  }

  addLog("Smart Prompt applied!");
  flashSmartButton();
}

/* ================================================================
   13) ON DEMAND RUN OF THE NEWEST CODE ON THE PAGE
   ================================================================ */

function runNewestOnDemand() {
  if (!serviceOn) {
    addLog("Main Service is OFF - turn it on first.");
    return;
  }

  var code = newestRhinoCode(true);
  if (!code) {
    addLog("No Rhino code found on this page.");
    return;
  }

  var h = hash(code);
  delete executed[h];

  addLog("Running the newest code block on this page...");
  enqueueCode(code, h, "manual");
}

/* ================================================================
   14) SCANNING LOOP + DEBOUNCE
   ================================================================ */

/* The stability window is a time span, so re-check it exactly when it
   expires instead of waiting for the next 1.5 s tick: that keeps the
   hand-off to Rhino snappy without ever sending half-typed code. */
function scheduleSettleScan() {
  if (settleTimer) {
    return;
  }
  settleTimer = window.setTimeout(function () {
    settleTimer = null;
    try {
      scan();
    } catch (e) {
      /* a scan must never break the page */
    }
  }, STABLE_MS + 200);
}

function clearSettleScan() {
  if (settleTimer) {
    window.clearTimeout(settleTimer);
    settleTimer = null;
  }
}

function cleanPendingHashes(now) {
  var toDelete = [];
  pendingHashes.forEach(function (value, key) {
    if (now - value.time > HASH_TTL) {
      toDelete.push(key);
    }
  });
  var i;
  for (i = 0; i < toDelete.length; i++) {
    pendingHashes.delete(toDelete[i]);
  }
}

/* On the very first scan, older code blocks found on the page are
   treated as history: opening an old conversation must not fire a
   dozen heavy scripts at Rhino. The newest block still runs, and the
   ▶ Run button can execute any of them on demand. */
function seedHistory() {
  var all = extractAllCodes();
  var rhinoBlocks = [];
  var i;

  for (i = 0; i < all.length; i++) {
    if (isRhinoCode(all[i])) {
      rhinoBlocks.push(all[i]);
    }
  }

  if (rhinoBlocks.length > 1) {
    var skipped = 0;
    for (i = 0; i < rhinoBlocks.length - 1; i++) {
      rememberExecuted(hash(rhinoBlocks[i]));
      skipped = skipped + 1;
    }
    addLog(skipped + " older code block(s) skipped (page history).");
  }
}

function scan() {
  if (!serviceOn) {
    setPanelStatus("off");
    return;
  }
  if (!liveOn) {
    return;
  }

  if (!firstScanDone) {
    firstScanDone = true;
    try {
      seedHistory();
    } catch (e) {
      /* never break the page because of seeding */
    }
  }

  var all = extractAllCodes();
  var now = Date.now();
  var i;
  var rhinoSeen = 0;

  for (i = 0; i < all.length; i++) {
    var code = all[i];
    if (!isRhinoCode(code)) {
      continue;
    }
    rhinoSeen = rhinoSeen + 1;

    var h = hash(code);
    if (executed[h]) {
      continue;
    }

    var entry = pendingHashes.get(h);
    if (!entry) {
      /* first sighting -> wait until it settles */
      pendingHashes.set(h, { code: code, count: 1, time: now, first: now });
      scheduleSettleScan();
    } else {
      entry.count = entry.count + 1;
      entry.time = now;
      entry.code = code;
      if (entry.count >= STABLE_CYCLES && (now - entry.first) >= STABLE_MS) {
        pendingHashes.delete(h);
        enqueueCode(code, h, "live");
      }
    }
  }

  cleanPendingHashes(now);

  if (lastScanCounts.all !== all.length || lastScanCounts.rhino !== rhinoSeen) {
    lastScanCounts = { all: all.length, rhino: rhinoSeen };
    updateDiagnostics();
  }
}

/* The 1.5 s interval stays as the safety net, but a MutationObserver
   lets the bridge react the moment a code block is inserted or edited,
   which is what makes the sync feel instant while an answer streams. */
var domObserver = null;
var observerPending = false;

function attachObserver() {
  if (domObserver || !document.body) {
    return;
  }
  if (typeof window.MutationObserver === "undefined") {
    return;
  }
  try {
    domObserver = new window.MutationObserver(function () {
      if (observerPending) {
        return;
      }
      observerPending = true;
      window.setTimeout(function () {
        observerPending = false;
        try {
          scan();
        } catch (e) {
          /* a scan must never break the page */
        }
      }, MUTATION_DEBOUNCE);
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  } catch (e) {
    domObserver = null;
  }
}

function detachObserver() {
  if (domObserver) {
    try {
      domObserver.disconnect();
    } catch (e) {
      /* ignore */
    }
    domObserver = null;
  }
}

function startScanning() {
  if (scanTimer) {
    return;
  }
  scanTimer = window.setInterval(scan, SCAN_INTERVAL);
  attachObserver();
  try {
    scan();   /* do not make the first sighting wait a whole tick */
  } catch (e) {
    /* ignore */
  }
}

function stopScanning() {
  if (scanTimer) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }
  clearSettleScan();
  detachObserver();
}

/* ================================================================
   15) MESSAGES FROM POPUP
   ================================================================ */

function handleMessage(msg, sender, sendResponse) {
  if (!msg || !msg.action) {
    return;
  }

  if (msg.action === "setService") {
    serviceOn = (msg.value === undefined) ? true : !!msg.value;
    if (serviceOn) {
      if (panelOn) {
        createPanel();
      }
      startScanning();
      if (runQueue.length > 0) {
        pumpQueue();
      }
    } else {
      cancelRun();
      runQueue = [];
      stopViewport();
      destroyPanel();
      stopScanning();
    }
    updateBadge();
    return;
  }

  if (msg.action === "setLive") {
    liveOn = (msg.value === undefined) ? true : !!msg.value;
    updateBadge();
    if (serviceOn) {
      setPanelStatus(liveOn ? "idle" : "paused");
    } else {
      setPanelStatus("off");
    }
    if (liveOn && runQueue.length > 0) {
      pumpQueue();
    }
    return;
  }

  if (msg.action === "setView") {
    setViewEnabled(msg.value === undefined ? true : !!msg.value);
    return;
  }

  if (msg.action === "fitView") {
    fitRhinoView();
    return;
  }

  if (msg.action === "setDock") {
    setDock(msg.value === "left" ? "left" : (msg.value === "right" ? "right" : ""));
    return;
  }

  if (msg.action === "verifyNow") {
    bridgeRequest("/verify", "GET", null, function (error, data) {
      if (!error && data) {
        updateVerifyUI(data);
      }
    });
    return;
  }

  if (msg.action === "retryRun") {
    if (!isRunning()) {
      addLog("Retrying the last script...");
      setPanelStatus("retry", L("retrying"));
      currentAttempt = currentAttempt + 1;
      bridgeRequest("/retry", "POST", { mode: "auto" }, function (error, data) {
        if (error) {
          addLog("Could not retry: " + (error.message ? error.message : error));
          setPanelStatus("offline");
          return;
        }
        updateVerifyUI(data && data.verify ? data.verify : null);
        handleRunFinished(data);
      });
    }
    return;
  }

  if (msg.action === "setTheme") {
    currentTheme = THEMES[msg.value] ? msg.value : "dark";
    setTheme(currentTheme, true);
    return;
  }

  if (msg.action === "setManualCode") {
    var incoming = msg.value ? String(msg.value) : "";
    var box = getManualBox();
    if (box && !manualDirty) {
      box.value = incoming;
      manualSource = "popup";
      var fromPopup = cleanCodeReport(incoming);
      manualCleaned = fromPopup.chrome + fromPopup.glued;
      updateManualMeta();
    }
    return;
  }

  /* The popup has no copy of the cleaner: it asks the page, which owns
     the single implementation, so both boxes are cleaned identically. */
  if (msg.action === "cleanCode") {
    var report = cleanCodeReport(msg.value ? String(msg.value) : "");
    sendResponse({
      ok: true,
      code: report.code,
      removed: report.chrome + report.glued,
      lines: report.lines
    });
    return true;
  }

  if (msg.action === "runManual") {
    var code = msg.value ? String(msg.value) : readManualBox();
    var manualBoxEl = getManualBox();
    if (manualBoxEl) {
      manualBoxEl.value = code;
      manualDirty = false;
    }
    runManualFromPanel();
    return;
  }

  if (msg.action === "setSmart") {
    smartOn = (msg.value === undefined) ? true : !!msg.value;
    updateSmartArea();
    return;
  }

  if (msg.action === "setPanel") {
    panelOn = (msg.value === undefined) ? true : !!msg.value;
    if (panelOn && serviceOn) {
      createPanel();
    } else {
      destroyPanel();
    }
    return;
  }

  if (msg.action === "setPrompt") {
    customPrompt = msg.value ? msg.value : DEFAULT_PROMPT;
    return;
  }

  if (msg.action === "setLang") {
    panelLang = msg.value ? msg.value : "en";
    refreshPanelTexts();
    return;
  }

  if (msg.action === "runNewest") {
    runNewestOnDemand();
    return;
  }

  if (msg.action === "cancel") {
    cancelRun();
    return;
  }

  if (msg.action === "getInfo") {
    sendResponse({
      chatbot: detectChatbot(),
      running: isRunning(),
      queued: queueLength(),
      executed: bridgeState.count,
      version: "2.6.4",
      viewport: viewSupported,
      docked: panelDock,
      minimised: panelMin,
      maximised: panelMax,
      attempt: currentAttempt
    });
    return;
  }
}

try {
  chrome.runtime.onMessage.addListener(handleMessage);
} catch (e) {
  /* runtime unavailable - page still works, panel still works */
}

/* The popup writes "manualCode" when the user runs something there; the
   panel box follows, so both boxes always show the same script. */
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes) {
      return;
    }
    if (changes.theme && changes.theme.newValue && THEMES[changes.theme.newValue]) {
      currentTheme = changes.theme.newValue;
      setTheme(currentTheme, true);
    }
    if (changes.manualCode && !manualDirty) {
      var value = changes.manualCode.newValue ? String(changes.manualCode.newValue) : "";
      var box = getManualBox();
      if (box && box.value !== value) {
        box.value = value;
        manualSource = "popup";
        updateManualMeta();
      }
    }
  });
} catch (e) {
  /* no storage events - the panel simply does not mirror the popup */
}

/* Re-label the panel after a language switch (panel is rebuilt so the
   layout direction and every label match). */
function refreshPanelTexts() {
  if (!panelExists()) {
    return;
  }
  var panel = document.getElementById(PANEL_ID);
  var rect = panel.getBoundingClientRect();
  var hadCustom = panelPos;
  panelPos = { left: rect.left, top: rect.top };
  destroyPanel();
  createPanel();
  if (!hadCustom) {
    panelPos = null;
    applyPanelPosition();
  }
  setPanelStatus(isRunning() ? "running" : (serviceOn ? (liveOn ? "idle" : "paused") : "off"));
}

/* ================================================================
   16) INITIALISATION
   ================================================================ */

function disposeBridge() {
  stopScanning();
  stopProgressPolling();
  stopHealthTick();
  clearRevertTimer();
  stopViewport();
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  destroyPanel();
  try {
    chrome.runtime.onMessage.removeListener(handleMessage);
  } catch (e) {
    /* runtime already gone - nothing to detach */
  }
  document.removeEventListener("mousemove", onDragMove, true);
  document.removeEventListener("mouseup", onDragEnd, true);
  document.removeEventListener("mousemove", onResizeMove, true);
  document.removeEventListener("mouseup", onResizeEnd, true);

  /* the previous instance can no longer complete its queue */
  bridgeState.running = false;
  bridgeState.activeHash = null;
}

window[BRIDGE_GLOBAL_KEY] = {
  version: "2.6.4",
  state: bridgeState,
  dispose: disposeBridge
};

function init() {
  if (!serviceOn) {
    return;
  }
  if (panelOn) {
    createPanel();
  }
  startScanning();
  addLog("Initialized on " + detectChatbot());
}

function loadSettingsThenInit() {
  try {
    chrome.storage.local.get(
      ["srvUrl", "service", "live", "smart", "panel", "customPrompt", "panelPos", "lang",
       "panelDock", "panelSize", "panelMin", "panelMax", "viewEnable",
       "theme", "manualCode"],
      function (data) {
        if (data) {
          if (data.srvUrl) {
            SERVER = data.srvUrl;
          }
          if (typeof data.service === "boolean") { serviceOn = data.service; }
          if (typeof data.live === "boolean") { liveOn = data.live; }
          if (typeof data.smart === "boolean") { smartOn = data.smart; }
          if (typeof data.panel === "boolean") { panelOn = data.panel; }
          if (data.panelPos && typeof data.panelPos.left === "number") {
            panelPos = data.panelPos;
          }
          if (typeof data.panelDock === "string") { panelDock = data.panelDock; }
          if (data.panelSize && typeof data.panelSize.w === "number") {
            panelSize = data.panelSize;
          }
          if (typeof data.panelMin === "boolean") { panelMin = data.panelMin; }
          if (typeof data.panelMax === "boolean") { panelMax = data.panelMax; }
          if (typeof data.viewEnable === "boolean") { viewOn = data.viewEnable; }
          if (data.theme && THEMES[data.theme]) { currentTheme = data.theme; }
          pendingManualCode = data.manualCode ? String(data.manualCode) : "";
          if (data.lang) { panelLang = data.lang; }
          customPrompt = data.customPrompt ? data.customPrompt : DEFAULT_PROMPT;

          /* a fresh injection can never own an old in-flight request */
          bridgeState.running = false;
          bridgeState.activeHash = null;
        }
        init();
      }
    );
  } catch (e) {
    /* chrome.storage unavailable: run with defaults */
    customPrompt = DEFAULT_PROMPT;
    bridgeState.running = false;
    bridgeState.activeHash = null;
    init();
  }
}

loadSettingsThenInit();
