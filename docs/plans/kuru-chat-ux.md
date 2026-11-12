# Kuru's chat controls

2026-11-12. The owner: "we have a lot of workspaces, we need a different ui to
select it because they don't all fit, maybe we can have a filters button? …
redesign the chat portion of kuru as well, I'm not entirely happy with where
the search, talk/not talk button and the [Telegram] buttons are and not
entirely happy with where the mic and pen buttons are either."

This covers Kuru's chat in both places it is drawn, which are one component
(`KuruDrawer.tsx`): the drawer beside the panes (320 px and up, a full-screen
sheet under 720 px of window) and the floating Kuru's chat (320–960 px wide,
260 px tall and up).

## What was wrong

Measured in a headless copy with 21 workspaces and two other nodes:

- The tag row (Todo · nodes · workspaces) was 2002 px of chips inside a 420 px
  drawer. Four chips fit; the other twenty were a sideways scroll with no bar.
- The header held five unlabelled icons of three different kinds, drawn three
  different ways: two that *find* things (search, pins — one framed, one not),
  and two that are *settings* (speak replies, Telegram — one whose glyph is
  its state, one a green tile). Nothing said which were switches.
- The mic and the pen sat inside the box at its right end, where every other
  chat puts Send. The mic does not send; it writes into the box. And there was
  no Send: a dictation or a set of pen marks arrives by mouse, and only a key
  could send it.

## The controls, by what they do and how often

| control | what it does | how often | so it goes |
|---|---|---|---|
| Filter by workspace / node | narrows the list | many times a day, more with every workspace | header, with a word beside it when there is room |
| Search | finds a line in the whole history | a few times a day | header, beside the filter |
| Pins | opens the kept lines | now and then | header, last of the three |
| Speak replies | whether a reply is read aloud | flipped when the room changes | the box's foot: it is about the answer to what you are about to send |
| Telegram | whether Kuru also listens and answers there | flipped when you leave the Mac | the box's foot, beside the speaker |
| Mic (dictate) | writes what you say into the box | every few messages | the box's foot, first: it is the box's tool |
| Pen | draws on the screen; the marks come into the box | now and then | the box's foot, beside the mic |
| Send | sends the box | every message (Enter still does) | the box's foot, alone at the right |

One rule comes out of it: **the top of the chat is for finding, the bottom is
for talking.** The header changes what you are looking at; the box and its
foot are what goes in and how the answer comes back.

## The layout

The drawer at its usual width (the floating chat is the same, in its own
window, with its grip over the head):

```
┌──────────────────────────────────────────────┐
│ [▣ 3] [● Kuru]        [⌕] [⏷ Filter] [⚲ 2] ✕ │  head: find
├──────────────────────────────────────────────┤
│                                              │
│   …the conversation…                         │
│                                              │
├──────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────┐ │
│ │ Say something to Kuru, or @omarchy …     │ │  the words, the box's whole width
│ │ [mic] [pen] │ [speaker] [plane]     [➤]  │ │  foot: in · replies · send
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

With a filter on, one strip appears under the head and says what the list is
narrowed to. It is the old row's own chips, only the picked ones:

```
│ [▣ 3] [● Kuru]      [⌕] [⏷ Filter 2] [⚲ 2] ✕ │
│ [Todo] [● kururu ×] [● Pasapy ×]             │  press one to let it go; Todo lets all go
```

The filter, opened — a panel hung from the head, over the list, never wider or
taller than the chat it is in:

```
│ [▣ 3] [● Kuru]        [⌕] [⏷ Filter] [⚲ 2] ✕ │
│          ┌─────────────────────────────────┐ │
│          │ ⌕ Workspace or node…            │ │
│          │ ✓ Todo · the whole conversation │ │
│          │ NODES                           │ │
│          │   mac                           │ │
│          │   ● omarchy                   2 │ │
│          │   ● studio               away   │ │
│          │ LATELY                          │ │
│          │   ● kururu                 only │ │
│          │   ● Pasapy                      │ │
│          │ EVERYTHING ELSE                 │ │
│          │   ● 340 Studios site            │ │
│          │   ● Archive 2025                │ │
│          │   …                             │ │
│          └─────────────────────────────────┘ │
```

At 320 px (the narrowest drawer and floating chat) the words in the head go
and the icons stay; the filter's count stays on its icon. On a phone's sheet
the panel is the sheet's width and its rows are a thumb tall.

Height is what the floating chat is short of (260 px at its smallest), so the
trade is even: the row of chips that was always there is gone (33 px) and the
box's foot is new (32 px). The filter's strip is only there while a filter is.

## The filter with 21+ workspaces, and with nodes

- **It scales by typing.** The panel opens with the keyboard in its field; two
  letters leave two rows. Without typing it is still ordered to be short at the
  top: the workspaces the loaded lines are about, most recent first (five at
  most), then the rest by name, in a list that scrolls inside the panel.
- **Several at once**, as before: a row is a switch and the panel stays open,
  the list behind it narrowing as you press. Workspaces are any-of; a node with
  them is that node's lines about any of them. "only" on a row (hover, or
  Shift+Enter) makes it the one thing shown and closes the panel, so going from
  one workspace to another is one press and not three.
- **Todo** (the owner's word for everything) is the panel's first row and the
  strip's first chip.
- **Nodes** are the panel's first group on a kururu linked with others, in
  their own hues, with what the row said before: an unheard count, "away",
  "too old". On a kururu on its own the group is not drawn.
- **A tag pressed on a line** still shows that workspace's thread from that
  line, and pressed again shows everything; the strip then says so.
- **What does not change:** how a line gets its tags, the tag button that
  corrects them, what is remembered per device, the reach-back for more lines
  under a filter, a pin or a quote opening a line the filter hides.

## Keyboard

| key | where | does |
|---|---|---|
| ⌘F, or `C-a /` | drawer open | search (as before) |
| ⌘⇧F (Ctrl+Shift+F off a Mac) | drawer open | open or close the filter |
| type | filter | narrows the rows |
| ↑ ↓, Home, End | filter | walk the rows |
| Enter | filter | switch the row on or off; the panel stays |
| Shift+Enter | filter | only this row, and close |
| Backspace in an empty field | filter | let go of the last one picked |
| Esc | filter | close it; the keyboard goes back where it was |
| Enter / Shift+Enter | box | send / new line (as before) |
| Tab | box | on to mic, pen, speaker, Telegram, Send |
| Enter or Space on the mic | box's foot | start dictating; again, or Esc, to stop (the mic was pointer-only) |

## Not in this

- The voice's waveform and the pen's tools in the floating Kuru's row
  (`Pill.tsx`, `FloatWave`) are left as KUR-277 put them.
- The tag button's menu on a line is still `Menu` with every workspace as a
  switch. It would take the filter's panel well; it works, so not now.
- No server, shared or desktop change: what is picked is still
  `kururu.kuru.tags` in this device's storage.
