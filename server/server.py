"""
================================================================
 RHINO LIVE BRIDGE - LOCAL BRIDGE SERVER
 Version: 2.6.4
 Designer: Reza Khoshnood
================================================================
 The middle-man between the Chrome extension and Rhino 3D.

 ARCHITECTURE (v2.6.4 - step by step execution + live viewport)
 ---------------------------------------------------------------
 Code is no longer sent to Rhino as one single big blob. Every
 incoming script is first split into SMALL SYNTAX-SAFE STEPS by
 chunker.py, then the steps are handed to Rhino ONE BY ONE:

   extension --POST /command-->|  chunker  |--step 1--> Rhino executes
                               |  session  |   ...          |
   extension <-- result -------|   loop    |--step n-->      |
                               |           |<-- /send_result-+

 Why: one huge exec() call in Rhino means a long blocking operation,
 no chance to redraw, and a real risk of freezing / crashing Rhino on
 long AI-generated scripts. Small steps keep Rhino responsive and let
 the user watch the model being built (and stop it) step by step.

 Endpoints
 ---------
   GET  /status      - bridge + Rhino liveness  (extension polls ~2s)
   POST /command     - receive a script, run it step by step, answer
   GET  /get_task    - Rhino polls this every 500 ms (fast while busy)
   POST /send_result - Rhino reports the result of one step
   GET  /progress    - live step progress for the UI
   POST /cancel      - stop the running script immediately
   GET  /viewport    - newest viewport frame for the panel (2.6.4)
   POST /viewport    - panel buttons: {"action":"fit"|"capture"}
   POST /viewport_frame - the Rhino worker uploads captured frames

 Run:
   python server.py      (or double-click start_server.bat)
 Dependencies:
   pip install fastapi uvicorn pydantic
================================================================
"""

import asyncio
import threading
import time
import uuid

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from chunker import chunk_code

# ------------------------------------------------------------------
# GLOBAL STATE  (documented API of the bridge)
# ------------------------------------------------------------------
pending_command = None        # str  - code waiting for Rhino to pick up
command_result = None         # dict - result posted back by Rhino
command_event = asyncio.Event()   # signalled by /send_result

# ------------------------------------------------------------------
# TIMING (tuned so that Rhino always reports before the server gives up)
# ------------------------------------------------------------------
STEP_TIMEOUT_MIN = 30.0       # seconds allowed for one step
STEP_TIMEOUT_PER_CHAR = 1.0 / 200.0
STEP_TIMEOUT_MAX = 120.0
SESSION_SAFETY_TIMEOUT = 1800.0   # hard ceiling for one whole script
INTER_STEP_DELAY = 0.08       # breathing room for Rhino between steps
RHINO_ONLINE_WINDOW = 6.0     # /get_task polled more recently than this = alive

# ------------------------------------------------------------------
# APP
# ------------------------------------------------------------------
app = FastAPI(title="Rhino Live Bridge Server", version="2.6.4")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------
# REQUEST MODELS
# ------------------------------------------------------------------
class CommandRequest(BaseModel):
    type: str = "python"
    code: str = ""


class ResultRequest(BaseModel):
    success: bool = False
    result: str = "OK"
    error: str = ""
    session_id: str = ""
    step: int = 0


# ------------------------------------------------------------------
# SESSION
# ------------------------------------------------------------------
class Session(object):
    """One script being executed step by step."""

    def __init__(self, session_id, chunk_result, source_chars):
        self.id = session_id
        self.steps = chunk_result["steps"]
        self.total = len(self.steps)
        self.split = chunk_result["split"]
        self.truncated = chunk_result["truncated"]
        self.source_lines = chunk_result["original_lines"]
        self.source_chars = source_chars

        self.next_index = 0        # index of the step waiting to be picked up
        self.delivered = False     # has the current step been handed to Rhino?
        self.delivered_at = 0.0
        self.ready_at = 0.0        # do not deliver before this timestamp
        self.finished = False
        self.success = True
        self.error = ""
        self.failed_step = 0
        self.cancelled = False
        self.started_at = time.time()
        self.finished_at = 0.0
        self.current_kind = self.steps[0]["kind"] if self.steps else ""

    # ---------- helpers ----------
    def current_step(self):
        if self.next_index < 0 or self.next_index >= self.total:
            return None
        return self.steps[self.next_index]

    def step_timeout(self):
        step = self.current_step()
        if step is None:
            return STEP_TIMEOUT_MIN
        value = STEP_TIMEOUT_MIN + (step["chars"] * STEP_TIMEOUT_PER_CHAR)
        if value > STEP_TIMEOUT_MAX:
            value = STEP_TIMEOUT_MAX
        return value

    def progress_payload(self):
        step = self.current_step()
        reported = step["index"] if step is not None else self.total
        return {
            "active": not self.finished,
            "session_id": self.id,
            "step": reported,
            "total": self.total,
            "kind": step["kind"] if step is not None else "",
            "start_line": step["start_line"] if step is not None else 0,
            "end_line": step["end_line"] if step is not None else 0,
            "split": self.split,
            "large": bool(step["large"]) if step is not None else False,
            "success": None if not self.finished else self.success,
            "error": self.error,
            "cancelled": self.cancelled,
            "elapsed": round((self.finished_at or time.time()) - self.started_at, 2),
        }


