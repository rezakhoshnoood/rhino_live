# -*- coding: utf-8 -*-
"""
================================================================
 RHINO LIVE BRIDGE - RHINO WORKER PLUGIN
 Version: 2.6.4
 Designer: Reza Khoshnood
================================================================

 HOW TO USE (one time only):
   1. Open Rhino 7 or Rhino 8
   2. Type the command:  EditPythonScript
   3. Open this file  (rhino-plugin/install_plugin.py)
   4. Press F5 (Run)
   5. Leave Rhino open - the worker now waits for code.

 WHAT CHANGED IN 2.6.4
 -----------------------------------
 0. LIVE VIEWPORT WITHOUT ANY .rhp PLUGIN.
    This worker already runs inside Rhino, so it can see the viewport.
    The bridge server now tells the worker (inside every /get_task
    answer) when the Chrome panel is waiting for a frame; the worker
    then captures the active view ON THE MAIN THREAD (same Idle event
    as code execution), encodes it as JPEG and uploads it to
    POST /viewport_frame. The panel shows the synced Rhino view with
    the plain server + this script - no plugin installation needed.
    The Fit button works too: the server flags "fit", the worker runs
    ZoomExtents on the main thread and uploads the new frame.

 WHAT CHANGED IN 2.6.2
 -----------------------------------
 1. EXECUTION RUNS ON RHINO'S MAIN THREAD.
    The old version executed AI code directly inside a background
    thread. Rhino (like almost every CAD kernel) is not thread safe:
    creating geometry and redrawing from a worker thread can freeze
    or crash the application. Now the network thread only *collects*
    jobs; the actual exec() happens in Rhino's Idle event, which is
    the main thread, one job per idle tick.

 2. STEP BY STEP EXECUTION.
    Long scripts no longer arrive as one big exec(). The bridge
    server splits them into small syntax-safe steps and this worker
    executes one step per idle tick. Rhino breathes between steps.

 3. REDRAW CONTROL.
    Redraw is switched off while a script is running and switched on
    again at the end (or on error / cancel), so Rhino does not have
    to regenerate the viewport after every single object.

 4. SAFE EVENT HANDLER.
    Nothing may ever escape the Idle handler - an exception thrown
    into Rhino's event loop can take the application down. Every
    path is wrapped.

 5. REAL CANCELLATION + NO ORPHAN SCOPE.
    Cancel requests are picked up on the next poll; queued steps are
    dropped and the session scope is released.

 WHY NO WEBSOCKETS:
   Rhino's IronPython 2.7 environment cannot install pip packages, so
   websocket-client / requests are unavailable. Everything here uses
   System.Net.WebClient from the .NET framework, which is always
   present in both Rhino 7 (IronPython 2.7) and Rhino 8 (CPython 3).

 NOTE:
   exec(code, scope) uses the call/tuple form of exec, which the
   Python 2.7 language reference explicitly supports for Python 3
   compatibility, so the same line works on both interpreters.
================================================================
"""

import Rhino
import rhinoscriptsyntax as rs
import scriptcontext as sc
import System.Net
import System.Text
import json
import time
import threading
import sys

try:                       # IronPython 2.7 (Rhino 7)
    from Queue import Queue, Empty
except ImportError:        # CPython 3 (Rhino 8)
    from queue import Queue, Empty


# ------------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------------
SERVER_URL = "http://127.0.0.1:8765"
VERSION = "2.6.4"
DESIGNER = "Reza Khoshnood"

POLL_IDLE_SECONDS = 0.5      # normal polling (documented behaviour)
POLL_FAST_SECONDS = 0.12     # while a multi-step script is running
FAST_POLLS_AFTER_STEP = 40   # how many fast polls before falling back
PICKUP_TIMEOUT = 8.0         # seconds the main thread has to start a step
DEFAULT_STEP_TIMEOUT = 30.0  # used when the server does not announce one
TIMEOUT_MARGIN = 2.0         # report back this long BEFORE the server gives up
BUSY_HINT = ("Rhino is blocked by an open command or dialog, so step %d could "
             "not run. Close it and press the run button again.")
