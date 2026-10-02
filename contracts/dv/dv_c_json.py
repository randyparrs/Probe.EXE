# { "Depends": "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379" }
import json

from genlayer import *


class DvJson(gl.Contract):
    """Experiment C: one LLM call answered as JSON and parsed with json.loads inside
    gl.vm.run_nondet (the company_naming pattern). Validators compare the parsed label."""

    last_label: str
    calls: u256

    def __init__(self):
        self.last_label = ""
        self.calls = u256(0)

    @gl.public.write
    def classify(self, text: str) -> None:
        prompt = (
            "Classify the sentiment of the review below as positive or negative.\n"
            "Respond using ONLY the following format:\n"
            '{"label": "positive" or "negative", "confidence": int between 0 and 100}\n'
            "It is mandatory that you respond only using the JSON format above, nothing else.\n\n"
            "Review: " + str(text)
        )

        def leader_fn() -> dict:
            result = gl.nondet.exec_prompt(prompt)
            return json.loads(_extract_json_from_string(result))

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            return leader_fn()["label"] == leaders_res.calldata["label"]

        analysis = gl.vm.run_nondet(leader_fn, validator_fn)
        self.last_label = str(analysis["label"])
        self.calls = u256(int(self.calls) + 1)

    @gl.public.view
    def get_state(self) -> dict:
        return {"last_label": self.last_label, "calls": int(self.calls)}


def _extract_json_from_string(s: str) -> str:
    start_index = s.find("{")
    end_index = s.rfind("}")
    if start_index != -1 and end_index != -1 and start_index < end_index:
        return s[start_index : end_index + 1]
    return ""
