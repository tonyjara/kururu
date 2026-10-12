/**
 * Settings → Connections → Machines: which of the user's other computers the
 * sidebar watches — a VPS, a PC on the same tailnet.
 *
 * This works through the user's own ssh, so what makes a machine work here is
 * what makes `ssh <host>` work in a terminal without a question, and the one
 * thing the page can usefully say when it does not is to go and do that once.
 * The row in the sidebar carries ssh's own error for the rest, and its shell
 * button is the terminal to do it in.
 *
 * It holds nothing but what is being typed: the list is the server's, pushed
 * to every window.
 */
import { useState } from "react";
import * as api from "../session";
import { useKururu } from "../session";
import { Btn, DangerButton, Details, errorText, Group, Item, Mono, Outcome, P, Row, Step, Steps, useTyping } from "./ui";

export function MachinesPage() {
  const { machines } = useKururu();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [panel, setPanel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typing = useTyping();

  const add = () => {
    if (!host.trim() || busy) return;
    setBusy(true);
    setError(null);
    api
      .addMachine(name, host, panel)
      .then(() => {
        setName("");
        setHost("");
        setPanel("");
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const field = (value: string, set: (v: string) => void, placeholder: string, label: string, mono = true) => (
    <input
      className={`st-input${mono ? " st-input-mono" : ""}`}
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
    <>
      <Group title="Watching" foot="CPU, memory and disk in the sidebar, read over ssh every fifteen seconds while a window is open, with a shell button beside each.">
        {machines.length === 0 && <p className="st-empty">No machines yet.</p>}
        {machines.map((machine) => (
          <Item
            key={machine.id}
            name={machine.name}
            sub={
              <>
                <Mono>{machine.host}</Mono>
                {machine.error ? <Outcome bad>{machine.error}</Outcome> : <> · {machine.reading ? "connected" : "connecting…"}</>}
              </>
            }
          >
            <DangerButton label="Remove" ask={`Stop watching ${machine.name}?`} onConfirm={() => api.removeMachine(machine.id)} />
          </Item>
        ))}
      </Group>

      <Group title="Add a machine">
        <Steps>
          <Step n={1} done={machines.length > 0} title="Make ssh work without a question" line="kururu never answers a prompt.">
            <Details summary="What that means">
              <P>
                The host has to work with <Mono>ssh &lt;host&gt;</Mono> in a terminal without asking anything: the key loaded, the host key already accepted, and, with Tailscale SSH
                in check mode, the browser check done. kururu runs <Mono>ssh</Mono> with your own <Mono>~/.ssh/config</Mono> and one fixed, read-only script there:{" "}
                <Mono>/proc</Mono> and <Mono>df</Mono>. Nothing is installed and no port is opened. If a row says it cannot connect, press its shell button in the sidebar and
                answer whatever ssh asks, once.
              </P>
            </Details>
          </Step>
          <Step n={2} done={false} title="Add it">
            <Row label="Host" hint="As you would type it after ssh." wide as="label">
              {field(host, setHost, "my-vps or root@203.0.113.7", "ssh host")}
            </Row>
            <Row label="Name" hint="The host, if blank." wide as="label">
              {field(name, setName, "", "Name", false)}
            </Row>
            <Row label="Panel" hint="A dashboard to link to, optional." wide as="label">
              {field(panel, setPanel, "https://dokploy.example.com", "Dashboard URL")}
            </Row>
            <Row label="" hint={error ? <Outcome bad>{error}</Outcome> : undefined}>
              <Btn primary disabled={!host.trim() || busy} onClick={add}>
                {busy ? "Adding…" : "Add"}
              </Btn>
            </Row>
          </Step>
        </Steps>
      </Group>
    </>
  );
}
