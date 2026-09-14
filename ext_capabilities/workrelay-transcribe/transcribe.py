#!/usr/bin/env python3
"""WorkRelay 语音转录引擎 - 基于 faster-whisper."""

import sys
import os
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WR_WHISPER_MODEL", "small")
MODEL = None
MODEL_CACHE = os.environ.get(
    "WR_WHISPER_CACHE",
    os.path.join(os.path.expanduser("~"), ".cache", "faster-whisper"),
)


def load_model():
    global MODEL
    MODEL = WhisperModel(
        MODEL_NAME,
        device="cpu",
        compute_type="int8",
        download_root=MODEL_CACHE,
    )
    print(f"[WorkRelay] Whisper model '{MODEL_NAME}' loaded", file=sys.stderr)


def transcribe(audio_path: str, language: str = "zh") -> str:
    if MODEL is None:
        load_model()
    segments, info = MODEL.transcribe(
        audio_path,
        language=language,
        beam_size=5,
        vad_filter=True,
    )
    return " ".join(s.text.strip() for s in segments)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file> [language]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "zh"

    if not os.path.isfile(audio_file):
        print(f"ERROR: file not found: {audio_file}", file=sys.stderr)
        sys.exit(1)

    try:
        result = transcribe(audio_file, lang)
        print(result.strip())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
