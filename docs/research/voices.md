# A better voice for Kuru

Research, dated 2026-10-11. **No voice code was changed** to write it: the
models were run in a scratch directory, against Kururu's own `node_modules` and
its own `sentencesOf` and `phonemesEs`, imported read-only. Two kinds of
evidence are kept apart throughout. **Measured on this Mac** means an M2 Max
with 32 GB on macOS 27.0.1, with Kururu's server, host and live agents running
beside it, so the timings carry some noise. **Reported** means somebody else's
number, on the hardware they name. The licence readings are a developer's
reading and not legal advice.

The question was whether a voice exists that is free to download and run here —
no subscription, no per-use API — and better than Kokoro-82M as Kururu runs it,
in English and in Spanish, since a reply is read in whichever language it was
written in.

## The short answer

**Not in English. Probably in Spanish, if your ears agree.** Kokoro is still the
best-ranked small open model in both public blind arenas, `af_heart` is the
voice its card grades A, and every open model ranked clearly above it there is
either licensed for non-commercial use only or does not speak Spanish ([1], [2],
[3]). Spanish is where Kokoro is weak by its own card's account, and where
Kururu already works around the library to reach it at all. Of everything
rendered here, **Supertonic 3** was the only engine Whisper transcribed without
a single error in both languages — "pull request" and "build" included — and it
runs on the very onnxruntime-node build Kururu already ships, in Node, with no
phonemiser, about twice as fast as Kokoro to the first sentence. Against it:
Supertone archived the project on 2026-09-09, so nothing will ever be fixed
upstream, and the weights are under OpenRAIL-M, whose use restrictions travel
with the model ([4], [5]). **Pocket TTS**, from Kyutai, is the live alternative
— 27 voices that speak Spanish, cloning, CC-BY-4.0 weights, and after the older
Piper the fastest engine measured — but its runtime is Python and torch. The
quality tier (Chatterbox, Qwen3-TTS and their kind) needs a Python or MLX
sidecar and gigabytes, wins no blind test against Kokoro in English, and the
small Qwen3 tried here babbled past the end of its sentence in 39 takes of 96.
Apple's Premium and Enhanced voices could not be judged, because none is
installed on this Mac. Settings already holds a voice per language, so "Kokoro
for English, Supertonic for Spanish" is a third engine beside the two there are
rather than a replacement: cheap to try, and cheap to undo.

**The samples** are in `~/Desktop/kuru-voice-samples/`, with a README of their
own. Every file says the same passage — one per language, four sentences as
`sentencesOf` splits it, joined with 250 ms of silence. Compare these first:

| | Kururu today | against |
|---|---|---|
| English | `en-kokoro-af_heart.wav` | `en-supertonic3-F1.wav` · `en-pocket-alba.wav`, `-lola`, `-rafael` · `en-chatterbox-default.wav` |
| Spanish | `es-kokoro-ef_dora.wav` | `es-supertonic3-F1.wav`, `-M1` · `es-pocket-lola.wav`, `-rafael` · `es-chatterbox-default.wav` · `es-say-Monica.wav`, `es-say-Paulina.wav` |

Levels differ by several decibels between engines — Piper and `say` are hot, and
Kokoro on MLX is 3 dB quieter than the same phonemes through kokoro-js — and
louder is not better.

## Kokoro today, and where it falls short