session = None            # type: Session or None  (only one script at a time)
last_finished = None      # type: Session or None  (for the UI "done" summary)
rhino_cleanup = None      # session id Rhino must forget (scope cleanup)
rhino_last_seen = 0.0


# ------------------------------------------------------------------
# LIVE VIEWPORT STATE (2.6.4 - no .rhp plugin needed)
# ------------------------------------------------------------------
# The Rhino worker script (rhino-plugin/install_plugin.py) already runs
# INSIDE Rhino - the user starts it once with EditPythonScript > F5.
# Since 2.6.4 that worker also captures the active view on Rhino's main
# thread and uploads the frames (POST /viewport_frame); this server only
# caches the newest one and serves it to the Chrome panel. No plugin
# (.rhp) installation is required for the synced live view any more.
VIEWPORT_MIN_WIDTH = 320
VIEWPORT_MAX_WIDTH = 1280
VIEWPORT_DEFAULT_WIDTH = 720
VIEWPORT_WANT_FRESH = 6.0     # a panel poll this recent means "keep frames coming"
VIEWPORT_FRAME_STALE = 0.9    # ask the worker for a new frame after this age

view_state = {
    "rev": 0,
    "ts": 0.0,
    "width": 0,
    "height": 0,
    "format": "jpeg",
    "data": "",
    "frames": 0,
    "last_error": "",
    "last_poll": 0.0,
    "want_width": VIEWPORT_DEFAULT_WIDTH,
    "fit_pending": False,
    "capture_pending": False,
}
view_lock = threading.Lock()


def _clamp_view_width(value):
    try:
        width = int(value or 0)
    except Exception:
        width = 0
    if width <= 0:
        return VIEWPORT_DEFAULT_WIDTH
    if width < VIEWPORT_MIN_WIDTH:
        return VIEWPORT_MIN_WIDTH
    if width > VIEWPORT_MAX_WIDTH:
        return VIEWPORT_MAX_WIDTH
    return width


def _view_for_worker():
    """What the Rhino worker should do about the viewport right now.

    Handed out with every /get_task answer, so the worker learns about
    a waiting panel (and about Fit / refresh requests) on its normal
    poll - no extra channel, no plugin.
    """
    now = time.time()
    with view_lock:
        fit = bool(view_state["fit_pending"])
        capture = bool(view_state["capture_pending"])
        view_state["fit_pending"] = False
        view_state["capture_pending"] = False
        want = fit or capture
        if not want:
            if view_state["frames"] == 0:
                want = True
            elif (now - view_state["last_poll"] < VIEWPORT_WANT_FRESH
                    and now - view_state["ts"] > VIEWPORT_FRAME_STALE):
                want = True
        return {
            "want_frame": bool(want),
            "fit": fit,
            "capture": capture,
            "width": view_state["want_width"],
        }


def _view_payload(rev):
    """The /viewport answer for the Chrome panel (current cache)."""
    now = time.time()
    with view_lock:
        if not view_state["data"]:
            return None
        return {
            "ok": True,
            "rev": view_state["rev"],
            "ts": round(view_state["ts"], 3),
            "width": view_state["width"],
            "height": view_state["height"],
            "format": view_state["format"],
            "stale": bool(view_state["rev"] <= rev),
            "age": round(now - view_state["ts"], 3),
            "data": view_state["data"],
            "engine": "server",
            "version": "2.6.4",
        }


