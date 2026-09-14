#!/usr/bin/env python3
"""WorkRelay 语音转录常驻服务（2026-08-12）
faster-whisper 模型加载一次后常驻内存，避免每次转写重复加载模型（省 3-5 秒）。
HTTP 接口：
  POST /transcribe  multipart/form-data: file=<audio>
  GET  /health      健康检查
启动：python3 transcribe_server.py [port]   （默认 17890）
"""
import sys
import os
import json
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from faster_whisper import WhisperModel

PORT = int(os.environ.get("WR_WHISPER_PORT", "17890"))
MODEL_NAME = os.environ.get("WR_WHISPER_MODEL", "small")
MODEL_CACHE = os.environ.get(
    "WR_WHISPER_CACHE",
    os.path.join(os.path.expanduser("~"), ".cache", "faster-whisper"),
)
LANGUAGE = os.environ.get("WR_WHISPER_LANG", "zh")

_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(
            MODEL_NAME,
            device="cpu",
            compute_type="int8",
            download_root=MODEL_CACHE,
        )
    return _model


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静模式
        pass

    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/transcribe":
            self._send_json(404, {"error": "not found"})
            return
        try:
            # 解析 multipart（只取第一个 file 字段）
            content_type = self.headers.get("Content-Type", "")
            boundary = None
            if "boundary=" in content_type:
                boundary = content_type.split("boundary=")[1].strip().strip('"')
            if not boundary:
                self._send_json(400, {"error": "missing boundary"})
                return

            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            # 极简 multipart 解析：按 boundary 切块，找 filename + 内容
            parts = body.split(b"--" + boundary.encode())
            audio_data = None
            for part in parts:
                if b'filename="' in part and b"\r\n\r\n" in part:
                    _, data = part.split(b"\r\n\r\n", 1)
                    audio_data = data.rstrip(b"\r\n--")
                    break
            if audio_data is None:
                self._send_json(400, {"error": "no file part"})
                return

            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name
            try:
                model = get_model()
                segments, _info = model.transcribe(
                    tmp_path, language=LANGUAGE, beam_size=5, vad_filter=True
                )
                text = " ".join(s.text.strip() for s in segments)
                self._send_json(200, {"text": text})
            finally:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {"error": str(e)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    # 先加载模型（启动即常驻）
    get_model()
    print(f"[WorkRelay] whisper server ready: http://127.0.0.1:{PORT} model={MODEL_NAME}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