Kokoro-82M v1.0 came out in January 2025 with Apache-2.0 weights, and the card
names nothing later ([6]). Kururu runs the 92 MB q8 ONNX through kokoro-js
1.2.1, @huggingface/transformers 3.8.1 and onnxruntime-node 1.21.0, on the CPU,
in a process of its own. That process exists because onnxruntime-node aborts in
a static destructor when a process that loaded it exits: the server forks it on
the first sentence and ends it with SIGKILL, which runs nothing
([`server/src/kokoro.ts`](../../server/src/kokoro.ts),
[voice](../voice.md#gotchas)). English goes in as text. Spanish goes in as
phonemes, because kokoro-js phonemises English only and refuses a Spanish voice
by name although the package ships all three:
[`server/src/voice.ts`](../../server/src/voice.ts)'s `phonemesEs` runs the real
`espeak-ng -v es --ipa=2` a clause at a time, `modelPhonemes` applies the
substitutions the model's tokeniser was trained against, the punctuation is put
back, and the ids go to `generate_from_ids`
([voice](../voice.md#two-languages)). The Mac's `say` speaks whenever Kokoro
cannot. That is the state of things, and it works. Where it falls short:

- **Spanish is Kokoro's weakest tier by its own account.** Three voices
  (`ef_dora`, `em_alex`, `em_santa`), and the grade column the English voices
  carry — `af_heart` A, `af_bella` A- — is simply absent for them. The card
  warns that non-English support "may be absent or thin due to weak G2P and/or
  lack of training data", and names no Spanish data among what it was trained on
  ([3], [6]).
- **It is Castilian because of a flag.** `-v es` is espeak-ng's Spanish (Spain)
  voice. On this Mac it gives `mˌiɣɾaθjˈon` for "migración", with the θ that a
  Mexican or Paraguayan speaker does not use. espeak-ng 1.52.0 here also has
  `es-419`, Spanish (Latin America), which gives `mˌiɣɾasjˈon`. Whether Kokoro's
  Spanish voices read `es-419`'s phonemes well was not tried.
- **English loanwords come out Spanish.** espeak reads "pull request" as `pˈuʎ
  rekˈest`, and Whisper hears "pool request" — the only error in Kokoro's
  Spanish sample (measured). Kuru's replies are full of such words.
- **About a second before Kuru says anything.** Warm, Kokoro took 1.14–1.36 s
  for the first sentence here (measured). Every later sentence is made while the
  one before it plays, so the first is the whole of the wait.
- **Short sentences are its weak spot.** The card says its voices are weak on
  utterances under about 10–20 tokens ([3]), and Kururu speaks a sentence at a
  time, some as short as "Want me to handle it?".
- **Frozen.** kokoro-js has had no release since 1.2.1 in May 2025 ([7]), while
  transformers.js has reached 4.3.1 and onnxruntime-node 1.30.0 ([8], [9]).
  Stable is the kind word.

English is not on that list. `af_heart` is the one voice the card grades A, and
nothing below has been shown to beat it.

## The field: two tiers of models, and the Mac's own voices

The **small tier** is Kokoro's own class: about 100M parameters or fewer, faster
than real time on a laptop CPU, a few hundred megabytes. The **quality tier** is
0.5–2B parameters, usually a language model over audio tokens, with cloning,
emotion control and native Spanish, at a few gigabytes. And there are **macOS's
own voices**, which cost nothing but the user's click. The table holds the
serious candidates; what was left out, and why, follows it.

| model | params | download | English: quality evidence | Spanish: quality evidence | route from Node | licence for shipping | voices |
|---|---|---|---|---|---|---|---|
| **Kokoro-82M v1.0** (Kururu today) | 82M | 92 MB (q8 ONNX) | AA Elo 1064, 5th of 16 open-weights entries; TTS Arena V2 1478 ±22; `af_heart` graded A ([1], [2], [3]) | 3 ungraded voices through espeak-ng; the card calls it "thin" ([3]) | in process today: kokoro-js on onnxruntime-node, in a child | Apache-2.0, weights and code ([6]) | 54 presets, 3 of them Spanish; no cloning |
| **Supertonic 3** (Supertone, Apr 2026) | ~99M | ~401 MB (fp32 ONNX + 10 styles); also packaged by sherpa-onnx ([10]) | on no arena; vendor WER 2.06 on its own English test ([4]) | one of 31 languages; Spanish WER published only as a chart ([4]) | onnxruntime-node directly, through Supertone's MIT Node example; or sherpa-onnx-node | code MIT, weights OpenRAIL-M; upstream archived 2026-09-09 ([5], [4]) | 10 styles (F1–F5, M1–M5), the same in every language; no cloning |
| **Pocket TTS** (Kyutai; Spanish since Apr 2026) | ~100M | 219 MB per language + 4–8 MB per voice; `spanish_24l` 672 MB ([11]) | on no arena | dedicated Spanish models; WER 1.15 %, speaker similarity 80.1 % in a competitor's evaluation ([12]) | Python + torch officially; unofficial ONNX exports; sherpa-onnx has its English model only ([13], [14]) | code MIT, weights CC-BY-4.0 (attribution); the cloning weights are gated ([11], [15]) | 27 voice states in its Spanish folder; cloning from a WAV ([16]) |
| **Piper** (VITS) | — | 21–121 MB per voice ([17]) | older VITS; on no arena | the only explicit accents: es_AR, es_ES, es_MX ([17]) | sherpa-onnx-node; piper1-gpl has no Node binding ([18]) | GPL-3.0 with espeak-ng inside; several Spanish voices descend from research-only data ([18], [19]) | 1–2 speakers per voice |
| **Magpie-Multilingual** (NVIDIA, v2607) | 357M | 569 MB (F16 GGUF) | AA 1062, level with Kokoro ([1]) | CER 0.60 % (vendor); trained partly on a Spain-based corpus ([20]) | NeMo or NeMo-Speech.cpp; GPU-oriented, no Mac numbers ([20]) | NVIDIA Open Model License, commercial use allowed ([20]) | 5 voices; cloning removed |
| **Chatterbox Multilingual** v2 / v3 (Resemble) | 500M | v3 ≈ 3.2 GB ([21]); v2 4-bit MLX 612 MB + 495 MB tokenizer (measured) | TTS Arena V2 1481 ±19, a tie; AA 1026, below Kokoro ([2], [1]) | 23 languages, plus es-ES and es-MX/LatAm single-language packs; no Spanish WER published ([22], [23]) | Python sidecar: PyTorch, or MLX through mlx-audio ([24]) | MIT; the Python package watermarks every file ([22]) | one built-in voice; cloning from 10 s or more ([23]) |
| **Qwen3-TTS** (Jan 2026) | 0.6B / 1.7B | 0.6B 4-bit 1.7 GB (measured); 1.7B 4-bit ≈ 2.3 GB ([25]) | on no arena | Spanish WER 1.126 (1.7B, self-reported on the MiniMax test) ([26]) | Python/MLX sidecar; Swift MLX; llama.cpp | Apache-2.0 ([26]) | 9 speakers, none native to Spanish; cloning; voice design on 1.7B ([26]) |
| **macOS Enhanced / Premium** | — | none installed here; about 75–590 MB a voice, installed by the user | no blind test against Kokoro found; community comments single out Premium Ava and Zoe, Enhanced Evan and Nathan ([27], [28]) | Enhanced Mónica, Paulina, Jorge, Juan, Angélica, Diego…; no Spanish voice confirmed at Premium | `say` today; AVSpeechSynthesizer from a Swift helper | speaking on the user's own Mac, yes; redistributing voices or publishing their output, no ([29]) | dozens; Personal Voice (en-US, es-MX) with per-app consent ([30]) |

**Left out.** Above Kokoro on Artificial Analysis's open-weights board, and no
use here: Breeze TTS 2 (1222), Fish Audio S2 Pro (1116) and Voxtral TTS (1086)
carry non-commercial weight licences, and Step-Audio-EditX (1096) has no Spanish
([1], [31], [32], [33], [34]). Higgs TTS 3 is research and non-commercial
([35]). NeuTTS Nano Spanish is free only under US$5M of annual revenue,
watermarks its output and only clones ([36], [37]). Of the newer small models,
Kitten 0.8, Soprano, and Chatterbox Turbo and Nano speak English only ([38],
[39], [40]). Fun-CosyVoice3 0.5B and VoxCPM2 are Apache-2.0 and speak Spanish,
but neither is on an arena, and VoxCPM2 runs slower than real time on an M4 Pro
([41], [42]).

### The small tier: two live models, opposite in the way that counts

**Supertonic 3** is ONNX through and through: four graphs, a character-level
indexer and a language tag around the text (`<es>…</es>`), no phonemiser, and
official examples in Node among ten other languages ([4]). It is also finished,
in the bad sense. Supertone announced on 2026-07-23 that there would be "no
further development or official support for the open-source Supertonic models",
took its Voice Builder offline after 2026-08-31 and archived the repository on
2026-09-09; the weights are still on the Hub ([4], [43]). Its ten voices are
styles shared by all 31 languages, which is the one way on this list to have
Kuru speak English and Spanish in the same voice without cloning. It has no
independent evaluation in either language.

**Pocket TTS** is the opposite: alive — Spanish arrived in v2.0.0 in April 2026,
the training code in August, a retrained Spanish model in v3.3.0 on 24 September
([44]) — and built for the CPU. Kyutai reports about six times real time and
about 200 ms to the first chunk on an M4 Air's CPU, on two cores, with nothing
gained from the GPU ([13]). It reads text through SentencePiece, so it too needs
no phonemiser. Its Spanish folder holds 27 voice states, it clones from a WAV,
and a voice state can be exported and reused ([16], [44]). The best Spanish
evidence for any small open model is a competitor's: Gradium, who make the
closed Phonon, measured Pocket TTS at 1.15 % WER and 80.1 % speaker similarity
in Spanish, behind Phonon and ahead of Magpie and NeuTTS Nano ([12]). A
community note warns that a Spanish prompt starting with "¿" can cut generation
short ([45]); the one question in the sample came through whole.

**Piper** is the only model with a named regional accent — es_AR, es_ES and
es_MX voices ([17]) — and the most encumbered, for the licence reasons below.
Its sound is a generation older than Kokoro's, and the Open Home Foundation,
which keeps it, is looking for maintainers ([18]).

### The quality tier: native Spanish, not better English, and not here without a sidecar

On Artificial Analysis's open-weights board Kokoro is fifth at 1064 Elo, over
5,307 samples; the four above it are the non-commercial three and one with no
Spanish, and Chatterbox sits below at 1026 ([1]). On TTS Arena V2 Kokoro has
1478 ±22 and Chatterbox 1481 ±19, a tie inside the error bars ([2]). Qwen3-TTS,
CosyVoice3, VoxCPM2 and Chatterbox v3 are on neither board, so no human vote
compares their English with Kokoro's at all. Their Spanish numbers are
self-reported WER on one shared test set — Qwen3-TTS 1.7B 1.126, VoxCPM2 1.438,
and the non-commercial Fish S2 0.910 — within half a point of each other ([42],
[26]). That says each is intelligible, and nothing about which sounds like a
person. What the tier offers is cloning, emotion and dialect: Chatterbox has
dedicated es-ES and es-MX/LatAm checkpoints ([22], [23]), and Qwen3-TTS has a
voice-design model ([26]).

The cost is speed and a runtime. Reported on an M5 Pro, Fun-CosyVoice3 0.5B at 4
bits runs at an RTF of 0.59 and Qwen3-TTS 1.7B at 4 bits at 0.79, against
Kokoro's 0.17 on CoreML ([25]); VoxCPM2 runs at 1.76 on an M4 Pro through
llama.cpp, slower than it speaks ([42]). At 0.6–0.8, a five-second first
sentence takes three to four seconds to make. No maintained ONNX or JavaScript
runtime was found for any of them; mlx-audio, in Python, has nearly all of them
([24]).

### Licences, read for shipping

Kururu is Apache-2.0 and today ships no weights at all: Kokoro is fetched from
the Hub on first use, into `~/.cache/kururu/models`
([voice](../voice.md#installing)). That matters, because most of these licences
attach their strictest terms to distributing the model.

- **Kokoro.** Weights and kokoro-js are both Apache-2.0 ([6], [7]). Nothing to
  pass on, nothing to restrict.
- **Supertonic 3.** The sample code is MIT; the weights are the BigScience
  OpenRAIL-M licence. Commercial use and redistribution "in any medium, with or
  without modifications" are allowed, but the use-based restrictions "MUST be
  included as an enforceable provision by You in any type of legal agreement
  (e.g. a license) governing the use", and you must require your users to
  comply. Among them: no content placed "in any context (e.g. bot generating
  tweets) without expressly and intelligibly disclaiming that the information
  and/or content is machine generated", no impersonation without consent, no
  medical advice ([5]). The archiving on 2026-09-09 changes none of that; it
  only leaves nobody to ask ([4]).
- **Pocket TTS.** Code MIT, weights CC-BY-4.0: commercial use and redistribution
  with attribution to Kyutai. The repository with the cloning weights is gated
  behind sharing contact details; the one without cloning is not. Kyutai
  prohibits "voice impersonation or cloning without explicit and lawful
  consent", and lists the predefined voices' own licences on a separate page
  ([11], [15], [13]).
- **Piper.** piper1-gpl is GPL-3.0 and compiles espeak-ng in, so it belongs in a
  separate process or not at all ([18]). Worse is the data: the es_AR `daniela`
  voice, like es_ES `davefx` and `sharvard`, is fine-tuned from the US English
  `lessac` voice ([46]), and lessac's Blizzard 2013 data is under a research
  licence that excludes "any commercial purpose, including the development,
  marketing, commercialisation, sale or licencing of voice synthesis … products
  or services" ([19]). Whether a fine-tune inherits that is unsettled, which is
  reason enough to leave those voices alone. es_MX `claude` names apache-2.0
  data and no lessac base ([47]).
- **espeak-ng**, which Kururu already uses for Spanish, is GPL-3.0-or-later
  ([48]). Kururu does not ship it — the user runs `brew install espeak-ng` — and
  talks to it as a separate program, text in and phonemes out on the command
  line, which is the arm's-length communication the GPL FAQ describes between
  separate programs ([49]). Shipping the binary inside the app would make an
  aggregate, with the GPL's obligations on espeak-ng and not on Kururu.
  Supertonic and Pocket would take it off the Spanish path altogether.
- **The quality tier.** Chatterbox is MIT, and its Python package stamps an
  imperceptible watermark on every file ([22]). Qwen3-TTS, Fun-CosyVoice3 and
  VoxCPM2 are Apache-2.0 ([26], [41], [42]). Magpie's NVIDIA Open Model License
  allows commercial use; its full text was not read ([20]). NeuTTS Nano is free
  only below US$5M of annual revenue ([36]). Breeze TTS 2, Fish S2 Pro, Voxtral
  and Higgs TTS 3 cannot be embedded in a product without a deal ([31], [32],
  [33], [35]).
- **Apple's voices** may be used, not redistributed — see below.

### macOS's voices: untested here, and a test is a click away

Nothing here could say whether Apple's better voices beat Kokoro, because this
Mac has none. The doubled Samantha, Mónica and Paulina in `say -v '?'` are not a
compact voice and an Enhanced one: AVFoundation names them
`com.apple.voice.compact.*` and `com.apple.voice.super-compact.*`, both of
quality "default", and the two Samanthas render byte-identical audio (measured).
`parseSayVoices` in [`shared/voice.ts`](../../shared/voice.ts) drops the second
of a doubled name on the belief that it is an Enhanced copy; here it is the same
voice twice, so nothing is lost, but the picker has never yet been offered an
Enhanced voice on this Mac.

Apple's **Premium** tier, from macOS 13, is "a premium quality voice that you
must download to use" ([50]); it covers a handful of English voices — Ava, Zoe,
Jamie, Serena, Karen, Matilda, Isha — and **Enhanced** covers many more ([51]).
For Spanish, the download catalogues on this Mac's disk (read off the disk;
dated 2023, so a baseline rather than the live list) offer high-quality Mónica
es-ES at 437 MB, Paulina es-MX at 391 MB and Diego es-AR at 74 MB, and Jorge,
Juan, Angélica, Carlos and Soledad at 77–154 MB; no source confirms a Spanish
voice at Premium. No blind comparison of any Apple voice with Kokoro was found.
Community comments single out Premium Ava and Zoe and Enhanced Evan and Nathan
([27], from 2022; [28]), and report Premium and Enhanced voices on Tahoe that
produce no sound, skip lines or croak in some apps ([51], [28]).

Three things any test has to respect:

- **`say` falls back in silence.** A name it does not know — "Ava (Premium)"
  while uninstalled, "Voice 1", a full identifier — exits 0 and renders the
  default voice, byte for byte (measured). The name has to come off `say -v '?'`
  after installing, not from a list like the one below.
- **Installing is the user's, by hand:** System Settings → Accessibility → Read
  & Speak → System voice → Manage Voices. There is no API that starts a download
  ([52], [53]).
- **The licence allows speaking and nothing more.** The user may use system
  voices "while running the Apple Software" and for personal, non-commercial
  content; "recording, publishing or redistribution" in any public or commercial
  context is excluded ([29]). Reading a reply to the person whose Mac it is,
  which Kururu does with `say` today, is the first. Bundling a voice, or
  offering an export of Kuru's speech, would be the second.

What a test would take: the user installs, say, Ava (Premium), Zoe (Premium) and
Evan or Nathan (Enhanced) for English, and Paulina, Mónica and whichever of
Jorge, Juan or Angélica are offered for Spanish. Then the same eight sentences
are rendered with Kururu's exact call (`say -v <name> -r 175 -f -
--file-format=WAVE --data-format=LEI16@22050`), put through the same Whisper
check and listened to beside the Kokoro and Supertonic files. One more render at
the voice's own rate is worth the minute: the one Siri voice reachable here came
out at 48 kHz, and Kururu asks `say` for 22,050 Hz. If a voice wins, nothing in
Kururu has to change — Settings → Voice already lists every English and Spanish
voice `say -v '?'` lists. Unverified on macOS 27: whether an installed Premium
voice is listed under its tiered name.

**The Siri voice is a curiosity, not an option.** Siri had downloaded a 271 MB
en-US voice of its own, and a script run under `xcrun swift` found it in
`AVSpeechSynthesisVoice.speechVoices()` as "Voice 1", quality Enhanced, and
rendered clean 48 kHz speech with it; a compiled AVSpeechSynthesizer tool on the
same Mac could not see it, and `say` cannot reach it (measured). Apple's
documented position since WWDC20 is that Siri voices are not available through
the API ([54]), and identifiers of this kind that worked on iPadOS stopped
working in the 26 beta ([55]). Nothing should rest on it. **Personal Voice** —
the user's own voice — is offered to third-party apps with per-app consent,
speaks Spanish (Mexico), and is licensed for personal, non-commercial use ([30],
[29]). Kuru in the user's own voice is a product decision, not a quality one,
and is left there.

## Measured on this Mac

Each engine rendered the same eight sentences (four per language) in a fresh
process, timed per sentence, and Whisper large-v3-turbo transcribed the result
back with the language forced. Kokoro ran on exactly Kururu's path — the same
packages out of Kururu's `node_modules`, the same model cache, the Spanish
phonemes made by importing `phonemesEs` itself, the process ended by SIGKILL —
but under Node 24 rather than the app's Electron binary running as node; the
same onnxruntime-node and CPU path should behave alike, and that was not
checked. The scripts lived in a scratch directory that does not outlive the
session; the samples' README records the settings of every file.

| engine | device | warm RTF | warm 1st sentence | process start → first audio | peak memory | weights | WER en / es |
|---|---|---|---|---|---|---|---|
| **Kokoro-82M q8**, kokoro-js (Kururu today) | CPU | 0.47–0.48 | 1.14–1.36 s | 1.6 s | 641 MB | 92 MB | 0 / 2.2 % |
| Kokoro-82M bf16, mlx-audio, same phonemes | Metal | 0.04–0.14 | 0.22–0.38 s | 1.5 s | 418 MB RSS, 2.3 GB Metal | 330 MB | 0 / 2.2 % |
| macOS `say`, as Kururu calls it | CPU (daemon) | 0.21–0.29 | 0.75–1.07 s | 1.1 s | — | 0 | 0 / 0–2.2 % |
| **Supertonic 3**, onnxruntime-node, 8 steps | CPU | 0.20–0.22 | 0.56–0.77 s | 0.9 s | 899 MB | 401 MB | **0 / 0 %** |
| **Pocket TTS** (english / spanish) | CPU, 1 torch thread | 0.14–0.17 | 0.23–0.38 s; first chunk 42–57 ms | 2.4 s | 982 MB | 219 MB a language | 0–2.3 / 6.5 % |
| Pocket TTS `spanish_24l` | CPU, 1 torch thread | 0.48–0.52 | 0.87–0.99 s | 3.2 s | 2.3 GB | 672 MB | — / 4.3 % |
| Piper, high voices | CPU | 0.02–0.13 | 0.05–0.24 s | 1.3 s | 544 MB | 63–121 MB a voice | 0–4.7 / 4.3–6.5 % |
| Chatterbox Multilingual v2, 4-bit, mlx-audio | Metal | 0.42–0.43 | 0.90–1.01 s | **31 s the first time**; its load 1.9 s after | 1.3 GB RSS, 2.2 GB Metal | 1.1 GB | 2.3 / 6.5 % |
| Qwen3-TTS 0.6B CustomVoice, 4-bit, mlx-audio | Metal | ~0.3 when it stops | ~0.8 s | 9 s | 1.9 GB RSS, **12 GB Metal** | 1.7 GB | 4.7 / 52–67 % raw |

RTF is the time to make a sentence over the time it lasts, taken over the
sentences after the first; under 1 is faster than speech. "Warm 1st sentence"
re-renders the first sentence at the end of the run, which is the wait a reply
costs once the engine is up. "Process start → first audio" is import, load and
the first sentence of a fresh process with the model files already in the OS
cache, since the cache could not be purged without admin rights. Peak memory is
the maximum resident set; for MLX the Metal figure is MLX's own peak, since the
system's footprint figure appears to count reserved GPU address space.

**Reading the WER column.** Each language is one passage of about 45 words, so a
single wrong word is about two points. The column measures intelligibility — a
word skipped, garbled or misheard — and not naturalness: a flat voice that says
every word scores 0. Whether a voice sounds like a person is for your ears and
the samples, not for this table.

What the numbers, and the listening for them, showed:

- **Loanwords separate the engines.** In Spanish only Supertonic 3 (both voices)
  and `say`'s Paulina scored 0. Kokoro's espeak path gave "pool request"; Pocket
  gave "puyye", "puyereque" and "will" for "build"; Piper "pupquest" and "buil";
  Chatterbox heard "pull" as "build". In English the common miss was "build"
  heard as "bill" (Chatterbox, Pocket's alba, Qwen3's serena, Piper's ryan). A
  coding assistant says these words constantly, so this is the column's most
  useful row.
- **Qwen3-TTS ran away in 39 of 96 test takes** — every sentence, both voices,
  two temperatures, three takes each — going on babbling for 10–80 s after the
  sentence ended: `ryan` in 34 of 48, `serena` in 5 of 48, and a lower
  temperature barely helped. Keeping the shortest of four tries still left
  `ryan`'s Spanish at 21.7 % WER, and Metal peaked at 12 GB during runaways.
  `es-qwen3tts-serena-raw.wav` is what that sounds like: 100 s for four
  sentences. This is the 0.6B model at 4 bits, and only that. Reported on an M5
  Pro, Qwen3-TTS 0.6B's English round-trip WER is 15.58 % at 4 bits and 9.74 %
  at 8, against 3.47 % for the 1.7B at 4 bits ([25]), which points at the
  quantisation; the 6- and 8-bit builds were not tried here.
- **Pocket's `lola` in English** opens three of four sentences with 1.3–1.5 s of
  silence. Her Spanish does not. Pocket streams a first chunk in 42–57 ms, but
  Kururu plays whole sentences, and Pocket's whole sentence (0.23–0.38 s) is
  already about a quarter of Kokoro's.
- **Kokoro on MLX is the same voice four to ten times faster** — fed the
  identical phonemes and voice rows, 0.22–0.38 s for the first sentence against
  1.14–1.36 s. Its sentence times jumped between 70 ms and 1.2 s with no pattern
  by length, which looks like Metal compiling kernels for each new shape, and on
  MLX's CPU backend it was useless (RTF about 10). Reported elsewhere, Kokoro on
  MLX runs at 12–22× real time on M1 and M4 Max ([56]). The speed is real, and
  it costs a Python and MLX runtime Kururu does not have.
- **Chatterbox v2 is no faster than Kokoro here** (RTF 0.42), took 23 s to load
  and 6.4 s for its first sentence the first time it ever ran, and its Spanish
  is its English default voice speaking Spanish.
- **Supertonic 3 kept about six cores busy** while it spoke (101 s of CPU in
  17.5 s of wall clock). Much of that is Supertone's example helper juggling
  plain arrays (`Array.flat`, `Array.from`) around the ONNX calls, so a port to
  typed arrays should be cheaper. It renders at 44.1 kHz, the only engine above
  24 kHz.
- **`say` costs 0.7–1.1 s a sentence whatever its length**, because Kururu
  spawns `/usr/bin/say` for each one.

## How each route would sit in Kururu

Whatever is chosen inherits one constraint from
[`kokoro.ts`](../../server/src/kokoro.ts): a native inference runtime lives in a
process of its own that the server starts lazily, talks to over a narrow
protocol and ends with SIGKILL, so that the runtime's exit can never become the
server's. All four routes keep that shape; they differ in what the process is
and what it drags into the install and the signed app.

| route | engines it reaches | adds to the install | adds to the signed app | measured here |
|---|---|---|---|---|
| onnxruntime-node directly, in the existing voice process | Kokoro (today); Supertonic 3; Pocket through unofficial ONNX exports | the model, on first use | nothing — onnxruntime-node's darwin binaries are already in the builder's list | Kokoro, Supertonic 3 |
| sherpa-onnx-node | Supertonic 3 (int8), Piper, Kokoro in English and Chinese, Pocket in English | the models, on first use | a ~34 MB native addon with its own ONNX runtime | nothing |
| a Python sidecar (mlx-audio, pocket-tts) | nearly everything: Kokoro, Chatterbox, Qwen3, Pocket, Piper… | a Python with MLX (436 MB) or torch (784 MB), in the app or on first use | in the app, every `.so` and `.dylib` signed for the hardened runtime, plus MLX's metallib; on first use, nothing Kururu signs or notarizes | all the Python rows above |
| a Swift helper | CoreML: Kokoro, Pocket (FluidAudio); MLX: Pocket, Qwen3 and others (mlx-audio-swift); Apple's voices (AVSpeechSynthesizer) | the models, on first use | one more Mach-O beside the talk-key hook; MLX also needs Xcode to build its shaders | Apple's voices only |

**onnxruntime-node, in the process that already exists.** Supertonic 3 was
measured on the very onnxruntime-node 1.21.0 out of Kururu's `node_modules`,
through Supertone's MIT Node example, unchanged but for where it found the
runtime. The installed transformers.js 3.8.1 does have a Supertonic model class
and a `text-to-speech` pipeline for it, but for a different export: the three
graphs (`text_encoder`, `latent_denoiser`, `voice_decoder`) of onnx-community's
conversion of the first Supertonic ([57]), with no language argument. A
third-party export of Supertonic 2 documents the same pipeline with Spanish
([58]); none was found for Supertonic 3, which Supertone publishes as four
graphs (`duration_predictor`, `text_encoder`, `vector_estimator`, `vocoder`)
plus `unicode_indexer.json`. So the route is the example's ~560 lines over
onnxruntime-node directly, in the same process as Kokoro: one ONNX runtime, one
SIGKILL, and nothing new for
[`desktop/electron-builder.yml`](../../desktop/electron-builder.yml) to copy or
for codesign to sign. onnxruntime-node's README marks the CoreML execution
provider as supported on macOS arm64 ([59]), and the 1.21.0 darwin build in
Kururu's `node_modules` does contain it (checked here: its library and its
binding both name it); it was not tried for either model. Pocket TTS can come
this way too, through community ONNX exports ([60]), but its autoregressive loop
would have to be written in JavaScript by hand, and nothing about that path was
measured.

**sherpa-onnx-node** (1.13.8, Apache-2.0) is one native addon for many engines:
its darwin-arm64 package is about 34 MB with no Python ([61]), and it packages
Supertonic 3 for Spanish (`supertonic-3-es`) and eight Spanish Piper voices
([10]). Its Kokoro has English and Chinese front ends only, so Kokoro's Spanish
voices are out of reach through it ([62]), and its Pocket TTS is the English
model ([14]). It would bring a second ONNX runtime and a second native binary to
sign, which the voice process would contain as it contains the first. No Apple
Silicon numbers exist for it. For Supertonic alone it buys nothing over the
route above.

**A Python sidecar** is the only way to most of the quality tier. mlx-audio
(0.5.8, MIT) has the widest catalogue and an OpenAI-shaped `/v1/audio/speech`
server that keeps models loaded ([24]); Pocket TTS's own runtime is Python and
torch. Measured here, the MLX environment was 436 MB and Pocket's 784 MB,
Pocket's process took 2.4 s to its first audio (1.9 s of it importing torch),
and Chatterbox's first-ever start took 31 s. Inside the signed app, Apple's
guidance is to sign the interpreter and every `.so` and `.dylib` one by one,
inside out, for the hardened runtime, without `--deep`, with exception
entitlements likely on the interpreter ([63]); MLX wants its `mlx.metallib`
beside `libmlx`, which has fought with signing ([64]). For scale, Voicebox — a
Python TTS app on MLX and PyTorch — ships a 538 MB DMG ([65]). The other way is
to install the environment on first use under `~/.cache/kururu`, as LM Studio
fetches its MLX engine ([66]): files an app writes with its own code are not
quarantined, any more than curl's are, so Gatekeeper never examines them ([67]).
That is also its weakness — Kururu would be running code its notarization says
nothing about. Kururu already fetches weights on first use, but weights are
data. The process shape carries over: `spawn` instead of `fork`, stdio or HTTP
instead of IPC, SIGKILL as before.

**A Swift helper** is a pattern Kururu already has: the talk-key hook,
[`desktop/talkkey/talkkey.swift`](../../desktop/talkkey/talkkey.swift), built
with `swiftc` through `xcrun` and shipped as a bare Mach-O. FluidAudio (an
Apache-2.0 SDK on CoreML, through SwiftPM, with a macOS command line) lists
Pocket TTS with Spanish, streaming and cloning, Kokoro with Spanish through a
CoreML G2P and no eSpeak, and a beta Chatterbox Multilingual ([68]). Its README
also says TTS "currently supports American English only", and one July 2026 test
on an M4 Air found its Kokoro 1.5–1.8× slower than MLX with twice the memory, in
a debug build ([69]) — a prototype before a decision. MLX in Swift
(mlx-audio-swift lists Pocket TTS and Qwen3-TTS among others, [70]) needs Xcode:
"SwiftPM (command line) cannot build the Metal shaders" ([71]), plus the
metallib's placement. The talk-key hook already skips itself without Xcode; a
voice that needs Xcode to build is the same trade, made for something more
central. The same helper is the better road to Apple's voices whatever else is
chosen: AVSpeechSynthesizer addresses a voice by identifier and returns nil for
one that is missing rather than substituting Samantha, writes buffers as it goes
([72]), and returned first audio in 0.2–0.6 s here against `say`'s second a
sentence.

## Recommendation

**Keep Kokoro's `af_heart` for English.** Kokoro is the best-ranked small open
model in both blind arenas, nothing shippable is ranked clearly above it, and
the two small models that might challenge it — Supertonic 3 and Pocket TTS —
have never been put before listeners against it. Supertonic's English was also
error-free here and twice as quick to start, so if your ears prefer
`en-supertonic3-F1.wav` to `en-kokoro-af_heart.wav`, the same change below
covers English too; the evidence alone does not ask for it.

**For Spanish, try Supertonic 3 first — if the samples agree.** It was the only
engine with no transcription error in either language, on exactly the words
Kuru's replies are full of; it runs where Kokoro runs, with no new runtime, no
new binary to sign and no `espeak-ng`; and it reaches the first sentence in
0.56–0.77 s against Kokoro's 1.14–1.36 s. What is against it is real but
bounded. It is orphaned, so the revision that works is the last there will ever
be, and it should be pinned; if the Hub repository ever goes, mirroring it would
make Kururu a distributor, the case OpenRAIL-M's flow-down clause is written
for. Those terms require that its use restrictions be passed on to users when
the model is distributed, and one of them requires saying that machine-generated
content is machine-generated in contexts like bots ([5]) — trivially true of an
assistant called Kuru, but it must be said. Its accent is undocumented, it has
ten voices and no cloning, the download is 401 MB against Kokoro's 92, and it
held about 900 MB and six cores while it spoke.

**Pocket TTS is the choice if your ears prefer it, or if a voice of your own — a
clone — matters.** It is the one small model under active development, with 27
Spanish voices, CC-BY-4.0 weights and cloning, and only the older Piper was
faster here. It stumbled on the loanwords (6.5 % here), `lola` has to be trimmed
of leading silence in English, and every road to it from Node is a prototype:
Python and torch installed on first use, an unofficial ONNX export with a
hand-written loop, or FluidAudio in Swift.

**Not the quality tier, now.** The clean ones need a Python or MLX sidecar and
gigabytes, they win no blind test against Kokoro in English, Chatterbox v2 was
no faster than Kokoro and took half a minute to start the first time, and the
small Qwen3 cannot be left unattended. What might change that is untested:
Chatterbox v3 and its es-MX/LatAm pack, if a Latin American accent matters, and
Qwen3-TTS at 1.7B.

**Apple's voices are an open question with a cheap answer.** If an Enhanced
Paulina or Mónica beats Kokoro's Spanish to your ear, it is a choice in Settings
today, at `say`'s second a sentence and with nothing to ship.

In order:

1. **Listen.** `~/Desktop/kuru-voice-samples/`, the files named at the top.
   Naturalness is your call; nothing measured here can make it.
2. **Optionally, install Premium and Enhanced voices** and have them rendered
   and checked the same way, as described under macOS's voices — a few minutes
   once they are down. A few hundred megabytes each, your click, no change to
   Kururu.
3. **Optionally, approve the downloads over the 2 GB budget** — Chatterbox
   Multilingual v3 and the es-MX/LatAm pack (about 3.2 GB each) and Qwen3-TTS
   1.7B at 4 bits (about 2.3 GB) — if a winner from the quality tier would be
   worth a sidecar to you. If not, skip it.
4. **Then build the winner.** For Supertonic 3, the list follows.

Separately, and cheaper than any of it: if Kokoro stays for Spanish and only the
accent grates, `-v es-419` instead of `-v es` in `phonemesEs` is a one-flag
experiment, untried — Kokoro learned its Spanish from `es` phonemes, and
`modelPhonemes` may want a substitution more.

### What switching would take

For Supertonic 3 as a third engine, chosen per language. Everything here is
server, shared and web code: editing `server/src/voice.ts` and `kokoro.ts` costs
a reconnect, and nothing touches the pty host or anybody's agents.

1. **[`shared/voice.ts`](../../shared/voice.ts).** `VoiceEngine` becomes
   `"kokoro" | "supertonic" | "system"`. A `SUPERTONIC_VOICES` catalogue of
   F1–F5 and M1–M5, each offered under both languages, since one style speaks
   all 31 — unlike Kokoro's, whose voices each belong to one. A pinned model:
   `Supertone/supertonic-3` at revision `3cadd1e`, about 401 MB, the number for
   the sentence beside the download button. `adoptVoice` accepts the new engine.
   The module's header, which says speech is Kokoro, is brought up to date. The
   defaults stay as they are until the samples say otherwise.
2. **The voice process, [`server/src/kokoro.ts`](../../server/src/kokoro.ts).**
   It hosts both engines rather than a second process being added beside it:
   `load` names the engine and its files, `speak` carries the language for
   Supertonic, and there is still one ONNX runtime and one SIGKILL. Supertonic
   is four `InferenceSession`s, the unicode indexer, the style JSON and the
   denoising loop — a port of Supertone's MIT example, its notice kept, on typed
   arrays. It was measured at 8 denoising steps and speed 1.05; Supertone's
   published speeds for Supertonic 2 use 2 and 5 steps ([73]), which is speed to
   buy if the quality holds.
3. **[`server/src/voice.ts`](../../server/src/voice.ts).** `resolve` and
   `synthesize` learn the engine; Spanish through Supertonic skips `phonemesEs`
   and no longer needs `espeak-ng`, so the Spanish tool status becomes Kokoro's
   alone. The one speed slider maps onto Supertonic's own speed as it already
   maps onto `say`'s rate, and its 44.1 kHz WAVs need nothing, since the player
   already takes 22 and 24 kHz and lets the browser resample
   ([voice](../voice.md#gotchas)). The model status becomes one per model.
   Kokoro's files arrive through transformers.js's `from_pretrained`;
   Supertonic's would be fetched by name at the pinned revision into the same
   cache, `~/.cache/kururu/models`, with progress on the socket as now. Whether
   transformers.js's own hub helpers can fetch a repository it has no model
   class for was not checked. `status()` lists the new voices, and `say` stays
   the fallback for anything that cannot speak.
4. **Settings → Voice, in `web/`.** A second download, its size, the new voices
   under each language, and a line naming the weights' licence.
5. **Packaging: nothing new.** `desktop/build.mjs` already keeps
   onnxruntime-node external and `electron-builder.yml` already copies its
   darwin binaries; the bundled voice process grows by the port. The voice stack
   in a built DMG is itself still unverified ([voice](../voice.md#gotchas)).
6. **Licence.** An acknowledgement for the Supertonic weights that carries
   OpenRAIL-M's use restrictions, which the licence requires be passed on when
   the model is distributed ([5]). Kururu fetches weights rather than shipping
   them, which is arguably not distributing them; it is simpler not to lean on
   that.
7. **Tests** for the pure parts (`bun test`): the catalogue, `adoptVoice` with
   the new engine, and the language tagging if it is lifted into a function.
8. **Docs.** [voice](../voice.md) — the mouth in "The pieces", "Two languages",
   "Installing" — and a gotcha recording that the upstream is archived and the
   revision pinned on purpose.

Choosing Pocket TTS instead adds a decision this list does not have to make —
which runtime — trims `lola`'s leading silence, and changes the licence line to
CC-BY-4.0 attribution for Kyutai, plus whatever its per-voice licence page says,
which was not read ([13]). Choosing an Apple voice takes nothing; replacing the
`say` spawn with an AVSpeechSynthesizer helper is worth doing for its own sake,
and it should check that a rendered buffer is not empty, given the reports of
Premium voices producing silence.

## Open questions

- **Naturalness.** No independent listening test of Spanish exists for any
  candidate, and of the candidates here the arenas cover only Kokoro, Chatterbox
  and Magpie, in English. The samples and your ears are the test.
- **Supertonic 3's Spanish accent**, undocumented, and its Spanish WER,
  published only as a chart ([4]). Also untried: Supertonic 2, smaller (66M)
  with Spanish among five languages, which Supertone reports at 8–11× Kokoro's
  throughput on an M4 Pro CPU ([73]) — a vendor measuring itself against a
  competitor — and which may load through the transformers.js Kururu has.
- **Owed, over the 2 GB budget:** Chatterbox Multilingual v3 — MLX fp16 2,713 MB
  plus the 495 MB S3 tokenizer, or about 3.2 GB of PyTorch weights plus torch;
  Resemble's `Chatterbox-Multilingual-es-mx-latam`, about 3.2 GB; Qwen3-TTS 1.7B
  CustomVoice at 4 bits, 2,312 MB; the official Qwen3-TTS 0.6B in bf16, 2,498
  MB. **Owed within it:** Qwen3-TTS 0.6B at 6 bits (1,834 MB) and 8 bits (1,974
  MB), which would say whether the runaways are the quantisation.
- **Pocket TTS cloning** needs the gated `kyutai/pocket-tts` weights: accepting
  Kyutai's terms on the Hub, which prohibit cloning without consent, and `hf
  auth login` ([11]). That is your call, and it was not made. Whether an English
  voice cloned into Spanish keeps an English accent is unknown. Pocket's
  per-voice licences were not read.
- **Apple's voices**, every question above: whether Premium or Enhanced beats
  Kokoro, how `say` lists them on macOS 27, and whether the Tahoe reports of
  silent Premium voices hold on 27.
- **Runtime unknowns.** Electron's node against Node 24 for every timing; the
  CoreML execution provider for Kokoro or Supertonic; whether Kokoro at fp32 or
  fp16 is faster than q8 on this CPU; sherpa-onnx on Apple Silicon at all, and
  how its espeak-ng data squares with the GPL ([48], [49]).
- **Text Kuru actually says.** Two passages are not a corpus. Numbers, version
  strings, file paths and code names in Spanish were tested by no source for any
  model.

## Sources

1. [Artificial Analysis, open-weights speech leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice/open-weights)
2. [TTS Arena V2, live leaderboard JSON (read 2026-10-11)](https://tts-agi-tts-arena-v2.hf.space/api/leaderboard)
3. [hexgrad, Kokoro-82M VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
4. [supertone-inc/supertonic (archived 2026-09-09)](https://github.com/supertone-inc/supertonic)
5. [Supertonic 3 LICENSE (BigScience OpenRAIL-M)](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE)
6. [hexgrad, Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M)
7. [npm registry, kokoro-js](https://registry.npmjs.org/kokoro-js)
8. [npm, @huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers)
9. [npm, onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)
10. [sherpa-onnx, Spanish TTS models](https://k2-fsa.github.io/sherpa/onnx/tts/all/Spanish/index.html)
11. [kyutai/pocket-tts model card](https://huggingface.co/kyutai/pocket-tts)
12. [Gradium, Phonon Multilingual evaluation (vendor, July 2026)](https://gradium.ai/blog/phonon-multilingual-smaller-clearer-better)
13. [kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts)
14. [sherpa-onnx, PocketTTS](https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html)
15. [kyutai/pocket-tts-without-voice-cloning](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning)
16. [kyutai/pocket-tts, languages/spanish file listing](https://huggingface.co/kyutai/pocket-tts/tree/main/languages/spanish)
17. [rhasspy/piper-voices, Spanish voices](https://huggingface.co/rhasspy/piper-voices/tree/main/es)
18. [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)
19. [CSTR, Blizzard 2013 Lessac data licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html)
20. [nvidia/magpie_tts_multilingual_357m model card](https://huggingface.co/nvidia/magpie_tts_multilingual_357m)
21. [ResembleAI/chatterbox file listing](https://huggingface.co/ResembleAI/chatterbox/tree/main)
22. [ResembleAI/chatterbox model card](https://huggingface.co/ResembleAI/chatterbox)
23. [Resemble AI, Chatterbox Multilingual](https://resemble.ai/learn/models/chatterbox-multilingual)
24. [Blaizzy/mlx-audio](https://github.com/Blaizzy/mlx-audio)
25. [soniqo.audio, Apple Silicon TTS benchmarks (M5 Pro)](https://soniqo.audio/benchmarks)
26. [Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
27. [AppleVis, comment 138704 (2022)](https://applevis.com/comment/138704)
28. [AnkiWeb forums, support for premium TTS voices in Apple (2025)](https://forums.ankiweb.net/t/please-add-support-for-premium-tts-voices-in-apple/63592)
29. [Apple, macOS Tahoe 26 software licence agreement, section 2F](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)
30. [Apple Support, create a Personal Voice on Mac](https://support.apple.com/guide/mac-help/mchldfd72333/mac)
31. [OrcaRouter, Breeze TTS 2 tops the open-weights arena](https://www.orcarouter.ai/blog/breeze-tts-2-tops-open-weights-speech-arena)
32. [fishaudio/s2-pro model card](https://huggingface.co/fishaudio/s2-pro)
33. [DataNorth, Mistral releases Voxtral TTS](https://datanorth.ai/news/mistral-releases-voxtral-tts-open-weight-text-to-speech-model)
34. [stepfun-ai/Step-Audio-EditX model card](https://huggingface.co/stepfun-ai/Step-Audio-EditX)
35. [bosonai/higgs-audio-v3-tts-4b model card](https://huggingface.co/bosonai/higgs-audio-v3-tts-4b)
36. [NeuTTS Open License 1.0](https://github.com/neuphonic/neutts/blob/main/LICENSE)
37. [neuphonic/neutts-nano-spanish model card](https://huggingface.co/neuphonic/neutts-nano-spanish)
38. [KittenML/KittenTTS](https://github.com/KittenML/KittenTTS)
39. [ekwek1/soprano](https://github.com/ekwek1/soprano)
40. [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox)
41. [FunAudioLLM/Fun-CosyVoice3-0.5B-2512 model card](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
42. [openbmb/VoxCPM](https://github.com/openbmb/VoxCPM)
43. [Supertone/supertonic-3 on Hugging Face](https://huggingface.co/Supertone/supertonic-3)
44. [kyutai-labs/pocket-tts releases](https://github.com/kyutai-labs/pocket-tts/releases)
45. [EryriLabs/pocket-tts-GGUF (community notes)](https://huggingface.co/EryriLabs/pocket-tts-GGUF)
46. [Piper es_AR daniela high, MODEL_CARD](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_AR/daniela/high/MODEL_CARD)
47. [Piper es_MX claude high, MODEL_CARD](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD)
48. [espeak-ng README (GPL-3.0-or-later)](https://github.com/espeak-ng/espeak-ng)
49. [GNU GPL FAQ, mere aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
50. [Apple, AVSpeechSynthesisVoiceQuality.premium](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality/premium)
51. [Scriptation, Are there better playback voices available? (updated 2026-08-10)](https://help.scriptation.com/en/article/are-there-better-playback-voices-available-wbbvl2/)
52. [Apple Support, change the voice your Mac uses to speak text](https://support.apple.com/en-ca/guide/mac-help/mchlp2290)
53. [Apple Developer Forums 787779, downloading Premium voices programmatically](https://developer.apple.com/forums/thread/787779)
54. [WWDC20 session 10022, Create a seamless speech experience](https://developer.apple.com/videos/play/wwdc2020/10022/)
55. [Apple Developer Forums 787959, Siri voice identifiers in the 26 beta](https://developer.apple.com/forums/thread/787959)
56. [vllm-mlx, audio benchmarks](https://vllm-mlx.is-a.dev/benchmarks/audio/)
57. [onnx-community/Supertonic-TTS-ONNX](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX)
58. [BeyondWordsAI/Supertonic-TTS-2-ONNX](https://huggingface.co/BeyondWordsAI/Supertonic-TTS-2-ONNX)
59. [microsoft/onnxruntime, js/node README](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md)
60. [soniqo/Pocket-TTS-100M-ONNX-INT8 (community ONNX export)](https://huggingface.co/soniqo/Pocket-TTS-100M-ONNX-INT8)
61. [npm registry, sherpa-onnx-darwin-arm64](https://registry.npmjs.org/sherpa-onnx-darwin-arm64/latest)
62. [sherpa-onnx, Kokoro models](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)
63. [Apple Developer Forums 765679, signing an embedded Python](https://developer.apple.com/forums/thread/765679)
64. [ml-explore/mlx issue 1286, metallib and code signing (mirror)](https://upd.dev/ml-explore/mlx/issues/1286)
65. [jamiepine/voicebox, latest release assets (GitHub API)](https://api.github.com/repos/jamiepine/voicebox/releases/latest)
66. [LM Studio, MLX](https://lmstudio.ai/mlx)
67. [Apple Developer Forums 127694, quarantine and Gatekeeper](https://developer.apple.com/forums/thread/127694)
68. [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio)
69. [dokterbob/macos-speech-server issue 26 (MLX vs FluidAudio Kokoro, M4 Air)](https://github.com/dokterbob/macos-speech-server/issues/26)
70. [Blaizzy/mlx-audio-swift](https://github.com/Blaizzy/mlx-audio-swift)
71. [ml-explore/mlx-swift](https://github.com/ml-explore/mlx-swift)
72. [Apple, AVSpeechSynthesizer.write(_:toBufferCallback:)](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write%28_:tobuffercallback:%29)
73. [Supertone/supertonic-2 on Hugging Face (speeds on an M4 Pro CPU)](https://huggingface.co/Supertone/supertonic-2)

[1]: https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice/open-weights
[2]: https://tts-agi-tts-arena-v2.hf.space/api/leaderboard
[3]: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
[4]: https://github.com/supertone-inc/supertonic
[5]: https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE
[6]: https://huggingface.co/hexgrad/Kokoro-82M
[7]: https://registry.npmjs.org/kokoro-js
[8]: https://www.npmjs.com/package/@huggingface/transformers
[9]: https://www.npmjs.com/package/onnxruntime-node
[10]: https://k2-fsa.github.io/sherpa/onnx/tts/all/Spanish/index.html
[11]: https://huggingface.co/kyutai/pocket-tts
[12]: https://gradium.ai/blog/phonon-multilingual-smaller-clearer-better
[13]: https://github.com/kyutai-labs/pocket-tts
[14]: https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html
[15]: https://huggingface.co/kyutai/pocket-tts-without-voice-cloning
[16]: https://huggingface.co/kyutai/pocket-tts/tree/main/languages/spanish
[17]: https://huggingface.co/rhasspy/piper-voices/tree/main/es
[18]: https://github.com/OHF-Voice/piper1-gpl
[19]: https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
[20]: https://huggingface.co/nvidia/magpie_tts_multilingual_357m
[21]: https://huggingface.co/ResembleAI/chatterbox/tree/main
[22]: https://huggingface.co/ResembleAI/chatterbox
[23]: https://resemble.ai/learn/models/chatterbox-multilingual
[24]: https://github.com/Blaizzy/mlx-audio
[25]: https://soniqo.audio/benchmarks
[26]: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
[27]: https://applevis.com/comment/138704
[28]: https://forums.ankiweb.net/t/please-add-support-for-premium-tts-voices-in-apple/63592
[29]: https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
[30]: https://support.apple.com/guide/mac-help/mchldfd72333/mac
[31]: https://www.orcarouter.ai/blog/breeze-tts-2-tops-open-weights-speech-arena
[32]: https://huggingface.co/fishaudio/s2-pro
[33]: https://datanorth.ai/news/mistral-releases-voxtral-tts-open-weight-text-to-speech-model
[34]: https://huggingface.co/stepfun-ai/Step-Audio-EditX
[35]: https://huggingface.co/bosonai/higgs-audio-v3-tts-4b
[36]: https://github.com/neuphonic/neutts/blob/main/LICENSE
[37]: https://huggingface.co/neuphonic/neutts-nano-spanish
[38]: https://github.com/KittenML/KittenTTS
[39]: https://github.com/ekwek1/soprano
[40]: https://github.com/resemble-ai/chatterbox
[41]: https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
[42]: https://github.com/openbmb/VoxCPM
[43]: https://huggingface.co/Supertone/supertonic-3
[44]: https://github.com/kyutai-labs/pocket-tts/releases
[45]: https://huggingface.co/EryriLabs/pocket-tts-GGUF
[46]: https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_AR/daniela/high/MODEL_CARD
[47]: https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD
[48]: https://github.com/espeak-ng/espeak-ng
[49]: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
[50]: https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality/premium
[51]: https://help.scriptation.com/en/article/are-there-better-playback-voices-available-wbbvl2/
[52]: https://support.apple.com/en-ca/guide/mac-help/mchlp2290
[53]: https://developer.apple.com/forums/thread/787779
[54]: https://developer.apple.com/videos/play/wwdc2020/10022/
[55]: https://developer.apple.com/forums/thread/787959
[56]: https://vllm-mlx.is-a.dev/benchmarks/audio/
[57]: https://huggingface.co/onnx-community/Supertonic-TTS-ONNX
[58]: https://huggingface.co/BeyondWordsAI/Supertonic-TTS-2-ONNX
[59]: https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md
[60]: https://huggingface.co/soniqo/Pocket-TTS-100M-ONNX-INT8
[61]: https://registry.npmjs.org/sherpa-onnx-darwin-arm64/latest
[62]: https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html
[63]: https://developer.apple.com/forums/thread/765679
[64]: https://upd.dev/ml-explore/mlx/issues/1286
[65]: https://api.github.com/repos/jamiepine/voicebox/releases/latest
[66]: https://lmstudio.ai/mlx
[67]: https://developer.apple.com/forums/thread/127694
[68]: https://github.com/FluidInference/FluidAudio
[69]: https://github.com/dokterbob/macos-speech-server/issues/26
[70]: https://github.com/Blaizzy/mlx-audio-swift
[71]: https://github.com/ml-explore/mlx-swift
[72]: https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write%28_:tobuffercallback:%29
[73]: https://huggingface.co/Supertone/supertonic-2
