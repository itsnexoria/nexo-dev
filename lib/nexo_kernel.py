"""Minimal persistent Python kernel for Nexo notebooks (JSON lines over stdio)."""
import ast
import base64
import contextlib
import io
import json
import os
import sys
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")
_out = sys.stdout
_G = {"__name__": "__main__", "__builtins__": __builtins__}
_count = 0


def emit(obj):
    _out.write("\x01NEXO:" + json.dumps(obj) + "\n")
    _out.flush()


def figures():
    plt = sys.modules.get("matplotlib.pyplot")
    imgs = []
    if plt is None:
        return imgs
    for n in plt.get_fignums():
        fig = plt.figure(n)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        imgs.append(base64.b64encode(buf.getvalue()).decode())
        plt.close(fig)
    return imgs


def run(code):
    global _count
    _count += 1
    outputs = []
    so, se = io.StringIO(), io.StringIO()
    result = None
    err = None
    try:
        tree = ast.parse(code, mode="exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
            exec(compile(tree, "<cell>", "exec"), _G)
            if last is not None:
                result = eval(compile(last, "<cell>", "eval"), _G)
    except (Exception, SystemExit) as e:
        tb = e.__traceback__.tb_next if e.__traceback__ is not None and not isinstance(e, SyntaxError) else e.__traceback__
        err = {
            "output_type": "error",
            "ename": type(e).__name__,
            "evalue": str(e),
            "traceback": "".join(traceback.format_exception(type(e), e, tb)).splitlines(),
        }
    if so.getvalue():
        outputs.append({"output_type": "stream", "name": "stdout", "text": so.getvalue()})
    if se.getvalue():
        outputs.append({"output_type": "stream", "name": "stderr", "text": se.getvalue()})
    if result is not None:
        _G["_"] = result
        data = {"text/plain": repr(result)}
        html = getattr(result, "_repr_html_", None)
        if callable(html):
            try:
                data["text/html"] = html()
            except Exception:
                pass
        outputs.append({"output_type": "execute_result", "data": data, "metadata": {}, "execution_count": _count})
    try:
        for b64 in figures():
            outputs.append({"output_type": "display_data", "data": {"image/png": b64, "text/plain": "<Figure>"}, "metadata": {}})
    except Exception:
        pass
    if err:
        outputs.append(err)
    return {"outputs": outputs, "count": _count}


sys.stdin = io.StringIO("")  # input() raises EOFError instead of hanging
sys.path.insert(0, os.getcwd())
emit({"ready": True})
for raw in sys.__stdin__:
    raw = raw.strip()
    if not raw:
        continue
    req = json.loads(raw)
    res = run(req["code"])
    res["id"] = req["id"]
    emit(res)
