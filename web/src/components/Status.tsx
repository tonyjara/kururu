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
 * mascot *is* belongs to the user: `mascot.ts` here and `server/src/mascot.ts`
 * on the other side are the two halves of that, and neither this file nor the
 * stylesheet knows it is a frog.
 *
 * This lives in a component rather than in two `<span>`s because the sprite is
 * structure now, not a class name, and the sidebar and the tab strip must not be
 * able to disagree about it — the same reason `labels.ts` exists for the words.
 * The box is a fixed size whatever is inside it, so a row does not shift
 * sideways when an agent starts working, and a mascot of any frame size is
 * scaled into that box rather than being allowed to set the height of a tab.
 */
import type { CSSProperties } from "react";
import type { AgentSnapshot } from "../../../shared/model";
import { statusLabel } from "../labels";
import { useMascot } from "../mascot";

/**
 * How long one full cycle of the mascot takes, however many frames it has.
 *
 * A fixed cycle rather than a fixed frame rate, so a replacement sprite keeps
 * the cadence the window was designed around instead of running at whatever
 * speed its frame count implies — a twelve-frame mascot at the frog's frame rate
 * would take two seconds to get round, which stops reading as "busy" and starts
 * reading as "stuck".
 */
const CYCLE_MS = 720;

export function Status({ agent }: { agent: AgentSnapshot }) {
  const mascot = useMascot();
  /**
   * Exited is not an `AgentStatus` — it is a fact about the pty that outranks
   * whatever the heuristic last thought. Resolved here so both callers cannot
   * resolve it differently.
   */
  const state = agent.exited ? "exited" : agent.status;
  const label = statusLabel(agent);

  /**
   * The dot is the fallback as well as the mark for the other three states: a
   * mascot that has not loaded, or cannot, leaves the row with something in it
   * rather than a hole exactly where the state worth seeing would have been.
   */
  const showMascot = state === "working" && mascot !== null;

  return (
    <span className={`status status-${state}`} title={label} aria-label={label} role="img">
      {showMascot ? (
        <span
          className="mascot"
          style={
            {
              /**
               * The strip is laid out at one box-width per frame and walked
               * past the box by `@keyframes hop`, which translates it by its own
               * width. `steps()` wants the frame count, and the count came from
               * the image, so the animation is written here rather than in the
               * stylesheet — it is the one part of this that a replacement
               * sprite changes.
               */
              backgroundImage: `url(${mascot.src})`,
              width: `calc(var(--status-size) * ${mascot.frames})`,
              animationDuration: `${CYCLE_MS}ms`,
              animationTimingFunction: `steps(${mascot.frames})`,
            } as CSSProperties
          }
        />
      ) : (
        <span className="status-dot" />
      )}
    </span>
  );
}