MAX_OPEN_SCOPES = 4          # safety cap on leaked session scopes

# ---- live viewport (2.6.4, no .rhp plugin needed) ------------------
VIEW_CAPTURE_INTERVAL = 0.9  # seconds between two uploaded frames
VIEW_WAIT_TIMEOUT = 2.5      # how long the worker waits for a capture
VIEWPORT_MIN_WIDTH = 320
VIEWPORT_MAX_WIDTH = 1280
VIEWPORT_JPEG_QUALITY = 72

# ------------------------------------------------------------------
# MODULE STATE
# ------------------------------------------------------------------
_job_queue = Queue()          # worker thread  -> main thread (idle)
_result_queue = Queue()       # main thread    -> worker thread
_abandoned_jobs = set()       # jobs the worker gave up on; main thread drops them
_scopes = {}                  # session_id -> persistent exec scope
_scope_order = []             # for the safety cap
_idle_state = {"attached": False}
_idle_handler = None          # keep a reference alive (delegate garbage collection)
_stop_flag = {"stop": False}


# ------------------------------------------------------------------
# HTTP HELPERS (.NET only - no pip packages)
# ------------------------------------------------------------------
def _to_text(value):
    """Return a .NET friendly unicode string."""
    try:
        if not isinstance(value, type(u"")):
            return value.decode("utf-8")
        return value
    except Exception:
        return value


def _new_client():
    """Configured .NET WebClient for JSON traffic."""
    client = System.Net.WebClient()
    try:
        client.Headers["Content-Type"] = "application/json"
        client.Encoding = System.Text.Encoding.UTF8
    except Exception:
        pass
    try:
        # never route localhost traffic through a system / corporate proxy
        client.Proxy = None
    except Exception:
        pass
    return client


def http_get(url):
    """GET a URL and return the parsed JSON dictionary."""
    client = _new_client()
    try:
        text = client.DownloadString(url)
    finally:
        try:
            client.Dispose()
        except Exception:
            pass
    return json.loads(text)


def http_post(url, data_dict):
    """POST a dictionary as JSON and return the raw response text."""
    payload = json.dumps(data_dict)
    client = _new_client()
    try:
        text = client.UploadString(url, "POST", _to_text(payload))
    finally:
        try:
            client.Dispose()
        except Exception:
            pass
    return text


# ------------------------------------------------------------------
# SCOPE MANAGEMENT
# ------------------------------------------------------------------
def _new_scope():
    return {
        "rs": rs,
        "Rhino": Rhino,
        "sc": sc,
        "doc": sc.doc,
    }


def _drop_scope(session_id):
    if session_id in _scopes:
        try:
            _scopes.pop(session_id, None)
        except Exception:
            pass
    try:
        if session_id in _scope_order:
            _scope_order.remove(session_id)
    except Exception:
        pass


def _drop_all_scopes():
    for key in list(_scopes.keys()):
        _drop_scope(key)


def _drop_oldest_scope():
    while len(_scope_order) > MAX_OPEN_SCOPES:
        oldest = _scope_order.pop(0)
        try:
            _scopes.pop(oldest, None)
        except Exception:
            pass


# ------------------------------------------------------------------
# REDRAW HELPERS
# ------------------------------------------------------------------
def _redraw_off():
    try:
        rs.EnableRedraw(False)
    except Exception:
        pass


def _redraw_on_and_refresh():
    try:
        rs.EnableRedraw(True)
    except Exception:
        pass
    try:
        rs.Redraw()
    except Exception:
        pass


