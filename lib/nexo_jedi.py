"""Tiny JSON-lines server around jedi, used by Nexo for Python IntelliSense."""
import json
import sys

try:
    import jedi
except ImportError:
    sys.stdout.write(json.dumps({"id": 0, "error": "no-jedi"}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

root = sys.argv[1] if len(sys.argv) > 1 else "."
project = jedi.Project(path=root)


def script(req):
    return jedi.Script(code=req["source"], path=req.get("path") or None, project=project)


def op_complete(req):
    out = []
    for c in script(req).complete(req["line"], req["col"] - 1)[:200]:
        out.append({"label": c.name, "kind": c.type, "detail": c.description, "sig": _sig(c)})
    return out


def _sig(c):
    try:
        sigs = c.get_signatures()
        return sigs[0].to_string() if sigs else ""
    except Exception:
        return ""


def op_hover(req):
    names = script(req).help(req["line"], req["col"] - 1)
    if not names:
        return None
    n = names[0]
    doc = (n.docstring(raw=True) or "")[:2000]
    return {"name": n.full_name or n.name, "type": n.type, "sig": _sig(n), "doc": doc}


def op_define(req):
    out = []
    for d in script(req).goto(req["line"], req["col"] - 1, follow_imports=True, follow_builtin_imports=False):
        if d.module_path:
            out.append({"path": str(d.module_path), "line": d.line, "col": d.column + 1})
    return out


def op_signature(req):
    out = []
    for s in script(req).get_signatures(req["line"], req["col"] - 1):
        out.append({"label": s.to_string(), "params": [p.to_string() for p in s.params], "active": s.index or 0})
    return out


OPS = {"complete": op_complete, "hover": op_hover, "define": op_define, "signature": op_signature}

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        req = json.loads(raw)
        res = {"id": req["id"], "result": OPS[req["op"]](req)}
    except Exception as e:  # keep the server alive on any jedi error
        res = {"id": req.get("id") if isinstance(req, dict) else None, "result": None, "error": str(e)}
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
