# -*- coding: utf-8 -*-
"""
================================================================
 RHINO LIVE BRIDGE - SELF CONTAINED RHINO PLUGIN
 Version: 2.6.4
 Designer: Reza Khoshnood
================================================================

 WHAT THIS IS
 ------------
 The whole bridge now runs INSIDE Rhino. No FastAPI, no uvicorn, no
 start_server.bat, no extra console window, no pip install:

     Chrome extension  --HTTP-->  this script (inside Rhino)
                                     |  chunker: code -> steps
                                     |  idle event: executes one step
                                     v  main thread, crash safe
                                  your Rhino document

 The HTTP server is built on System.Net.Sockets.TcpListener, which is
 part of .NET and needs no administrator rights (unlike HttpListener,
 which usually needs a urlacl reservation). Nothing outside the .NET
 base class library is used, so it works in Rhino 7 (IronPython 2.7)
 AND Rhino 8 (CPython 3).

 HOW TO START IT
 ---------------
 Automatic (recommended):
     Use RhinoLiveBridge.rhp - install it once and the bridge starts
     with every Rhino session. (See rhp/README-BUILD.txt)

 Manual, two options:
     1) EditPythonScript -> open this file -> F5
     2) drag this file onto the Rhino window, or type in Rhino:
            _-RunPythonScript "C:\\path\\to\\RhinoLiveBridge.py"

 While it runs, the Chrome extension finds it automatically on
 http://127.0.0.1:8765 - and the floating panel shows "Server OK".

 TO STOP IT
 ----------
 Type this in the Rhino command line:  RhinoLiveBridgeStop
 (the alias is registered automatically when the bridge starts)

 ENDPOINTS (same protocol as the standalone server)
 --------------------------------------------------
   GET  /status        bridge + rhino liveness, busy flag
   POST /command       run an AI generated script, step by step
   GET  /get_task      compatibility shim (always "no task" here)
   POST /send_result   compatibility shim
   GET  /progress      live step progress for the UI
   POST /cancel        stop the running script immediately

 2.6.2 ADDITIONS
 ---------------
   GET  /status        now also reports viewport / verify capabilities
   GET  /viewport      one JPEG frame of the active Rhino view (base64)
   POST /viewport      {"action":"fit"} or {"action":"capture"}
   GET  /verify        verification report of the last run
   POST /retry         re-run the last script after repairing it and
                       removing the partial geometry of the failed run

 WHAT IS NEW IN 2.6.3
 --------------------
   1) VIEWPORT SELF HEALING.  A failed frame capture no longer marks
      the viewport "unsupported" forever: captures are retried with
      backoff and the first success restores the live stream. Three
      capture strategies are tried (CaptureToBitmap(Size), ViewCapture,
      native CaptureToBitmap + resize) and three encoders (JPEG with
      quality, plain JPEG, PNG), and /viewport always explains WHY no
      frame is available yet instead of leaving the panel black.
   2) The active view lookup falls back to any open model view when
      Rhino reports no ActiveView.

 WHAT IS NEW IN 2.6.2
 --------------------
   1) LIVE VIEWPORT.  The active view is captured on the main thread
      (RhinoView.CaptureToBitmap), encoded as JPEG and served through
      /viewport, so the Chrome panel shows Rhino live while code runs.
   2) CODE CLEANUP.  Every script is cleaned before chunking: markdown
      fences, line numbers, REPL prompts and chat chrome are removed,
      imports that can never work inside Rhino (numpy, tkinter, ...)
      are dropped, missing `import rhinoscriptsyntax as rs` and
      friends are injected, blocking dialogs are detected up front.
   3) SELF HEALING.  A failing step is repaired (missing import,
      stray indent, dropped module) and retried on the spot, twice.
   4) VERIFICATION.  After every run the bridge checks the document:
      how many objects were created, whether they are valid, which
      steps ran, what was repaired.  /verify exposes that report.
   5) RETRY.  If a run still fails, /retry removes the geometry the
      failed run left behind and executes a repaired copy again.

 CRASH PREVENTION (unchanged principles)
 ---------------------------------------
   * every HTTP request is handled on its own background thread
   * geometry is ONLY touched on Rhino's main thread (Idle event)
   * long scripts are executed as small syntax safe steps,
     one step per idle tick
   * redraw is switched off during a run and on again at the end
   * nothing may ever escape the idle handler
================================================================
"""

import json
import re
import sys
import threading
import time

import System

# IronPython 2.7 (Rhino 7) and pythonnet (Rhino 8) both need the .NET
# namespaces to be touched once before their members become reachable.
try:
    import System.Net.Sockets      # noqa: F401
except Exception:
    pass
try:
    import System.Text             # noqa: F401
except Exception:
    pass

import Rhino
import rhinoscriptsyntax as rs
import scriptcontext as sc


# ------------------------------------------------------------------
# PYTHON 2 / 3 COMPATIBILITY SHIMS
# ------------------------------------------------------------------
try:
    unicode                       # noqa: F821  (Python 2)
except NameError:
    unicode = str                 # noqa: F821  (Python 3)
    basestring = (str, bytes)     # noqa: F821

try:
    from Queue import Queue, Empty
except ImportError:
    from queue import Queue, Empty


def _byte_array(size):
    """Return a writable .NET byte[] of the given length."""
    try:
        return System.Array.CreateInstance(System.Byte, size)
    except Exception:
        # pythonnet sometimes needs the byte type resolved differently
        return System.Array.CreateInstance(System.PrimitiveType.Byte, size)


def _utf8_get_string(byte_array, offset=0, count=None):
    """Decode a .NET byte[] as UTF-8 text."""
    if count is None:
        text = System.Text.Encoding.UTF8.GetString(byte_array)
    else:
        text = System.Text.Encoding.UTF8.GetString(byte_array, offset, count)
    return text


def _utf8_get_bytes(text):
    """Encode text as a .NET UTF-8 byte[] (takes a unicode string)."""
    return System.Text.Encoding.UTF8.GetBytes(_u(text))


def _make_listener(host, port):
    """Create a TcpListener, tolerating both .NET interop styles."""
    try:
        return System.Net.Sockets.TcpListener(System.Net.IPAddress.Parse(host), port)
    except AttributeError:
        from System.Net import Sockets, IPAddress
        return Sockets.TcpListener(IPAddress.Parse(host), port)


def _u(value):
    """Return a .NET friendly unicode string."""
    if isinstance(value, unicode):        # noqa: F821
        return value
    if hasattr(value, "decode"):
        try:
            return value.decode("utf-8")
        except Exception:
            return unicode(value)          # noqa: F821
    return unicode(value)                  # noqa: F821


# ------------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------------
VERSION = "2.6.4"
DESIGNER = "Reza Khoshnood"
HOST = "127.0.0.1"
PORT = 8765
HTTP_READ_TIMEOUT_MS = 15000
MAX_REQUEST_BYTES = 4 * 1024 * 1024

STEP_TIMEOUT_MIN = 30.0        # seconds allowed for one step
STEP_TIMEOUT_PER_CHAR = 1.0 / 200.0
STEP_TIMEOUT_MAX = 120.0
SESSION_SAFETY_TIMEOUT = 1800.0
CONNECT_WAIT_FOR_IDLE = 20.0   # how long a step may wait for the main thread
MAX_OPEN_SCOPES = 4
BACKLOG = 32

# ---- live viewport (2.6.2) ---------------------------------------
VIEWPORT_DEFAULT_WIDTH = 720   # px sent to the extension by default
VIEWPORT_MIN_WIDTH = 320
VIEWPORT_MAX_WIDTH = 1280
VIEWPORT_JPEG_QUALITY = 72
VIEWPORT_MIN_INTERVAL = 0.20   # seconds between two main thread captures
VIEWPORT_FRESH_FOR = 1.10      # a frame younger than this is reused as is
VIEWPORT_WAIT_DEFAULT = 2.50   # how long /viewport waits for a new frame
VIEWPORT_WAIT_MAX = 6.0
# 2.6.3: a failed capture is retried, never treated as "game over".
# One transient failure (view not painted yet, encoder busy, Rhino just
# started) used to mark the viewport unsupported forever and the panel
# stayed black until Rhino was restarted.
VIEWPORT_FAIL_INTERVAL = 1.00  # seconds between two capture RETRIES
VIEWPORT_UNSUPPORTED_AFTER = 3 # consecutive failures before we say so

# ---- verification + automatic repair (2.6.2) ---------------------
MAX_REPAIRS_PER_STEP = 2       # repairs applied while a step is failing
MAX_RETRY_ATTEMPTS = 2         # whole-script retries offered to the client
MAX_CHECKED_OBJECTS = 400      # validity check budget after a run
MAX_CLEANUP_OBJECTS = 5000     # partial geometry removed before a retry


