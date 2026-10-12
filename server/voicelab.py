"""
The voice lab: engines on trial for Kuru's voice, in a process the server starts and kills.

Why this exists, and in Python. docs/research/voices.md compared Kokoro with what
else is free to run here and could not settle it on paper: naturalness is a
matter of listening, and the candidates had only been heard as samples, not as
Kuru. So they are wired in as a third engine to pick in Settings and live with
for a while, and the ones that lose are deleted. Most of them exist only in
Python — Pocket TTS on torch, Chatterbox and Qwen3-TTS on MLX — and building a
Node port of each before anybody has chosen one would be work done for the
losers. Supertonic 3 could run in Node, and would if it won; it runs here on
Python's onnxruntime so that everything on trial lives in one place and leaves
together.

Nothing here is installed by kururu. The environments and the weights are in
the folder the server passes as the first argument (`~/.cache/kururu/voicelab`),
made by hand once — see docs/voice.md, "The voice lab". The server runs this file
with `-I` under one of two environments, because torch and MLX do not share
one: `venv-pocket` for Pocket TTS, `venv-mlx` for everything else. Each engine
imports its library the first time it is asked for, so neither environment ever
needs the other's.

The protocol is a line of JSON each way. In:
    {"id": 1, "model": "qwen3", "voice": "serena", "lang": "es", "text": "…", "speed": 1}
Out, the answer, with the WAV as base64 — a sentence is a few hundred kilobytes:
    {"id": 1, "wav": "…", "ms": 812}   or   {"id": 1, "error": "…"}
and, between answers, what a model is doing, for Settings to show:
    {"event": "loading" | "loaded" | "failed", "model": "qwen3", "ms": 9000, "error": "…"}
Requests are answered one at a time, in order. stdout is the channel and
nothing else may write to it: libraries print their progress, so file
descriptor 1 is pointed at stderr once the channel has been kept aside.

It ends by SIGKILL from the server, or by itself when stdin closes — the
server went, however it went.
"""

import base64
import gc
import io
import json
import os
import re
import sys
import time
import unicodedata
import wave

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.cache/kururu/voicelab")

# The channel, kept before anything can print into it.
CHANNEL = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

# Two MLX models resident at most: a pick per language is two, and the third
# would be several gigabytes of somebody's memory for a voice not in use.
MLX_RESIDENT = 2


def send(msg):
    CHANNEL.write(json.dumps(msg) + "\n")
    CHANNEL.flush()