# ------------------------------------------------------------------
# LIVE VIEWPORT CAPTURE (MAIN THREAD - 2.6.4)
# ------------------------------------------------------------------
# The worker script runs inside Rhino, so it can capture the active
# view itself: no .rhp plugin is needed for the synced live view.
# Capturing must happen on Rhino's main thread (RhinoView wants the UI
# thread), which is why this runs as a "view" job inside the same Idle
# handler that executes code steps - never from the network thread.
def _drawing_modules(errors):
    """Best effort access to System.Drawing (Size / Bitmap / Imaging)."""
    system = None
    drawing = None
    imaging = None
    io_mod = None
    try:
        import System
        system = System
    except Exception as ex:
        errors.append("System: " + str(ex))
        return system, drawing, imaging, io_mod
    try:
        import System.IO
        io_mod = System.IO
    except Exception:
        try:
            io_mod = system.IO
        except Exception as ex:
            errors.append("System.IO: " + str(ex))
    try:
        import System.Drawing
        drawing = System.Drawing
    except Exception:
        try:
            drawing = system.Drawing
        except Exception as ex:
            errors.append("System.Drawing: " + str(ex))
    try:
        import System.Drawing.Imaging
        imaging = System.Drawing.Imaging
    except Exception:
        imaging = None
    if imaging is None:
        # .NET Core (Rhino 8 CPython): pull the assembly in by name
        try:
            import clr
            try:
                clr.AddReference("System.Drawing.Common")
            except Exception:
                clr.AddReference("System.Drawing")
            import System.Drawing.Imaging
            imaging = System.Drawing.Imaging
            if drawing is None:
                import System.Drawing
                drawing = System.Drawing
        except Exception as ex:
            errors.append("System.Drawing.Imaging: " + str(ex))
    return system, drawing, imaging, io_mod


def _active_view():
    """The RhinoView to capture (RhinoCommon: doc.Views.ActiveView)."""
    documents = []
    try:
        documents.append(sc.doc)
    except Exception:
        pass
    try:
        documents.append(Rhino.RhinoDoc.ActiveDoc)
    except Exception:
        pass
    for document in documents:
        if document is None:
            continue
        try:
            view = document.Views.ActiveView
        except Exception:
            view = None
        if view is not None:
            return view
        try:
            for fallback in document.Views:
                if fallback is not None:
                    return fallback
        except Exception:
            pass
    return None


def _capture_bitmap(view, target_w, target_h, drawing, errors):
    """Grab a bitmap of the view, whichever Rhino API cooperates."""
    if drawing is not None:
        try:
            bitmap = view.CaptureToBitmap(drawing.Size(target_w, target_h))
            if bitmap is not None:
                return bitmap
            errors.append("CaptureToBitmap(Size) returned None")
        except Exception as ex:
            errors.append("CaptureToBitmap(Size): " + str(ex))
    try:
        capture = Rhino.Display.ViewCapture()
        capture.Width = target_w
        capture.Height = target_h
        try:
            capture.DrawAxes = False
            capture.DrawGridAxes = False
            capture.TransparentBackground = False
        except Exception:
            pass
        bitmap = capture.CaptureToBitmap(view)
        if bitmap is not None:
            return bitmap
        errors.append("ViewCapture returned None")
    except Exception as ex:
        errors.append("ViewCapture: " + str(ex))
    try:
        bitmap = view.CaptureToBitmap()
        if bitmap is not None:
            if drawing is not None:
                try:
                    if int(bitmap.Width) != target_w:
                        resized = drawing.Bitmap(
                            bitmap, drawing.Size(target_w, target_h))
                        try:
                            bitmap.Dispose()
                        except Exception:
                            pass
                        bitmap = resized
                except Exception as ex:
                    errors.append("resize: " + str(ex))
            return bitmap
        errors.append("CaptureToBitmap() returned None")
    except Exception as ex:
        errors.append("CaptureToBitmap(): " + str(ex))
    return None


