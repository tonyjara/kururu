/**
 * Settings → Connections → Nodes: the other kururus this one is linked
 * with — a child on a box that stays on while the Mac's lid is shut — and,
 * on the parent, the roster that says who they are.
 *
 * Two pages in one, by role. The parent's is the one with controls: a
 * computer is added by running one command on it, which this page shows —
 * the Mac's address and a single-use code already in it — and then says
 * when it has joined; a node is renamed, ranked by dragging, removed. A
 * child's is the same list read-only, since the roster is the parent's. A
 * node in no roster yet shows Add a computer, and, folded under it, a
 * place to paste the Mac's command for when this is the new computer.
 *
 * Pairing used to start on the new computer, which showed a code to be
 * typed into the Mac with its address, and the page could not make plain
 * what the code was for, where it came from or where it went. Now the
 * person copies one line from the screen they are already looking at.
 *
 * Ranking is a drag, and also ↑ and ↓, because a phone has no drag to give
 * and the order decides who leads when the Mac sleeps. Removing asks first,
 * in place, as every destructive control in Settings does: Settings is
 * already modal, and a confirm over a confirm is a stack.
 *
 * Each child's secrets sit under the roster on the parent, a group per
 * node, and what a child holds sits under its read-only roster
 * (`Secrets.tsx`).
 *
 * It holds nothing but what is being typed; the list is the server's.
 */
import { useEffect, useRef, useState } from "react";
import type { NodeStatus, NodesView } from "../../../shared/nodes";
import { nodeState } from "../nodes";
import * as api from "../session";
import { useKururu } from "../session";
import { HeldList, NodeSecrets } from "./Secrets";
import { Banner, Btn, DangerButton, Details, Dot, Empty, errorText, Group, IconBtn, Item, Mono, Outcome, P, Row, Step, Steps, useTyping, type Tone } from "./ui";

/** A row of the rank list: this node or another, in one shape so the drag treats them alike. */
interface Member {
  id: string;
  name: string;
  rank: number;
  self: boolean;
  node: NodeStatus | null;
}

function membersOf(view: NodesView): Member[] {
  const others: Member[] = view.nodes.map((node) => ({ id: node.id, name: node.name, rank: node.rank, self: false, node }));
  const self: Member[] = view.self.rank === null ? [] : [{ id: view.self.id, name: view.self.name, rank: view.self.rank, self: true, node: null }];
  return [...others, ...self].sort((a, b) => a.rank - b.rank);
}

function toneOf(member: Member): Tone {
  if (member.self) return "ok";
  return member.node?.state === "up" ? "ok" : member.node?.state === "connecting" ? "busy" : "off";
}

export function NodesPage() {
  const { nodes } = useKururu();
  if (!nodes) return <Empty>Asking the server…</Empty>;
  return (
    <>
      {nodes.role === "child" ? <ChildRoster view={nodes} /> : <ParentRoster view={nodes} />}
      {nodes.role === "child" && <HeldList />}
      {nodes.role === "parent" && nodes.nodes.map((node) => <NodeSecrets key={node.id} node={node} />)}
      {nodes.role === "alone" && <JoinMac />}
    </>
  );
}

