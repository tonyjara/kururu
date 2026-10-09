/**
 * The voice's pure half: which language, which transcript, what to say, and
 * the WAV. The transcripts in here are what `yap` actually produced for the
 * same clip in the wrong locale, so the chooser is tested against the real
 * failure and not an invented one.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE,
  adoptVoice,
  clipMs,
  detectLanguage,
  downsample,
  encodeWav,
  keyCodeLabel,
  parseSayVoices,
  pickTranscript,
  sentencesOf,
  spokenText,
  systemFallback,
} from "../../shared/voice";
import { modelPhonemes, superseded, type Utterance } from "../src/voice";

describe("parseSayVoices", () => {
  const listing = [
    "Bad News            en_US    # Hello! My name is Bad News.",
    "Eddy (Spanish (Mexico)) es_MX    # ¡Hola! Me llamo Eddy.",
    "Mónica (Spanish (Spain)) es_ES    # ¡Hola! Me llamo Mónica.",
    "Mónica (Spanish (Spain)) es_ES    # ¡Hola! Me llamo Mónica.",
    "Samantha (English (US)) en_US    # Hello! My name is Samantha.",
    "Anna                de_DE    # Hallo! Ich heiße Anna.",
    "",
  ].join("\n");

  test("keeps the two languages, once each, with the name say -v takes", () => {
    const voices = parseSayVoices(listing);
    expect(voices.map((v) => v.id)).toEqual(["Bad News", "Eddy (Spanish (Mexico))", "Mónica (Spanish (Spain))", "Samantha (English (US))"]);
    expect(voices[1]).toEqual({ engine: "system", id: "Eddy (Spanish (Mexico))", name: "Eddy (Spanish (Mexico))", lang: "es", note: "es_MX" });
  });

  test("the fallback prefers the voices people know", () => {
    const voices = parseSayVoices(listing);
    expect(systemFallback("en", voices)).toEqual({ engine: "system", voice: "Samantha (English (US))" });
    expect(systemFallback("es", voices)).toEqual({ engine: "system", voice: "Mónica (Spanish (Spain))" });
    expect(systemFallback("es", [])).toBeNull();
  });
});

describe("detectLanguage", () => {
  test("tells the two apart", () => {
    expect(detectLanguage("Three agents are running and one is waiting on you.", ["en", "es"])).toBe("en");
    expect(detectLanguage("Tres agentes están trabajando y uno está esperando.", ["en", "es"])).toBe("es");
    expect(detectLanguage("La tarjeta del login terminó.", ["en", "es"])).toBe("es");
  });

  test("one language is no question, and nothing to go on is the first", () => {
    expect(detectLanguage("Hola, ¿qué tal?", ["en"])).toBe("en");
    expect(detectLanguage("", ["es", "en"])).toBe("es");
    expect(detectLanguage("a220 w6", ["es", "en"])).toBe("es");
  });
});

describe("pickTranscript", () => {
  test("a row of commas is not a transcript", () => {
    const picked = pickTranscript(
      [
        { lang: "en", text: ", , , , , , , , , ," },
        { lang: "es", text: "Abre una tarjeta nueva en el tablero y ponle que arregle el login del teléfono." },
      ],
      ["en", "es"],
    );
    expect(picked?.lang).toBe("es");
  });

  test("the right model's words are the ones with the language in them", () => {
    const picked = pickTranscript(
      [
        { lang: "en", text: "Start a new agent on the Kure workspace and ask it to rename tabs on right click." },
        { lang: "es", text: "Estar a nuevo asiente onda cure workspace an asquito rename tabs." },
      ],
      ["es", "en"],
    );
    expect(picked?.lang).toBe("en");
  });

  test("a clip with nothing in it is null, and one candidate is the answer", () => {
    expect(pickTranscript([{ lang: "en", text: "" }, { lang: "es", text: "…" }], ["en", "es"])).toBeNull();
    expect(pickTranscript([{ lang: "en", text: "" }, { lang: "es", text: "Hola" }], ["en", "es"])?.text).toBe("Hola");
  });

  test("a tie goes to the first language", () => {
    expect(pickTranscript([{ lang: "en", text: "Kuru" }, { lang: "es", text: "Kuru" }], ["es", "en"])?.lang).toBe("es");
  });
});

describe("spokenText", () => {
  test("code is left out, markdown is taken off, lists become sentences", () => {
    const said = spokenText("## Done\n\nThree agents:\n- `a220` on the login card\n- **a221** on the migration\n\n```ts\nconst x = 1;\n```\n\nSee [the board](http://x).");
    expect(said).not.toContain("```");
    expect(said).not.toContain("const x");
    expect(said).not.toContain("**");
    expect(said).not.toContain("#");
    expect(said).toContain("a220 on the login card");
    expect(said).toContain("code left out");
    expect(said).toContain("See the board.");
  });

  test("a long reply is cut at a sentence", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const said = spokenText(long);
    expect(said.length).toBeLessThanOrEqual(1600);
    expect(said.endsWith(".")).toBe(true);
    expect(said).not.toMatch(/number \d+ is$/);
  });

  test("nothing stays nothing", () => {
    expect(spokenText("")).toBe("");
    expect(spokenText("```\nonly code\n```")).toBe("(code left out)");
  });
});

describe("sentencesOf", () => {
  test("splits at sentence ends and keeps the marks", () => {
    expect(sentencesOf("Three agents are running. One is waiting on you! Is that fine?")).toEqual([
      "Three agents are running.",
      "One is waiting on you!",
      "Is that fine?",
    ]);
  });

  test("a sentence longer than the limit is cut at a comma", () => {
    const parts = sentencesOf(`${"word ".repeat(40)}, ${"more ".repeat(40)}.`, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(121);
  });
});

describe("the clip", () => {
  test("encodeWav writes the header and the samples", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16_000);
    const view = new DataView(wav);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...new Uint8Array(wav, 8, 4))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x8000);
    expect(wav.byteLength).toBe(54);
  });

  test("downsample averages and leaves a matching rate alone", () => {
    const same = new Float32Array([1, 2, 3]);
    expect(downsample(same, 16_000, 16_000)).toBe(same);
    const down = downsample(new Float32Array([1, 1, 1, 3, 3, 3]), 48_000, 16_000);
    expect(Array.from(down)).toEqual([1, 3]);
  });

  test("clipMs reads the duration off the length", () => {
    expect(clipMs(44)).toBe(0);
    expect(clipMs(44 + 32_000)).toBe(1000);
  });
});

describe("adoptVoice", () => {
  test("nothing is the defaults", () => {
    expect(adoptVoice(null)).toEqual(DEFAULT_VOICE);
    expect(adoptVoice("junk")).toEqual(DEFAULT_VOICE);
  });

  test("bad fields fall back one at a time", () => {
    const got = adoptVoice({
      speak: false,
      languages: ["es", "fr", "es"],
      locales: { en: "en-GB", es: "xx-XX" },
      voices: { en: { engine: "system", voice: "Samantha" }, es: { engine: "nope", voice: "x" } },
      speed: Number.NaN,
      volume: 9,
      talkKey: "Key Q; rm -rf",
    });
    expect(got.speak).toBe(false);
    expect(got.languages).toEqual(["es"]);
    expect(got.locales).toEqual({ en: "en-GB", es: "es-MX" });
    expect(got.voices.en).toEqual({ engine: "system", voice: "Samantha" });
    expect(got.voices.es).toEqual(DEFAULT_VOICE.voices.es);
    expect(got.speed).toBe(1);
    expect(got.volume).toBe(1);
    expect(got.talkKey).toBe("ControlRight");
  });

  test("no languages at all is both", () => {
    expect(adoptVoice({ languages: [] }).languages).toEqual(["en", "es"]);
  });
});

describe("keyCodeLabel", () => {
  test("says what a person would", () => {
    expect(keyCodeLabel("ControlRight")).toBe("Right Control");
    expect(keyCodeLabel("KeyV")).toBe("V");
    expect(keyCodeLabel("F13")).toBe("F13");
    expect(keyCodeLabel("Whatever")).toBe("Whatever");
  });
});

describe("modelPhonemes", () => {
  test("ties become the model's symbols and the rest is untied", () => {
    const tie = "͡";
    expect(modelPhonemes(`kˈe t${tie}ʃˌut${tie}ʃeɾˈias\n ðˈixo el ˈa${tie}ɪɾe`)).toBe("kˈe ʧˌuʧeɾˈias ðˈixo el ˈIɾe");
    expect(modelPhonemes(`a${tie}b-c`)).toBe("abc");
  });
});

describe("superseded", () => {
  const said = (n: number, patch: Partial<Utterance> = {}): Utterance => ({
    id: `u${n}`,
    n,
    profileId: "p1",
    quiet: false,
    chunks: [Buffer.from("x")],
    at: 0,
    heard: true,
    stale: false,
    done: true,
    ...patch,
  });

  test("words to a harness supersede what it said before them, and nothing else", () => {
    const { drop } = superseded(
      [said(1), said(2, { profileId: "p2" }), said(3, { quiet: true, profileId: "" }), said(4, { stale: true }), said(5), said(6)],
      "p1",
      5,
    );
    // Not another profile's, not an audition, not what is already stale,
    // and not a reply made while the words were being typed.
    expect(drop).toEqual(["u1", "u5"]);
  });

  test("skipped is the replies nobody heard begin", () => {
    const { drop, skipped } = superseded(
      [
        said(1),
        // Came while the key was down: every sentence waited.
        said(2, { heard: false }),
        // Still being made when the words went.
        said(3, { heard: false, done: false, chunks: [] }),
        // Every sentence failed; there was never anything to hear.
        said(4, { heard: false, chunks: [] }),
      ],
      "p1",
      4,
    );
    expect(drop).toEqual(["u1", "u2", "u3", "u4"]);
    expect(skipped).toBe(2);
  });
});