# ------------------------------------------------------------------
# 1) GET /status  - polled by the Chrome extension every 2 seconds
# ------------------------------------------------------------------
@app.get("/status")
def get_status():
    now = time.time()
    seen = bool(rhino_last_seen) and (now - rhino_last_seen) < RHINO_ONLINE_WINDOW
    return {
        "server": "running",
        "rhino_connected": True,
        # extra fields used by the popup for an accurate indicator
        "rhino_seen": seen,
        "rhino_last_poll_seconds": round(now - rhino_last_seen, 2) if rhino_last_seen else -1.0,
        "busy": bool(session is not None and not session.finished),
        "session_active": bool(session is not None and not session.finished),
        # 2.6.4: the worker uploads viewport frames - report their health
        "viewport": {
            "available": view_state["frames"] > 0,
            "frames": view_state["frames"],
            "rev": view_state["rev"],
            "width": view_state["width"],
            "height": view_state["height"],
            "format": view_state["format"],
            "age": round(now - view_state["ts"], 2) if view_state["ts"] else -1.0,
            "error": view_state["last_error"],
        },
        "engine": "server",
        "version": "2.6.4",
    }


# ------------------------------------------------------------------
# 2) POST /command - extension sends Rhino Python code here
#    The code is split into steps and executed one by one.
# ------------------------------------------------------------------
@app.post("/command")
async def post_command(request: CommandRequest):
    global session, pending_command, command_result

    # only one script at a time: Rhino documents are single threaded
    if session is not None and not session.finished:
        return {
            "success": False,
            "result": "",
            "error": "Rhino is busy: another script is running. Press Stop first.",
        }

    chunk_result = chunk_code(request.code)

    if chunk_result["total"] == 0:
        return {"success": False, "result": "", "error": "Empty code - nothing to run."}

    session = Session(uuid.uuid4().hex[:8], chunk_result, len(request.code or ""))
    command_result = None

    # hand the first step over exactly like the original protocol did
    pending_command = session.steps[0]["code"] if session.steps[0]["code"].strip() else None
    session.delivered = False

    if session.split:
        print("[bridge] new script: %d lines -> %d steps (session %s)" % (
            session.source_lines, session.total, session.id))
    else:
        print("[bridge] new script: %d lines -> single step (session %s)" % (
            session.source_lines, session.id))

    return await _run_session(session)


async def _run_session(current):
    """Wait for Rhino to work through the steps and build the final answer.

    Every step gets its own deadline. A stray /send_result (e.g. from a
    step that finished just after a cancel) can wake the wait up, but it
    can never extend the deadline of the step being waited on.
    """
    global session, pending_command, command_event, rhino_cleanup

    started = time.time()
    last_index = current.next_index

    while not current.finished:
        timeout = current.step_timeout()
        remaining = SESSION_SAFETY_TIMEOUT - (time.time() - started)
        if remaining <= 0:
            current.cancelled = True
            _finish_session(current, False,
                            "Script timed out (safety limit of %d seconds reached)."
                            % int(SESSION_SAFETY_TIMEOUT))
            rhino_cleanup = current.id
            break
        if timeout > remaining:
            timeout = remaining

        step_deadline = time.time() + timeout
        advanced = False

        while not current.finished:
            command_event.clear()
            left = step_deadline - time.time()
            if left <= 0:
                break
            try:
                await asyncio.wait_for(command_event.wait(), timeout=left)
            except asyncio.TimeoutError:
                break

            if current.finished:
                break
            if current.next_index != last_index:
                advanced = True
                break
            # stale wake-up (result of another / a cancelled step):
            # keep waiting inside the same deadline

        if current.finished:
            break

        if not advanced:
            # this step never completed in time
            current.cancelled = True
            _finish_session(current, False, "Rhino timeout")
            rhino_cleanup = current.id
            break

        last_index = current.next_index

    # ---------------- aggregate answer ----------------
    duration = round(time.time() - started, 2)

    if current.success:
        message = "OK"
        if current.total > 1:
            message = "OK - %d steps, %d lines" % (current.total, current.source_lines)
        return {
            "success": True,
            "result": message,
            "error": "",
            "steps": current.total,
            "duration": duration,
        }

    return {
        "success": False,
        "result": "",
        "error": current.error,
        "steps": current.total,
        "duration": duration,
    }


def _finish_session(target, success, error):
    global session, last_finished, pending_command
    target.finished = True
    target.success = success
    target.error = error
    target.finished_at = time.time()
    last_finished = target
    if session is target:
        session = target      # keep it for /progress, marked finished
    pending_command = None
    command_event.set()


