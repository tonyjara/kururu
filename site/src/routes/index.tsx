import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frog } from "../components/Frog";
import { PhoneShot, Shot } from "../components/Shot";
import { RELEASE, SITE } from "../site";
import { SHOTS } from "../shots";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Statuses />
        <Workspaces />
        <Boards />
        <Kuru />
        <Needs />
        <Phone />
        <Machines />
        <Processes />
        <Extras />
        <Download />
      </main>
      <Footer />
    </>
  );
}

function Nav() {
  return (
    <header className="nav">
      <div className="wrap nav-inner">
        <a className="brand" href="/" aria-label="Kururu home">
          <Frog scale={1} />
          <span>kururu</span>
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#boards">Boards</a>
          <a href="#kuru">Kuru</a>
          <a href="#phone">Phone</a>
          <a href="#machines">Machines</a>
          <a href={SITE.github}>GitHub</a>
        </nav>
        <a className="btn btn-small" href="#download">
          Download
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="wrap">
        <p className="eyebrow">
          <span className="pixel">Kururu</span> is Guaraní for frog
        </p>
        <h1>
          Every coding agent you run, <span className="hl">in one window.</span>
        </h1>
        <p className="lede">
          Kururu runs Claude Code and Codex in terminals it owns, across all your projects. Tile them, hand them cards
          from a board, and talk to one session that keeps an eye on the rest, from your desk, your phone or Telegram.
          Close the window and they keep working.
        </p>
        <div className="cta-row">
          <a className="btn" href={RELEASE.appleSilicon}>
            <AppleGlyph />
            Download for Mac
          </a>
          <a className="btn btn-ghost" href={SITE.github}>
            <GitHubGlyph />
            Source on GitHub
          </a>
        </div>
        <p className="fine">
          Version {RELEASE.version} for Apple silicon · <a href={RELEASE.intel}>Intel build</a> · Free and open source,
          Apache 2.0
        </p>
      </div>
      <div className="wrap hero-shot">
        <div className="hopper" aria-hidden="true">
          <Frog pose="hop" scale={2} />
        </div>
        <Shot shot={SHOTS.hero} title="Kururu" sizes="(min-width: 1200px) 1150px, 100vw" eager />
      </div>
    </section>
  );
}