# ==================================================================
# 1) CHUNKER
# ------------------------------------------------------------------
# The exact same splitting rules as server/chunker.py, inlined so this
# file is completely self contained. test_chunker_parity.py proves the
# two implementations produce identical step boundaries.
# ==================================================================
BLOCK_OPEN_RE = re.compile(
    r"^\s*(def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b"
)
CLAUSE_RE = re.compile(r"^(elif|else|except|finally|case)\b")
IMPORT_RE = re.compile(r"^\s*(import|from)\s")
CONTINUATION_RE = re.compile(r"\\\s*$")
FENCE_RE = re.compile(r"^\s*```")

DEFAULT_MAX_LINES = 25
DEFAULT_MAX_CHARS = 1500


def _indent_of(line):
    return len(line) - len(line.lstrip(" \t"))


def _is_blank(line):
    return line.strip() == ""


def _is_comment(line):
    return line.lstrip().startswith("#")


def _ends_with_continuation(line):
    return bool(CONTINUATION_RE.search(line))


def _strip_fences(code):
    lines = code.split("\n")
    start = 0
    while start < len(lines) and _is_blank(lines[start]):
        start += 1
    if start < len(lines) and FENCE_RE.match(lines[start]):
        lines.pop(start)
    end = len(lines) - 1
    while end >= 0 and _is_blank(lines[end]):
        end -= 1
    if end > start and FENCE_RE.match(lines[end]):
        lines.pop(end)
    return "\n".join(lines)


def _scan_logical_line(lines, i, n):
    depth = 0
    triple = None
    j = i
    while j < n:
        text = lines[j]
        k = 0
        while k < len(text):
            ch = text[k]
            if triple is not None:
                if text.startswith(triple, k):
                    triple = None
                    k += 3
                    continue
                k += 1
                continue
            if ch == "#":
                break
            if ch == '"' or ch == "'":
                if text.startswith(ch * 3, k):
                    triple = ch * 3
                    k += 3
                    continue
                quote = ch
                k += 1
                while k < len(text):
                    if text[k] == "\\":
                        k += 2
                        continue
                    if text[k] == quote:
                        k += 1
                        break
                    k += 1
                continue
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                if depth > 0:
                    depth -= 1
            k += 1
        if triple is not None or depth > 0 or _ends_with_continuation(text):
            j += 1
            continue
        break
    if j >= n:
        return n - 1
    return j


def _opens_block(lines, start, end):
    text = lines[end].strip()
    if "#" in text:
        text = text.split("#", 1)[0].strip()
    if not text.endswith(":"):
        return False
    joined = " ".join(lines[start:end + 1]).strip()
    if not BLOCK_OPEN_RE.match(joined):
        return False
    return True


def _scan_suite(lines, k, n, base_indent):
    last = k - 1
    while k < n:
        line = lines[k]
        if _is_blank(line):
            k += 1
            continue
        if _indent_of(line) <= base_indent:
            break
        k = _scan_unit_from(lines, k, n) + 1
        last = k - 1
    while True:
        m = k
        while m < n and _is_blank(lines[m]):
            m += 1
        if m >= n:
            break
        if _indent_of(lines[m]) != base_indent:
            break
        if not CLAUSE_RE.match(lines[m].lstrip()):
            break
        e = _scan_logical_line(lines, m, n)
        if _opens_block(lines, m, e):
            e = _scan_suite(lines, e + 1, n, base_indent)
        last = e
        k = e + 1
    return last


def _scan_unit_from(lines, i, n):
    while i < n and (_is_blank(lines[i]) or _is_comment(lines[i])):
        i += 1
    if i >= n:
        return n - 1
    while i < n and lines[i].lstrip().startswith("@"):
        i = _scan_logical_line(lines, i, n) + 1
        while i < n and _is_blank(lines[i]):
            i += 1
    if i >= n:
        return n - 1
    base_indent = _indent_of(lines[i])
    end = _scan_logical_line(lines, i, n)
    if _opens_block(lines, i, end):
        end = _scan_suite(lines, end + 1, n, base_indent)
    return end


def _classify(lines, start, end):
    first_code = None
    for t in range(start, end + 1):
        if not _is_blank(lines[t]) and not _is_comment(lines[t]):
            first_code = t
            break
    if first_code is None:
        return "comment"
    if IMPORT_RE.match(lines[first_code]):
        return "import"
    t = first_code
    while t <= end:
        e = _scan_logical_line(lines, t, end + 1)
        if _opens_block(lines, t, e):
            return "block"
        t = e + 1
        while t <= end and (_is_blank(lines[t]) or _is_comment(lines[t])):
            t += 1
    return "statement"


def _step_dict(lines, start, end, n, index, max_chars):
    code = "\n".join(lines[start:end + 1])
    if end + 1 < n:
        code += "\n"
    return {
        "index": index,
        "code": code,
        "kind": _classify(lines, start, end),
        "start_line": start + 1,
        "end_line": end + 1,
        "lines": end - start + 1,
        "chars": len(code),
        "large": len(code) > max_chars,
    }


def chunk_code(code, max_lines=DEFAULT_MAX_LINES, max_chars=DEFAULT_MAX_CHARS):
    """Split Rhino Python code into ordered, syntax safe execution steps."""
    if code is None:
        code = ""

    cleaned = _strip_fences(code.replace("\r\n", "\n").replace("\r", "\n"))
    lines = cleaned.split("\n")
    n = len(lines)

    if cleaned.strip() == "":
        return {"steps": [], "total": 0, "original_lines": n, "split": False,
                "truncated": False, "normalized": ""}

    units = []
    i = 0
    while i < n:
        end = _scan_unit_from(lines, i, n)
        if end < i:
            end = i
        units.append((i, end))
        i = end + 1

    ranges = []
    cur_start = None
    cur_end = None
    for start, end in units:
        if cur_start is None:
            cur_start, cur_end = start, end
            continue
        candidate_chars = sum(len(lines[t]) + 1 for t in range(cur_start, end + 1))
        candidate_lines = end - cur_start + 1
        if candidate_lines <= max_lines and candidate_chars <= max_chars:
            cur_end = end
        else:
            ranges.append((cur_start, cur_end))
            cur_start, cur_end = start, end
    if cur_start is not None:
        ranges.append((cur_start, cur_end))

    merged = []
    for start, end in ranges:
        first = None
        for t in range(start, end + 1):
            if _is_blank(lines[t]) or _is_comment(lines[t]):
                continue
            first = lines[t].lstrip()
            break
        if merged and first is not None and CLAUSE_RE.match(first):
            prev_start, prev_end = merged[-1]
            merged[-1] = (prev_start, end)
        else:
            merged.append((start, end))

    steps = []
    truncated = False
    for start, end in merged:
        step = _step_dict(lines, start, end, n, len(steps) + 1, max_chars)
        if step["large"]:
            truncated = True
        steps.append(step)

    return {
        "steps": steps,
        "total": len(steps),
        "original_lines": n,
        "split": len(steps) > 1,
        "truncated": truncated,
        "normalized": cleaned,
    }


# ==================================================================
# 1b) CODE CLEANUP  (2.6.2)
# ------------------------------------------------------------------
# AI answers reach the bridge with chat chrome around the code: markdown
# fences, line numbers, "Copy" labels, REPL prompts, curly quotes and -
# very often - imports of modules that cannot exist inside Rhino. All of
# that is removed here, BEFORE the chunker splits the script, so every
# step that reaches Rhino is the cleanest possible form of the answer.
# ==================================================================
CHROME_LINE_RE = re.compile(
    r"^(copy|copy code|copy to clipboard|copied|edit|run|run code|try again|retry|"
    r"regenerate|save|share|insert|preview|output|result|example|python|python 2|"
    r"python 3|py|py3|python3|bash|json|javascript|typescript|shell|text)$",
    re.IGNORECASE,
)
LINE_NUMBER_RE = re.compile(r"^[ \t]*\d{1,4}(?:[\.\):\|\t ]+|$)")
REPL_PROMPT_RE = re.compile(r"^[ \t]*(?:>>>|\.\.\.)(?:[ \t]|$)")
CLR_REFERENCE_RE = re.compile(r"^[ \t]*clr\s*\.\s*(?:AddReference|AddReferenceToFile|AddReferenceToFileAndPath)\s*\(")
INPUT_CALL_RE = re.compile(r"\b(raw_input|input)[ \t]*\(")
TYPED_BLOCKING_RE = re.compile(
    r"\brs\s*\.\s*(GetPoint|GetPoints|GetReal|GetInteger|GetString|GetObject|GetObjects|"
    r"GetBoolean|GetNumber|GetLayer|GetColor|ListBox|ComboListBox|PropertyListBox|"
    r"MultiListBox|OpenFileName|SaveFileName|GetAngle|GetDistance|GetRectangle|GetCircle|"
    r"GetLine|GetPlane|GetTransform|GetCurveObject|GetSurfaceObject|GetMesh|MessageBox|"
    r"EditBox|GetPointOnMesh|GetPointOnSurface)\s*\("
)

