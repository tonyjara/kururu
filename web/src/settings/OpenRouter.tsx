/**
 * Settings → Connections → OpenRouter: the key the bottom bar's balance is read with.
 *
 * One key and the words around it, and the words are the page: before anybody
 * pastes a key that can delete every other key on their account, it has to say
 * which kind of key, where to make one, and what kururu does with it — and the
 * first thing most people will try is the inference key already in their
 * `.env`, which the server refuses with a sentence pointing back here.
 *
 * The key goes to the server once and is not sent back; what this draws
 * afterwards is the `hint` every window is sent.
 */
import * as api from "../session";
import { useKururu } from "../session";
import { HeldFrom, LentTo, useHeld } from "./Secrets";
import { A, Details, Group, KeyRow, Mono, P, Readout, Step, Steps } from "./ui";

const KEYS_URL = "https://openrouter.ai/settings/management-keys";

export function OpenRouterPage() {
  const { openrouter } = useKururu();
  const held = useHeld("openrouter");
  return (
    <>
      <Group title="Account" foot="Your balance on the bottom bar, with what every key on the account has spent today, this week and this month. Asked once a minute while a window is open.">
        <Readout
          label="Key"
          tone={!openrouter ? "off" : openrouter.error ? "bad" : openrouter.reading ? "ok" : "busy"}
          value={!openrouter ? "None yet" : openrouter.error ? openrouter.error : openrouter.reading ? `${openrouter.hint}, connected` : `${openrouter.hint}, connecting…`}
        />
        <HeldFrom kind="openrouter" />
        <LentTo kind="openrouter" />
      </Group>
      {!held && <SetUp />}
    </>
  );
}

/** The two steps, on a node that keeps its own key. One holding the parent's has nothing to set. */
function SetUp() {
  const { openrouter } = useKururu();
  return (
    <>
      <Group title="Set up">
        <Steps>
          <Step n={1} done={openrouter !== null} title="Make a management key" line="Not the kind your projects use: OpenRouter only tells the balance to a management key.">
            <Readout label="Keys page" value={<A href={KEYS_URL}>openrouter.ai/settings/management-keys</A>} />
            <Details summary="What a management key can do">
              <P>
                It cannot run a model, but it can create and delete your API keys. kururu only ever reads with it. It is kept in <Mono>~/.config/kururu/openrouter.json</Mono>,
                readable only by you, never sent back to a window and never in a backup. It goes to another node only if you lend it there, in Settings → Nodes.
              </P>
            </Details>
          </Step>
          <Step n={2} done={openrouter !== null} title="Give kururu the key">
            <KeyRow
              label="Key"
              placeholder="sk-or-v1-…"
              ariaLabel="OpenRouter management key"
              stored={openrouter ? { hint: openrouter.hint, tone: openrouter.error ? "bad" : openrouter.reading ? "ok" : "busy" } : null}
              onSave={(key) => api.setOpenRouterKey(key)}
              removeAsk="Forget the key?"
              onRemove={() => api.clearOpenRouterKey()}
            />
          </Step>
        </Steps>
      </Group>
    </>
  );
}
