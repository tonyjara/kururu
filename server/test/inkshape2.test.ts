/**
 * The screen pen's phase 2, the pure part: what a burst of ink is drawn as
 * (`shapeOf`), and what a mark's label says once it knows kururu's own
 * window, a browser tab's element, a snapshot, and its pens. The shapes are
 * drawn here the way a hand draws them — a circle that does not quite close,
 * a box with a lean, an arrow as one stroke and as three — since a classifier
 * tested on perfect geometry would say nothing about a trackpad.
 */
import { describe, expect, it } from "bun:test";
import { chipsIn } from "../../shared/chips";
import { adoptScreenSet, redactScreenSet, screenMarkLabel, screenMarkdown, shapeOf, type InkXY, type ScreenSet } from "../../shared/ink";

/** A circle that stops a little short of where it began, wobbling as a hand does. */
function circle(cx: number, cy: number, r: number, sweep = 340): InkXY[] {
  const out: InkXY[] = [];
  for (let a = 0; a <= sweep; a += 6) {
    const wobble = 1 + 0.04 * Math.sin(a / 17);
    out.push([cx + r * wobble * Math.cos((a * Math.PI) / 180), cy + r * wobble * Math.sin((a * Math.PI) / 180)]);
  }
  return out;
}

/** A line from one point to another in small steps, a little uneven. */
function line(from: InkXY, to: InkXY, steps = 24): InkXY[] {
  const out: InkXY[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([from[0] + (to[0] - from[0]) * t + Math.sin(i) * 0.6, from[1] + (to[1] - from[1]) * t + Math.cos(i) * 0.6]);
  }
  return out;
}

const join = (...parts: InkXY[][]): InkXY[] => parts.flatMap((part, i) => (i ? part.slice(1) : part));

describe("the shape word", () => {
  it("a circle round something is circled, closed or nearly", () => {
    expect(shapeOf([circle(200, 200, 60)]).shape).toBe("circled");
    expect(shapeOf([circle(200, 200, 60, 370)]).shape).toBe("circled");
    // An ellipse round a line of text.
    expect(shapeOf([circle(200, 200, 60).map(([x, y]) => [200 + (x - 200) * 3, y] as InkXY)]).shape).toBe("circled");
  });

  it("a box is boxed", () => {
    const box = join(line([100, 100], [300, 104]), line([300, 104], [298, 220]), line([298, 220], [102, 218]), line([102, 218], [101, 106]));
    expect(shapeOf([box]).shape).toBe("boxed");
  });

  it("an arrow of three strokes points at the end its head is on", () => {
    const shaft = line([100, 300], [300, 120]);
    const barbA = line([300, 120], [270, 125], 6);
    const barbB = line([300, 120], [292, 150], 6);
    const got = shapeOf([shaft, barbA, barbB]);
    expect(got.shape).toBe("arrow");
    expect(got.tip?.[0]).toBeCloseTo(300, -1);
    expect(got.tip?.[1]).toBeCloseTo(120, -1);
    // The head drawn at the start of the shaft instead.
    const back = shapeOf([line([300, 120], [100, 300]), line([300, 120], [270, 125], 6)]);
    expect(back.shape).toBe("arrow");
    expect(back.tip?.[0]).toBeCloseTo(300, -1);
  });

  it("an arrow in one stroke: the shaft, then out along a barb and back for the other", () => {
    const stroke = join(line([100, 300], [300, 120]), line([300, 120], [268, 124], 6), line([268, 124], [300, 120], 6), line([300, 120], [294, 152], 6));
    const got = shapeOf([stroke]);
    expect(got.shape).toBe("arrow");
    expect(got.tip?.[0]).toBeCloseTo(300, -1);
  });

  it("a flat line under something is underlined; a slope alone is nothing", () => {
    expect(shapeOf([line([100, 400], [420, 404])]).shape).toBe("underlined");
    expect(shapeOf([line([100, 400], [300, 200])]).shape).toBe("");
  });

  it("the highlighter is highlighted, a scribble and a dot are nothing", () => {
    expect(shapeOf([line([100, 400], [420, 404])], [{ tool: "highlighter", color: "yellow" }]).shape).toBe("highlighted");
    const scribble = join(line([100, 100], [200, 180]), line([200, 180], [120, 220]), line([120, 220], [260, 140]));
    expect(shapeOf([scribble]).shape).toBe("");
    expect(shapeOf([[[10, 10]]]).shape).toBe("");
    expect(shapeOf([]).shape).toBe("");
  });
});

const under = { app: "Safari", bundle: "com.apple.Safari", window: "Stripe — Payments", bounds: null, front: null };