# ------------------------------------------------------------------
# 3) GET /get_task - Rhino polls this every 500 ms
# ------------------------------------------------------------------
@app.get("/get_task")
def get_task():
    global pending_command, rhino_last_seen, rhino_cleanup

    rhino_last_seen = time.time()

    # 1) Rhino must forget a cancelled / failed session (drop the scope)
    if rhino_cleanup is not None:
        session_id = rhino_cleanup
        rhino_cleanup = None
        return {
            "has_task": True,
            "code": "",
            "cancel": True,
            "session_id": session_id,
            "step": 0,
            "total": 0,
            "view": _view_for_worker(),
        }

    current = session

    # 2) a script is running: only step delivery, never the bare queue
    if current is not None and not current.finished:
        ready = (not current.delivered
                 and current.next_index < current.total
                 and time.time() >= current.ready_at)
        if not ready:
            return {"has_task": False, "view": _view_for_worker()}

        step = current.steps[current.next_index]
        current.delivered = True
        current.delivered_at = time.time()
        current.current_kind = step["kind"]
        pending_command = None
        return {
            "has_task": True,
            "code": step["code"],
            "session_id": current.id,
            "step": step["index"],
            "total": current.total,
            "kind": step["kind"],
            "start_line": step["start_line"],
            "end_line": step["end_line"],
            "last": step["index"] == current.total,
            # how long the server will wait for this step: Rhino reports its
            # own, more specific error a moment before this deadline
            "timeout": round(current.step_timeout(), 2),
            "view": _view_for_worker(),
        }

    # 3) plain code queued outside of a session (single command protocol)
    if pending_command is not None:
        code = pending_command
        pending_command = None
        return {"has_task": True, "code": code, "view": _view_for_worker()}

    return {"has_task": False, "view": _view_for_worker()}


# ------------------------------------------------------------------
# 4) POST /send_result - Rhino reports the result of one step
# ------------------------------------------------------------------
@app.post("/send_result")
async def send_result(request: ResultRequest):
    global session, command_result, command_event, rhino_cleanup, rhino_last_seen

    rhino_last_seen = time.time()

    current = session

    # ---- result belongs to a running session step ----
    if current is not None and not current.finished and current.delivered:
        step = current.current_step()

        if request.success:
            if current.next_index + 1 >= current.total:
                _finish_session(current, True, "")
            else:
                current.next_index += 1
                current.delivered = False
                current.ready_at = time.time() + INTER_STEP_DELAY
        else:
            error = request.error or "Unknown Rhino error"
            if step is not None:
                error = "Step %d/%d: %s" % (step["index"], current.total, error)
            current.failed_step = step["index"] if step is not None else 0
            _finish_session(current, False, error)
            rhino_cleanup = current.id

        command_event.set()
        return {"ok": True}

    # ---- stray result (session already finished / cancelled) ----
    command_result = {
        "success": request.success,
        "result": request.result,
        "error": request.error,
    }
    command_event.set()
    return {"ok": True}


# ------------------------------------------------------------------
# 5) GET /progress - live progress for the floating panel and popup
# ------------------------------------------------------------------
@app.get("/progress")
def get_progress():
    current = session
    if current is not None and not current.finished:
        return current.progress_payload()

    if last_finished is not None:
        payload = last_finished.progress_payload()
        payload["active"] = False
        return payload

    return {"active": False, "step": 0, "total": 0, "success": None, "error": ""}


# ------------------------------------------------------------------
# 6) POST /cancel - stop the running script
# ------------------------------------------------------------------
@app.post("/cancel")
async def cancel():
    global session, pending_command, rhino_cleanup

    current = session
    if current is not None and not current.finished:
        current.cancelled = True
        _finish_session(current, False, "Cancelled by user")
        rhino_cleanup = current.id
        print("[bridge] session %s cancelled by the user" % current.id)
        return {"cancelled": True, "session_id": current.id}

    return {"cancelled": False}


# ------------------------------------------------------------------
# 7) LIVE VIEWPORT WITHOUT A PLUGIN (2.6.4)
# ------------------------------------------------------------------
# The Rhino worker script runs inside Rhino already, so IT captures the
# frames (on Rhino's main thread) and uploads them; this server caches
# the newest frame and serves it to the panel. The .rhp plugin is NOT
# required for the synced live view any more.
class ViewportFrameRequest(BaseModel):
    data: str = ""
    format: str = "jpeg"
    width: int = 0
    height: int = 0
    error: str = ""
    after_fit: bool = False


class ViewportActionRequest(BaseModel):
    action: str = "capture"
    rev: int = 0
    width: int = 0


