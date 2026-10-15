# The voice

Talking to Kuru, the profile's harness, and hearing it answer. Hold the right
Control key and speak; let go and the words go to the harness as a turn. When
its turn ends, its last message is read aloud — whether you spoke or typed,
and never while you are talking.
Settings → Voice picks the key, the languages and the voices.

The argument is in the header of `shared/voice.ts`: the voice is **not a
second brain**. Speech-to-speech models in front of a coding agent give you
two personalities and a bill per minute for the one that only talks. Kuru is
the Claude Code session `harness.md` describes, and what is added is a pair
of ears and a mouth around it. Nothing in between generates a word, and
nothing of the voice leaves the machine: audio is heard and made here. A
channel, if you switch one on, is another matter — Telegram carries the
conversation's *text*, never its audio; see [channels](channels.md).

## The pieces

| piece | where | what |
|---|---|---|
| The talk key | `web/src/voice.ts` | A capture-phase keydown/keyup pair on the window. Down starts recording at once; up within 320 ms is a tap and leaves the microphone open until the next tap; a longer hold sends on release. Escape drops the clip, and stops Kuru mid-reply — see [Escape](#escape). The window losing focus with the key down sends what there is. |
| The microphone | `web/src/voice.ts` | PCM off an `AudioWorklet`, 16 kHz mono, written as a WAV by hand (`encodeWav`) and posted to `/api/voice/hear` under an id the page mints. Not a `MediaRecorder`: it writes WebM/Opus, which Apple's recogniser will not open. Five minutes in (`CLIP_ROLL_MS`) what there is goes as a message of its own and the recording carries on. |
| The stash | `web/src/unsent.ts` | Every clip is written to IndexedDB before it is posted and dropped only once the server answers that it has it; sent again on a backoff, on every reconnect, and by the next page to load. See [nothing you say is lost](#nothing-you-say-is-lost). |
| The outbox | `server/src/outbox.ts` | The clip on the server's disk the moment it arrives, its words beside it once they are made, handed to Kuru in order and kept until Kuru's own session says it took them. Survives restarts; retries a failed transcription and an unconfirmed delivery. |
| The ears | `server/src/voice.ts` `transcribe` → `yap` | Apple's on-device recogniser, one model per locale, through a Homebrew command line, reading the outbox's file where it lies. The clip is transcribed once per language you speak, in parallel, and `pickTranscript` keeps the one with the language in it. |
| The words in | `Harness.hear` | Prefixed `[voice]` so Kuru knows a name may be misheard, and typed into its terminal with `now`, as `send_agent` types: a harness mid-turn hears it between tool calls, one showing a prompt or with your hands in its terminal hears it after. Typed and not posted to its inbox, because Claude Code makes everything on the inbox another session's message — see [harness](harness.md#speaking-into-a-running-agent) — and these are your words. Not running, it is started, and the words wait for its first hook report. It tells the outbox when they are typed, or dropped with a harness that went first. |
| The words out | `index.ts` `/api/report` → `Voice.spoke` | The harness's own Stop report carries `last_assistant_message`; when the reporter is a profile's harness, that reply is spoken — unless the turn answered only a message from Telegram, whose reply is already on the phone (see [channels](channels.md#is-the-reply-spoken-on-the-mac)). The role prompt tells Kuru its final message is heard, not read. The `say` tool speaks one line mid-turn. |
| The mouth | `server/src/voice.ts` → `kokoro.ts`, or `say` | Kokoro-82M on the CPU through `kokoro-js`, in a process of its own that the server forks on the first sentence and kills with it, a sentence at a time, each announced on the socket as a `speech` chunk the moment it is ready. The Mac's own `say` voices are the fallback that needs nothing. |
| The lab | `server/src/voicelab.ts` → `server/voicelab.py` | Engines on trial against Kokoro — Supertonic 3, Pocket TTS, Chatterbox, Qwen3-TTS — in Python processes of their own, offered in Settings → Voice when their files are in `~/.cache/kururu/voicelab`. See [the voice lab](#the-voice-lab). |
| The player | `web/src/voice.ts` | Fetches each chunk from `/api/speech` and plays them in order on the page's one `AudioContext` (`notify.ts`). The talk key cuts Kuru off, and so do the pill's ✕ and Escape. Tells the server what became of each reply: held, each sentence played to its end, or let go before it. |
| The hush | `server/src/voice.ts` `talk` | Nothing plays while anybody talks, and what waited plays after — see [below](#never-over-you). |
| The missed list | `server/src/voice.ts` `review`, `replay`, `seen` | Every reply nobody played to its end, kept as words in the database (see [data](data.md)) — see [what you missed](#what-you-missed). Not a message of its own: it is merged into the conversation below. |
| The conversation | `shared/kuru.ts`, `server/src/kuru.ts` | The harness's turns out of the database, your messages out of the outbox and each reply's fate off the missed list, as one list per profile with two counts — the `kuru` message, sent on connect and on every change, and paged back through `GET /api/kuru`. See [the drawer](#the-drawer). |
| The drawer | `KuruDrawer.tsx` | The conversation, beside the panes on a desktop (narrowing them, like the sidebar) and the whole screen on a phone: every message of yours with its state, every reply with its fate, a live row for what Kuru is doing, and a composer that types to Kuru through the outbox. Opened by the chip, the harness key, a tap on the pill, the floating pill and the menu bar. |
| The chip | `StatusBar.tsx` `sb-kuru` | The one door onto the drawer, the second of the status bar's two drawer chips (the first is what needs you). Its mark is what Kuru is doing — a dim dot, the mascot hopping while it thinks, the speaker glyph while it speaks, the blocked ink and "asking" on a prompt, "off" when not running — and its news is text inside it: a red count with the mic for messages that did not get through. In flight and all delivered are not news and get no mark. It carried a count of unheard replies until 2026-10-12; the drawer marks each where it sits, which is all the count led to. |
| The pill | `VoicePill.tsx` | A level meter and a line, over the panes, zen included. Says which gesture ends the recording, what was heard and where it went, what Kuru is saying. Dragged anywhere in the window by mouse or finger and drawn where this device left it (`web/src/place.ts`); a double click puts it back. Its ✕ is `dismissVoice`: Kuru stops mid-word and the rest of the reply, and what was queued behind it, is marked unheard; a clip being recorded is thrown away; words lingering go. Escape is the same ✕ while Kuru speaks. A plain click — one that travelled less than the drag's own slop, and landed outside the ✕ — toggles the drawer at the reply the pill is showing: open it unless it is already open, in which case this closes it, so a pill that only ever shows its last line is one tap from the whole conversation and one tap back. The pill is the live indicator; the drawer is the record. |
| The button | `KuruDrawer.tsx` `kuru-mic` | The key for a thumb, in the drawer's composer: held, it records; tapped, it toggles. How a phone talks. It was on the status bar beside the chip until 2026-10-12 — two controls for one conversation, one of them on every device's one strip. |

## Never over you

While the talk key is down on any client, no client plays a word, and that
lasts until the words have been heard and handed to Kuru — the length of the
pill's "sending", not only of the key. A page says `talking` on the press
and again once the server has its clip on the disk, or the clip was thrown
away; from there the outbox says it for that clip until its first attempt at
Kuru is over (handed over, or failed), so the page can let go the moment its
words are safe. The server tells every page `hush` while anybody is talking. The press cuts
off what was playing, on every page — the phone on the desk is as loud as
the window — and a sentence that arrives during the hush waits in the
queue. Sentences go on being made, so what waited is ready when the hush
lifts.

When it lifts, **what waited plays, in the order it was said**, and every
reply that waited starts with "While you were talking." ("Mientras
hablabas." in Spanish) so it is not taken for the answer to what you just
said. That answer is made after them — utterances are made one at a time,
in order — so it plays after them and nothing overlaps. Whether the words
got through makes no difference to this: a clip thrown away with Escape
leaves the replies that came during it just as unheard.

The lead-in is decided at the last moment it can be, when a reply's first
sentence is made and about to go out: the reply was said while somebody was
talking, or somebody is talking now. It is its own short sentence, made in
the reply's language and voice, a fraction of a second for two words.

It used to be otherwise. Words that reached Kuru **dropped** every reply of
its made before them, on the argument that Kuru would answer with that reply
in front of it, so hearing it first was being talked over twice. The reply
that was dropped said the Pasapy poster generator was done, and Kuru
answering something else does not repeat news. The cost of keeping them is
a few seconds before the answer starts; the cost of dropping them was
finding out an hour later.

What the press cut off, and what was queued behind it on that page, is not
replayed after the hush: cutting it off was what the press was for. It goes
to the missed list instead.

## Escape

Escape is the voice's in two moments and no others: while a clip is being
taken, which it drops, and while Kuru is mid-reply, which it stops. Stopping
is the pill's ✕ itself — `voiceEscape` calls `dismissVoice` — so the reply
and everything queued behind it are let go, land unheard in the drawer and
on the chip's count, and nothing more of them is made. Any other Escape is
not the voice's and goes where it always went: to the terminal, the dialog,
the drawer, the prefix. Escape for something else while Kuru talks — closing
a dialog, leaving insert mode — stops Kuru first, and the next Escape does
what it was for.

"Mid-reply" is the phase `speaking`, and it lasts through the moment between
two sentences while the next is still being made (`between`), since to
anybody listening Kuru has not finished. It is held for at most `GAP_MS`,
five seconds, because a reply whose last sentence the engine choked on never
says it was the last. The phase rather than the player, because the phase is
what the pill reports to every window, and the window and the pill must
agree on whether an Escape was the voice's.

Where it is heard, and what else gets it:

| the talk key | where Escape is pressed | Kuru | the app in front |
|---|---|---|---|
| everywhere, hook live | another application | stopped — the hook's `escape` reaches the pill | **gets it too**: the tap only listens. An agent in another terminal app is interrupted |
| everywhere, hook live | Kururu's window | stopped — by the hook, and by the window forwarding it | does not: the window takes it in the capture phase, before the prefix and the terminal |
| window only | Kururu's window | stopped | does not, as above |
| window only | another application | not heard | gets it, as ever |
| any | the phone's key bar **esc** | not heard | gets it: that bar exists to reach the terminal, and the pill's ✕ is there for Kuru |

In the window the decision is made from the pill's phase as last reported
(`remotePhase`), a few milliseconds old: an Escape in the instant Kuru
finishes can be taken and do nothing, and the next one goes through. The
key the window forwards and the key the hook sent are the same press, and
the second finds nothing to stop.

Swallowing Escape in other applications would need an active tap, which
needs Accessibility; the hook asks for Input Monitoring and nothing else, so
this does not.

## Nothing you say is lost

**What lost a message on 2026-10-09**, twice: its length. The server took a
clip of at most 3 MB — a minute and thirty-eight seconds at 16 kHz — and
refused a longer one by destroying the request mid-upload. The window saw a
reset connection and said "Could not send the clip", and in the same moment
lifted the hush, so Kuru's reply that had waited out the recording started
and its first sentence took the pill's one line. The error was on screen for
a frame. The audio had only ever been in the page's memory, and went with
the failed upload. Of the hundred-odd voice turns that had reached Kuru, the
longest was 241 words, about the length of that cap; "long-ass message" is
what both lost ones were called. Kuru's reply did not cancel the message —
it hid that it had failed.

Every piece of that is now kept somewhere that survives it:

1. **On the release**, the clip is written to IndexedDB (`unsent.ts`) and
   posted under an id the page minted. A server that is down, restarting or
   refusing is tried again — 1, 2, 5, 10, then every 30 seconds, and at once
   on every reconnect — and a reloaded page finds its clips and sends them on
   start. The id makes a repeat the same message. A clip has no length past
   which it stops counting: the window rolls a recording into a new clip
   every five minutes, and the server's cap (`CLIP_MAX_BYTES`, six minutes)
   is a backstop it never reaches, answered with 413 and why when it is.
2. **On arrival**, the outbox writes the audio, then its entry in
   the database ([data](data.md)), and only then answers. The
   page drops its copy on that answer.
3. **Transcribing**: the recogniser reads the file. Failing to run is tried
   again at 3, 10 and 30 seconds (`transcribeRetryMs`), then the message is
   `failed` with its audio kept. Running and hearing nothing is `failed` at
   once — "Nothing heard" — audio kept. Resend hears it again.
4. **Queued**: the words are written into the entry, and the message is
   handed to the harness once every earlier message of its profile is past
   transcribing (`handable`), so Kuru gets them in the order they were said.
   A busy, asking or starting Kuru holds them in its own list, which is
   memory — and so the outbox hands every queued, untyped message over again
   after a restart, not before the harness has adopted its terminals.
5. **Typed** is not delivered. Kuru's `UserPromptSubmit` hook reports the
   prompt it took, and its transcript records it — or the queue entry for a
   message typed mid-turn — and either carrying the words (`promptCarries`)
   is **delivered**; the audio is removed and the words stay on the list. A
   typed message Kuru has had its chance at — between turns for fifteen
   seconds since the typing, or not running — and does not have is typed
   once more, then failed. Twice in the prompt box is better than never; a
   third time would be a loop. A Kuru that exits holding words is started
   again for them once, then they fail.

The list keeps every message still on its way and every failed one, and the
newest twenty delivered per profile (`OUTBOX_KEEP`). A failed one is the one
with something to do: **Resend** (or **Listen again**, for one with no words
yet) or **Discard**, which takes the audio off the disk too — both inline on
the message in the drawer. The page adds two states of its own above the
server's: `recording`, and `saving` for a clip the server does not have yet.

**A line typed in the drawer's composer takes the same road** (`kuru-say`,
`Outbox.say`): it joins the list as `queued` with its words already made, goes
to Kuru in order with whatever was said before it, is confirmed by Kuru's own
prompt hook, and is typed again once or failed on the same rules. No clip, so
nothing to hear and `ms` is zero, which is how the two are told apart
(`spokenMessage`); it is typed without the `[voice]` prefix, since nothing in
it was misheard. This is how the phone talks to Kuru today: playback works
over plain http, and only the microphone needs the secure context.

## What you missed

A reply that **nobody played to its end** is kept, as words, on a list per
profile. Three ways onto it:

- **Let go** — the pill's ✕ or Escape, the talk key's press, or a sentence
  a page could not fetch. A reply with a hole in it was not heard.
- **Nobody listening** — no window or phone open, or none that could play
  (no audio output, or the speech volume at zero). It is counted missed two
  seconds after its last sentence is made, if nobody has taken it up.
- **The server went** while it was being said, which under `bun run dev` is
  every save: the page's next fetch finds a new server that never made it.

The server decides, from what the pages tell it. A page says it **holds** a
reply when the first sentence reaches it, says each sentence it **played**
to its end, and says when it **let go** of one before its end
(`speech-held`, `speech-played`). A reply whose last sentence somebody
played was heard — the end and not every sentence, since a page that came
in half way heard how it came out. One that everybody holding it let go is
missed at once, and nothing more of it is made, which lets whatever is
queued behind it start sooner. A page that never says anything — one from
before this change, or one with nothing to play on — has no say, which is
why a reply nobody holds is missed and not "probably heard".

The list is in the database, keyed by the profile's key rather than its
session id — three host restarts in one morning once orphaned every entry
keyed by id — and every reply is
written to it, pending, the moment it is said, so a server that dies with a
reply in flight leaves that reply missed rather than forgotten. Each profile
keeps its newest thirty (`MISSED_MAX`).

**Getting them back.** The drawer marks each unheard reply where it sits
in the conversation, with a **Play** of its own; the status bar's chip
carried the count until 2026-10-12 and no longer does. Saying (or typing) "what did I miss?" to Kuru
plays all of them, oldest first, each starting "Earlier.": the role tells it
to call `play_missed`, which queues them and hands their words back to it so
it ends its turn with a line rather than a retelling. The menu bar's **Play**
is the same `Voice.replay`, through `POST /api/kuru/play`. The drawer's
header had **Play unheard** and **Mark all heard** buttons too, and they went
on 2026-10-12: nobody could say what they were for. A replay heard to its end takes
its reply off the list; one cut off leaves it there, and a replay is never
put on the list itself.

**Unheard means neither heard nor seen.** A reply also leaves the list when
it has been in view in the open drawer for about two seconds
(`KURU_SEEN_MS`, the `kuru-seen` verb, `Voice.seen`) — the count's job is to
bring you to the drawer, and once you are there it has done it; a count that
survived reading would teach you to ignore it. Opening the drawer is not
seeing: a glance at a long list is not reading the reply at the top of it,
so the drawer watches which replies are actually on screen.

A running harness keeps the tools and role it was started with (see
[harness](harness.md#gotchas)); `play_missed` is there from its next start.
The chip and the drawer work without it.

## The drawer

One place, one timeline: `KuruDrawer.tsx`, beside the panes, a flex sibling
of `.stage` about 420px wide that narrows it the way the sidebar does, rather
than a panel floated over it. It does not dim the terminals, because you read
Kuru's answer while watching the agent it talks about, and a click into them
is just a click into the layout — on a desktop only its own close button,
the chip, or `Esc` (from anywhere but its composer) closes it. On a narrow
window it is a full-screen sheet with the usual close button, one sheet at a
time, like the board and the databases, and there a click outside does close
it. The harness key (`C-a a`) opens and
shuts it; **Terminal** in its header is the old `open-harness` — started,
resumed or revealed. The speaker in its header is Settings → Voice's **Speak
replies**, the same setting written through the same `set-voice`, so the two
always agree: a speaker while replies are read aloud, struck through while
they are only on screen. Muting also stops a reply already audible, through
the pill's ✕, so it lands unheard. A reply's own **Play** and `play_missed`
still speak while it is off — muting is about replies arriving, not about
replies you ask for — and so, as the setting stands, does a line Kuru says
mid-turn through `say` (`sayAside` does not read it).

What is in it is the server's `kuru` message, merged once on the server
(`shared/kuru.ts` `mergeConversation`, tested) from three things it already
keeps: the harness's turns in the database — every prompt Kuru took and every
reply it gave — your messages' states from the outbox, and each reply's fate
from the missed list. A delivered clip and the turn it became are one item,
linked by the turn's `voiceId`; a message still on its way stands on its own
until it arrives. A reply named for its utterance is `heard`, `unheard` or
`speaking` by the missed list's word, and one that was never spoken has no
fate to show. A line said mid-turn through `say` is a turn of its own
(`via: "kururu"`), drawn smaller. A fresh session is a mark on the timeline,
not a different list.

**Who spoke is a colour.** Yours are on raised chrome at the right, Kuru's in
a wash of the accent at the left, and nothing else wears either. kururu's
`[kururu]` notices, a background task's `<task-notification>` and another
session's message all reach Kuru's session as user turns, so the prompt hook
records them as yours. `readPrompt` (`shared/kuru.ts`) reads every prompt on
the way *out* of the database, so the hundreds already stored are covered
without a migration. It takes off what is never anybody's words (a paste
envelope, even one with its end cut off, `<system-reminder>`, a local command's
record) and makes a notice of the cross-session envelope, with Claude Code's
line before it and advice after it, or of a task report. A notice is drawn as
one quiet line, such as `kururu · "Live tracking…" in Holapy finished its turn`,
with "is blocked" in the blocked ink. A tap shows the whole message, and its
card codes are links. The Telegram echo uses the same reading, so a task report
is never sent to the chat as something you typed. Until 2026-10-13 notices were
drawn as your bubbles. Every reply never spoken also wore the scrolled-to
highlight for good, because the check was `null === null`. Together those made
the colours alternate. The socket carries the newest `KURU_RECENT` of each
profile and everything on the two lists with something to do about it;
**Show earlier** pages back through `GET /api/kuru`.

The live row at the foot says what Kuru is doing now — the mascot hopping
with "thinking", "asking something in its terminal" with **Open terminal**,
"not running" with **Start** — and the chip says the same in a glyph, from
the same function (`kuruLive` in `web/src/kuru.ts`), so the two cannot
disagree. A card code in a reply (`KUR-67`) is a door onto the profile board
at that card, resolved against the boards the profile actually has; a word
shaped like one that is not a card is left as a word.

**The background presence is the menu bar**, not the pill: a persistent
count floating over every application would be intrusive, so the frog's title
gains the unheard count after the agent count (`3 · 2 unheard`), and its menu
gets Kuru's lines when there is news — "Kuru: 2 unheard replies" with
**Play** (`POST /api/kuru/play`) and **Open the conversation**, and "1
message did not get through to Kuru" with Open. The counts ride on
`/api/health`, which the runner already polls; a click on the floating pill's
words raises the main window and opens the drawer at that reply — or, if the
window was already in front with the drawer already open, closes it
(`kururu:raise-main` with the utterance, `kururu:open-kuru` back to the page).

## Two languages

Kuru is spoken to in English and Spanish, sometimes in one sentence. Three
things follow.

- **Hearing** runs every ticked language's model over the clip and compares
  the transcripts. The wrong model's output is recognisable — the Spanish
  model hearing English writes Spanish-looking nonsense with none of the
  language's function words; the English one hearing Spanish writes a row of
  commas — so the one that uses more of its own language's commonest words,
  per word, wins. A clip that is half and half goes to the longer half; the
  other half is garbled either way, which is the recogniser's limit.
- **Speaking** detects the reply's language the same way and uses the voice
  chosen for it. Kokoro's voices are each of one language, so Settings
  holds a pair.
- **Spanish through Kokoro** needs `espeak-ng`. The library that wraps Kokoro
  phonemises through an English-only port of espeak and refuses a Spanish
  voice by name, although it ships three. Kokoro was trained on espeak-ng's
  phonemes for every language but English, so the server runs the real
  `espeak-ng`, applies the handful of substitutions the model's tokeniser
  was trained against (`modelPhonemes`), and drives the model directly.
  Punctuation is put back by hand, a clause at a time, because the command
  line drops it and Kokoro's prosody lives in it. Without `espeak-ng`,
  Spanish falls back to a Mac voice.

## Installing

```sh
brew install yap        # the ears — macOS 26 or later
brew install espeak-ng  # Spanish through Kokoro; English needs nothing
```

The model is a download of about 92 MB, once, into
`~/.cache/kururu/models` (`KURURU_MODELS` overrides; `XDG_CACHE_HOME` is
respected). Settings → Voice has the button, and picking a Kokoro voice
fetches it too. Until it is there the Mac's voices speak. A recogniser
locale's model is fetched by macOS the first time it is asked for; the
first clip in a new accent can take ten seconds and say nothing, and the
next is half a second.

Settings → Voice says what is found and what to type when something is
not. The server looks on its PATH and in Homebrew's two directories, since
a server started from the app has a PATH no shell set.

## The voice lab

The candidates [research/voices.md](research/voices.md) found are pickable as
Kuru's voice, under "· trial" headings in Settings → Voice, so they can be
heard as Kuru for a while rather than as samples once. Whichever lose are
deleted. This is a trial and is built like one: the folder is made by hand,
nothing in kururu installs or updates it, the app does not ship
`voicelab.py` (only a checkout's server has the lab), and a model whose
files are missing is simply not offered.

| model | voices | speaks | on disk | weights' licence |
|---|---|---|---|---|
| Supertonic 3 (`supertonic`) | F1–F5, M1–M5 | en, es | 383 MB | OpenRAIL-M |
| Pocket TTS (`pocket`) | 11 of its 27 — `lola` and `rafael` are the native Spanish ones | en, es | in `hf/`, 1.7 GB with the next | CC-BY-4.0 |
| Pocket TTS, 24-layer Spanish (`pocket-hq`) | `lola`, `rafael` | es | (above) | CC-BY-4.0 |
| Chatterbox Multilingual v3 (`chatterbox`) | Default; Heart, cloned from a Kokoro `af_heart` render | en, es | 2.5 GB | MIT |
| Chatterbox es-MX/LatAm (`chatterbox-latam`) | Default; Heart | es | 2.5 GB | MIT |
| Qwen3-TTS 1.7B CustomVoice, 4-bit (`qwen3`) | Serena, Vivian, Ryan, Aiden | en, es | 2.2 GB | Apache-2.0 |

**The folder**, `~/.cache/kururu/voicelab` (`KURURU_VOICELAB` overrides),
about 11 GB: `venv-mlx` (mlx-audio 0.5.8 and onnxruntime 1.31, which run
everything but Pocket), `venv-pocket` (pocket-tts 3.3.0 on torch), both on
Homebrew's Python 3.12; `models/`; `hf/`, the hub cache Pocket and
Chatterbox's speech tokenizer read from; `refs/heart.wav`, the clip the
cloned Chatterbox voice is made from; `bin/uv`, which built the
environments. The processes run offline (`HF_HUB_OFFLINE`), with every
cache the libraries keep pointed inside the folder.

**Two things in it were made here, not downloaded.** Chatterbox v3's MLX
build ships without the default voice's conditionals, so
`conds.safetensors` is the one from `mlx-community/chatterbox-4bit` (the same
default voice). And Resemble publishes the es-MX/LatAm fine-tune as PyTorch
weights only: `chatterbox-latam` is its T3 and S3Gen put through mlx-audio's
own `sanitize`, beside v3's voice encoder, in mlx-audio's layout — no torch,
and every key and shape checked against the v3 build.

**How it runs.** One process per environment, started by the first sentence
that needs it and killed with the server, for `kokoro.ts`'s reasons. A model
loads on its first sentence: Supertonic and Chatterbox in a second or two,
Qwen3 in three, Pocket in two and a half — but the first load after the folder
was made took Pocket 36 s and can take Chatterbox half a minute, so a pick
may say nothing for that long. Settings' "Trial engines" row says what is
loaded. At most two MLX models are held at once, and a process nobody has
asked for anything in fifteen minutes is ended, since these hold gigabytes
of the memory the agents are using. Qwen3 gets a token budget a little past
what the sentence needs and one more take when the first is still far too
long: its 0.6B ran on past the end of its sentence in 39 takes of 96 here.
Pocket's leading silence is trimmed. Speed follows the slider for Supertonic,
Qwen3 and nothing else.

**Deleting it.** Pick a Kokoro or Mac voice for each language, then
`rm -rf ~/.cache/kururu/voicelab` — or just a model's folder under `models/`,
which takes its voices out of the picker. A voice still chosen whose model is
gone speaks with the Mac's voice. The code is `server/voicelab.py`,
`server/src/voicelab.ts`, the `lab` engine with `LAB_MODELS`, `labVoice` and
`labOptions` in `shared/voice.ts`, and the lines that call them in
`server/src/voice.ts`, `server/src/index.ts` (the preview's engine check),
`settings/Voice.tsx` and `server/test/voice.test.ts`.

## The phone

The server does the hearing and the speaking, so a phone only posts a WAV
and plays one; the microphone button is in the Kuru drawer's composer. One thing stands
in the way: a browser opens the microphone only in a secure context, and a
tailnet IP over plain http is not one. The Electron window loads
`127.0.0.1`, which is. For the phone, `tailscale serve` can put the server
behind the tailnet's https name — **that is the user's decision and is
never run by kururu or by anybody working on it** (rule 4). Until then the
button on the phone says why it did nothing.

## The talk key everywhere

Settings → Voice → **Talk key works in every app**, or the same switch in the
tray. Hold the key in any application; the pill floats over whatever you are
in; Kuru answers there. Off by default; the window's own key works as it
always has.

| piece | where | what |
|---|---|---|
| The hook | `desktop/talkkey/talkkey.swift` → `dist/talkkey` | A session-level, **listen-only** `CGEventTap`, in a process of its own on Kokoro's reasoning: started and stopped by the app, it costs a key and not a window when it dies. It maps the same `KeyboardEvent.code` names Settings stores to keycodes (and, for a modifier, to the device bit that tells the right key from the left), and writes one JSON line per event: `ready`, `denied`, `unsupported`, `down`, `up`, `escape`, `chord`. Built by `desktop/talkkey/build.mjs` (needs Xcode's `swiftc`; without it the menu says so and the key stays window-only). Listen-only is the whole permission story: **Input Monitoring**, asked once with the system prompt, and nothing else. |
| The router | `desktop/talkkey.js` | Spawns the hook on the key the pill reports, restarts it on a new key, and sends its events to the pill's webContents and no other. Owns the panel. Pushes `{on, live, status, phase}` to every window. |
| The pill | `VoicePill.tsx` | A level meter and a line, over the panes, zen included. Says which gesture ends the recording, what was heard and where it went, what Kuru is saying. Dragged anywhere in the window by mouse or finger and drawn where this device left it (`web/src/place.ts`); a double click puts it back. Its ✕ is `dismissVoice`: Kuru stops mid-word and the rest of the reply, and what was queued behind it, is marked unheard; a clip being recorded is thrown away; words lingering go. Escape is the same ✕ while Kuru speaks. A plain click — one that travelled less than the drag's own slop, and landed outside the ✕ — toggles the drawer at the reply the pill is showing: open it unless it is already open, in which case this closes it, so a pill that only ever shows its last line is one tap from the whole conversation and one tap back. The pill is the live indicator; the drawer is the record. |
| The panel | `desktop/talkkey.js` `ensurePanel` | A frameless, transparent, non-activating panel kept on top of every space including full-screen apps, sized to the pill and shown while the pill has something to say. Never focusable, so a press over another app moves no focus. Dragging it is `-webkit-app-region: drag`, which moves the window; its spot is kept in `desktop.json` as a share of whichever display it was on, not a pixel, so a monitor switched away from does not strand it — see the gotcha below. A draggable region ignores every pointer event that lands in it, not only the ones that become a drag, so the ✕ and the words are both carved out as `no-drag` or neither could be pressed; a click on the words is the drawer: it raises the *main* window (`kururu:raise-main` with the reply's utterance, making one if there is none) rather than the panel itself — the panel is never focusable, so `kururu:show`'s "raise whichever window sent this" would raise nothing useful — and tells the page to open the drawer at that reply, or to toggle it instead when the window was already in front before this click raised it, so a click that finds the window already there with the drawer already open is the one that closes it (`kururu:open-kuru`, the flag decided in the main process since only it knows whether the window needed raising, kept by the preload for a page still mounting). The tray's **Reset Pill Position** forgets the drag, puts it at its own spot on the display under the cursor, and shows it there for five seconds whether or not it has anything to say (`PillHere` in `Pill.tsx`). Every decision about where it goes is a line in `pill.log` (tray → Logs). |
| The grammar | `web/src/voice.ts` `applyTalkGesture` | Hold, tap and Escape are the same three functions the DOM key handler calls, fed by the hook's `down` and `up` — written once. **Chord** is the one word the hook has that the window never needed: another key pressed during a hold is a shortcut for the application in front, so the clip is dropped and the release that follows is not a send. |
| The fallback | `desktop/talkkey.js` `setAltSpace` | ⌥Space through `globalShortcut`, which needs no permission and sees no key-up, so it is a tap: once to open the microphone, again to send. Off by default, offered when the hook is denied. |

**One voice client on this Mac.** While the hook is live the pill is the page
that records, posts, plays and reports held and played. The main window's
`voice.ts` is told so across the bridge (`setVoiceRemote`): its key handler
stands down, its mic button and its Escape-while-listening are sent to the
pill, and sentences it would have played are left to the pill — one microphone,
one player, one state. That is also what keeps a key the hook *and* a focused
window both saw from firing twice. The moment the hook is denied, missing or
dies, the bridge flips and the window's handler is back, so the key never fires
nowhere. The phone keeps its own button and is unchanged.

Two honest edges. Escape is seen, not swallowed, so the one that drops a clip
or stops Kuru also reaches the app in front — unless that app is Kururu's
window, which keeps it from its terminals; see [Escape](#escape). Swallowing
it everywhere would need an active tap and Accessibility, which is not asked
for. And the permission is granted per bundle, so the dev shell
(`brand.mjs` re-signs it as its own) is approved once and the installed app
once.

Unverified as of 0.2.0: the hook under the signed, notarized app (it is a bare
Mach-O in `Resources/server`, as node-pty's `spawn-helper` already is), and
`type: "panel"` over a full-screen application. Both were built and typecheck;
neither has been pressed in a DMG.

Unverified as of 0.3.0: clicking the panel's words to open the harness —
typechecks and the `no-drag` carve-out matches Electron's documented
behaviour for the ✕, but it has not been clicked for real over another
application, and raising the main window from a non-focusable panel
(`kururu:raise-main`) has not been pressed either. Also unverified: the
panel's recovery after a real monitor change. **Reset Pill Position**
showing the pill, the reload of a page that does not answer it, and the
settle passes after a display event were driven in an isolated Electron
against a stub page, on one display; no second display has been plugged in
or pulled. `pill.log` is how the next try is read.

## What it is not

- **Not a realtime model.** OpenAI Realtime or Gemini Live up front would
  answer in under a second and could be interrupted mid-word, but the work
  still waits on Claude Code's turns, you get two personalities, and the
  brain moves off the subscription. Revisit if bantering with Kuru matters
  more than directing it.
- **Not cloud transcription or cloud voices**, although the module is shaped
  so one could be added behind `VoiceEngine`: the user chose local for
  privacy and for no key.
- **Not in the pty host.** A reply is heard about through the same hook
  report that already told the harness what was said. Nothing here costs
  anybody a running agent.

## Gotchas

- **The talk key must not re-install on render.** `installTalkKey` is
  installed once from `App` and reads the key and the profile through refs.
  Re-adding a capture listener moves it to the back of the list and, worse,
  a key held across the swap loses its key-up.
- **A hot reload is a swap the code cannot refuse.** Vite re-runs
  `voice.ts` when it or `session.ts` changes, the page's effect cleanup
  takes the old copy's listeners away, and the new copy is idle. On
  2026-10-11 the old copy was mid-sentence: the key-up went to the new
  one, and the old one recorded the room for a quarter of an hour, a clip to
  Kuru every five minutes, under a pill showing nothing. `installSpeech`'s
  cleanup now sends what a recording holds and closes the microphone — the
  words after the reload are lost, not the ones before. The cleanup that
  runs is the *old* copy's, so the guard protects from the reload after the
  one that delivered it. A real reload clears every old copy, and an agent
  can ask for one (`bun run reload-window`) that waits until nobody is
  talking and Kuru is not speaking — see
  [architecture](architecture.md#reloading-the-window).
- **`kokoro-js`'s `stream()` hangs on a string.** It never closes the
  splitter, so the last sentence is never yielded. `sentencesOf` splits and
  `generate` is called per sentence.
- **Ten percent of a sentence is the model loading.** The Kokoro process is
  started on the first sentence after a server start, which under
  `bun run dev` is every save, and goes down with that server. The first
  sentence after one costs a few hundred milliseconds more.
- **Kokoro is a process because of how it exits.** Its ONNX runtime aborts any
  process that loaded it when that process exits, which made every server
  exit a SIGABRT and broke `C-a B` (see [gotchas](gotchas.md)). Moving it
  out also took the model load off the server's thread. A test with the old
  arrangement measured a 1.9 s stall; with the process it was 6 ms.
- **The packaged app's copy of the voice stack is unverified.**
  `electron-builder.yml` copies `kokoro-js` and its native dependencies
  into `Resources/node_modules`, Darwin binaries only, but no DMG has been
  built with it yet. The process is started lazily and a failure to start
  or load it is caught, so a missing piece costs the voice and not the app:
  the Mac's voices speak and Settings says Kokoro could not load. `kokoro.mjs`
  ships in `Resources/server` with the rest of `dist`.
- **The microphone in the packaged app** needs the usage string in
  `Info.plist` (`extendInfo`) and the `audio-input` entitlement, both now in
  the builder config, both unverified in a signed build. Without them the
  stream opens and carries silence.
- **The player is busy from the moment it shifts a chunk, not from the
  moment it plays one.** `pump` fetches and decodes before it has a source
  to set `playing` to, and a chunk arriving in that gap used to start a
  fetch of its own and play over the one before it. While the server
  still sent a reply's sentences all together, that played every
  sentence at once. `loading` covers the gap.
- **A sentence goes out the moment it is made, not when the reply is
  done.** `render` announces each one as Kokoro finishes it, so Kuru
  starts talking about a second after its turn ends, and the next
  sentence is made while the one before it plays. A sentence the engine
  chokes on is skipped and `seq` counts what was made, so a reply whose
  last sentence failed never sends a chunk marked `last`. Nothing reads
  `last`.
- **The pill's place is a share of the window, not a pixel.** What is
  kept is how far along the room it has to move in it sits, 0–1 on each
  axis, and the stylesheet draws that as `left: x·100%` with a
  `translate` back by `x·100%` of the pill — inside the window at every
  size of either, with nothing measured. It needs `width: max-content`:
  a fixed box left to shrink to fit is as wide as the window less its
  `left`, which wrapped a pill near the right edge a word to a line.
- **The panel's place is the same idea, one level up.** `desktop/talkkey.js`
  keeps a share of whichever *display* it was dragged on (`{ displayId, x, y }`
  in `desktop.json`'s `pill`), not a pixel pair — a pixel is nonsense the
  moment that display is unplugged. `place()` reapplies the share to the
  same display when `screen.getAllDisplays()` still has it, or to whichever
  is home (the cursor's display, else the primary one) when it does not,
  which is what puts a pill back on screen after a monitor is switched away
  from rather than leaving it stranded at a coordinate nothing answers to.
  `screen`'s `display-added`, `display-removed` and `display-metrics-changed`
  all call `place()` again, so a monitor unplugged while the pill is merely
  hidden is already fixed by the time it is next shown. An older build's raw
  pixel pair reads as a share past 1 and is dropped on load rather than
  honoured. The tray's **Reset Pill Position** forgets the share and puts it
  back at its own spot, for a pill that drifted somewhere unhelpful without a
  display ever changing.
- **Placing once, at the event, was not enough.** KUR-68 called `place()`
  on each display event and the pill still went missing after a monitor
  change, for two reasons. The event is where a change starts: macOS goes on
  moving the windows that were on a display that left, and `screen` can
  answer with the old arrangement for a moment, so `displaysChanged` places
  it at once and again at 600 ms and 2.5 s (`SETTLE_MS`), and a move inside
  that window is the system's and never pins it. And a pill that was up when
  the change happened was moved but never shown again: now a pill that is up
  is shown again on every pass (`reveal` — `showInactive` is
  `orderFrontRegardless`, so again is not a no-op — plus `invalidate()` for
  a transparent panel that lost its frame). Whether it is up is the file's
  own `shown`, not `isVisible()`, which answers yes for exactly the panel
  that is shown where nobody can see it. `place()` also holds the result
  inside the chosen display's work area, skips displays Electron says are
  not `detected`, and reads the bounds back: a panel whose middle is on no
  display is put on the primary one and the log says so.
- **A reset that moved a hidden window looked like no reset.** The panel is
  only up while the pill is talking, so the first Reset put an invisible
  window in the right place and showed nothing. Reset now sends
  `kururu:pill-locate` (kept by the preload for a page still mounting); the
  page draws `PillHere` for five seconds and reports `locating`, which
  `report` shows like a phase but keeps out of the phase every window is
  told, since a window reads Escape by it. A page that does not answer in
  2 s is loaded again and asked again — a wedged or dead page is the other
  way a pill disappears, and a renderer that dies is reloaded too, once per
  30 s at most.
- **`pill.log` is the only witness.** The panel has no devtools and an
  installed app's stderr goes nowhere, so every `place()` writes one JSON
  line to `~/.local/state/kururu/pill.log` — why it ran, which display it
  chose and how (pinned, under the cursor, nearest, primary), the cursor,
  the target and the bounds read back, whether it landed on a display, and
  every display it chose between — beside each display event, reset, drag
  pin, failed load and renderer death. Moved aside at 256 KB, as
  `lifecycle.log` is. The tray's Logs menu opens it.
- **The pill takes the pointer now**, which it did not while it only
  talked. A press on it prevents `mousedown`, the mic button's fix, so
  dragging it or pressing its ✕ never takes the focus off a terminal.
- **The pill takes the pointer now**, which it did not while it only
  talked. A press on it prevents `mousedown`, the mic button's fix, so
  dragging it or pressing its ✕ never takes the focus off a terminal.
- **The ✕ on a clip still being opened waits for the microphone.** It is
  `cancelTalk`, the same as Escape, and that closes what `open` made — so
  pressed in the first moment it takes the pill down when the stream is
  up, not before.
- **A page's talks are counted, not flagged.** The key can go down again
  while the last clip is still being heard, and the first one finishing
  must not lift the second one's hush. Each recording ends its talk once,
  in `close` or in `open`'s failure, never both.
- **Between two sentences is still speaking.** The pill used to drop to
  `heard` when a sentence ended before the next was made, looking no
  different, so an Escape in that gap was not the voice's and went on to the
  terminal and the agent in it. `between` holds `speaking` until the
  reply's last sentence, or `GAP_MS`. The two places the player gives up
  for want of an output pump once more, empty, so a phase left `speaking`
  with nothing playing does not take every Escape after it.
- **The hush acts on its edge, not its level.** Going quiet runs
  `stopSpeaking` once; a second page pressing while this one already holds
  a reply does not throw that reply away. Coming back runs `pump`.
- **A dropped socket lifts the hush on both ends.** The server forgets a
  client's say when its socket goes, and the page forgets the server's when
  its socket goes, since the next server says again on connect; a page
  still talking says so again from `onopen`. A client that stays connected
  and never says it stopped is let go after three minutes (`TALK_MAX_MS`),
  past the longest clip the server would take.
- **A page holds a reply once and lets it go once.** `held` in
  `web/src/voice.ts` is what it has told the server it holds; letting go of
  one it never held says nothing, so a ✕ pressed after a reply was played
  out does not mark it missed. The server ignores letting go of a reply
  already heard for the same reason.
- **A missed reply is replayed from its words, not its audio.** The audio is
  in the last two dozen utterances and gone after; the words are on the
  disk. `speak` is told they are `spoken` already, because a second pass of
  `spokenText` eats underscores the first one left in names.
- **Reload the window after a change here.** A page from before this change
  holds nothing and reports nothing, so every reply it plays looks unheard
  to the server and lands on the list two seconds after it is made. A page
  from before the outbox posts with no id; the server mints one, keeps and
  delivers the message all the same, and answers in the old shape as well
  (`legacyHeard`) once its words are made — without that the old pill
  quoted `undefined` and said Kuru was starting.
- **The floating pill loads what the window loads.** From a checkout that
  is the checkout's vite, so a change under `web/` reaches the pill as it is
  saved; from the app it is the server's page. ⌘R in the window reloads the
  pill too — once it is idle, if it is mid-sentence — and so does **Rebuild
  the web app** when the pill is on the built page. A server restart is
  still only a reconnect: the pill loads again only when the page it should
  show is a different one. Its unsent clips are in IndexedDB, which is per
  origin, so a clip saved while it was on one page is sent the next time it
  is on that page, not on the other.
- **A clip's length is a fraction and `execFile`'s timeout is not.** The
  recogniser's timeout grows with the clip, and a timeout of 63029.06 ms
  throws before `yap` starts — which read as a transcription failure on
  every clip whose sample count was not a multiple of sixteen. The window's
  own clips come in 128-sample blocks and never hit it; a clip from anywhere
  else did. Rounded, in `transcribe` and in the entry.
- **A refusal must be answered, not hung up on.** `readBody` destroys the
  request at its cap, which suits an upload nobody reads the answer to. The
  clip route reads its body to the end whatever its size (`readClip`) so a
  window still uploading gets the 413 and the reason — the reset connection
  is half of how the 2026-10-09 message was lost.
- **The pill's line is not the only record.** Anything that happens to a
  message after the pill has moved on — a retry, a failure at the
  confirmation timeout — is in the drawer, with Resend on a failed one, and a
  failure brings the pill back for fifteen seconds if nothing else holds it.
- **`say` speaks at 22 kHz and Kokoro at 24.** Both are plain WAVs and the
  browser's decoder resamples; nothing here cares.
