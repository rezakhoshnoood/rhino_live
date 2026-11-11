# -*- coding: utf-8 -*-
"""
================================================================
 RHINO LIVE BRIDGE - SMART CODE CHUNKER
 Version: 2.6.4
 Designer: Reza Khoshnood
================================================================

 WHY THIS EXISTS
 ---------------
 Executing a long AI-generated script in one single exec() call can
 freeze or crash Rhino: one long blocking call, thousands of geometry
 operations with no chance to redraw, and no way for the user to stop
 halfway.

 This module splits a script into SMALL LOGICAL STEPS that are executed
 one after another. Every step is a syntactically complete piece of
 Python, so the model is built gradually and Rhino stays responsive.

 SPLITTING RULES (a step may never break Python syntax):
   * a step boundary is only ever placed between TOP-LEVEL statements
   * multi-line statements are kept whole:
       - open brackets ( , [ , {           -> stay inside one step
       - line continuation with a backslash-> stays inside one step
       - triple quoted strings             -> stay inside one step
   * compound statements keep their whole body:
       def / class / if / for / while / try / with   + everything indented
   * clause chains stay together:  if/elif/else, try/except/finally
   * decorators (@deco) stay attached to the def/class they decorate
   * banner comments and blank lines stay attached to the statement below
   * small consecutive statements are grouped together (up to max_lines /
     max_chars) so short scripts still need only one or two round trips
   * defaults: 25 lines / 1500 characters per step - small enough that
     Rhino never runs a long blocking chunk, large enough that a normal
     script needs just a couple of steps

 GUARANTEE (tested):
   "".join(step["code"] for step in steps) == result["normalized"]

   (result["normalized"] is the input after CRLF normalisation and
    removal of a wrapping ```python fence)

   The split is a pure partition of the source lines, therefore running
   the steps in order is exactly equivalent to running the whole script.
================================================================
"""

import re

# A line that opens an indented block (compound statement header).
BLOCK_OPEN_RE = re.compile(
    r"^\s*(def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b"
)

# A continuation clause of a compound statement. These may NEVER start a step.
CLAUSE_RE = re.compile(r"^(elif|else|except|finally|case)\b")

# Import lines (used only for labelling steps in the UI).
IMPORT_RE = re.compile(r"^\s*(import|from)\s")

CONTINUATION_RE = re.compile(r"\\\s*$")

FENCE_RE = re.compile(r"^\s*```")

DEFAULT_MAX_LINES = 25
DEFAULT_MAX_CHARS = 1500


# ------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------
def _indent_of(line):
    return len(line) - len(line.lstrip(" \t"))


def _is_blank(line):
    return line.strip() == ""


def _is_comment(line):
    return line.lstrip().startswith("#")


def _ends_with_continuation(line):
    return bool(CONTINUATION_RE.search(line))


def _strip_fences(code):
    """Remove a wrapping ```python ... ``` fence if the AI included one."""
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
    """Return the index of the last line of the logical line starting at i.

    Consumes continuation lines while brackets are open, a backslash
    continuation is present, or a triple-quoted string is still open.
    """
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
                break  # comment runs to the end of the line

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
    """True when the logical line [start..end] is a compound statement header."""
    text = lines[end].strip()
    # drop a trailing comment
    if "#" in text:
        text = text.split("#", 1)[0].strip()
    if not text.endswith(":"):
        return False
    joined = " ".join(lines[start:end + 1]).strip()
    if not BLOCK_OPEN_RE.match(joined):
        return False
    return True


def _scan_suite(lines, k, n, base_indent):
    """Return the last line index of the indented suite plus its clauses."""
    last = k - 1

    # ---- indented body ----
    while k < n:
        line = lines[k]
        if _is_blank(line):
            k += 1
            continue
        if _indent_of(line) <= base_indent:
            break
        k = _scan_unit_from(lines, k, n) + 1
        last = k - 1

    # ---- else / elif / except / finally chains ----
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
    """Return the last line index of one complete top-level unit starting at i.

    A unit = banner comments + decorators + one top-level statement
    (including its whole indented body and any clause chain).
    """
    # banner: blank lines and comments belong to the statement below
    while i < n and (_is_blank(lines[i]) or _is_comment(lines[i])):
        i += 1
    if i >= n:
        return n - 1

    # decorators
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
    """Label a step for the UI: import / block / statement / comment."""
    first_code = None
    for t in range(start, end + 1):
        if not _is_blank(lines[t]) and not _is_comment(lines[t]):
            first_code = t
            break

    if first_code is None:
        return "comment"
    if IMPORT_RE.match(lines[first_code]):
        return "import"

    # does this step contain a compound statement header at its own level?
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
    """Split Rhino Python code into ordered, syntax-safe execution steps.

    Returns:
        {
          "steps": [ {index, code, kind, start_line, end_line, lines, chars, large}, ... ],
          "total": int,
          "original_lines": int,
          "split": bool,          # False when a single step covers everything
          "truncated": bool       # True when a step had to stay bigger than max_chars
        }
    """
    if code is None:
        code = ""

    cleaned = _strip_fences(code.replace("\r\n", "\n").replace("\r", "\n"))
    lines = cleaned.split("\n")
    n = len(lines)

    if cleaned.strip() == "":
        return {"steps": [], "total": 0, "original_lines": n, "split": False,
                "truncated": False, "normalized": ""}

    # ---- 1) cut the source into complete top-level units ----
    units = []
    i = 0
    while i < n:
        end = _scan_unit_from(lines, i, n)
        if end < i:
            end = i
        units.append((i, end))
        i = end + 1

    # ---- 2) group small consecutive units into one step ----
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

    # ---- 3) safety net: a step must never START with a clause keyword ----
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

    # ---- 4) build the step list ----
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
        # the source after CRLF normalisation and markdown-fence removal;
        # "".join(step["code"]) always equals this string exactly
        "normalized": cleaned,
    }


# ------------------------------------------------------------------
# quick self-check when run directly:  python chunker.py file.py
# ------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        with open(sys.argv[1], "r") as handle:
            source = handle.read()
    else:
        source = (
            "import rhinoscriptsyntax as rs\n"
            "import Rhino\n"
            "import math\n"
            "\n"
            "# build a tower\n"
            "def add_floor(z, size):\n"
            "    pts = [[0, 0, z], [size, 0, z], [size, size, z], [0, size, z]]\n"
            "    curve = rs.AddPolyline(pts + [pts[0]])\n"
            "    if curve:\n"
            "        return rs.AddPlanarSrf([curve])\n"
            "    else:\n"
            "        return None\n"
            "\n"
            "for level in range(12):\n"
            "    surf = add_floor(level * 3.0, 20.0 - level)\n"
            "    try:\n"
            "        rs.ObjectColor(surf, (255 - level * 10, 120, 200))\n"
            "    except Exception:\n"
            "        pass\n"
        )

    result = chunk_code(source)
    print("steps      :", result["total"])
    print("split      :", result["split"])
    print("lines      :", result["original_lines"])
    print("")
    for step in result["steps"]:
        print("--- step %d/%d  (%s, lines %d-%d, %d chars) ---" % (
            step["index"], result["total"], step["kind"],
            step["start_line"], step["end_line"], step["chars"]))
        print(step["code"])

    joined = "".join(s["code"] for s in result["steps"])
    print("")
    print("PARTITION INVARIANT (join == original):", joined == source)