# modules that can never work inside Rhino's Python engine. Importing them
# would abort the whole script, so the import line is dropped and reported.
FORBIDDEN_IMPORT_RE = re.compile(
    r"^[ \t]*(?:import|from)[ \t]+"
    r"(numpy|scipy|pandas|matplotlib|PIL|Pillow|cv2|sklearn|torch|tensorflow|"
    r"tkinter|Tkinter|tkMessageBox|PyQt4|PyQt5|PyQt6|PySide|PySide2|PySide6|wx|"
    r"requests|urllib|urllib2|urllib3|aiohttp|flask|django|socket|http|"
    r"System\.Windows\.Forms|System\.Windows\.Controls|System\.Drawing\.Design)\b"
)

# identifier -> import line that makes it available
AUTO_IMPORTS = [
    ("rs.", "import rhinoscriptsyntax as rs", "rhinoscriptsyntax"),
    ("sc.", "import scriptcontext as sc", "scriptcontext"),
    ("Rhino.", "import Rhino", "Rhino"),
    ("math.", "import math", "math"),
    ("random.", "import random", "random"),
    ("time.", "import time", "time"),
    ("json.", "import json", "json"),
]

STRING_RE = re.compile(r"\"[^\"\n]*\"|'[^'\n]*'")
COMMENT_RE = re.compile(r"#[^\n]*$")


def _code_only(line):
    """The line with comments and string literals removed (for detection)."""
    text = COMMENT_RE.sub("", line)
    text = STRING_RE.sub('""', text)
    return text


def _dedent_code(code):
    lines = code.split("\n")
    indent = -1
    for line in lines:
        if not line.strip():
            continue
        lead = len(line) - len(line.lstrip(" \t"))
        if indent < 0 or lead < indent:
            indent = lead
    if indent <= 0:
        return code
    out = []
    for line in lines:
        out.append(line[indent:] if len(line) >= indent else line.lstrip(" \t"))
    return "\n".join(out)


def _fix_typography(code):
    """Curly quotes / nbsp / zero width characters -> plain ASCII."""
    text = code
    text = text.replace(u"\u2018", "'").replace(u"\u2019", "'")
    text = text.replace(u"\u201c", '"').replace(u"\u201d", '"')
    text = text.replace(u"\u00a0", " ")
    text = text.replace(u"\u200b", "").replace(u"\u200c", "").replace(u"\u200d", "")
    text = text.replace(u"\ufeff", "").replace(u"\r\n", "\n").replace(u"\r", "\n")
    return text


def _code_top_index(lines):
    """Where injected imports may be inserted (after __future__ imports)."""
    index = 0
    while index < len(lines) and lines[index].strip() == "":
        index += 1
    while index < len(lines) and lines[index].lstrip().startswith("from __future__"):
        index += 1
    return index


def clean_code(code):
    """Return {'code', 'notes', 'removed_imports', 'inserted_imports'}.

    Deterministic, side effect free and safe to call twice (idempotent).
    """
    notes = []
    removed = []
    inserted = []

    text = _fix_typography(_u(code) if not isinstance(code, unicode) else code)  # noqa: F821
    lines = text.split("\n")

    # ---- 1) drop fences, REPL prompts and pure chrome lines ----------
    stage = []
    for line in lines:
        if FENCE_RE.match(line):
            continue
        if REPL_PROMPT_RE.match(line):
            line = REPL_PROMPT_RE.sub("", line)
            if not line.strip():
                continue
        if CHROME_LINE_RE.match(line.strip()):
            continue
        stage.append(line.rstrip())
    lines = stage

    # ---- 2) drop line numbers (only when most lines carry one) -------
    non_empty = 0
    numbered = 0
    for line in lines:
        if not line.strip():
            continue
        non_empty += 1
        if LINE_NUMBER_RE.match(line):
            numbered += 1
    if non_empty > 2 and float(numbered) / float(non_empty) > 0.5:
        lines = [LINE_NUMBER_RE.sub("", line) if line.strip() else line for line in lines]
        notes.append("removed line numbers")

    # ---- 3) drop imports that cannot work, and clr references --------
    stage = []
    for line in lines:
        stripped = line.strip()
        match = FORBIDDEN_IMPORT_RE.match(line)
        if match:
            removed.append(match.group(1))
            continue
        if CLR_REFERENCE_RE.match(line):
            removed.append("clr.AddReference")
            continue
        stage.append(line)
    lines = stage
    if removed:
        notes.append("dropped imports that cannot run inside Rhino: " +
                     ", ".join(sorted(set(removed))))

    # ---- 4) neutralise blocking console input ------------------------
    joined = "\n".join(lines)
    joined, replaced_input = _neutralise_input(joined)
    if replaced_input:
        lines = joined.split("\n")
        notes.append("replaced %d blocking input() call(s) with empty strings" % replaced_input)

    # ---- 5) inject the imports the code obviously needs --------------
    blob = "\n".join(_code_only(line) for line in lines)
    have = blob
    preamble = []
    for token, import_line, module in AUTO_IMPORTS:
        if token not in have:
            continue
        pattern = re.compile(r"^[ \t]*(?:import[ \t]+" + re.escape(module) +
                             r"\b|from[ \t]+" + re.escape(module) + r"\b)", re.MULTILINE)
        if pattern.search(have):
            continue
        preamble.append(import_line)
        inserted.append(module)
    if preamble:
        at = _code_top_index(lines)
        lines = lines[:at] + preamble + lines[at:]
        notes.append("injected missing import(s): " + ", ".join(inserted))

    # ---- 6) tidy whitespace -----------------------------------------
    out = []
    blanks = 0
    for line in lines:
        if not line.strip():
            blanks += 1
            if blanks > 1:
                continue
            out.append("")
        else:
            blanks = 0
            out.append(line.rstrip())
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    if out:
        out[0] = out[0].lstrip(" \t")

    cleaned = _dedent_code("\n".join(out))
    if cleaned.strip() == "":
        notes.append("the script is empty after cleaning")

    return {
        "code": cleaned,
        "notes": notes,
        "removed_imports": sorted(set(removed)),
        "inserted_imports": inserted,
    }


def _neutralise_input(code):
    """Replace every input()/raw_input() call by "" (they would hang Rhino).

    Returns (code, replaced_count). The argument list is consumed with a
    small balanced parenthesis scanner, so nested calls and quotes survive.
    """
    text = code
    replaced = 0
    guard = 0
    while guard < 50:
        guard += 1
        match = INPUT_CALL_RE.search(text)
        if not match:
            break
        start = match.start()
        index = match.end()
        depth = 1
        while index < len(text) and depth > 0:
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            index += 1
        text = text[:start] + '""' + text[index:]
        replaced += 1
    return text, replaced


def find_blocking_call(code):
    """Name of the first interactive Rhino dialog used by the code, or ''.

    Such a call stops Rhino's main thread until a human clicks something,
    which would freeze the step, the progress bar and every later step.
    Detecting it before execution is a crash prevention feature.
    """
    for line in code.split("\n"):
        match = TYPED_BLOCKING_RE.search(_code_only(line))
        if match:
            return "rs." + match.group(1)
    return ""


def repair_code(code, error):
    """Return (fixed_code, reason) for a known failure, or (None, '')."""
    err = (error or "").lower()
    if not err:
        return None, ""

    if ("indent" in err or "unexpected eof" in err or "expected an indented block" in err
            or "unindent" in err):
        fixed = _dedent_code(code)
        if fixed != code:
            return fixed, "re-indented the code"

    match = re.search(r"no module named ['\"]([A-Za-z0-9_\.]+)['\"]", err)
    if match is None and ("importerror" in err or "cannot import name" in err):
        match = re.search(r"(?:cannot import name[^\n]*from|import of)\s+['\"]?([A-Za-z0-9_\.]+)", err)
    if match:
        module = match.group(1).split(".")[0]
        keep = []
        dropped = False
        for line in code.split("\n"):
            if re.match(r"^[ \t]*(?:import|from)[ \t]+" + re.escape(module) + r"\b", line):
                dropped = True
                continue
            keep.append(line)
        if dropped:
            return "\n".join(keep), "removed unavailable module '%s'" % module

    if "nameerror" in err or "is not defined" in err:
        match = re.search(r"name ['\"]([A-Za-z_][A-Za-z0-9_]*)['\"] is not defined", err)
        name = match.group(1) if match else ""
        aliases = {
            "rs": "import rhinoscriptsyntax as rs",
            "Rhino": "import Rhino",
            "sc": "import scriptcontext as sc",
            "math": "import math",
            "random": "import random",
            "time": "import time",
            "json": "import json",
        }
        if name in aliases:
            return aliases[name] + "\n" + code, "imported the missing module for '%s'" % name

    if ("syntaxerror" in err or "invalid character" in err or "unexpected character" in err
            or "invalid syntax" in err or "non-ascii" in err):
        fixed = _fix_typography(code)
        if fixed != code:
            return fixed, "normalised typographic characters"

    return None, ""


