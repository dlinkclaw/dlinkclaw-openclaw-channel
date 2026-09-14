#!/usr/bin/env python3
"""WorkRelay TTS: patch Voicebox kokoro_backend.py — 修复中文 pipeline 英文朗读。

问题：Kokoro 中文 pipeline 默认 version=None 走 legacy_call，英文文本被原样透传给模型，
模型把英文字母按日文假名音逐字读出（如 "Hello" -> L.O.H.O.R.Y.O.）。

方案：把 zh pipeline 的 g2p 替换为混合 G2P——
  - 中文段：legacy（pypinyin→IPA），Kokoro-82M 认识的音素
  - 英文段：misaki en G2P（→IPA）
  - 纯数字段：cn2an 转中文数字再走 legacy
三类音素都是 Kokoro-82M 认识的 IPA，中英混读正常。

幂等：源码已包含 _MixedZhG2P 标记则跳过。用法：python3 patch-kokoro-en.py <kokoro_backend.py>
"""
import ast
import sys

MARKER = "_MixedZhG2P"

ANCHOR = """            self._pipelines[kokoro_lang] = KPipeline(
                lang_code=kokoro_lang,
                repo_id=KOKORO_HF_REPO,
                model=self._model,
            )
"""

PATCH = ANCHOR + """
            # 2026-08-13 修复（WorkRelay）：Kokoro 中文 pipeline 的 legacy_call 会把英文原样
            # 透传给模型，模型把字母按日文假名音逐字读出（如 Hello -> L.O.H.O.R.Y.O.）。
            # 方案：自定义混合 G2P——中文段走 legacy（pypinyin→IPA），英文段走 misaki en G2P，
            # 纯数字段 cn2an 转中文数字再走 legacy。三类音素都是 Kokoro-82M 认识的 IPA。
            if kokoro_lang == "z":
                from misaki import zh, en
                import jieba
                import re as _re
                import cn2an

                en_g2p = en.G2P(trf=False, british=False, unk="")

                class _MixedZhG2P:
                    def __call__(self, text):
                        def zh_to_ipa(seg):
                            words = jieba.lcut(seg, cut_all=False)
                            return " ".join(zh.ZHG2P.word2ipa(w) for w in words)
                        result = ""
                        for segment in _re.findall(r"[\\u4E00-\\u9FFF]+|[^\\u4E00-\\u9FFF]+", text):
                            if _re.search(r"[\\u4E00-\\u9FFF]", segment):
                                seg = cn2an.transform(segment, "an2cn") if _re.search(r"\\d", segment) else segment
                                result += zh_to_ipa(seg)
                            elif _re.search(r"[A-Za-z]", segment):
                                ps, _ = en_g2p(segment.strip())
                                result += ps
                            elif _re.search(r"\\d", segment):
                                result += zh_to_ipa(cn2an.transform(segment, "an2cn"))
                            else:
                                result += segment
                        return result.replace(chr(815), ""), None

                self._pipelines[kokoro_lang].g2p = _MixedZhG2P()
"""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch-kokoro-en.py <kokoro_backend.py>", file=sys.stderr)
        return 1
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if MARKER in src:
        print("already patched, skip")
        return 0
    if ANCHOR not in src:
        print("ERROR: anchor not found in", path, file=sys.stderr)
        return 1
    new_src = src.replace(ANCHOR, PATCH, 1)
    ast.parse(new_src)  # 语法检查
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_src)
    print("patched OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
