/* ================================================================
   RHINO LIVE BRIDGE - BACKGROUND SERVICE WORKER
   Version: 2.6.4  |  Designer: Reza Khoshnood
   ----------------------------------------------------------------
   WHY THIS FILE EXISTS
   ----------------------------------------------------------------
   A content script runs inside the web page (chatgpt.com, claude.ai,
   ...). Modern Chrome applies Local Network Access / Private Network
   Access rules to such page-context requests, so a fetch() from the
   page to http://127.0.0.1:8765 can be blocked or left waiting for a
   permission prompt. That is exactly why auto-sync used to fail while
   typing code into the popup "Code" tab still worked: the popup is an
   extension page, the content script is not.

   This worker runs in the EXTENSION context and holds the
   host_permissions for 127.0.0.1, so its fetch() reaches the bridge
   server reliably. Every bridge call from a content script is
   forwarded here:

       content.js  --chrome.runtime.sendMessage-->  this worker
                   <---- {ok:true, data:{...}} ----  fetch() to 8765

   The worker is a pure transport: it knows nothing about Rhino or the
   detected code, it only relays JSON to / from the bridge server.
   ================================================================ */

var DEFAULT_SERVER = "http://127.0.0.1:8765";
var REQUEST_TIMEOUT_MS = 40000;   /* default for fast calls */

/* 2.6.2: /command and /retry keep the HTTP connection open until Rhino has
   executed every step. A long script (hundreds of steps) legitimately takes
   minutes, so those two endpoints get their own, much larger budget instead
   of being aborted at 40 s - which looked exactly like "auto execution is
   broken" while pasting the same code worked. */
var LONG_TIMEOUT_MS = 240000;
var TIMEOUT_BY_PATH = {
  "/command": LONG_TIMEOUT_MS,
  "/retry": LONG_TIMEOUT_MS,
  "/viewport": 12000,
  "/cancel": 15000
};

function timeoutFor(path) {
  if (TIMEOUT_BY_PATH[path]) {
    return TIMEOUT_BY_PATH[path];
  }
  var base = String(path || "").split("?")[0];
  if (TIMEOUT_BY_PATH[base]) {
    return TIMEOUT_BY_PATH[base];
  }
  return REQUEST_TIMEOUT_MS;
}

/* ----------------------------------------------------------------
   Server url resolution: storage is the source of truth, so a page
   cannot redirect the bridge anywhere it likes.
   ---------------------------------------------------------------- */
function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
}

function resolveServer(callback) {
  try {
    chrome.storage.local.get(["srvUrl"], function (data) {
      if (chrome.runtime.lastError) {
        callback(DEFAULT_SERVER);
        return;
      }
      var url = (data && data.srvUrl) ? data.srvUrl : DEFAULT_SERVER;
      if (!isHttpUrl(url)) {
        url = DEFAULT_SERVER;
      }
      while (url.length > 0 && url.charAt(url.length - 1) === "/") {
        url = url.substring(0, url.length - 1);
      }
      callback(url);
    });
  } catch (e) {
    callback(DEFAULT_SERVER);
  }
}

/* ----------------------------------------------------------------
   One HTTP call against the bridge server
   ---------------------------------------------------------------- */
function callBridge(server, path, method, body, done) {
  var url = server + path;
  var options = {
    method: method || "GET",
    cache: "no-store"
  };

  if (body !== undefined && body !== null && method !== "GET") {
    options.headers = { "Content-Type": "application/json" };
    options.body = (typeof body === "string") ? body : JSON.stringify(body);
  }

  var finished = false;
  var budget = timeoutFor(path);
  var timer = setTimeout(function () {
    if (!finished) {
      finished = true;
      done(new Error("timeout"));
    }
  }, budget);

  try {
    fetch(url, options)
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        done(null, data);
      })
      .catch(function (error) {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        done(new Error(String((error && error.message) ? error.message : error)));
      });
  } catch (e) {
    if (!finished) {
      finished = true;
      clearTimeout(timer);
      done(new Error(String(e && e.message ? e.message : e)));
    }
  }
}

/* ----------------------------------------------------------------
   Message handling.  Two message shapes are understood:
     { type: "bridge", path, method, body }  -> proxy an HTTP call
     { type: "bridgeStatus" }                -> quick reachability probe
   Everything else is ignored so other listeners can answer.
   ---------------------------------------------------------------- */
function handleMessage(message, sender, sendResponse) {
  if (!message || message.type !== "bridge") {
    return;
  }

  var path = message.path;
  if (typeof path !== "string" || path.charAt(0) !== "/") {
    sendResponse({ ok: false, error: "bad path" });
    return;
  }

  /* the caller may propose a server (tests, custom setups); storage wins */
  if (isHttpUrl(message.server)) {
    var proposed = message.server;
    while (proposed.length > 0 && proposed.charAt(proposed.length - 1) === "/") {
      proposed = proposed.substring(0, proposed.length - 1);
    }
    callBridge(proposed, path, message.method, message.body, function (error, data) {
      if (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      } else {
        sendResponse({ ok: true, data: data });
      }
    });
    return true;
  }

  resolveServer(function (server) {
    callBridge(server, path, message.method, message.body, function (error, data) {
      if (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      } else {
        sendResponse({ ok: true, data: data });
      }
    });
  });

  return true;   /* keep the message channel open for the async answer */
}

try {
  chrome.runtime.onMessage.addListener(handleMessage);
} catch (e) {
  /* nothing else to do: the extension simply runs without the proxy */
}

/* expose the pieces for the automated tests (harmless in production) */
if (typeof globalThis !== "undefined") {
  globalThis.__rhinoBridgeWorker = {
    callBridge: callBridge,
    resolveServer: resolveServer,
    handleMessage: handleMessage,
    timeoutFor: timeoutFor,
    DEFAULT_SERVER: DEFAULT_SERVER,
    LONG_TIMEOUT_MS: LONG_TIMEOUT_MS
  };
}