# ==================================================================
# 1c) DOCUMENT PROBES  (2.6.2 - used by the verification loop)
# ==================================================================
def _doc_object_ids():
    """Set of every object id in the document, or None when unavailable."""
    try:
        objects = sc.doc.Objects
    except Exception:
        return None
    ids = set()
    try:
        for obj in objects:
            try:
                ids.add(str(obj.Id))
            except Exception:
                pass
    except Exception:
        return None
    return ids


def _guid(value):
    try:
        return System.Guid(value)
    except Exception:
        return value


def check_new_objects(before_ids, limit=MAX_CHECKED_OBJECTS):
    """(created, invalid_ids, checked) for the objects added since before_ids."""
    after = _doc_object_ids()
    if after is None or before_ids is None:
        return None, [], 0

    created = [guid for guid in after if guid not in before_ids]
    invalid = []
    checked = 0
    for guid in created:
        if checked >= limit:
            break
        checked += 1
        try:
            obj = sc.doc.Objects.Find(_guid(guid))
        except Exception:
            obj = None
        if obj is None:
            continue
        try:
            if not obj.IsValid:
                invalid.append(guid)
        except Exception:
            pass
    return len(created), invalid, checked


def _query_value(query, name, default=""):
    if not query:
        return default
    for part in query.split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
        else:
            key, value = part, ""
        if key.strip() == name:
            return value
    return default


def _query_int(query, name, default=0):
    try:
        return int(_query_value(query, name, str(default)))
    except Exception:
        return default


def _query_float(query, name, default=0.0):
    try:
        return float(_query_value(query, name, str(default)))
    except Exception:
        return default


# ==================================================================
# 1d) LIVE VIEWPORT  (2.6.2)
# ------------------------------------------------------------------
# Frames are captured on Rhino's main thread only (RhinoView wants the
# UI thread), encoded to JPEG and cached. /viewport serves the cache and
# asks for a fresh frame when the caller is behind, so the panel is
# always in sync with the document and never hammers the main thread.
# ==================================================================
def _active_view():
    """The RhinoView to capture (RhinoCommon: doc.Views.ActiveView)."""
    candidates = []
    try:
        candidates.append(sc.doc)
    except Exception:
        pass
    try:
        candidates.append(Rhino.RhinoDoc.ActiveDoc)
    except Exception:
        pass
    for document in candidates:
        if document is None:
            continue
        try:
            view = document.Views.ActiveView
        except Exception:
            view = None
        if view is not None:
            return view
        # 2.6.3: some layouts report no ActiveView (all views minimised,
        # a page view focused, ...). Any real model view is better than
        # a black panel, so fall back to the first view of the document.
        try:
            for fallback in document.Views:
                if fallback is not None:
                    return fallback
        except Exception:
            pass
    return None


