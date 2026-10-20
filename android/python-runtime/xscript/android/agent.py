"""Goal-driven screen agent: screenshot -> vision model -> one allowed action, repeated.

    from xscript.android import ai, agent
    ai.config(BASE_URL, model="qwen2.5-vl-7b")
    res = agent.run("打开设置并进入 WLAN 页面", max_steps=15)
    res.status   # "done" | "failed" | "max_steps" | "timeout" | "aborted"

Uses the endpoint chosen with ai.config(). Each step sends the goal, the recent
history and a fresh screenshot; the model answers with one JSON action. Only
actions in `actions` run (default: click, long_click, swipe, back, wait);
"done" and "fail" are always allowed. Coordinates are checked against the
captured area before anything is touched. Stop it from another thread or a
UI callback with Agent.stop() / agent.stop_all(); the current step finishes
and no further action runs. Every step makes exactly one model request, so
max_steps also caps what a run can cost. log=True prints one line per step.
"""
import json
import threading
import time

from xscript.android import ai

__all__ = ["Agent", "AgentResult", "run", "stop_all", "ACTIONS", "DEFAULT_ACTIONS"]

ACTIONS = ("click", "long_click", "swipe", "input", "back", "home", "recents", "wait")
DEFAULT_ACTIONS = ("click", "long_click", "swipe", "back", "wait")
_ALWAYS = ("done", "fail")
MAX_WAIT = 10.0
MAX_INPUT = 500

SYSTEM = (
    "You operate an Android phone to reach a goal. Each turn you get the goal, the steps so far "
    "and a screenshot that is {w}x{h} pixels. Reply with JSON only, exactly one action:\n"
    "{actions}\n"
    'Always add "reason": "<short why>". Coordinates are screenshot pixels. '
    'Reply {{"action": "done", "message": "..."}} when the goal is reached and '
    '{{"action": "fail", "message": "..."}} when it cannot be reached.')
_SHAPES = {
    "click": '{"action": "click", "x": 0, "y": 0}',
    "long_click": '{"action": "long_click", "x": 0, "y": 0}',
    "swipe": '{"action": "swipe", "x1": 0, "y1": 0, "x2": 0, "y2": 0}',
    "input": '{"action": "input", "text": "..."}  (types into the focused field)',
    "back": '{"action": "back"}', "home": '{"action": "home"}', "recents": '{"action": "recents"}',
    "wait": '{"action": "wait", "seconds": 1}',
    "done": '{"action": "done", "message": "..."}', "fail": '{"action": "fail", "message": "..."}',
}

_live = set()
_live_lock = threading.Lock()


class AgentResult:
    """status, message, steps (list of dicts: step, action, reason, ok, error)."""

    def __init__(self, status, message, steps):
        self.status, self.message, self.steps = status, message, steps

    @property
    def ok(self):
        return self.status == "done"

    def __repr__(self):
        return "AgentResult(status=%r, steps=%d, message=%r)" % (self.status, len(self.steps), self.message)