def _encode_bitmap(bitmap, system, imaging, io_mod, errors):
    """Bitmap -> (base64, format). Fresh stream for every attempt."""
    if io_mod is None or system is None:
        errors.append("no System.IO / System for encoding")
        return None, ""
    if imaging is not None:
        encoder = None
        try:
            for candidate in imaging.ImageCodecInfo.GetImageEncoders():
                if str(candidate.MimeType).lower() == "image/jpeg":
                    encoder = candidate
                    break
        except Exception as ex:
            errors.append("GetImageEncoders: " + str(ex))
        if encoder is not None:
            stream = io_mod.MemoryStream()
            try:
                params = imaging.EncoderParameters(1)
                params.Param[0] = imaging.EncoderParameter(
                    imaging.Encoder.Quality,
                    system.Int64(VIEWPORT_JPEG_QUALITY))
                bitmap.Save(stream, encoder, params)
                return system.Convert.ToBase64String(stream.ToArray()), "jpeg"
            except Exception as ex:
                errors.append("jpeg(quality): " + str(ex))
            finally:
                try:
                    stream.Close()
                except Exception:
                    pass
        stream = io_mod.MemoryStream()
        try:
            bitmap.Save(stream, imaging.ImageFormat.Jpeg)
            return system.Convert.ToBase64String(stream.ToArray()), "jpeg"
        except Exception as ex:
            errors.append("jpeg: " + str(ex))
        finally:
            try:
                stream.Close()
            except Exception:
                pass
        stream = io_mod.MemoryStream()
        try:
            bitmap.Save(stream, imaging.ImageFormat.Png)
            return system.Convert.ToBase64String(stream.ToArray()), "png"
        except Exception as ex:
            errors.append("png: " + str(ex))
        finally:
            try:
                stream.Close()
            except Exception:
                pass
    else:
        errors.append("System.Drawing.Imaging unavailable")
    return None, ""


def _run_view_job(job):
    """Capture one viewport frame. Main thread only. Never raises."""
    result = {
        "id": job.get("id"),
        "kind": "view",
        "success": False,
        "error": "",
        "data": "",
        "format": "jpeg",
        "width": 0,
        "height": 0,
        "after_fit": bool(job.get("fit")),
    }

    if job.get("fit"):
        try:
            rs.ZoomExtents()
        except Exception:
            try:
                rs.Command("_Zoom _Extents", False)
            except Exception:
                pass

    view = _active_view()
    if view is None:
        result["error"] = "no viewport open in Rhino"
        return result

    try:
        size = view.Size
        view_w = int(size.Width)
        view_h = int(size.Height)
    except Exception:
        try:
            vp_size = view.ActiveViewport.Size
            view_w = int(vp_size.Width)
            view_h = int(vp_size.Height)
        except Exception:
            view_w, view_h = 1600, 900
    if view_w <= 0 or view_h <= 0:
        view_w, view_h = 1600, 900

    target_w = int(job.get("width") or 720)
    if target_w < VIEWPORT_MIN_WIDTH:
        target_w = VIEWPORT_MIN_WIDTH
    if target_w > VIEWPORT_MAX_WIDTH:
        target_w = VIEWPORT_MAX_WIDTH
    target_h = int(round(float(target_w) * float(view_h) / float(view_w)))
    if target_h < 120:
        target_h = 120
    if target_h > VIEWPORT_MAX_WIDTH:
        target_h = VIEWPORT_MAX_WIDTH

    errors = []
    system, drawing, imaging, io_mod = _drawing_modules(errors)
    bitmap = _capture_bitmap(view, target_w, target_h, drawing, errors)
    if bitmap is None:
        result["error"] = "viewport capture failed: " + " | ".join(errors[-3:])
        return result

    try:
        payload, used_format = _encode_bitmap(bitmap, system, imaging, io_mod, errors)
    finally:
        try:
            bitmap.Dispose()
        except Exception:
            pass
    if payload is None:
        result["error"] = "viewport encoding failed: " + " | ".join(errors[-3:])
        return result

    result["success"] = True
    result["data"] = payload
    result["format"] = used_format
    result["width"] = target_w
    result["height"] = target_h
    return result