/** The parent's list, and a lone node's — which becomes a parent with its first add. */
function ParentRoster({ view }: { view: NodesView }) {
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /** Set by Escape and by a save, so the blur that follows the field going away does not save a second time, or save what Escape abandoned. */
  const abandoned = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typing = useTyping();
  const members = membersOf(view);
  const parent = view.role === "parent";

  const attempt = (work: Promise<unknown>) => {
    setError(null);
    work.catch((err: unknown) => setError(errorText(err)));
  };
  /** The whole list, with `id` moved to land before `before` (or last). */
  const move = (id: string, before: string | null) => {
    const order = members.map((m) => m.id).filter((one) => one !== id);
    const at = before === null ? order.length : order.indexOf(before);
    order.splice(at === -1 ? order.length : at, 0, id);
    if (order.join() !== members.map((m) => m.id).join()) attempt(api.rankNodes(order));
  };
  const step = (index: number, by: -1 | 1) => {
    const order = members.map((m) => m.id);
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(index + by, 0, moved);
    attempt(api.rankNodes(order));
  };
  const saveName = () => {
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    if (!renaming) return;
    // Once: Enter saves and then the field's going away blurs it.
    abandoned.current = true;
    const { id, value } = renaming;
    setRenaming(null);
    if (value.trim()) attempt(api.renameNode(id, value.trim()));
  };

  return (
    <>
      {view.reachable && <Banner>{view.reachable}</Banner>}
      {parent && (
        <Group
          title="The roster"
          foot="Signed here and passed along every link. Drag to rank: the first node in this order that is reachable leads, which is the one that will answer Telegram while the nodes above it are away."
        >
          {members.map((member, index) => {
            const node = member.node;
            const line = over?.id === member.id ? (over.after ? " st-node-under" : " st-node-over") : "";
            return (
              <div
                key={member.id}
                className={`st-node${line}${dragging === member.id ? " st-node-dragging" : ""}`}
                draggable={renaming?.id !== member.id}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", member.id);
                  setDragging(member.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(event) => {
                  if (!dragging || dragging === member.id) return;
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > box.top + box.height / 2;
                  setOver((was) => (was?.id === member.id && was.after === after ? was : { id: member.id, after }));
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setOver((was) => (was?.id === member.id ? null : was));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = dragging;
                  const after = over?.id === member.id && over.after;
                  setDragging(null);
                  setOver(null);
                  if (!id || id === member.id) return;
                  move(id, after ? (members[index + 1]?.id ?? null) : member.id);
                }}
              >
                <Item
                  lead={<Dot tone={toneOf(member)} title={member.self ? "this node" : node ? nodeState(node) : undefined} />}
                  name={
                    renaming?.id === member.id ? (
                      <input
                        className="st-input st-input-mono"
                        value={renaming.value}
                        aria-label={`New name for ${member.name}`}
                        autoFocus
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(event) => setRenaming({ id: member.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveName();
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            abandoned.current = true;
                            setRenaming(null);
                          }
                        }}
                        onFocus={typing.onFocus}
                        onBlur={() => {
                          typing.onBlur();
                          saveName();
                        }}
                      />
                    ) : (
                      <>
                        <span>{member.name}</span>
                        {member.self && <span className="st-pill">this node</span>}
                        {view.leader === member.id && <span className="st-pill st-pill-ok">leads</span>}
                      </>
                    )
                  }
                  sub={member.self ? selfLine(view) : node ? <NodeLine node={node} /> : null}
                >
                  <IconBtn glyph="↑" label={`Move ${member.name} up`} disabled={index === 0} onClick={() => step(index, -1)} />
                  <IconBtn glyph="↓" label={`Move ${member.name} down`} disabled={index === members.length - 1} onClick={() => step(index, 1)} />
                  <IconBtn
                    icon="edit"
                    label={`Rename ${member.name}`}
                    onClick={() => {
                      abandoned.current = false;
                      setRenaming({ id: member.id, value: member.name });
                    }}
                  />
                  {node && <OpenLink node={node} />}
                  {node && (
                    <DangerButton
                      label="Remove"
                      ask={`Take ${node.name} out of the roster? Its links drop, and it comes back only by running a new join command.`}
                      onConfirm={() => attempt(api.removeNode(node.id))}
                    />
                  )}
                </Item>
              </div>
            );
          })}
          {error && (
            <Row label="" hint={<Outcome bad>{error}</Outcome>} />
          )}
        </Group>
      )}
      <AddComputer view={view} />
    </>
  );
}

/** The second line of this node's own row: where the others dial it. */
function selfLine(view: NodesView) {
  return view.self.address ? (
    <>
      <Mono>
        {view.self.address}:{view.self.port}
      </Mono>{" "}
      · where the others dial it
    </>
  ) : (
    "no tailnet address"
  );
}

/** Another node's second line: its link, where it is, which kururu, and what went wrong last. */
function NodeLine({ node }: { node: NodeStatus }) {
  return (
    <>
      {nodeState(node)} ·{" "}
      <Mono>
        {node.address}:{node.port}
      </Mono>
      {node.summary && <> · v{node.summary.version}</>}
      {node.summary && !node.summary.host.current && <> · its pty host is behind</>}
      {node.parent && <> · the parent</>}
      {node.error && node.state !== "up" && (
        <>
          {" "}
          · <Outcome bad>{node.error}</Outcome>
        </>
      )}
    </>
  );
}

/**
 * Going to the node, which is how anything there is done: a browser follows
 * the link, with the node's token in it on the parent. The desktop window
 * does not follow it in place — `preload.js` lets no served page move the
 * window — so it opens in the browser, and the tray's "Open" is the window's
 * own way there.
 */
function OpenLink({ node }: { node: NodeStatus }) {
  return (
    <a className="st-btn" href={node.url} target="_blank" rel="noreferrer noopener" title={`Open ${node.name}'s kururu`}>
      Open
    </a>
  );
}

/** What to run on a computer that has no kururu yet: the clone and the wizard, which ends by asking for the join command. */
const SETUP_LINES = "git clone https://github.com/tonyjara/kururu.git ~/kururu\ncd ~/kururu && node tools/kururu.mjs child setup";

/**
 * A command to run on the other computer, with a Copy beside it. Selecting
 * it is one click too (`user-select: all`), for a phone, whose page over
 * plain http gets no clipboard.
 */
function Command({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className="st-command">
      <pre className="st-command-text" aria-label={label}>
        {text}
      </pre>
      {typeof navigator.clipboard?.writeText === "function" && <Btn onClick={copy}>{copied ? "Copied" : "Copy"}</Btn>}
    </div>
  );
}

