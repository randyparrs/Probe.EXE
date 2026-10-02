# { "Depends": "py-genlayer:1j12s63yfjpva9ik2xgnffgrs6v44y1f52jvj9w7xvdn7qckd379" }
from genlayer import *

POSITIVE = ("gorgeous", "best", "great", "good", "love", "excellent")
NEGATIVE = ("bad", "worst", "broken", "poor", "hate", "terrible")


class DvDeterministic(gl.Contract):
    """Experiment A: no LLM, no nondeterministic block. Same storage write as B and C, so any
    DETERMINISTIC_VIOLATION here is the network's base rate."""

    last_label: str
    calls: u256

    def __init__(self):
        self.last_label = ""
        self.calls = u256(0)

    @gl.public.write
    def classify(self, text: str) -> None:
        words = [w.strip(".,!?") for w in str(text).lower().split()]
        score = sum(1 for w in words if w in POSITIVE) - sum(1 for w in words if w in NEGATIVE)
        self.last_label = "positive" if score >= 0 else "negative"
        self.calls = u256(int(self.calls) + 1)

    @gl.public.view
    def get_state(self) -> dict:
        return {"last_label": self.last_label, "calls": int(self.calls)}