# ------------------------------------------------------------------
# JOB EXECUTION (MAIN THREAD - called from the Idle event)
# ------------------------------------------------------------------
def _run_job(job):
    """Execute one step of a script. Never raises."""
    session_id = job.get("session_id") or "single"
    step_index = job.get("step") or 1
    total = job.get("total") or 1
    last = bool(job.get("last")) or step_index >= total
    code = job.get("code") or ""

    started = time.time()
    ok = True
    error = ""
    result_text = "OK"

    scope = _scopes.get(session_id)
    if scope is None or step_index <= 1:
        scope = _new_scope()
        _scopes[session_id] = scope
        if session_id not in _scope_order:
            _scope_order.append(session_id)
        _drop_oldest_scope()
        _redraw_off()

    try:
        exec(code, scope)
    except Exception as ex:
        ok = False
        error = str(ex)
        result_text = ""
    except BaseException as ex:      # KeyboardInterrupt / SystemExit from bad code
        ok = False
        error = "Interrupted: " + str(ex)
        result_text = ""

    if ok and not last:
        # show the model growing, one step at a time
        try:
            rs.Redraw()
        except Exception:
            pass
    else:
        _redraw_on_and_refresh()
        _drop_scope(session_id)

    return {
        "id": job.get("id"),
        "session_id": session_id,
        "step": step_index,
        "success": ok,
        "result": result_text,
        "error": error,
        "duration": round(time.time() - started, 3),
    }


def _rhino_is_busy():
    """Never execute while a Rhino command or modal dialog is running."""
    try:
        if Rhino.RhinoApp.CommandInProgress:
            return True
    except Exception:
        pass
    try:
        if Rhino.RhinoApp.MouseButtonDown:
            return True
    except Exception:
        pass
    return False


def _on_rhino_idle(sender, args):
    """Idle event = main thread, no command running.

    Exactly one step is executed per idle tick, then we return control to
    Rhino. That keeps the UI alive and the geometry pipeline calm.
    """
    job = None
    try:
        if _job_queue.empty():
            return
        if _rhino_is_busy():
            return

        try:
            job = _job_queue.get_nowait()
        except Empty:
            return

        job_id = job.get("id")
        if job_id in _abandoned_jobs:
            _abandoned_jobs.discard(job_id)
            return

        job["picked_at"] = time.time()
        if job.get("kind") == "view":
            result = _run_view_job(job)
        else:
            result = _run_job(job)
        _result_queue.put(result)

    except BaseException as ex:
        # an exception escaping into Rhino's event loop can kill Rhino:
        # report it as a failed step instead.
        try:
            _result_queue.put({
                "id": job.get("id") if job else None,
                "session_id": job.get("session_id") if job else "single",
                "step": job.get("step") if job else 0,
                "success": False,
                "result": "",
                "error": "Bridge internal error: " + str(ex),
                "duration": 0.0,
            })
        except Exception:
            pass


def _attach_idle_handler():
    """Register the main-thread executor exactly once."""
    global _idle_handler

    if _idle_state["attached"]:
        return True
    try:
        _idle_handler = _on_rhino_idle
        Rhino.RhinoApp.Idle += _idle_handler
        _idle_state["attached"] = True
        return True
    except Exception as ex:
        print("[Rhino Live Bridge] Could not attach the main-thread executor: " + str(ex))
        return False


# ------------------------------------------------------------------
# RESULT WAITING
# ------------------------------------------------------------------
def _pull_result(job_id):
    """Non-blocking: is there a finished result for this job?"""
    while True:
        try:
            result = _result_queue.get_nowait()
        except Empty:
            return None
        if result.get("id") == job_id:
            return result
        # result of an older / abandoned job: discard it


def _wait_two_phase(job, step_timeout):
    """Wait for the main thread, separating pickup from execution.

    Returns (result, reason):
      result != None                 -> the main thread answered
      reason == "busy"               -> Rhino never picked the step up
      reason == "exec_timeout"       -> picked up, but took too long
    """
    started = time.time()

    # ---- phase 1: has the main thread taken the job? ----
    while time.time() < started + PICKUP_TIMEOUT:
        result = _pull_result(job.get("id"))
        if result is not None:
            return result, None
        if job.get("picked_at"):
            break
        time.sleep(0.05)
    else:
        return None, "busy"

    # ---- phase 2: execution ----
    budget = step_timeout - TIMEOUT_MARGIN - (time.time() - started)
    if budget < 1.0:
        budget = 1.0
    deadline = time.time() + budget
    while time.time() < deadline:
        result = _pull_result(job.get("id"))
        if result is not None:
            return result, None
        time.sleep(0.05)

    return None, "exec_timeout"


