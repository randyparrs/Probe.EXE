"""Real-LLM stand-in for GenVM's LLM module, for gltest direct mode.

gltest direct mode answers `ExecPrompt` from mocks (or `vm._live_llm_handler`) and has no
handler at all for `ExecPromptTemplate`, the request `prompt_comparative` and
`prompt_non_comparative` send. This module answers both with a real model through OpenRouter,
reproducing what GenVM does with them. Source of truth, genvm@abb71bf (copies in
reference/genvm/):

  ExecPrompt           genvm-llm-default.lua ExecPrompt + lib-llm.lua exec_prompt_transform
                       prompt filtered NFKC -> RmZeroWidth -> NormalizeWS (filters.rs), empty ->
                       EMPTY_PROMPT; temperature 0.7, max_tokens 8000; "json" adds the system
                       message "respond with a valid json object" and response_format json_object.
  ExecPromptTemplate   lib-llm.lua exec_prompt_template_transform: the eq_* templates of
                       genvm-module-llm.yaml, `#{key}` substitution, temperature 0.7,
                       max_tokens 1000. EqComparative and EqNonComparativeValidator use the
                       "bool" format: JSON mode, then the "result" key; a missing or non-bool
                       "result" is False (providers.rs exec_prompt_bool_reason).
  JSON answers         fences stripped and parsed (providers.rs sanitize_json_str), re-serialized.
                       GenVM also completes truncated JSON (complete_json); not reproduced.

The release Studio Next runs, genvm-manager v0.6.0-rc6 (copies in
reference/genvm-manager-v0.6.0-rc6/), has the same templates and the same prompt transforms
(temperature, max_tokens, system message); it differs in provider selection (llm_policy) and in
charging tokens as gas.

Not reproduced: a node's provider list and fallback order (one model per role here), the gas
policy, images.
"""

import json
import os
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

import yaml

REFERENCE = Path(__file__).resolve().parent.parent / "reference" / "genvm"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct"

TEMPERATURE = 0.7
MAX_TOKENS_PROMPT = 8000
MAX_TOKENS_TEMPLATE = 1000
JSON_SYSTEM_MESSAGE = "respond with a valid json object"

# lib-llm.lua exec_prompt_template_transform
TEMPLATES = {
    "EqComparative": ("eq_comparative", "bool"),
    "EqNonComparativeValidator": ("eq_non_comparative_validator", "bool"),
    "EqNonComparativeLeader": ("eq_non_comparative_leader", "text"),
}

RETRY_STATUSES = {408, 429, 500, 502, 503, 504}