/**
 * Add a computer: three steps in plain words, and the middle one is a
 * command with this Mac's address and a single-use code in it. The page
 * watches for the join itself — `joined` in the view — so the person goes
 * from the other computer's terminal back to a page that already says it
 * worked.
 */
function AddComputer({ view }: { view: NodesView }) {
  const [error, setError] = useState<string | null>(null);
  /** When this page asked for the command, so a join from before it is not taken for this one. */
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const invite = view.invite;
  useEffect(() => {
    if (!invite) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [invite]);
  const show = (on: boolean) => {
    setError(null);
    if (on) setAskedAt(Date.now());
    api.inviteNode(on).catch((err: unknown) => setError(errorText(err)));
  };
  const joined = askedAt !== null && view.joined && view.joined.at >= askedAt ? view.joined : null;
  const left = invite ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : 0;
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <Group title="Add a computer">
      <Row label="To add a computer, run one command on it." hint="The command has this Mac's address and a code in it, and works once, for ten minutes." />
      <Steps>
        <Step n={1} done={false} title="Make sure the new computer has kururu" line="Skip this if kururu is already set up there.">
          <Row label="Ask an agent on it" hint={<>Say: “use the kururu skill to set up a child”. It walks you through the rest.</>} wide />
          <Row label="Or run these on it" hint="Setup checks and fixes what it needs, and at the end asks for the command in step 2." wide>
            <Command text={SETUP_LINES} label="Commands that set kururu up on the new computer" />
          </Row>
        </Step>
        <Step n={2} done={joined !== null} title="Run this command on the new computer">
          {invite ? (
            <Row label="" hint={<>Works once, for the next {clock}.</>} wide>
              <Command text={invite.command} label="The command to run on the new computer" />
            </Row>
          ) : (
            <Row label="" hint={error ? <Outcome bad>{error}</Outcome> : view.reachable ? undefined : "It has this Mac's address and a single-use code in it."}>
              <Btn primary disabled={view.reachable !== null} onClick={() => show(true)}>
                Show the command
              </Btn>
            </Row>
          )}
        </Step>
        <Step n={3} done={joined !== null} title={joined ? `${joined.name} joined` : "Wait here"}>
          {!joined && (
            <Row
              label=""
              hint={invite ? "Waiting for the new computer… This page says when it has joined." : "This page says when the new computer has joined."}
            >
              {invite && <Btn onClick={() => show(false)}>Cancel</Btn>}
            </Row>
          )}
        </Step>
      </Steps>
      {/* Outside the steps, because a done step folds to its title and this
          is the one line the person came back to the page to read. */}
      {joined && (
        <Row label={`${joined.name} joined.`} hint="It is in the list above, and its link comes up by itself in a moment.">
          <Btn onClick={() => show(true)}>Add another</Btn>
        </Row>
      )}
    </Group>
  );
}

/** A child's view of the roster: who is in it and how each link is, and nothing to change. */
function ChildRoster({ view }: { view: NodesView }) {
  const parent = view.nodes.find((node) => node.parent);
  const members = membersOf(view);
  return (
    <Group
      title={parent ? `In ${parent.name}'s roster` : "In a roster"}
      foot="Who is in the roster, their names and their order are the parent's, changed in its Settings → Nodes. This node keeps the newest roster it has seen and passes it on."
    >
      {members.map((member) => (
        <Item
          key={member.id}
          lead={<Dot tone={toneOf(member)} title={member.self ? "this node" : member.node ? nodeState(member.node) : undefined} />}
          name={
            <>
              <span>{member.name}</span>
              {member.self && <span className="st-pill">this node</span>}
              {view.leader === member.id && <span className="st-pill st-pill-ok">leads</span>}
            </>
          }
          sub={member.self ? selfLine(view) : member.node ? <NodeLine node={member.node} /> : null}
        >
          {member.node && <OpenLink node={member.node} />}
        </Item>
      ))}
    </Group>
  );
}

/**
 * For when this is the new computer, and its own page is the easiest place
 * to paste into — a phone pointed at it, say. The same as running the
 * command in its terminal. Folded, because on the Mac this is the wrong
 * door, and Add a computer above is the right one.
 */
function JoinMac() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typing = useTyping();
  const join = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    api
      .joinNode(text)
      .then(() => setText(""))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Group title="Is this the new computer?">
      <Details summary="Paste the Mac's command here instead">
        <Row label="The command from the Mac" hint="Settings → Nodes → Add a computer, on the Mac, shows it: kururu child join and an address and a code." wide as="label">
          <input
            className="st-input st-input-mono"
            value={text}
            placeholder="kururu child join 100.64.0.1:7717 ABCD-EFGH"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") join();
            }}
            {...typing}
          />
        </Row>
        <Row label="" hint={error ? <Outcome bad>{error}</Outcome> : undefined}>
          <Btn primary disabled={!text.trim() || busy} onClick={join}>
            {busy ? "Joining…" : "Join"}
          </Btn>
        </Row>
      </Details>
    </Group>
  );
}