def wav_bytes(audio, rate):
    import numpy as np

    pcm = (np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Supertonic 3 — four ONNX graphs and a denoising loop, after Supertone's MIT
# example (github.com/supertone-oss-archive/supertonic, nodejs/helper.js),
# one sentence at a time and without its chunking, which a sentence never needs.
# ---------------------------------------------------------------------------

EMOJI = re.compile(
    "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF\U0001F800-\U0001F8FF\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F"
    "\U0001FA70-\U0001FAFF☀-⛿✀-➿\U0001F1E6-\U0001F1FF]+"
)
SUPERTONIC_REPLACE = [
    ("–", "-"), ("‑", "-"), ("—", "-"), ("_", " "), ("“", '"'), ("”", '"'),
    ("‘", "'"), ("’", "'"), ("´", "'"), ("`", "'"), ("[", " "), ("]", " "),
    ("|", " "), ("/", " "), ("#", " "), ("→", " "), ("←", " "),
]


class Supertonic:
    def __init__(self, root):
        import numpy as np
        import onnxruntime as ort

        self.np = np
        onnx = os.path.join(root, "onnx")
        self.styles_dir = os.path.join(root, "voice_styles")
        cfg = json.load(open(os.path.join(onnx, "tts.json")))
        self.rate = cfg["ae"]["sample_rate"]
        self.chunk = cfg["ae"]["base_chunk_size"] * cfg["ttl"]["chunk_compress_factor"]
        self.latent_dim = cfg["ttl"]["latent_dim"] * cfg["ttl"]["chunk_compress_factor"]
        self.indexer = json.load(open(os.path.join(onnx, "unicode_indexer.json")))
        opts = ort.SessionOptions()
        session = lambda name: ort.InferenceSession(os.path.join(onnx, name), opts, providers=["CPUExecutionProvider"])
        self.dp = session("duration_predictor.onnx")
        self.enc = session("text_encoder.onnx")
        self.est = session("vector_estimator.onnx")
        self.voc = session("vocoder.onnx")
        self.styles = {}
        self.rng = np.random.default_rng()

    def style(self, voice):
        if voice not in self.styles:
            if not re.fullmatch(r"[A-Z][0-9]", voice):
                raise ValueError(f"no Supertonic voice {voice}")
            raw = json.load(open(os.path.join(self.styles_dir, f"{voice}.json")))
            np = self.np
            self.styles[voice] = tuple(
                np.asarray(raw[key]["data"], dtype=np.float32).reshape(raw[key]["dims"]) for key in ("style_ttl", "style_dp")
            )
        return self.styles[voice]

    def prepare(self, text, lang):
        text = unicodedata.normalize("NFKD", text)
        text = EMOJI.sub("", text)
        for a, b in SUPERTONIC_REPLACE:
            text = text.replace(a, b)
        text = re.sub(r"[♥☆♡©\\]", "", text)
        for a, b in (("@", " at "), ("e.g.,", "for example, "), ("i.e.,", "that is, ")):
            text = text.replace(a, b)
        for mark in (",", ".", "!", "?", ";", ":", "'"):
            text = text.replace(" " + mark, mark)
        for double, single in (('""', '"'), ("''", "'")):
            while double in text:
                text = text.replace(double, single)
        text = re.sub(r"\s+", " ", text).strip()
        if not re.search(r"[.!?;:,'\"')\]}…。」』】〉》›»]$", text):
            text += "."
        return f"<{lang}>{text}</{lang}>"

    def ids(self, text):
        # The example indexes the first UTF-16 unit of each code point; a
        # character the model has no index for (-1) is dropped rather than fed.
        out = []
        for ch in text:
            code = ord(ch)
            if code > 0xFFFF:
                code = 0xD800 + ((code - 0x10000) >> 10)
            index = self.indexer[code] if code < len(self.indexer) else -1
            if index >= 0:
                out.append(index)
        return out

    def speak(self, voice, lang, text, speed, steps=8):
        np = self.np
        ttl, dp = self.style(voice)
        ids = np.asarray([self.ids(self.prepare(text, lang))], dtype=np.int64)
        mask = np.ones((1, 1, ids.shape[1]), dtype=np.float32)
        # 1.05 is the example's own pace; Kururu's slider multiplies it.
        duration = float(self.dp.run(["duration"], {"text_ids": ids, "style_dp": dp, "text_mask": mask})[0].reshape(-1)[0]) / (1.05 * speed)
        emb = self.enc.run(["text_emb"], {"text_ids": ids, "style_ttl": ttl, "text_mask": mask})[0]
        samples = int(duration * self.rate)
        frames = int((duration * self.rate + self.chunk - 1) // self.chunk)
        live = (samples + self.chunk - 1) // self.chunk
        latent_mask = (np.arange(frames) < live).astype(np.float32).reshape(1, 1, frames)
        x = self.rng.standard_normal((1, self.latent_dim, frames)).astype(np.float32) * latent_mask
        total = np.asarray([steps], dtype=np.float32)
        for step in range(steps):
            x = self.est.run(
                ["denoised_latent"],
                {
                    "noisy_latent": x,
                    "text_emb": emb,
                    "style_ttl": ttl,
                    "text_mask": mask,
                    "latent_mask": latent_mask,
                    "total_step": total,
                    "current_step": np.asarray([step], dtype=np.float32),
                },
            )[0]
        audio = self.voc.run(["wav_tts"], {"latent": x})[0].reshape(-1)[:samples]
        return audio, self.rate


# ---------------------------------------------------------------------------
# Pocket TTS — Kyutai's own package on torch, a model per language. The
# predefined voices are embeddings fetched once into the lab's hub cache.
# ---------------------------------------------------------------------------


class Pocket:
    def __init__(self, languages):
        from pocket_tts import TTSModel

        self.models = {}
        self.states = {}
        self.TTSModel = TTSModel
        # "pocket" is english and spanish; "pocket-hq" the 24-layer Spanish alone.
        self.languages = languages

    def speak(self, voice, lang, text, speed):
        import torch

        language = self.languages.get(lang)
        if not language:
            raise ValueError(f"this Pocket model does not speak {lang}")
        if language not in self.models:
            self.models[language] = self.TTSModel.load_model(language=language)
        model = self.models[language]
        key = (language, voice)
        if key not in self.states:
            if not re.fullmatch(r"[a-z_]+", voice):
                raise ValueError(f"no Pocket voice {voice}")
            self.states[key] = model.get_state_for_audio_prompt(voice)
        chunks = list(model.generate_audio_stream(self.states[key], text))
        audio = torch.cat(chunks, dim=0).reshape(-1).float().numpy()
        return trim_silence(audio, model.sample_rate), model.sample_rate


def trim_silence(audio, rate, floor=0.01, keep=0.08):
    """Pocket's `lola` opens some English sentences with a second and more of nothing; a reply read a sentence at a time cannot afford it."""
    import numpy as np

    loud = np.nonzero(np.abs(audio) > floor)[0]
    if not len(loud):
        return audio
    start = max(0, int(loud[0]) - int(keep * rate))
    return audio[start:]


# ---------------------------------------------------------------------------
# MLX models through mlx-audio: Chatterbox (v3, and the es-MX/LatAm fine-tune
# converted to the same layout) and Qwen3-TTS.
# ---------------------------------------------------------------------------

QWEN_LANGS = {"en": "english", "es": "spanish"}


class MlxModel:
    def __init__(self, model_id, path):
        from mlx_audio.tts.utils import load

        self.id = model_id
        self.model = load(path)
        self.rate = self.model.sample_rate
        self.conds = {}

    def run(self, text, **kw):
        import numpy as np

        parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in self.model.generate(text=text, verbose=False, **kw)]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def speak(self, voice, lang, text, speed):
        if self.id.startswith("chatterbox"):
            kw = {"lang_code": lang, "exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8}
            if voice != "default":
                # A cloned voice: the reference is read once and its
                # conditionals kept, rather than worked out every sentence.
                if voice not in self.conds:
                    if not re.fullmatch(r"[a-z_]+", voice):
                        raise ValueError(f"no Chatterbox voice {voice}")
                    ref = os.path.join(ROOT, "refs", f"{voice}.wav")
                    self.conds[voice] = self.model.prepare_conditionals(ref, self.rate, exaggeration=0.5)
                kw["conds"] = self.conds[voice]
            return self.run(text, **kw), self.rate
        # Qwen3-TTS. The 0.6B at 4 bits ran on past the end of its sentence in
        # 39 takes of 96 here; the 1.7B is reported steadier, and the guard
        # stays anyway: a token budget a little past what the words need at
        # a slow pace, and one more take when the first is still far too long.
        expect = max(1.5, len(text) / 13.0)
        budget = int(12.5 * (2.2 * expect + 2))
        kw = {"voice": voice, "lang_code": QWEN_LANGS[lang], "max_tokens": budget, "speed": speed}
        audio = self.run(text, **kw)
        if len(audio) / self.rate > 1.8 * expect:
            again = self.run(text, **kw)
            if len(again) < len(audio):
                audio = again
        return audio, self.rate


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

MLX_PATHS = {
    "chatterbox": "models/chatterbox-v3",
    "chatterbox-latam": "models/chatterbox-latam",
    "qwen3": "models/qwen3-tts-1.7b",
}

engines = {}
mlx_order = []


def engine(model_id):
    if model_id in engines:
        if model_id in mlx_order:
            mlx_order.remove(model_id)
            mlx_order.append(model_id)
        return engines[model_id]
    send({"event": "loading", "model": model_id})
    started = time.perf_counter()
    try:
        if model_id == "supertonic":
            made = Supertonic(os.path.join(ROOT, "models", "supertonic-3"))
        elif model_id == "pocket":
            made = Pocket({"en": "english", "es": "spanish"})
        elif model_id == "pocket-hq":
            made = Pocket({"es": "spanish_24l"})
        elif model_id in MLX_PATHS:
            while len(mlx_order) >= MLX_RESIDENT:
                gone = mlx_order.pop(0)
                del engines[gone]
                gc.collect()
                import mlx.core as mx

                mx.clear_cache()
                send({"event": "unloaded", "model": gone})
            made = MlxModel(model_id, os.path.join(ROOT, MLX_PATHS[model_id]))
            mlx_order.append(model_id)
        else:
            raise ValueError(f"no lab model {model_id}")
    except Exception as err:
        send({"event": "failed", "model": model_id, "error": str(err)[:300]})
        raise
    engines[model_id] = made
    send({"event": "loaded", "model": model_id, "ms": round((time.perf_counter() - started) * 1000)})
    return made


def answer(req):
    rid = req.get("id")
    try:
        lang = req.get("lang")
        if lang not in ("en", "es"):
            raise ValueError(f"no language {lang}")
        speed = req.get("speed", 1)
        speed = float(speed) if isinstance(speed, (int, float)) and 0.5 <= speed <= 2 else 1.0
        text = str(req.get("text", "")).strip()
        if not text:
            raise ValueError("nothing to say")
        made = engine(str(req.get("model")))
        started = time.perf_counter()
        audio, rate = made.speak(str(req.get("voice")), lang, text, speed)
        if not len(audio):
            raise ValueError("the model made no sound")
        send({"id": rid, "wav": base64.b64encode(wav_bytes(audio, rate)).decode("ascii"), "ms": round((time.perf_counter() - started) * 1000)})
    except Exception as err:
        send({"id": rid, "error": f"{type(err).__name__}: {err}"[:400]})


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except ValueError:
        continue
    if isinstance(req, dict):
        answer(req)
