"""Generate the non-sensitive demo audio artifact with the Python standard library."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

RATE = 16_000
DURATION_SECONDS = 36
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "voiss-aura-web"
    / "public"
    / "demo"
    / "voiss-aura-architecture-review.wav"
)


def sample_at(index: int) -> int:
    second = index / RATE
    segment = min(int(second // 9), 3)
    phase = second % 9
    if phase < 0.35 or phase > 7.7:
        return 0
    envelope = min(1.0, (phase - 0.35) * 5, (7.7 - phase) * 5)
    carrier = 210 + segment * 45
    signal = (
        math.sin(2 * math.pi * carrier * second)
        + 0.34 * math.sin(2 * math.pi * (carrier * 1.5) * second)
        + 0.13 * math.sin(2 * math.pi * 3.2 * second)
    )
    return int(4_200 * envelope * signal)


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT), "wb") as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(RATE)
        for index in range(RATE * DURATION_SECONDS):
            destination.writeframesraw(struct.pack("<h", sample_at(index)))
    print(f"generated {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