@app.post("/viewport_frame")
def post_viewport_frame(request: ViewportFrameRequest):
    """The Rhino worker uploads one captured frame (or a capture error)."""
    global rhino_last_seen
    rhino_last_seen = time.time()
    with view_lock:
        if request.data:
            view_state["rev"] += 1
            view_state["ts"] = time.time()
            view_state["width"] = int(request.width or 0)
            view_state["height"] = int(request.height or 0)
            view_state["format"] = "png" if request.format == "png" else "jpeg"
            view_state["data"] = request.data
            view_state["frames"] += 1
            view_state["last_error"] = ""
            view_state["capture_pending"] = False
            if request.after_fit:
                view_state["fit_pending"] = False
            return {"ok": True, "rev": view_state["rev"], "engine": "server",
                    "version": "2.6.4"}
        if request.error:
            view_state["last_error"] = str(request.error)[:200]
        return {"ok": False, "error": view_state["last_error"],
                "rev": view_state["rev"], "engine": "server", "version": "2.6.4"}


@app.get("/viewport")
async def get_viewport(rev: int = 0, w: int = 0, wait: float = 0.0):
    """One frame for the Chrome panel (long-polls briefly for a new one)."""
    with view_lock:
        view_state["last_poll"] = time.time()
        if w:
            view_state["want_width"] = _clamp_view_width(w)

    deadline = time.time() + min(max(wait, 0.0), 6.0)
    while True:
        payload = _view_payload(rev)
        if payload is not None and (payload["rev"] > rev or time.time() >= deadline):
            return payload
        if time.time() >= deadline:
            break
        await asyncio.sleep(0.1)

    payload = _view_payload(rev)
    if payload is not None:
        return payload
    with view_lock:
        error = view_state["last_error"]
    return {
        "ok": False,
        "supported": True,
        "error": error or ("no frame yet - is the Rhino worker script "
                           "(rhino-plugin/install_plugin.py) running in Rhino? "
                           "EditPythonScript > open it > F5"),
        "rev": view_state["rev"],
        "engine": "server",
        "version": "2.6.4",
    }


@app.post("/viewport")
async def post_viewport(request: ViewportActionRequest):
    """Panel buttons: 'fit' (ZoomExtents in Rhino) and 'capture' (fresh frame)."""
    action = (request.action or "capture").lower()
    with view_lock:
        view_state["last_poll"] = time.time()
        if request.width:
            view_state["want_width"] = _clamp_view_width(request.width)
        if action == "fit":
            view_state["fit_pending"] = True
        view_state["capture_pending"] = True

    payload = _view_payload(request.rev or 0)
    if payload is not None:
        return payload
    return {
        "ok": False,
        "supported": True,
        "error": "frame requested - waiting for the Rhino worker",
        "rev": view_state["rev"],
        "engine": "server",
        "version": "2.6.4",
    }


@app.get("/verify")
def get_verify():
    current = session if session is not None else last_finished
    if current is None:
        return {"ok": False, "available": False, "note": "no run yet",
                "engine": "server", "version": "2.6.4"}
    payload = {
        "ok": bool(getattr(current, "success", False)),
        "available": True,
        "success": bool(getattr(current, "success", False)),
        "error": getattr(current, "error", ""),
        "steps": getattr(current, "total", 0),
        "objects_created": None,
        "repairs": [],
        "retryable": False,
        "note": "verification is only computed by the embedded plugin",
        "engine": "server",
        "version": "2.6.4",
    }
    return payload


@app.post("/retry")
async def post_retry():
    return {
        "success": False,
        "error": "retry needs the embedded plugin (RhinoLiveBridge.rhp)",
        "retry": {"attempt": 0, "max": 2, "exhausted": True},
        "engine": "server",
        "version": "2.6.4",
    }


# ------------------------------------------------------------------
# ENTRY POINT - 127.0.0.1 only (never 0.0.0.0 / "localhost",
# avoids Windows DNS/IPv6 resolution issues)
# ------------------------------------------------------------------
if __name__ == "__main__":
    print("=================================================================")
    print(" RHINO LIVE BRIDGE - LOCAL SERVER  v2.6.4")
    print(" Designer: Reza Khoshnood")
    print(" Listening on: http://127.0.0.1:8765")
    print(" Endpoints: /status  /command  /get_task  /send_result")
    print("            /progress  /cancel  /viewport  /verify  /retry")
    print(" Long scripts are executed STEP BY STEP so Rhino stays stable.")
    print(" Keep this window OPEN while using Rhino Live Bridge.")
    print("=================================================================")
    uvicorn.run(app, host="127.0.0.1", port=8765)