def _abandon_all_pending():
    """Cancel: drop queued jobs and release every session scope."""
    dropped = 0
    while not _job_queue.empty():
        try:
            job = _job_queue.get_nowait()
            if job.get("id"):
                _abandoned_jobs.add(job["id"])
            dropped += 1
        except Empty:
            break
    _drop_all_scopes()
    _redraw_on_and_refresh()
    if dropped:
        print("[Rhino Live Bridge] Cancelled: %d queued step(s) dropped." % dropped)


# ------------------------------------------------------------------
# LIVE VIEWPORT UPLOAD (worker thread side - 2.6.4)
# ------------------------------------------------------------------
_view_state = {"last_upload": 0.0, "last_error_print": 0.0}


def _wait_view_result(job_id, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = _pull_result(job_id)
        if result is not None:
            return result
        time.sleep(0.05)
    return None


def _maybe_capture_view(view_info):
    """Capture + upload a frame when the bridge server asks for one.

    The actual capture is a "view" job for the main thread (Idle); this
    function only queues it, waits briefly and uploads the result.
    """
    if not view_info:
        return
    fit = bool(view_info.get("fit"))
    want = fit or bool(view_info.get("want_frame")) or bool(view_info.get("capture"))
    if not want:
        return
    now = time.time()
    if not fit and (now - _view_state["last_upload"]) < VIEW_CAPTURE_INTERVAL:
        return

    job = {
        "id": "view-%.3f" % now,
        "kind": "view",
        "fit": fit,
        "width": view_info.get("width") or 720,
    }
    _job_queue.put(job)
    result = _wait_view_result(job["id"], VIEW_WAIT_TIMEOUT)
    if result is None:
        return

    if result.get("success") and result.get("data"):
        try:
            http_post(SERVER_URL + "/viewport_frame", {
                "data": result.get("data") or "",
                "format": result.get("format") or "jpeg",
                "width": result.get("width") or 0,
                "height": result.get("height") or 0,
                "after_fit": bool(result.get("after_fit")),
            })
            _view_state["last_upload"] = time.time()
        except Exception:
            pass
    elif result.get("error"):
        # the server passes the reason to the panel, so the user sees
        # WHY there is no picture instead of a silent black box
        try:
            http_post(SERVER_URL + "/viewport_frame",
                      {"error": result.get("error") or ""})
        except Exception:
            pass
        if time.time() - _view_state["last_error_print"] > 15.0:
            _view_state["last_error_print"] = time.time()
            print("[Rhino Live Bridge] Live view: " + str(result.get("error")))


# ------------------------------------------------------------------
# BACKGROUND WORKER (network + queueing only)
# ------------------------------------------------------------------
def rhino_worker():
    server_offline_reported = False
    fast_polls_left = 0

    while not _stop_flag["stop"]:
        # ---- 1) ask the bridge server for work ----
        try:
            task = http_get(SERVER_URL + "/get_task")
            if server_offline_reported:
                print("[Rhino Live Bridge] Server connection restored.")
                server_offline_reported = False
        except Exception:
            if not server_offline_reported:
                print("[Rhino Live Bridge] Waiting for server at " + SERVER_URL +
                      " ... (run start_server.bat)")
                server_offline_reported = True
            time.sleep(POLL_IDLE_SECONDS)
            continue

        # ---- 2) cancellation request ----
        if task and task.get("cancel"):
            _abandon_all_pending()
            fast_polls_left = 0
            time.sleep(POLL_IDLE_SECONDS)
            continue

        # ---- 3) nothing to do: keep the live viewport in sync ----
        if not task or not task.get("has_task"):
            _maybe_capture_view(task.get("view") if task else None)
            if fast_polls_left > 0:
                fast_polls_left -= 1
                time.sleep(POLL_FAST_SECONDS)
            else:
                time.sleep(POLL_IDLE_SECONDS)
            continue

        # ---- 3b) a Fit request from the panel comes first ----
        if task.get("view") and task["view"].get("fit"):
            _maybe_capture_view(task.get("view"))

        code = task.get("code") or ""
        if not code.strip():
            time.sleep(POLL_IDLE_SECONDS)
            continue

        session_id = task.get("session_id") or "single"
        step_index = task.get("step") or 1
        total = task.get("total") or 1
        is_last = bool(task.get("last")) or step_index >= total

        job = {
            "id": "%s-%s-%.3f" % (session_id, step_index, time.time()),
            "session_id": session_id,
            "step": step_index,
            "total": total,
            "last": is_last,
            "code": code,
            "kind": task.get("kind") or "",
        }

        if total > 1:
            print("[Rhino Live Bridge] Step %d/%d received (%d chars) - queued." %
                  (step_index, total, len(code)))
        else:
            print("[Rhino Live Bridge] Code received (%d chars) - queued." % len(code))

        _job_queue.put(job)

        # ---- 4) let the main thread execute it ----
        step_timeout = task.get("timeout") or DEFAULT_STEP_TIMEOUT
        result, reason = _wait_two_phase(job, step_timeout)

        if result is None:
            _abandoned_jobs.add(job.get("id"))
            if reason == "busy":
                error = BUSY_HINT % step_index
                print("[Rhino Live Bridge] Step %d/%d was never picked up "
                      "(rhino busy)." % (step_index, total))
            else:
                error = ("Step %d/%d exceeded its %d second time budget inside Rhino. "
                         "If it creates a huge number of objects, split the request."
                         % (step_index, total, int(step_timeout)))
                print("[Rhino Live Bridge] Step %d/%d ran out of time." % (step_index, total))
            result = {"success": False, "result": "", "error": error}

        # ---- 5) report back ----
        if result.get("success"):
            print("[Rhino Live Bridge] Step %d/%d done (%.2fs)." %
                  (step_index, total, result.get("duration") or 0.0))
        else:
            print("[Rhino Live Bridge] Step %d/%d failed: %s" %
                  (step_index, total, result.get("error") or "unknown error"))

        try:
            http_post(SERVER_URL + "/send_result", {
                "success": bool(result.get("success")),
                "result": result.get("result") or "",
                "error": result.get("error") or "",
                "session_id": session_id,
                "step": step_index,
            })
        except Exception as ex:
            print("[Rhino Live Bridge] Could not send the result back: " + str(ex))

        # ---- 5b) the model changed: refresh the synced viewport ----
        _maybe_capture_view(task.get("view"))

        # ---- 6) polling cadence: stay fast while a script is running ----
        fast_polls_left = FAST_POLLS_AFTER_STEP if (not is_last) else 0


# ------------------------------------------------------------------
# ENTRY POINT
# ------------------------------------------------------------------
def main():
    print("")
    print("=================================================================")
    print("  RHINO LIVE BRIDGE - RHINO WORKER  v" + VERSION)
    print("  Designer: " + DESIGNER)
    print("-----------------------------------------------------------------")
    print("  Bridge server : " + SERVER_URL)
    print("  Polling       : %s s idle / %s s while running" %
          (str(POLL_IDLE_SECONDS), str(POLL_FAST_SECONDS)))
    print("  Execution     : Rhino MAIN THREAD (Idle event) - crash safe")
    print("  Scripts run   : step by step, one step per idle tick")
    print("  Live viewport : this worker captures the active view for the")
    print("                  Chrome panel - NO .rhp plugin needed")
    print("  Python engine : " + sys.version.split("\n")[0])
    print("=================================================================")

    existing = getattr(sys, "_rhino_live_bridge_thread", None)
    if existing is not None and existing.is_alive():
        print("  Worker is ALREADY running - no second thread started.")
        print("")
        return

    if not _attach_idle_handler():
        print("  ERROR: the main-thread executor could not be attached.")
        print("  Try running this script again from EditPythonScript.")
        print("")
        return

    worker = threading.Thread(target=rhino_worker)
    worker.setDaemon(True)
    worker.start()
    sys._rhino_live_bridge_thread = worker

    print("  Worker started.")
    print("  Network thread collects the steps, the main thread executes")
    print("  them one by one - Rhino stays responsive and does not crash.")
    print("=================================================================")
    print("")


main()
