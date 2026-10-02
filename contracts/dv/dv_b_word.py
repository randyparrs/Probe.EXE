# { "Depends": "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379" }
from genlayer import *


class DvWord(gl.Contract):
    """Experiment B: one LLM call, answer is one word from a closed list, no JSON and no parsing.
    Leader and validators compare the word inside gl.vm.run_nondet (v0.2, sandboxed)."""

    last_label: str
    calls: u256

    def __init__(self):
        self.last_label = ""
        self.calls = u256(0)

    @gl.public.write
    def classify(self, text: str) -> None:
        prompt = (
            "Classify the sentiment of the review below as positive or negative.\n"
            "Answer with exactly one lowercase word, positive or negative, and nothing else.\n\n"
            "Review: " + str(text)
        )

        def leader_fn() -> str:
            return gl.nondet.exec_prompt(prompt).strip().lower().strip(".")

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            return leader_fn() == leaders_res.calldata

        self.last_label = gl.vm.run_nondet(leader_fn, validator_fn)
        self.calls = u256(int(self.calls) + 1)

    @gl.public.view
    def get_state(self) -> dict:
        return {"last_label": self.last_label, "calls": int(self.calls)}