class Viewport(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.rev = 0
        self.ts = 0.0
        self.width = 0
        self.height = 0
        self.format = "jpeg"
        self.data = ""
        self.wanted = False
        self.pending_width = 0
        self.last_attempt = 0.0
        self.event = threading.Event()
        self.last_error = ""
        self.supported = None          # None = unknown, then True/False
        self.captures = 0
        self.last_ms = 0.0
        self.failures = 0              # 2.6.3: consecutive capture failures
        self.strategy = ""             # 2.6.3: how the last frame was made

    # ---------------- request side (HTTP thread) ----------------
    def request(self, width=0):
        with self.lock:
            self.wanted = True
            if width:
                self.pending_width = width
            self.event.clear()

    def frame(self, rev=0, width=0, wait=VIEWPORT_WAIT_DEFAULT, force=False):
        """Return the frame payload for the extension.

        A cached frame is reused when it is fresh, newer than `rev` and
        was rendered at the requested width. Otherwise a capture is
        requested from the main thread and the caller waits for it.
        """
        self.request(width)
        wanted_width = self._width(width) if width else 0

        deadline = time.time() + min(max(wait, 0.25), VIEWPORT_WAIT_MAX)
        while True:
            with self.lock:
                have = bool(self.data)
                fresh = have and (time.time() - self.ts) <= VIEWPORT_FRESH_FOR
                width_ok = (wanted_width == 0) or (self.width == wanted_width)
                # 2.6.3: even after failures we keep asking the main
                # thread for a frame. "supported is False" is only a
                # report about the recent past, never a reason to stop
                # trying - the next capture may well succeed.
                if have and width_ok:
                    if not force and fresh:
                        return self._payload(self.rev <= rev)
                    if self.rev > rev:
                        return self._payload(False)
            if time.time() >= deadline:
                break
            self.event.wait(0.05)

        with self.lock:
            if self.data:
                return self._payload(True)
            return {
                "ok": False,
                "error": self.last_error or "no frame yet - is a viewport open?",
                "supported": self.supported,
                "failures": self.failures,
                "rev": self.rev,
                "engine": "embedded",
                "version": VERSION,
            }

    def _payload(self, stale):
        return {
            "ok": True,
            "rev": self.rev,
            "ts": round(self.ts, 3),
            "width": self.width,
            "height": self.height,
            "format": self.format,
            "stale": bool(stale),
            "age": round(time.time() - self.ts, 3),
            "ms": self.last_ms,
            "data": self.data,
            "engine": "embedded",
            "version": VERSION,
        }

    # ---------------- capture side (Rhino main thread) ----------------
    def _width(self, width):
        value = int(width or self.pending_width or VIEWPORT_DEFAULT_WIDTH)
        if value < VIEWPORT_MIN_WIDTH:
            value = VIEWPORT_MIN_WIDTH
        if value > VIEWPORT_MAX_WIDTH:
            value = VIEWPORT_MAX_WIDTH
        return value

    # ---------------- 2.6.3: capture helpers ----------------
    def _fail(self, message):
        """Record a failed attempt WITHOUT giving up on the viewport.

        2.6.2 marked the viewport unsupported after the very first
        failure, so one transient hiccup (Rhino still starting, view
        not painted yet, encoder busy) left the panel black forever.
        Now a failure is only counted; after VIEWPORT_UNSUPPORTED_AFTER
        in a row we REPORT it, but capture keeps being retried and the
        first success flips everything back to healthy.
        """
        with self.lock:
            self.failures += 1
            self.last_error = message
            if self.failures >= VIEWPORT_UNSUPPORTED_AFTER:
                self.supported = False
        self.event.set()
        return False

    def _drawing_modules(self, errors):
        """Best effort access to System.Drawing (Size / Bitmap / Imaging).

        Rhino 8 runs Python on .NET Core where System.Drawing.Common is
        not always loaded up front, so explicitly AddReference it when
        the plain import does not bring Imaging along. IronPython
        (Rhino 7) resolves the same names from the framework assembly.
        Returns (System, drawing, imaging, io) - any of them may be None.
        """
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
            # .NET Core (Rhino 8 CPython): pull the assembly in by name.
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

    def _capture_bitmap(self, view, target_w, target_h, drawing, errors):
        """Grab a bitmap of the view, whichever Rhino API cooperates.

        1. RhinoView.CaptureToBitmap(Size) - the classic Rhino 5+ API.
        2. Rhino.Display.ViewCapture       - the documented fallback,
           takes plain int Width/Height (no System.Drawing needed).
        3. RhinoView.CaptureToBitmap()     - native size, downscaled
           afterwards when a Size can be built.
        """
        if drawing is not None:
            try:
                bitmap = view.CaptureToBitmap(drawing.Size(target_w, target_h))
                if bitmap is not None:
                    self.strategy = "CaptureToBitmap(Size)"
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
                self.strategy = "ViewCapture"
                return bitmap
            errors.append("ViewCapture returned None")
        except Exception as ex:
            errors.append("ViewCapture: " + str(ex))
        try:
            bitmap = view.CaptureToBitmap()
            if bitmap is not None:
                self.strategy = "CaptureToBitmap()"
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
                            self.strategy = "CaptureToBitmap()+resize"
                    except Exception as ex:
                        errors.append("resize: " + str(ex))
                return bitmap
            errors.append("CaptureToBitmap() returned None")
        except Exception as ex:
            errors.append("CaptureToBitmap(): " + str(ex))
        return None

    def _encode_bitmap(self, bitmap, system, imaging, io_mod, errors):
        """Bitmap -> (base64, format). Every attempt gets a FRESH stream,
        so a half written JPEG can never poison the PNG fallback."""
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

    def capture(self, width=0):
        """Capture one frame. MUST be called on Rhino's main thread."""
        started = time.time()
        self.last_attempt = started
        errors = []

        view = _active_view()
        if view is None:
            return self._fail("no viewport open in Rhino")

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

        target_w = self._width(width)
        target_h = int(round(float(target_w) * float(view_h) / float(view_w)))
        if target_h < 120:
            target_h = 120
        if target_h > VIEWPORT_MAX_WIDTH:
            target_h = VIEWPORT_MAX_WIDTH

        system, drawing, imaging, io_mod = self._drawing_modules(errors)

        bitmap = self._capture_bitmap(view, target_w, target_h, drawing, errors)
        if bitmap is None:
            return self._fail("viewport capture failed: " + " | ".join(errors[-3:]))

        try:
            payload, used_format = self._encode_bitmap(
                bitmap, system, imaging, io_mod, errors)
        finally:
            try:
                bitmap.Dispose()
            except Exception:
                pass
        if payload is None:
            return self._fail("viewport encoding failed: " + " | ".join(errors[-3:]))

        with self.lock:
            self.rev += 1
            self.ts = time.time()
            self.width = target_w
            self.height = target_h
            self.format = used_format
            self.data = payload
            self.wanted = False
            self.last_error = ""
            self.supported = True
            self.failures = 0
            self.captures += 1
            self.last_ms = round((self.ts - started) * 1000.0, 1)
        self.event.set()
        return True

    def status(self):
        with self.lock:
            return {
                "available": self.supported is not False,
                "supported": self.supported,
                "frames": self.captures,
                "rev": self.rev,
                "width": self.width,
                "height": self.height,
                "format": self.format,
                "last_ms": self.last_ms,
                "error": self.last_error,
                "failures": self.failures,
                "strategy": self.strategy,
            }


VIEWPORT = Viewport()


# ==================================================================
# 2) TINY HTTP SERVER (TcpListener based, no admin rights, no pip)
# ==================================================================
HTTP_STATUS = {
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    500: "Internal Server Error",
}


class HttpRequest(object):
    def __init__(self, method, path, query, headers, body_text):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body_text = body_text


class HttpConnection(object):
    """Reads one HTTP request and writes one HTTP response."""

    def __init__(self, client):
        self.client = client
        self.stream = client.GetStream()

    def close(self):
        try:
            self.stream.Close()
        except Exception:
            pass
        try:
            self.client.Close()
        except Exception:
            pass

    # ---------------- reading ----------------
    def _read_bytes(self, read_buf, limit):
        """Read until the header terminator, return (buffer, header_end)."""
        buf = []
        header_end = -1
        while header_end < 0:
            count = self.stream.Read(read_buf, 0, len(read_buf))
            if count <= 0:
                break
            for i in range(count):
                buf.append(int(read_buf[i]))
            if len(buf) > limit:
                raise ValueError("request too large")
            header_end = _find_sequence(buf, 13, 10, 13, 10)
        return buf, header_end

    def read_request(self):
        read_buf = _byte_array(4096)

        buf, header_end = self._read_bytes(read_buf, MAX_REQUEST_BYTES)
        if header_end < 0:
            return None

        header_bytes = _byte_array(header_end)
        for i in range(header_end):
            header_bytes[i] = buf[i]
        header_text = _utf8_get_string(header_bytes)

        lines = header_text.split("\r\n")
        request_line = lines[0].split(" ")
        if len(request_line) < 2:
            return None
        method = request_line[0].upper()
        target = request_line[1]

        headers = {}
        for line in lines[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()

        length = 0
        if "content-length" in headers:
            try:
                length = int(headers["content-length"])
            except Exception:
                length = 0
        if length > MAX_REQUEST_BYTES:
            raise ValueError("body too large")

        body_start = header_end + 4
        while len(buf) < body_start + length:
            count = self.stream.Read(read_buf, 0, len(read_buf))
            if count <= 0:
                break
            for i in range(count):
                buf.append(int(read_buf[i]))

        body_text = ""
        if length > 0:
            body_bytes = _byte_array(length)
            for i in range(length):
                body_bytes[i] = buf[body_start + i]
            body_text = _utf8_get_string(body_bytes)

        if "?" in target:
            path, query = target.split("?", 1)
        else:
            path, query = target, ""

        return HttpRequest(method, path, query, headers, body_text)

    # ---------------- writing ----------------
    def write_response(self, status, payload_text):
        reason = HTTP_STATUS.get(status, "OK")
        if payload_text is None:
            payload_text = ""

        headers = [
            "HTTP/1.1 %d %s" % (status, reason),
            "Content-Type: application/json; charset=utf-8",
            "Content-Length: %d" % len(payload_text.encode("utf-8")),
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type",
            "Cache-Control: no-store",
            "Connection: close",
            "",
            "",
        ]
        text = "\r\n".join(headers) + payload_text

        try:
            arr = _utf8_get_bytes(text)
            self.stream.Write(arr, 0, arr.Length)
            self.stream.Flush()
        except Exception:
            pass


def _find_sequence(buf, *values):
    """Index of a byte sequence inside a list of ints, or -1."""
    span = len(values)
    total = len(buf)
    if total < span:
        return -1
    first = values[0]
    limit = total - span
    for i in range(limit + 1):
        if buf[i] != first:
            continue
        match = True
        for k in range(1, span):
            if buf[i + k] != values[k]:
                match = False
                break
        if match:
            return i
    return -1


# ==================================================================
# 3) BRIDGE CORE (sessions, step queue, main thread executor)
# ==================================================================
class Session(object):
    def __init__(self, session_id, chunk_result, attempt=1, auto_repair=True,
                 notes=None, cleaned_code="", orig_code=""):
        self.id = session_id
        self.steps = chunk_result["steps"]
        self.total = len(self.steps)
        self.split = chunk_result["split"]
        self.truncated = chunk_result["truncated"]
        self.source_lines = chunk_result["original_lines"]
        self.next_index = 0
        self.finished = False
        self.success = True
        self.error = ""
        self.cancelled = False
        self.started_at = time.time()
        self.finished_at = 0.0
        self.current_kind = self.steps[0]["kind"] if self.steps else ""
        self.event = threading.Event()

        # ---- 2.6.2: verification + self healing --------------------
        self.attempt = attempt
        self.auto_repair = auto_repair
        self.notes = list(notes or [])
        self.cleaned_code = cleaned_code or ""
        self.orig_code = orig_code or ""
        self.repairs = []
        self.step_repairs = 0
        self.blocked = ""
        self.before_ids = None
        self.after_ids = None
        self.objects_created = None
        self.invalid_objects = []
        self.checked_objects = 0
        self.steps_done = 0
        self.failed_step = 0
        self.verify_data = None

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

    def cleanup_ids(self):
        """Objects this run created - removed again before a retry."""
        if not self.before_ids or not self.after_ids:
            return []
        ids = [value for value in self.after_ids if value not in self.before_ids]
        if len(ids) > MAX_CLEANUP_OBJECTS:
            return []
        return ids

    def progress_payload(self):
        step = self.current_step()
        reported = step["index"] if step is not None else self.total
        return {
            "active": not self.finished,
            "session_id": self.id,
            "step": reported,
            "steps_done": self.steps_done,
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
            "attempt": self.attempt,
            "repairs": len(self.repairs),
            "engine": "embedded",
        }

    def verify_payload(self):
        """How well did this run actually go? (2.6.2)"""
        if self.verify_data is not None and self.finished:
            return self.verify_data

        checks = []
        cleaned_ok = self.notes is not None
        checks.append({
            "name": "code cleaned",
            "ok": bool(cleaned_ok),
            "detail": "; ".join(self.notes) if self.notes else "nothing to clean",
        })
        steps_ok = self.steps_done >= self.total and self.total > 0
        checks.append({
            "name": "all steps executed",
            "ok": bool(steps_ok and self.success) or bool(self.success),
            "detail": "%d/%d steps" % (self.steps_done, self.total),
        })
        checks.append({
            "name": "no runtime error",
            "ok": bool(self.success),
            "detail": self.error if self.error else "clean run",
        })
        geometry_ok = (self.invalid_objects == []) and (not self.blocked)
        checks.append({
            "name": "geometry valid",
            "ok": bool(geometry_ok),
            "detail": ("%d invalid object(s)" % len(self.invalid_objects))
                      if self.invalid_objects else
                      ("blocked: " + self.blocked if self.blocked else
                       "%d object(s) checked" % self.checked_objects),
        })
        ok = bool(self.success) and geometry_ok
        payload = {
            "ok": ok,
            "success": bool(self.success),
            "session_id": self.id,
            "attempt": self.attempt,
            "max_attempts": MAX_RETRY_ATTEMPTS,
            "steps": self.total,
            "steps_done": self.steps_done,
            "failed_step": self.failed_step,
            "lines": self.source_lines,
            "elapsed": round((self.finished_at or time.time()) - self.started_at, 2),
            "error": self.error,
            "cancelled": self.cancelled,
            "blocked": self.blocked,
            "objects_before": len(self.before_ids) if self.before_ids is not None else None,
            "objects_after": len(self.after_ids) if self.after_ids is not None else None,
            "objects_created": self.objects_created,
            "objects_checked": self.checked_objects,
            "invalid_objects": list(self.invalid_objects[:20]),
            "repairs": list(self.repairs),
            "warnings": list(self.notes),
            "checks": checks,
            "retryable": (not self.cancelled) and (not self.blocked) and
                         (not self.success) and self.attempt < MAX_RETRY_ATTEMPTS,
            "engine": "embedded",
            "version": VERSION,
        }
        if self.finished:
            self.verify_data = payload
        return payload



class Bridge(object):
    """Holds the session state. HTTP threads call into it; the Rhino main
    thread drains the step queue from the Idle event."""

    def __init__(self):
        self.lock = threading.RLock()
        self.session = None
        self.last_finished = None
        self.last_code = ""
        self.step_queue = Queue()
        self.main_jobs = Queue()      # 2.6.2: cleanup / fit run on the main thread
        self.scopes = {}
        self.scope_order = []
        self.jobs = 0                 # scripts handled since start
        self.cleaned_objects = 0      # objects removed by the retry loop
        self.last_error = ""
        self.idle_hooked = False
        self.stopped = False

    # ---------------- scopes ----------------
    def _new_scope(self):
        return {"rs": rs, "Rhino": Rhino, "sc": sc, "doc": sc.doc}

    def _drop_scope(self, session_id):
        try:
            self.scopes.pop(session_id, None)
        except Exception:
            pass
        try:
            if session_id in self.scope_order:
                self.scope_order.remove(session_id)
        except Exception:
            pass

    def _drop_all_scopes(self):
        for key in list(self.scopes.keys()):
            self._drop_scope(key)
        try:
            rs.EnableRedraw(True)
        except Exception:
            pass

    def _trim_scopes(self):
        while len(self.scope_order) > MAX_OPEN_SCOPES:
            oldest = self.scope_order.pop(0)
            try:
                self.scopes.pop(oldest, None)
            except Exception:
                pass

    # ---------------- result delivering ----------------
    def _finish(self, target, success, error):
        with self.lock:
            target.finished = True
            target.success = success
            target.error = error or ""
            target.finished_at = time.time()
            self.last_finished = target
            if self.session is target:
                self.session = target
            _clear_queue(self.step_queue)
            target.event.set()

    # ---------------- main thread side ----------------
    def _rhino_busy(self):
        try:
            if Rhino.RhinoApp.CommandInProgress:
                return True
        except Exception:
            pass
        return False

    def idle_tick(self):
        """Called from the Idle event: execute at most ONE unit of work."""
        try:
            if self.stopped:
                return
            if self._rhino_busy():
                return

            # 1) pending main thread jobs (cleanup, fit) come first
            if self._run_job():
                return

            # 2) live viewport. Frames are captured between steps too, so
            #    the Chrome panel really shows the model growing while a
            #    script runs. VIEWPORT_MIN_INTERVAL keeps the cost low;
            #    while captures are failing we back off to
            #    VIEWPORT_FAIL_INTERVAL but NEVER stop trying (2.6.3).
            if VIEWPORT.wanted:
                interval = VIEWPORT_MIN_INTERVAL
                if VIEWPORT.failures > 0:
                    interval = VIEWPORT_FAIL_INTERVAL
                if (time.time() - VIEWPORT.last_attempt) >= interval:
                    VIEWPORT.capture()

            if self.step_queue.empty():
                return

            try:
                item = self.step_queue.get_nowait()
            except Empty:
                return

            session = None
            with self.lock:
                session = self.session

            if item is None or session is None or session.finished:
                return
            if item.get("session_id") != session.id:
                return
            if session.cancelled:
                self._finish(session, False, "Cancelled by user")
                self._drop_all_scopes()
                return

            step = item.get("step") or {}
            if not step:
                return

            session_id = session.id
            index = step["index"]
            last = index >= session.total

            scope = self.scopes.get(session_id)
            if scope is None or index <= 1:
                scope = self._new_scope()
                self.scopes[session_id] = scope
                if session_id not in self.scope_order:
                    self.scope_order.append(session_id)
                self._trim_scopes()
                if session.before_ids is None:
                    session.before_ids = _doc_object_ids()
                try:
                    rs.EnableRedraw(False)
                except Exception:
                    pass

            # An interactive dialog would freeze Rhino's main thread and the
            # whole bridge with it, so it is refused BEFORE execution.
            blocking = find_blocking_call(step["code"])
            if blocking:
                session.blocked = blocking
                session.failed_step = index
                self._after_run(session)
                try:
                    rs.EnableRedraw(True)
                except Exception:
                    pass
                self._drop_scope(session_id)
                self.last_error = "interactive call: " + blocking
                self._finish(
                    session, False,
                    "Step %d/%d needs %s - interactive dialogs cannot run in live mode. "
                    "Ask the AI for hardcoded values." % (index, session.total, blocking))
                return

            ok = True
            error = ""
            try:
                exec(step["code"], scope)
            except Exception as ex:
                ok = False
                error = str(ex)
            except BaseException as ex:
                ok = False
                error = "Interrupted: " + str(ex)

            if ok and not last and not session.finished and not session.cancelled:
                session.steps_done = index
                try:
                    rs.Redraw()
                except Exception:
                    pass
                VIEWPORT.request()          # keep the live view in sync
                with self.lock:
                    if session.next_index < session.total:
                        session.next_index += 1
                if not session.finished and not session.cancelled:
                    self._schedule_next(session)
                else:
                    self._drop_scope(session_id)
                return

            if ok:
                # last step of the run
                session.steps_done = index
                try:
                    rs.EnableRedraw(True)
                except Exception:
                    pass
                try:
                    rs.Redraw()
                except Exception:
                    pass
                self._drop_scope(session_id)
                self._after_run(session)
                VIEWPORT.request()
                self.jobs += 1
                self._finish(session, True, "")
                return

            # ---------------- failure: repair and retry the step -------
            if session.auto_repair and session.step_repairs < MAX_REPAIRS_PER_STEP:
                fixed, reason = repair_code(step["code"], error)
                if fixed:
                    session.step_repairs += 1
                    session.repairs.append({
                        "step": index,
                        "reason": reason,
                        "error": error[:200],
                    })
                    retry_step = dict(step)
                    retry_step["code"] = fixed
                    self.step_queue.put({"session_id": session.id, "step": retry_step})
                    print("[Rhino Live Bridge] step %d failed (%s) -> %s" %
                          (index, error[:80], reason))
                    return

            session.failed_step = index
            try:
                rs.EnableRedraw(True)
            except Exception:
                pass
            try:
                rs.Redraw()
            except Exception:
                pass
            self._drop_scope(session_id)
            self._after_run(session)
            self.last_error = error
            self._finish(session, False,
                         "Step %d/%d: %s" % (index, session.total, error))

        except BaseException as ex:
            # nothing may escape into Rhino's event loop
            self.last_error = "idle handler: " + str(ex)
            try:
                with self.lock:
                    if self.session is not None and not self.session.finished:
                        self._finish(self.session, False, self.last_error)
            except Exception:
                pass

    # -------------- main thread jobs (2.6.2) --------------
    def _run_job(self):
        """Execute at most one queued main thread job. True when it ran."""
        try:
            job = self.main_jobs.get_nowait()
        except Empty:
            return False
        kind = ""
        try:
            if job:
                kind = job.get("kind") or ""
                if kind == "cleanup":
                    removed = self._delete_objects(job.get("ids") or [])
                    self.cleaned_objects += removed
                elif kind == "fit":
                    self._zoom_extents()
                    VIEWPORT.request()
                elif kind == "redraw":
                    try:
                        rs.Redraw()
                    except Exception:
                        pass
                    VIEWPORT.request()
        except Exception as ex:
            self.last_error = "job %s: %s" % (kind, ex)
        return True

    def _delete_objects(self, ids):
        """Remove the objects a failed run created (used before a retry)."""
        removed = 0
        for guid in ids:
            try:
                if sc.doc.Objects.Delete(_guid(guid), True):
                    removed += 1
            except Exception:
                pass
        try:
            sc.doc.Views.Redraw()
        except Exception:
            pass
        if removed:
            print("[Rhino Live Bridge] retry: removed %d object(s) of the failed run" % removed)
        return removed

    def _zoom_extents(self):
        try:
            rs.Command("_Zoom _Extents", False)
            return True
        except Exception:
            pass
        try:
            rs.ZoomExtents()
            return True
        except Exception:
            pass
        try:
            sc.doc.Views.ActiveView.ActiveViewport.ZoomExtents()
            return True
        except Exception:
            return False

    def _after_run(self, session):
        """Collect the facts the verification report is built from."""
        try:
            session.after_ids = _doc_object_ids()
            created, invalid, checked = check_new_objects(session.before_ids)
            session.objects_created = created
            session.invalid_objects = invalid
            session.checked_objects = checked
        except Exception as ex:
            self.last_error = "verify: " + str(ex)

    def _schedule_next(self, session):
        step = session.current_step()
        if step is None:
            return
        self.step_queue.put({"session_id": session.id, "step": step})

    # ---------------- HTTP side ----------------
    def start_session(self, code, auto_repair=True, auto_clean=True, attempt=1,
                      extra_notes=None):
        with self.lock:
            current = self.session
            if current is not None and not current.finished:
                return {"success": False, "result": "",
                        "error": "Rhino is busy: another script is running. Press Stop first.",
                        "engine": "embedded", "version": VERSION}

            notes = list(extra_notes or [])
            cleaned_code = code
            cleanup = None
            if auto_clean:
                cleanup = clean_code(code)
                cleaned_code = cleanup["code"]
                notes = notes + cleanup["notes"]

            chunk_result = chunk_code(cleaned_code)
            if chunk_result["total"] == 0:
                return {"success": False, "result": "",
                        "error": "Empty code - nothing to run.",
                        "notes": notes, "engine": "embedded", "version": VERSION,
                        "verify": {"ok": False, "available": False, "error": "empty code",
                                   "engine": "embedded", "version": VERSION}}

            session_id = "s%d" % int(time.time() * 1000)
            session = Session(session_id, chunk_result, attempt=attempt,
                              auto_repair=auto_repair, notes=notes,
                              cleaned_code=cleaned_code, orig_code=code)
            self.session = session
            self.last_code = code
            self.step_queue.put({"session_id": session.id, "step": session.steps[0]})
            VIEWPORT.request()

        print("[Rhino Live Bridge] new script: %d lines -> %d step(s)" %
              (session.source_lines, session.total))

        # wait for the main thread to work through the steps
        started = time.time()
        while not session.finished:
            remaining = SESSION_SAFETY_TIMEOUT - (time.time() - started)
            if remaining <= 0:
                session.cancelled = True
                self._finish(session, False, "Script timed out (safety limit reached).")
                self._drop_all_scopes()
                break

            timeout = session.step_timeout()
            if timeout > remaining:
                timeout = remaining
            if not session.event.wait(timeout):
                self._finish(session, False, "Rhino timeout")
                self._drop_all_scopes()
                break
            session.event.clear()

        duration = round(time.time() - started, 2)
        verify = session.verify_payload()

        if session.success:
            result_text = "OK"
            if session.total > 1:
                result_text = "OK - %d steps, %d lines" % (session.total, session.source_lines)
            return {"success": True, "result": result_text, "error": "",
                    "steps": session.total, "duration": duration, "engine": "embedded",
                    "version": VERSION, "notes": session.notes,
                    "attempt": session.attempt, "verify": verify}

        return {"success": False, "result": "", "error": session.error,
                "steps": session.total, "duration": duration, "engine": "embedded",
                "version": VERSION, "notes": session.notes,
                "attempt": session.attempt, "verify": verify}

    def retry(self, code=None, mode="auto"):
        """Re-run the last script: clean up its partial geometry, repair it."""
        with self.lock:
            current = self.session
            if current is not None and not current.finished:
                return {"success": False, "result": "", "error":
                        "Rhino is busy: another script is running. Press Stop first.",
                        "engine": "embedded", "version": VERSION,
                        "retry": {"attempt": 0, "max": MAX_RETRY_ATTEMPTS, "running": True}}

            previous = self.last_finished
            if previous is None and not code:
                return {"success": False, "result": "",
                        "error": "Nothing to retry yet - run a script first.",
                        "engine": "embedded", "version": VERSION,
                        "retry": {"attempt": 0, "max": MAX_RETRY_ATTEMPTS, "exhausted": True}}

            if previous is not None and previous.blocked:
                payload = previous.verify_payload()
                payload["retryable"] = False
                return {"success": False, "result": "", "verify": payload,
                        "error": "This script needs %s; retrying cannot fix an "
                                 "interactive dialog." % previous.blocked,
                        "engine": "embedded", "version": VERSION,
                        "retry": {"attempt": previous.attempt, "max": MAX_RETRY_ATTEMPTS,
                                  "exhausted": True}}

            if previous is not None and previous.attempt >= MAX_RETRY_ATTEMPTS:
                payload = previous.verify_payload()
                payload["retryable"] = False
                payload["exhausted"] = True
                return {"success": False, "result": "",
                        "error": previous.error or "retry limit reached",
                        "verify": payload, "engine": "embedded", "version": VERSION,
                        "retry": {"attempt": previous.attempt, "max": MAX_RETRY_ATTEMPTS,
                                  "exhausted": True}}

            source = code or (previous.cleaned_code if previous is not None else "")
            if not source and previous is not None:
                source = previous.orig_code

            attempt = (previous.attempt if previous is not None else 0) + 1
            repair_log = []
            error = previous.error if previous is not None else ""
            if previous is not None and mode != "off":
                fixed, reason = repair_code(source, error)
                if fixed:
                    source = fixed
                    repair_log.append(reason)

            cleanup = previous.cleanup_ids() if previous is not None else []
            if cleanup:
                self.main_jobs.put({"kind": "cleanup", "ids": cleanup})

        print("[Rhino Live Bridge] retry %d/%d (%d object(s) to clean, %d repair(s))" %
              (attempt, MAX_RETRY_ATTEMPTS, len(cleanup), len(repair_log)))

        result = self.start_session(source, auto_repair=True,
                                    auto_clean=(mode == "auto"),
                                    attempt=attempt, extra_notes=repair_log)
        result["retry"] = {
            "attempt": attempt,
            "max": MAX_RETRY_ATTEMPTS,
            "repair": repair_log,
            "cleaned_objects": len(cleanup),
            "exhausted": False,
        }
        return result

    def verify_report(self, session_id=None):
        with self.lock:
            current = self.session
            target = None
            if session_id:
                if current is not None and current.id == session_id:
                    target = current
                elif self.last_finished is not None and self.last_finished.id == session_id:
                    target = self.last_finished
            if target is None:
                if current is not None and not current.finished:
                    target = current
                elif self.last_finished is not None:
                    target = self.last_finished
            if target is None:
                return {"ok": False, "available": False, "note": "no run yet",
                        "engine": "embedded", "version": VERSION}
            payload = target.verify_payload()
            payload["available"] = True
            return payload

    def cancel(self):
        with self.lock:
            current = self.session
            if current is None or current.finished:
                return {"cancelled": False}
            current.cancelled = True
            _clear_queue(self.step_queue)
            self._drop_all_scopes()
            self._finish(current, False, "Cancelled by user")
            return {"cancelled": True, "session_id": current.id}

    def progress(self):
        with self.lock:
            current = self.session
            if current is not None and not current.finished:
                return current.progress_payload()
            if self.last_finished is not None:
                payload = self.last_finished.progress_payload()
                payload["active"] = False
                return payload
        return {"active": False, "step": 0, "total": 0, "success": None, "error": "",
                "engine": "embedded"}

    def status(self):
        with self.lock:
            busy = bool(self.session is not None and not self.session.finished)
            last_ok = None
            last_attempt = 0
            if self.last_finished is not None:
                last_ok = bool(self.last_finished.success)
                last_attempt = self.last_finished.attempt
            return {
                "server": "running",
                "rhino_connected": True,
                "rhino_seen": True,
                "busy": busy,
                "session_active": busy,
                "engine": "embedded",
                "version": VERSION,
                "designer": DESIGNER,
                "jobs": self.jobs,
                "last_error": self.last_error,
                "idle_hooked": self.idle_hooked,
                "cleaned_objects": self.cleaned_objects,
                "last_ok": last_ok,
                "last_attempt": last_attempt,
                "max_attempts": MAX_RETRY_ATTEMPTS,
                "viewport": VIEWPORT.status(),
                "capabilities": ["progress", "cancel", "viewport", "verify", "retry",
                                 "cleanup", "auto_repair"],
            }


def _clear_queue(queue):
    while not queue.empty():
        try:
            queue.get_nowait()
        except Empty:
            break


BRIDGE = Bridge()


# ==================================================================
# 4) REQUEST ROUTER
# ==================================================================
def handle_request(request):
    """Return (status, payload_dict)."""
    method = request.method
    path = request.path.rstrip("/")
    if path == "":
        path = "/"

    if method == "OPTIONS":
        return 204, ""

    def json_body():
        if not request.body_text:
            return {}
        try:
            data = json.loads(request.body_text)
            if isinstance(data, dict):
                return data
            return {}
        except Exception:
            return {}

    if path == "/status" and method == "GET":
        return 200, BRIDGE.status()

    if path == "/command" and method == "POST":
        body = json_body()
        code = body.get("code") or ""
        auto_repair = body.get("auto_repair")
        auto_clean = body.get("auto_clean")
        return 200, BRIDGE.start_session(
            code,
            auto_repair=(True if auto_repair is None else bool(auto_repair)),
            auto_clean=(True if auto_clean is None else bool(auto_clean)))

    if path == "/progress" and method == "GET":
        return 200, BRIDGE.progress()

    if path == "/cancel" and method == "POST":
        return 200, BRIDGE.cancel()

    # ---------------- 2.6.2: live viewport ----------------
    if path == "/viewport" and method == "GET":
        return 200, VIEWPORT.frame(
            rev=_query_int(request.query, "rev", 0),
            width=_query_int(request.query, "w", 0),
            wait=_query_float(request.query, "wait", VIEWPORT_WAIT_DEFAULT))

    if path == "/viewport" and method == "POST":
        body = json_body()
        action = str(body.get("action") or "capture").lower()
        if action == "fit":
            BRIDGE.main_jobs.put({"kind": "fit"})
        width = 0
        try:
            width = int(body.get("width") or 0)
        except Exception:
            width = 0
        rev = 0
        try:
            rev = int(body.get("rev") or 0)
        except Exception:
            rev = 0
        return 200, VIEWPORT.frame(rev=rev, width=width,
                                   wait=VIEWPORT_WAIT_DEFAULT,
                                   force=(action in ("fit", "capture")))

    # ---------------- 2.6.2: verification loop ----------------
    if path == "/verify" and method == "GET":
        return 200, BRIDGE.verify_report(_query_value(request.query, "session_id", "") or None)

    if path == "/retry" and method == "POST":
        body = json_body()
        return 200, BRIDGE.retry(body.get("code") or None,
                                 str(body.get("mode") or "auto"))

    # compatibility shims: in embedded mode the bridge already IS the worker
    if path == "/get_task" and method == "GET":
        return 200, {"has_task": False, "embedded": True,
                     "note": "the bridge runs inside Rhino; no external worker needed"}

    if path == "/send_result" and method == "POST":
        return 200, {"ok": True, "embedded": True}

    return 404, {"error": "unknown endpoint", "path": path}


# ==================================================================
# 5) SERVER THREAD
# ==================================================================
class Server(object):
    def __init__(self):
        self.listener = None
        self.thread = None
        self.running = False
        self.connections = 0

    def start(self):
        listener = _make_listener(HOST, PORT)
        listener.Start(BACKLOG)
        self.listener = listener
        self.running = True
        self.thread = threading.Thread(target=self._accept_loop)
        self.thread.setDaemon(True)
        self.thread.start()

    def _accept_loop(self):
        while self.running:
            try:
                client = self.listener.AcceptTcpClient()
            except Exception:
                if not self.running:
                    break
                time.sleep(0.2)
                continue

            try:
                worker = threading.Thread(target=self._serve, args=(client,))
                worker.setDaemon(True)
                worker.start()
            except Exception:
                try:
                    client.Close()
                except Exception:
                    pass

    def _serve(self, client):
        self.connections += 1
        connection = None
        try:
            try:
                client.ReceiveTimeout = HTTP_READ_TIMEOUT_MS
            except Exception:
                pass

            connection = HttpConnection(client)
            try:
                connection.stream.ReadTimeout = HTTP_READ_TIMEOUT_MS
            except Exception:
                pass

            request = connection.read_request()
            if request is None:
                return

            status, payload = handle_request(request)
            if payload == "":
                connection.write_response(status, "")
            else:
                connection.write_response(status, json.dumps(payload))
        except Exception as ex:
            try:
                if connection is not None:
                    connection.write_response(
                        500, json.dumps({"error": "bridge internal error: " + str(ex)}))
            except Exception:
                pass
        finally:
            if connection is not None:
                connection.close()
            else:
                try:
                    client.Close()
                except Exception:
                    pass

    def stop(self):
        self.running = False
        try:
            self.listener.Stop()
        except Exception:
            pass


SERVER = Server()


# ==================================================================
# 6) MAIN THREAD HOOK
# ==================================================================
def rhino_idle_handler(sender, args):
    BRIDGE.idle_tick()


_idle_handler = rhino_idle_handler


def hook_idle():
    if BRIDGE.idle_hooked:
        return True
    try:
        Rhino.RhinoApp.Idle += _idle_handler
        BRIDGE.idle_hooked = True
        return True
    except Exception as ex:
        print("[Rhino Live Bridge] could not hook the Idle event: " + str(ex))
        return False


def unhook_idle():
    if not BRIDGE.idle_hooked:
        return
    try:
        Rhino.RhinoApp.Idle -= _idle_handler
    except Exception:
        pass
    BRIDGE.idle_hooked = False


# ==================================================================
# 7) LIFECYCLE
# ==================================================================
def stop_bridge(silent=False):
    BRIDGE.stopped = True
    try:
        BRIDGE.cancel()
    except Exception:
        pass
    SERVER.stop()
    unhook_idle()
    BRIDGE._drop_all_scopes()
    try:
        Rhino.RhinoApp.RemoveAlias("RhinoLiveBridgeStop")
    except Exception:
        pass
    if not silent:
        print("[Rhino Live Bridge] stopped. Run the script again (or RhinoLiveBridge) to restart.")


def register_aliases(script_path):
    try:
        Rhino.RhinoApp.AddAlias(
            "RhinoLiveBridge",
            '_-RunPythonScript "%s"' % script_path)
    except Exception:
        pass
    try:
        Rhino.RhinoApp.AddAlias(
            "RhinoLiveBridgeStop",
            '_-RunPythonScript "%s" --stop' % script_path)
    except Exception:
        pass


def _script_path():
    try:
        return __file__
    except NameError:
        return "RhinoLiveBridge.py"


def main():
    argv = []
    try:
        argv = sys.argv
    except Exception:
        pass

    if "--stop" in argv:
        stop_bridge()
        return

    # already running? do not start a second server
    if SERVER.running:
        print("[Rhino Live Bridge] already running on %s:%d" % (HOST, PORT))
        return

    print("")
    print("=================================================================")
    print("  RHINO LIVE BRIDGE  v" + VERSION + "  (self contained)")
    print("  Designer: " + DESIGNER)
    print("-----------------------------------------------------------------")
    print("  HTTP bridge  : http://%s:%d   (inside Rhino, no extra app)" % (HOST, PORT))
    print("  Engine       : " + sys.version.split("\n")[0])
    print("  Execution    : Rhino main thread (Idle), one step per tick")
    print("  Live view    : /viewport  (JPEG frames of the active view)")
    print("  Verification : /verify + automatic repair + /retry loop")
    print("  Stop command : RhinoLiveBridgeStop")
    print("=================================================================")

    if not hook_idle():
        print("  ERROR: the main thread hook could not be installed.")
        print("  Please run this script again from EditPythonScript.")
        print("")
        return

    try:
        SERVER.start()
    except Exception as ex:
        print("  ERROR: could not listen on port %d: %s" % (PORT, ex))
        print("  Is another bridge (start_server.bat or a second Rhino) running?")
        print("")
        return

    register_aliases(_script_path())

    print("  Ready. Keep Rhino open - the Chrome extension finds the")
    print("  bridge automatically at http://%s:%d" % (HOST, PORT))
    print("=================================================================")
    print("")


main()