describe("the label", () => {
  it("leads with the shape, and says where in kururu or on which page", () => {
    expect(screenMarkLabel({ under, secure: false, shape: "circled" })).toBe('circled in Safari "Stripe — Payments"');
    expect(screenMarkLabel({ under, secure: false, shape: "" })).toBe('Safari "Stripe — Payments"');
    expect(screenMarkLabel({ under, secure: false, snap: true, shape: "" })).toBe('snapshot of Safari "Stripe — Payments"');
    const kururu = { what: "agent", name: "Fastermenu migration", detail: "", workspace: "fastermenu", element: "" };
    expect(screenMarkLabel({ under: { ...under, app: "Kururu" }, secure: false, shape: "underlined", kururu })).toBe('underlined in kururu: agent "Fastermenu migration"');
    expect(screenMarkLabel({ under, secure: false, kururu: { ...kururu, what: "the sidebar", name: "" } })).toBe("kururu: the sidebar");
    const element = { tag: "button", id: "", classes: [], attrs: {}, text: "Pay now", role: "button", name: "Pay now", selectors: [], box: { x: 0, y: 0, width: 1, height: 1 }, styles: {}, html: "", frame: "" };
    expect(screenMarkLabel({ under, secure: false, shape: "arrow", page: { url: "http://localhost:3000/checkout?token=abc", element } })).toBe('arrow to button "Pay now" on localhost:3000/checkout');
  });

  it("reads a set written before phase 2, which has none of it", () => {
    expect(screenMarkLabel({ under, secure: false })).toBe('Safari "Stripe — Payments"');
  });

  it("is a line chips.ts still reads as one mark", () => {
    const label = screenMarkLabel({ under: { ...under, window: "a [bracketed] \"title\" that goes on and on and on for ever" }, secure: false, shape: "circled" });
    const chips = chipsIn(`[mark 1 ${label}]`);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.kind).toBe("mark");
  });
});

describe("the body", () => {
  const body = (mark: Record<string, unknown>) => ({ kind: "screen", at: 1, audioAt: null, displays: [{ id: 1, width: 1440, height: 900, scale: 2 }], marks: [{ display: 1, t0: 0, t1: 1, box: { x: 0, y: 0, width: 10, height: 10 }, under, crop: "", frame: "", ...mark }] });

  it("keeps a style per stroke, dropping a stroke's with it, and shapes the ink itself", () => {
    const set = adoptScreenSet(body({ strokes: [circle(200, 200, 60), [], [[1, 1]]], styles: [{ tool: "pen", color: "blue" }, { tool: "pen", color: "red" }, { tool: "laser", color: "green" }], shape: "boxed" })) as ScreenSet;
    expect(set.marks[0]?.strokes).toHaveLength(2);
    expect(set.marks[0]?.styles).toEqual([{ tool: "pen", color: "blue" }, { tool: "pen", color: "red" }]);
    // The shape is the server's reading, never the body's say.
    expect(set.marks[0]?.shape).toBe("circled");
  });

  it("a snapshot has no shape; kururu's and the page's facts are kept, cut and redacted", () => {
    const set = adoptScreenSet(
      body({
        snap: true,
        strokes: [],
        kururu: { what: "card KUR-12", name: "  ship \n it ", element: "button \"Send\" sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
        page: { url: "http://localhost:3000/pay?token=secret123", element: { tag: "BUTTON", name: "Pay", selectors: [{ kind: "testid", value: '[data-testid="pay"]', unique: true }] } },
      }),
    ) as ScreenSet;
    const mark = set.marks[0]!;
    expect(mark.snap).toBe(true);
    expect(mark.shape).toBe("");
    expect(mark.kururu?.name).toBe("ship it");
    expect(mark.page?.element.tag).toBe("button");
    const clean = redactScreenSet(set).marks[0]!;
    expect(clean.kururu?.element).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(clean.page?.url).not.toContain("secret123");
    const md = screenMarkdown(redactScreenSet(set), { crops: {}, frames: { 1: "/x/frame-1.jpg" } });
    expect(md).toContain("A snapshot");
    expect(md).toContain('[data-testid="pay"]');
    expect(md).not.toContain("- Ink:");
  });

  it("says the pens used when they are not just the red one", () => {
    const set = adoptScreenSet(body({ strokes: [line([100, 400], [420, 404]), circle(200, 200, 60)], styles: [{ tool: "highlighter" }, { tool: "pen", color: "blue" }] })) as ScreenSet;
    expect(screenMarkdown(set, { crops: {}, frames: {} })).toContain("With the highlighter and the blue pen");
  });
});
