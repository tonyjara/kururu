/**
 * Settings → Connections → Nodes: the other kururus this one is linked
 * with — a child on a box that stays on while the Mac's lid is shut — and,
 * on the parent, the roster that says who they are.
 *
 * Two pages in one, by role, because the two halves of pairing happen on two
 * machines. The parent's is the one with controls: a node is added by the
 * address and the code it is showing, renamed, ranked by dragging, removed.
 * A child's is the same list read-only — the roster is the parent's, signed
 * there, and a child has no say in it — plus the code to show when it is
 * being paired. A node in no roster yet has both doors, since either it is
 * about to be a parent or about to be a child, and only the user knows which.
 *
 * Ranking is a drag, and also ↑ and ↓, because a phone has no drag to give
 * and the order decides who leads when the Mac sleeps. Removing asks first,
 * in place, as every destructive control in Settings does: Settings is
 * already modal, and a confirm over a confirm is a stack.
 *
 * It holds nothing but what is being typed; the list is the server's.
 */
import { useEffect, useRef, useState } from "react";
import { formatCode, type NodeStatus, type NodesView } from "../../../shared/nodes";
import { nodeState } from "../nodes";
import * as api from "../session";
import { useKururu } from "../session";
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
      {nodes.role !== "parent" && <PairHere view={nodes} />}
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
                      ask={`Take ${node.name} out of the roster? Its links drop, and it is paired again only with a new code.`}
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
      <AddNode view={view} />
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

function AddNode({ view }: { view: NodesView }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; bad: boolean } | null>(null);
  const typing = useTyping();

  const add = () => {
    if (!address.trim() || !code.trim() || busy) return;
    setBusy(true);
    setOutcome(null);
    api
      .addNode(address, code, name)
      .then((node) => {
        setAddress("");
        setCode("");
        setName("");
        setOutcome({ text: `Paired ${node.name}. Its link comes up in a moment.`, bad: false });
      })
      .catch((err: unknown) => setOutcome({ text: errorText(err), bad: true }))
      .finally(() => setBusy(false));
  };

  const field = (value: string, set: (v: string) => void, placeholder: string, label: string) => (
    <input
      className="st-input st-input-mono"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(event) => set(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") add();
      }}
      {...typing}
    />
  );

  return (
    <Group title="Add a node">
      <Steps>
        <Step n={1} done={false} title="Show a code on the new node" line={<>On it, <Mono>kururu child code</Mono>, or its own Settings → Nodes.</>}>
          <Details summary="What pairing does">
            <P>
              The node shows a code for ten minutes. This machine sends the code to the node's address with the roster; the node answers with its keys, and this
              machine signs a roster with it in. From then on the two link by proving those keys, over the tailnet only, and nothing else is shared: each keeps
              its own boards and agents, and what crosses is a summary of what each is doing. The first node you add makes this one the parent.
            </P>
          </Details>
        </Step>
        <Step n={2} done={false} title="Type its address and code here">
          <Row label="Address" hint="Its tailnet address, with the port if not 7717." wide as="label">
            {field(address, setAddress, "100.96.1.2:7717", "Node address")}
          </Row>
          <Row label="Code" wide as="label">
            {field(code, setCode, "ABC-DEF", "Pairing code")}
          </Row>
          <Row label="Name" hint="What @ will call it. Its hostname, if blank." wide as="label">
            {field(name, setName, "", "Node name")}
          </Row>
          <Row label="" hint={outcome ? <Outcome bad={outcome.bad}>{outcome.text}</Outcome> : undefined}>
            <Btn primary disabled={!address.trim() || !code.trim() || busy || view.reachable !== null} onClick={add}>
              {busy ? "Pairing…" : "Pair"}
            </Btn>
          </Row>
        </Step>
      </Steps>
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

/** The other half of pairing: a code shown here, typed in on the parent. */
function PairHere({ view }: { view: NodesView }) {
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pairing = view.pairing;
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  const ask = (on: boolean) => {
    setError(null);
    api.nodeCode(on).catch((err: unknown) => setError(errorText(err)));
  };
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <Group
      title={view.role === "child" ? "Pair again" : "Pair with a parent"}
      foot="The code is good for ten minutes and five wrong tries. Type it, with this node's address, into the parent's Settings → Nodes."
    >
      {pairing ? (
        <>
          <Row label="Code" hint={`Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`}>
            <span className="st-code">{formatCode(pairing.code)}</span>
          </Row>
          <Row label="This node's address" hint={view.self.address ? undefined : "No tailnet address: the parent cannot reach this node until Tailscale is up."}>
            {view.self.address ? (
              <Mono>
                {view.self.address}:{view.self.port}
              </Mono>
            ) : (
              <Outcome bad>none</Outcome>
            )}
          </Row>
          <Row label="" hint={error ? <Outcome bad>{error}</Outcome> : undefined}>
            <Btn onClick={() => ask(false)}>Stop</Btn>
          </Row>
        </>
      ) : (
        <Row label="Show a pairing code" hint={error ? <Outcome bad>{error}</Outcome> : "For the parent to type in."}>
          <Btn onClick={() => ask(true)}>Show code</Btn>
        </Row>
      )}
    </Group>
  );
}