class Agent:
    def __init__(self, goal, max_steps=20, actions=DEFAULT_ACTIONS, timeout=300, settle=1.0,
                 max_invalid=3, history=8, rect=None, on_step=None, capture=None, dry_run=False, log=True):
        if not isinstance(goal, str) or not goal.strip():
            raise ValueError("goal must be a nonempty string")
        if isinstance(max_steps, bool) or int(max_steps) != max_steps or not 1 <= max_steps <= 200:
            raise ValueError("max_steps must be an integer from 1 to 200")
        bad = [a for a in actions if a not in ACTIONS]
        if bad:
            raise ValueError("unknown actions: %s (allowed: %s)" % (", ".join(map(str, bad)), ", ".join(ACTIONS)))
        if timeout <= 0 or settle < 0 or max_invalid < 1 or history < 0:
            raise ValueError("timeout, settle, max_invalid and history must be positive")
        self.goal, self.max_steps, self.timeout, self.settle = goal.strip(), int(max_steps), float(timeout), float(settle)
        self.actions = tuple(dict.fromkeys(actions)) + _ALWAYS
        self.max_invalid, self.history, self.rect = int(max_invalid), int(history), rect
        self.on_step, self.capture, self.dry_run, self.log = on_step, capture, bool(dry_run), bool(log)
        self._stop = threading.Event()
        self.steps = []

    def stop(self):
        """Ask the loop to end after the current step; no further action is performed."""
        self._stop.set()

    @property
    def stopped(self):
        return self._stop.is_set()

    def _prompt(self, frame):
        lines = ["Goal: " + self.goal]
        recent = self.steps[-self.history:] if self.history else []
        if recent:
            lines.append("Steps so far:")
            for s in recent:
                lines.append("%d. %s%s" % (s["step"], json.dumps(s["action"], ensure_ascii=False),
                                           "" if s["ok"] else " -> rejected: " + s["error"]))
        lines.append("Reply with the next action as JSON.")
        return "\n".join(lines)

    def _decide(self, cfg):
        image = self.capture() if self.capture else None
        frame = ai._frame(image, self.rect, cfg)
        system = SYSTEM.format(w=frame.net_w, h=frame.net_h,
                               actions="\n".join(_SHAPES[a] for a in self.actions))
        reply = ai._chat(cfg, ai._message(frame, self._prompt(frame), system), cfg["json_mode"])
        payload = ai._json_payload(reply)
        if isinstance(payload, list) and payload:
            payload = payload[0]
        if not isinstance(payload, dict):
            raise ValueError("reply must be one JSON object")
        return payload, frame

    @staticmethod
    def _num(cmd, key):
        v = cmd.get(key)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
            raise ValueError("%s must be a number" % key)
        return float(v)

    def _point(self, cmd, frame, cfg, kx, ky):
        x, y = self._num(cmd, kx), self._num(cmd, ky)
        coords = cfg["coords"]
        if coords == "auto":
            coords = "ratio" if abs(x) <= 1 and abs(y) <= 1 else "pixel"
        if coords == "ratio":
            x, y = x * frame.net_w, y * frame.net_h
        elif coords == "norm1000":
            x, y = x * frame.net_w / 1000, y * frame.net_h / 1000
        if not (0 <= x <= frame.net_w and 0 <= y <= frame.net_h):
            raise ValueError("point (%g, %g) is outside the %dx%d screenshot" % (x, y, frame.net_w, frame.net_h))
        return frame.to_screen(x, y)

    def _plan(self, cmd, frame, cfg):
        """Validate one model action; returns (name, call args) or raises ValueError."""
        name = cmd.get("action")
        if name not in self.actions:
            raise ValueError("action %r is not allowed (allowed: %s)" % (name, ", ".join(self.actions)))
        if name in ("click", "long_click"):
            return name, self._point(cmd, frame, cfg, "x", "y")
        if name == "swipe":
            return name, self._point(cmd, frame, cfg, "x1", "y1") + self._point(cmd, frame, cfg, "x2", "y2")
        if name == "input":
            text = cmd.get("text")
            if not isinstance(text, str) or not text or len(text) > MAX_INPUT:
                raise ValueError("input text must be 1..%d characters" % MAX_INPUT)
            return name, (text,)
        if name == "wait":
            seconds = self._num(cmd, "seconds") if "seconds" in cmd else 1.0
            return name, (max(0.0, min(MAX_WAIT, seconds)),)
        return name, ()

    def _perform(self, name, args):
        if self.dry_run or name in _ALWAYS:
            return
        if name == "wait":
            self._stop.wait(args[0])
            return
        from xscript.android import action
        fn = {"click": action.click, "long_click": action.long_click, "input": action.input,
              "swipe": lambda *a: action.swipe(*a), "back": action.back, "home": action.home,
              "recents": action.recents}[name]
        fn(*args)

    def run(self):
        cfg = ai._require()
        with _live_lock:
            _live.add(self)
        try:
            return self._loop(cfg)
        finally:
            with _live_lock:
                _live.discard(self)

    def _finish(self, status, message):
        return AgentResult(status, message, list(self.steps))

    def _loop(self, cfg):
        deadline = time.monotonic() + self.timeout
        invalid = 0
        for n in range(1, self.max_steps + 1):
            if self._stop.is_set():
                return self._finish("aborted", "stopped by request")
            if time.monotonic() >= deadline:
                return self._finish("timeout", "no result within %gs" % self.timeout)
            record = dict(step=n, action=None, reason="", ok=False, error="")
            try:
                cmd, frame = self._decide(cfg)
                record["action"] = {k: v for k, v in cmd.items() if k != "reason"}
                record["reason"] = str(cmd.get("reason", ""))[:200]
                name, args = self._plan(cmd, frame, cfg)
            except (ValueError, ai.AiError) as exc:
                if isinstance(exc, ai.AiError) and exc.status is not None and exc.status != 429 \
                        and exc.status < 500:
                    raise  # auth or request errors will not fix themselves
                record["error"] = str(exc)[:200]
                self._emit(record)
                invalid += 1
                if invalid >= self.max_invalid:
                    return self._finish("failed", "too many invalid replies: " + record["error"])
                continue
            invalid = 0
            if self._stop.is_set():  # stop pressed while the model was thinking
                record["error"] = "stopped before acting"
                self._emit(record)
                return self._finish("aborted", "stopped by request")
            self._perform(name, args)
            record["ok"] = True
            self._emit(record)
            if name == "done":
                return self._finish("done", str(cmd.get("message", "")))
            if name == "fail":
                return self._finish("failed", str(cmd.get("message", "")))
            if name != "wait" and self.settle:
                self._stop.wait(self.settle)
        return self._finish("max_steps", "goal not reached in %d steps" % self.max_steps)

    def _emit(self, record):
        self.steps.append(record)
        if self.log:
            act = json.dumps(record["action"], ensure_ascii=False) if record["action"] else "-"
            print("[agent] %d/%d %s %s%s" % (record["step"], self.max_steps, act,
                                             "ok" if record["ok"] else "rejected: " + record["error"],
                                             " (" + record["reason"] + ")" if record["reason"] else ""))
        if self.on_step:
            self.on_step(dict(record))


def run(goal, max_steps=20, actions=DEFAULT_ACTIONS, timeout=300, settle=1.0, max_invalid=3,
        history=8, rect=None, on_step=None, capture=None, dry_run=False, log=True):
    """Run an Agent to completion and return its AgentResult (see Agent for the arguments)."""
    return Agent(goal, max_steps, actions, timeout, settle, max_invalid, history, rect, on_step,
                 capture, dry_run, log).run()


def stop_all():
    """Stop every running agent (e.g. from a floating-window button)."""
    with _live_lock:
        agents = list(_live)
    for a in agents:
        a.stop()
    return len(agents)
