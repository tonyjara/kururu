/**
 * The mark that says what an agent is doing, in the two places that draw it.
 *
 * It was a coloured dot for all four states. Two of them still are, and the line
 * between the two halves is not "stopped or going" — it is **whether it wants
 * you**. `blocked` and `done` do: one is waiting on an answer, the other has
 * finished and is holding a result. Those keep their dots, and in a sidebar
 * where everything else is moving a still dot is now the thing that stands out,
 * which is the right way round.
 *
 * `working` and `idle` are the two states an agent spends its time in, and they
 * get the mascot: hopping while it thinks, breathing while it waits. Movement
 * across a shape is read before colour and long before a tooltip, so a glance
 * down the sidebar separates "going" from "stopped" without reading anything —
 * which is the actual job. A mascot with no idle clip leaves idle as the dot it
 * always was.
 *
 * An idle animation that cannot animate falls back to the dot, and that rule is
 * here rather than in the stylesheet because it is a choice of *element*. Frozen
 * on frame one, a sitting frog and a crouching one are the same picture — so a
 * still idle sprite says less than the dot it replaced, having lost the one
 * distinction the badge exists to draw. The working sprite keeps its frame
 * either way: frozen, a frog is still not a dot.
 *
 * What the mascot *is* belongs to the user and lives in the snapshot; nothing in
 * here or in the stylesheet knows it is a frog. Which mascot belongs to the
 * *workspace*, and is resolved by the caller — a sidebar row and a tab strip can
 * be showing agents from two different ones.
 *
 * This lives in a component rather than in two `<span>`s because the sprite is
 * structure now, not a class name, and the sidebar and the tab strip must not be
 * able to disagree about it — the same reason `labels.ts` exists for the words.
 */
import type { CSSProperties } from "react";
import type { AgentSnapshot, MascotClip, MascotConfig } from "../../../shared/model";
import { statusLabel } from "../labels";
import { sheetUrl, usePrefersReducedMotion, useSheet } from "../mascot";

export function Status({ agent, mascot }: { agent: AgentSnapshot; mascot: MascotConfig }) {
  /**
   * Exited is not an `AgentStatus` — it is a fact about the pty that outranks
   * whatever the heuristic last thought. Resolved here so both callers cannot
   * resolve it differently.
   */
  const state = agent.exited ? "exited" : agent.status;
  const label = statusLabel(agent);
  const reduced = usePrefersReducedMotion();
  const still = mascot.motion === "never" || (mascot.motion === "system" && reduced);
  const clip =
    state === "working" ? mascot.working : state === "idle" && !still ? mascot.idle : null;
  return (
    <span className={`status status-${state}`} title={label} aria-label={label} role="img">
      {clip ? <Mascot config={mascot} clip={clip} /> : <span className="status-dot" />}
    </span>
  );
}

/**
 * One window onto a sprite sheet, walked sideways a cell at a time.
 *
 * The arithmetic is all ratios and no pixels, and that is deliberate: the badge
 * is `--status-size` in the stylesheet, and a second copy of that number in here
 * would be a thing to keep in step for no gain. Everything below is "how many
 * badge-widths", multiplied back out by `calc` — so the whole geometry follows
 * the box, and changing the box is one edit in one file.
 *
 * The element is a whole row of cells, `count` of them, each a full cell wide
 * rather than a trimmed one — that is what makes a single translate land exactly
 * on the next frame, since the gap between two frames in the sheet is a cell and
 * not a crop. The box clips it to the trim; `@keyframes hop` slides it by its own
 * width, so `steps(count)` puts each frame in the window in turn, whatever the
 * count is. The alternative — stepping `background-position` — has to know where
 * the strip started, and gets that wrong the moment a selection is not at the
 * left edge of the sheet.
 *
 * The trim comes from the mascot rather than the clip, which is what keeps a
 * sitting frog the same size as a jumping one: see `MascotConfig.trim`.
 */
export function Mascot({ config, clip }: { config: MascotConfig; clip: MascotClip }) {
  const src = sheetUrl(config.sheet);
  const sheet = useSheet(src);
  /**
   * The dot stands in until the sheet is known, and for good if it never is: a
   * mascot that cannot be drawn must still leave the row with something in it,
   * and a hole exactly where the state worth seeing would have been is the worst
   * of the available outcomes.
   */
  if (!sheet) return <span className="status-dot" />;

  const { frame, trim } = config;
  const { row, col, count } = clip;
  /** One badge-width is one trim-width, so every ratio below is over that. */
  const per = (n: number) => `calc(var(--status-size) * ${n / trim.size})`;

  return (
    <span
      className={`mascot mascot-${config.motion}`}
      style={
        {
          backgroundImage: `url(${src})`,
          backgroundSize: `${per(sheet.width)} ${per(sheet.height)}`,
          backgroundPosition: `${per(-(col * frame + trim.x))} ${per(-(row * frame + trim.y))}`,
          width: per(count * frame),
          height: per(frame),
          animationDuration: `${clip.cycle}ms`,
          animationTimingFunction: `steps(${count})`,
        } as CSSProperties
      }
    />
  );
}