/** The four states the app draws, because the legend is the product in one line. */
function Statuses() {
  return (
    <section className="statuses" aria-label="Agent states">
      <div className="wrap status-row">
        <div className="status">
          <Frog pose="hop" scale={1} />
          <div>
            <b>Working</b>
            <span>the mascot hops, because a glance catches movement</span>
          </div>
        </div>
        <div className="status">
          <i className="dot dot-blocked" />
          <div>
            <b>Blocked</b>
            <span>it is asking you something</span>
          </div>
        </div>
        <div className="status">
          <i className="dot dot-done" />
          <div>
            <b>Done</b>
            <span>it finished a turn</span>
          </div>
        </div>
        <div className="status">
          <i className="dot dot-idle" />
          <div>
            <b>Idle</b>
            <span>waiting for the next prompt</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Feature({
  id,
  label,
  title,
  children,
  media,
  flip = false,
}: {
  id?: string;
  label: string;
  title: ReactNode;
  children: ReactNode;
  media: ReactNode;
  flip?: boolean;
}) {
  return (
    <section className={`feature${flip ? " flip" : ""}`} id={id}>
      <div className="wrap feature-grid">
        <div className="feature-copy">
          <p className="label">{label}</p>
          <h2>{title}</h2>
          {children}
        </div>
        <div className="feature-media">{media}</div>
      </div>
    </section>
  );
}

function Workspaces() {
  return (
    <Feature
      id="workspaces"
      label="Workspaces"
      title="Many agents, many projects, one layout"
      media={<Shot shot={SHOTS.reader} title="Workspace" />}
    >
      <p>
        A workspace is a project. Split it into panes, stack tabs in a pane, and drag a tab or a whole pane anywhere,
        across workspaces too. Nothing stops because it moved.
      </p>
      <ul className="ticks">
        <li>
          Real terminals with colour, scrollback, selection and mouse. Agents and plain shells are the same machinery.
        </li>
        <li>
          The sidebar lists agents, not tabs: what each is doing, where, and how much of its context window is gone.
        </li>
        <li>
          A pane can be a document instead of a grid: markdown with highlighted code, images and diagrams, following the
          file your nvim is on.
        </li>
        <li>
          Driven from a tmux-style prefix. <kbd>C-a</kbd> <kbd>|</kbd> splits, <kbd>C-a</kbd> <kbd>h</kbd>{" "}
          <kbd>j</kbd> <kbd>k</kbd> <kbd>l</kbd> moves, <kbd>C-a</kbd> <kbd>1</kbd>…<kbd>9</kbd> jumps.
        </li>
      </ul>
    </Feature>
  );
}

/** Full width, because the board is a wide strip and a side column shrinks it to a thumbnail. */
function Boards() {
  return (
    <section className="feature wide" id="boards">
      <div className="wrap">
        <div className="wide-copy">
          <div>
            <p className="label">Boards</p>
            <h2>A board for every project, and cards that start agents</h2>
            <p>
              Write the work down as cards. Press run on one and an agent starts on it in the agents' pane, with the card
              as its brief, and the card moves as the agent does.
            </p>
          </div>
          <ul className="ticks">
            <li>
              A card can get its own git worktree. Finishing rebases and fast-forwards it back; a dirty tree or a conflict
              stays standing and says why. Nothing is forced.
            </li>
            <li>
              An idle card's agent is put to sleep once its conversation is safe on disk, and running the card again
              resumes it.
            </li>
            <li>What the agent made, a document or a file, is linked on the card after the agent is gone.</li>
            <li>A profile board sits over every project, with a timeline for the cards that have dates.</li>
          </ul>
        </div>
        <Shot shot={SHOTS.board} title="Board" sizes="(min-width: 1200px) 1150px, 100vw" />
      </div>
    </section>
  );
}

function Kuru() {
  return (
    <section className="kuru" id="kuru">
      <div className="wrap">
        <div className="kuru-head">
          <p className="label">The harness</p>
          <h2>
            Kuru: one session that <span className="hl">keeps an eye on the others</span>
          </h2>
          <p className="lede">
            Kuru is a Claude Code session kururu starts for each profile, with kururu's own controls as its tools. Ask it
            to start an agent on the migration card, what the API worker said, or whether anybody is stuck. It starts
            agents in panes, reads their replies and screens, passes on what you tell it, and tells you when one finishes
            or needs you.
          </p>
        </div>
        <div className="kuru-grid">
          <div className="kuru-shot">
            <Shot shot={SHOTS.kuru} title="Kuru" sizes="(min-width: 1200px) 740px, (min-width: 900px) 62vw, 100vw" />
          </div>
          <div className="cards">
            <article className="card">
              <h3>
                <span className="pixel">01</span> By voice
              </h3>
              <p>
                Hold the right Control key and speak, in any app. Recognition is Apple's, on the device; replies are read
                aloud by a small model on your CPU. No audio leaves the Mac.
              </p>
            </article>
            <article className="card">
              <h3>
                <span className="pixel">02</span> From Telegram
              </h3>
              <p>
                Pair your own account with a bot you make, and message Kuru from anywhere. Anyone else who finds the bot
                gets no answer.
              </p>
            </article>
            <article className="card">
              <h3>
                <span className="pixel">03</span> In the drawer
              </h3>
              <p>
                Every prompt and reply in one conversation, whichever way it came in, with the replies you missed marked
                unheard.
              </p>
            </article>
          </div>
        </div>
        <p className="kuru-note">
          What Kuru says to an agent is typed into its terminal as your words. A permission prompt stays yours to answer.
          There is no API key: Kuru is a session on your own subscription, visible in a pane and resumable.
        </p>
      </div>
    </section>
  );
}

function Needs() {
  return (
    <Feature
      id="needs"
      label="Needs you"
      title="Know which agent is waiting on you"
      media={<Shot shot={SHOTS.needs} title="Needs you" />}
      flip
    >
      <p>
        One tray counts everything that wants your attention, grouped by project, and <kbd>C-a</kbd> <kbd>o</kbd> takes
        you to the next one.
      </p>
      <ul className="ticks">
        <li>An agent asking a question or waiting on a permission.</li>
        <li>A card in Review.</li>
        <li>A turn that ended while you were looking elsewhere.</li>
        <li>A card whose agent went away without finishing.</li>
      </ul>
      <p className="muted">A working agent is never on the list. A row leaves when its state does, not when you dismiss it.</p>
    </Feature>
  );
}

function Phone() {
  return (
    <section className="feature phone-section" id="phone">
      <div className="wrap phone-grid">
        <div className="feature-copy">
          <p className="label">On your phone</p>
          <h2>Watch and steer from the couch</h2>
          <p>
            The phone opens the same URL as the desktop. Scan the QR code in the sidebar, on your Wi-Fi or over your
            tailnet, and every agent is there.
          </p>
          <ul className="ticks">
            <li>One pane at a time, so the phone never shrinks the terminals on your desk.</li>
            <li>A row of the keys a soft keyboard lacks: escape, tab, arrows, ^C.</li>
            <li>The dev server you are building, proxied so it opens on the phone too.</li>
          </ul>
          <p className="muted">
            Kururu listens on this Mac only until you press Share, and the code it shares is one nothing else on the
            network has. It never runs <code>tailscale</code> for you.
          </p>
        </div>
        <div className="phones">
          <PhoneShot shot={SHOTS.phone} />
          <PhoneShot shot={SHOTS.phone2} />
        </div>
      </div>
    </section>
  );
}

function Machines() {
  return (
    <section className="feature" id="machines">
      <div className="wrap feature-grid">
        <div className="feature-copy">
          <p className="label">Machines</p>
          <h2>Agents on other computers, over ssh</h2>
          <p>
            Add any machine you reach with <code>ssh</code>: a VPS, a desktop on your tailnet. The sidebar shows its CPU,
            memory and disk, and a button opens a shell on it.
          </p>
          <ul className="ticks">
            <li>
              Pin a workspace to a machine and its shells, editors, agents and card runs open there, each in a named tmux
              session.
            </li>
            <li>A dropped connection reattaches by itself. Closing the tab ends the session.</li>
            <li>Copies made inside tmux or nvim on the far machine land on this Mac's clipboard.</li>
          </ul>
        </div>
        <div className="feature-media">
          <Terminal
            lines={[
              ["prompt", "ssh -t build-box tmux new -A -s kururu-api"],
              ["dim", "attached · build-box · ~/src/api"],
              ["prompt", "bun test"],
              ["ok", "  142 pass"],
              ["ok", "  0 fail"],
              ["dim", "Ran 142 tests across 31 files. [2.84s]"],
              ["dim", "— connection dropped · reattaching —"],
              ["dim", "attached · build-box · ~/src/api"],
            ]}
          />
        </div>
      </div>
    </section>
  );
}

function Terminal({ lines }: { lines: [kind: "prompt" | "ok" | "dim", text: string][] }) {
  return (
    <figure className="term" aria-label="A terminal on a remote machine">
      <div className="shot-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <em>build-box</em>
      </div>
      <pre>
        {lines.map(([kind, text], i) => (
          <span key={i} className={`t-${kind}`}>
            {kind === "prompt" ? <b>$ </b> : null}
            {text}
            {"\n"}
          </span>
        ))}
      </pre>
    </figure>
  );
}

/** The three processes, because "quitting the window stops nothing" is the claim developers will test first. */
function Processes() {
  return (
    <section className="processes">
      <div className="wrap">
        <p className="label">How it is built</p>
        <h2>Quitting the window stops nothing</h2>
        <p className="lede">
          Kururu is three processes, and the window is the least important of them. Restart the server, close the window,
          close the terminal you started it from: the agents keep running.
        </p>
        <ol className="stack">
          <li>
            <span className="pixel">pty host</span>
            <p>Holds every terminal and outlives everything. Restarting it is the only thing that ends an agent, and the app asks first.</p>
          </li>
          <li>
            <span className="pixel">server</span>
            <p>The layout, the boards, the protocol. Restarted freely; it reconnects to the host and nobody notices.</p>
          </li>
          <li>
            <span className="pixel">window</span>
            <p>Finds a server and draws it, exactly as the phone does. A menu-bar frog runs the rest without a terminal.</p>
          </li>
        </ol>
      </div>
    </section>
  );
}

function Extras() {
  const items: [string, string][] = [
    ["File tree", "Markdown opens in the reader, everything else in the nvim already running in that project."],
    ["Dev servers", "Found on their own, listed under the agents, stoppable from their row, reachable from the phone."],
    ["Databases", "A workspace's Postgres, from its .env, in a viewer that is read-only unless you flip it."],
    ["The web for agents", "Search and scrape tools for every agent kururu starts, through a chain of providers you set."],
    ["Plan usage", "How much of your Claude plan is left, in the sidebar, for whichever account the profile uses."],
    ["Logins per profile", "Keep work and personal Claude and Codex accounts apart, one switch per profile."],
    ["Themes and skins", "Palette and shape chosen separately, plus mascots, from a registry of styles."],
    ["Backups", "Boards, conversations and settings to a private git repository of yours. Never a secret."],
  ];
  return (
    <section className="extras">
      <div className="wrap">
        <p className="label">Also in the box</p>
        <h2>The rest of a day with agents</h2>
        <div className="extras-grid">
          {items.map(([t, d]) => (
            <div className="extra" key={t}>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Download() {
  return (
    <section className="download" id="download">
      <div className="wrap download-inner">
        <Frog pose="croak" scale={4} className="download-frog" />
        <h2>Get Kururu</h2>
        <p className="lede">
          A signed Mac app. Open it and a frog appears in the menu bar; it starts everything else. Bring your own Claude
          Code or Codex.
        </p>
        <div className="cta-row center">
          <a className="btn" href={RELEASE.appleSilicon}>
            <AppleGlyph />
            Apple silicon
          </a>
          <a className="btn btn-ghost" href={RELEASE.intel}>
            <AppleGlyph />
            Intel
          </a>
        </div>
        <p className="fine">
          Version {RELEASE.version}, {RELEASE.date} · <a href={RELEASE.page}>Release notes</a> ·{" "}
          <a href={SITE.github}>Build it from source</a>
        </p>
        <p className="fine muted">
          Talking to Kuru needs macOS 26 and <code>brew install yap</code>.
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <span className="brand small">
          <Frog scale={1} />
          <span>kururu</span>
        </span>
        <nav aria-label="Footer">
          <a href={SITE.github}>GitHub</a>
          <a href={`${SITE.github}/blob/main/CHANGELOG.md`}>Changelog</a>
          <a href={`${SITE.github}/blob/main/LICENSE`}>Apache 2.0</a>
        </nav>
        {/* noopener without noreferrer, so tonyjara.com sees the visits came from here. */}
        <a className="made" href="https://tonyjara.com" target="_blank" rel="noopener">
          Made by <b>Nyto</b>
        </a>
      </div>
    </footer>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.32-3.5zM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.67-.92 2.66.97.08 1.96-.49 2.56-1.21z" />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}
