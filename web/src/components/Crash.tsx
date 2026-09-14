/**
 * What to show instead of a black window.
 *
 * React unmounts the whole root when a render throws and nothing catches it —
 * that is the documented behaviour, not a bug to work around. But `#root` is the
 * entire application and `body` is `--bg`, so an unmounted root is a window of
 * flat near-black with no text, no error and nothing to click: indistinguishable
 * at a glance from a dead GPU context, a server that never answered, or a
 * display asleep. Every one of those has a different cause and the same picture,
 * which is how "the screen went black" ends up with "idk why" attached to it.
 *
 * So this exists to make one of those four say which it is. It fixes nothing and
 * is not meant to — the value is entirely in the window still containing a
 * sentence afterwards. A boundary that silently re-rendered the tree would be
 * worse than the black screen, because a component that throws on every render
 * would spin instead of stopping, so the only way out offered here is a reload.
 *
 * The agents are not in this process. A crash in here costs a repaint and
 * nothing else — worth saying on the screen, because an app that owns other
 * people's long-running work has to be explicit about what it just cost them.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** React's own "which components were mounted", which a stack trace does not give. */
  where: string | null;
}

export class Crash extends Component<Props, State> {
  override state: State = { error: null, where: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /**
     * To the console as well as to the screen. The screen is for the person
     * looking at it now; the console is what survives being read out later, and
     * it is the only copy that keeps the full stack rather than the first lines
     * that fit in a box.
     */
    console.error("kururu: the UI crashed", error, info.componentStack);
    this.setState({ where: info.componentStack?.trim() || null });
  }

  override render(): ReactNode {
    const { error, where } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <h1>kururu stopped drawing.</h1>
        <p className="muted">
          The window is what broke. The server is still running and your agents are still in the
          pty host, untouched — reloading costs a repaint and nothing else.
        </p>
        {/* Above the trace rather than below it: a stack is as long as it likes,
            and the way out should not be something you have to scroll past one
            to find. */}
        <button className="button" onClick={() => location.reload()}>
          Reload the window
        </button>
        <pre className="crash-error">{error.stack || `${error.name}: ${error.message}`}</pre>
        {where && <pre className="crash-where">{where}</pre>}
      </div>
    );
  }
}
