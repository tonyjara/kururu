/**
 * The mark that says what an agent is doing, in the two places that draw it.
 *
 * It was a coloured dot everywhere, and for three of the four states it still
 * is — idle, blocked and done are all *stopped*, and a dot is the quietest way
 * to say which kind of stopped. The fourth is not stopped, and that is the one
 * distinction the mark exists for: "is this one still going, or is it waiting
 * for me?" A dot that pulses answers it only if you watch it for a second and a
 * half, which is longer than anybody looks at a sidebar.
 *
 * So the working state is the mascot, and it hops. Movement across a shape is
 * read before colour and long before a tooltip — a row with something alive in
 * it is findable out of the corner of an eye, which is the actual job. What the
 * mascot *is* belongs to the user and lives in the snapshot; nothing in here or
 * in the stylesheet knows it is a frog.
 *
 * This lives in a component rather than in two `<span>`s because the sprite is
 * structure now, not a class name, and the sidebar and the tab strip must not be
 * able to disagree about it — the same reason `labels.ts` exists for the words.
 */
import type { CSSProperties } from "react";
import type { AgentSnapshot, MascotConfig } from "../../../shared/model";
import { statusLabel } from "../labels";
import { sheetUrl, useSheet } from "../mascot";

export function Status({ agent, mascot }: { agent: AgentSnapshot; mascot: MascotConfig }) {
  /**
   * Exited is not an `AgentStatus` — it is a fact about the pty that outranks
   * whatever the heuristic last thought. Resolved here so both callers cannot
   * resolve it differently.
   */
  const state = agent.exited ? "exited" : agent.status;
  const label = statusLabel(agent);
  return (
    <span className={`status status-${state}`} title={label} aria-label={label} role="img">
      {state === "working" ? <Mascot config={mascot} /> : <span className="status-dot" />}
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
 */
export function Mascot({ config }: { config: MascotConfig }) {
  const src = sheetUrl(config.sheet);
  const sheet = useSheet(src);
  /**
   * The dot stands in until the sheet is known, and for good if it never is: a
   * mascot that cannot be drawn must still leave the row with something in it,
   * and a hole exactly where the state worth seeing would have been is the worst
   * of the available outcomes.
   */
  if (!sheet) return <span className="status-dot" />;

  const { frame, row, col, count, trim } = config;
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
          animationDuration: `${config.cycle}ms`,
          animationTimingFunction: `steps(${count})`,
        } as CSSProperties
      }
    />
  );
}