def _load_templates() -> dict:
    with open(REFERENCE / "genvm-module-llm.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)["prompt_templates"]


def _normalize_ws(text: str) -> str:
    """filters.rs normalize_whitespace."""
    out = []
    spaces = newlines = 0
    for ch in text:
        if ch == "\n":
            if not out:
                continue
            while out and out[-1] == " ":
                out.pop()
            newlines += 1
            spaces = 0
            if newlines <= 2:
                out.append("\n")
        elif ch.isspace():
            if out and out[-1] != "\n":
                spaces += 1
                newlines = 0
                if spaces == 1:
                    out.append(" ")
        else:
            spaces = newlines = 0
            out.append(ch)
    while out and out[-1] == " ":
        out.pop()
    return "".join(out)


def _rm_zero_width(text: str) -> str:
    """filters.rs RmZeroWidth: keeps ' ' and '\\n', drops characters with no or zero display
    width (control characters, tabs included; combining marks; format characters)."""
    return "".join(
        c for c in text
        if c in " \n" or unicodedata.category(c) not in ("Cc", "Cf", "Mn", "Me", "Zl", "Zp")
    )


def filter_prompt(text: str) -> str:
    return _normalize_ws(_rm_zero_width(unicodedata.normalize("NFKC", text)))


def sanitize_json_str(text: str) -> str:
    """providers.rs sanitize_json_str, without complete_json."""
    s = text.strip()
    if s.startswith("```json"):
        s = s[len("```json"):]
    elif s.startswith("```"):
        s = s[3:]
    if s.endswith("```"):
        s = s[:-3]
    return s.strip()


def openrouter_transport(api_key: str, provider_order: list | None = None, timeout: float = 180,
                         provider_by_model: dict | None = None, include_cost: bool = False,
                         attempts: int = 5, max_backoff: float = 16):
    """Returns transport(model, messages, max_tokens, json_mode) -> (text, meta).

    provider_by_model: a fixed OpenRouter provider per model id (local module, decision 11.9),
    taking precedence over provider_order. include_cost: ask OpenRouter for the cost of each call
    (usage.cost, in USD). attempts / max_backoff: retries of a failed call (the local module
    raises them: a 429 from a provider is a limit of this account, not a property of the model);
    "seconds" is always the attempt that answered."""

    def transport(model, messages, max_tokens, json_mode):
        body = {"model": model, "messages": messages, "stream": False,
                "temperature": TEMPERATURE, "max_tokens": max_tokens}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        order = (provider_by_model or {}).get(model) or provider_order
        if order:
            body["provider"] = {"order": order if isinstance(order, list) else [order], "allow_fallbacks": False}
        if include_cost:
            body["usage"] = {"include": True}
        data = json.dumps(body).encode("utf-8")
        retries = []
        for attempt in range(attempts):
            req = urllib.request.Request(OPENROUTER_URL, data=data, method="POST", headers={
                "Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                retries.append(e.code)
                if e.code in RETRY_STATUSES and attempt < attempts - 1:
                    time.sleep(min(2 ** attempt, max_backoff))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                retries.append(type(e).__name__)
                if attempt < attempts - 1:
                    time.sleep(min(2 ** attempt, max_backoff))
                    continue
                raise
            if "error" in payload:
                retries.append(str(payload["error"])[:200])
                if attempt < attempts - 1:
                    time.sleep(min(2 ** attempt, max_backoff))
                    continue
                raise RuntimeError(f"openrouter error: {payload['error']}")
            choice = payload["choices"][0]
            text = (choice.get("message") or {}).get("content")
            if text is None and choice.get("finish_reason") == "length":
                text = ""  # providers.rs: truncated with no content -> empty answer
            return text, {"seconds": round(time.time() - t0, 2), "provider": payload.get("provider"),
                          "finish_reason": choice.get("finish_reason"), "usage": payload.get("usage"),
                          "retries": retries}
        raise RuntimeError("unreachable")

    return transport


class GenvmLLM:
    """Answers ExecPrompt / ExecPromptTemplate like GenVM, recording every call.

    `phase` is set by the caller ("leader" / "validator-1" ...) so each recorded call says which
    role made it. Models can differ per role, like validators on the network running their own.
    """

    def __init__(self, transport, leader_model: str = DEFAULT_MODEL, validator_model: str = DEFAULT_MODEL,
                 seat_models: dict | None = None):
        self.transport = transport
        self.leader_model = leader_model
        self.validator_model = validator_model
        self.seat_models = seat_models or {}  # phase -> model, overrides the two above (local module)
        self.templates = _load_templates()
        self.phase = "leader"
        self.calls: list[dict] = []

    def _model(self) -> str:
        if self.phase in self.seat_models:
            return self.seat_models[self.phase]
        return self.leader_model if self.phase == "leader" else self.validator_model

    def _run(self, kind, system, user, max_tokens, fmt):
        messages = []
        if system is not None:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": [{"type": "text", "text": user}]})
        model = self._model()
        rec = {"phase": self.phase, "kind": kind, "model": model, "format": fmt,
               "user_head": user[:300]}
        self.calls.append(rec)
        try:
            text, meta = self.transport(model, messages, max_tokens, fmt in ("json", "bool"))
        except Exception as e:
            rec["error"] = repr(e)[:500]
            return {"error": {"causes": ["NO_PROVIDER_FOR_PROMPT"], "ctx": {"detail": repr(e)[:500]}}}
        rec.update(meta)
        rec["raw"] = text
        if fmt == "text":
            return {"ok": text}
        try:
            parsed = json.loads(sanitize_json_str(text))
        except ValueError as e:
            # GenVM: the provider call fails, the next provider is tried, none left -> error
            rec["error"] = f"invalid json: {e}"
            return {"error": {"causes": ["NO_PROVIDER_FOR_PROMPT"], "ctx": {"detail": rec["error"]}}}
        if fmt == "json":
            return {"ok": json.dumps(parsed)}
        result = parsed.get("result") if isinstance(parsed, dict) else None
        rec["bool"] = result if isinstance(result, bool) else False
        rec["bool_missing"] = not isinstance(result, bool)
        return {"ok": rec["bool"]}

    def exec_prompt(self, data: dict):
        prompt = filter_prompt(data.get("prompt", ""))
        if prompt == "":
            return {"error": {"causes": ["EMPTY_PROMPT"], "ctx": {}}}
        fmt = data.get("response_format", "text")
        system = JSON_SYSTEM_MESSAGE if fmt == "json" else None
        return self._run("ExecPrompt", system, prompt, MAX_TOKENS_PROMPT, fmt)

    def exec_prompt_template(self, data: dict):
        template_id, fmt = TEMPLATES[data["template"]]
        tpl = self.templates[template_id]
        user = tpl["user"]
        for key, val in data.items():
            if key != "template":
                user = user.replace("#{" + key + "}", str(val))
        return self._run(data["template"], tpl["system"], user, MAX_TOKENS_TEMPLATE, fmt)

    def install(self, vm) -> None:
        """Route the direct-mode VM's LLM requests here (contract and gltest untouched)."""
        vm._live_llm_handler = self.exec_prompt
        previous = vm._gl_call_hook

        def hook(vm_, request):
            if isinstance(request, dict) and "ExecPromptTemplate" in request:
                return self.exec_prompt_template(request["ExecPromptTemplate"])
            return previous(vm_, request) if previous else None

        vm._gl_call_hook = hook


def from_env() -> GenvmLLM:
    key = os.environ["OPENROUTER_API_KEY"]
    order = [p for p in os.environ.get("CR_PROVIDER", "").split(",") if p]
    leader = os.environ.get("CR_LEADER_MODEL", DEFAULT_MODEL)
    validator = os.environ.get("CR_VALIDATOR_MODEL", leader)
    return GenvmLLM(openrouter_transport(key, order or None), leader, validator)
