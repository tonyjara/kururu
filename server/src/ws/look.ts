/**
 * How kururu looks and behaves for the person: the mascots, the keyboard, the theme and the skin, the launchers, notifications, the terminal's appearance and where agents open.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import { isAgentPlacement } from "../../../shared/agentpane";
import { bindKey } from "../../../shared/keys";
import { adoptLaunch } from "../../../shared/launchers";
import { adoptMascot } from "../../../shared/model";
import { adoptNotify } from "../../../shared/notify";
import { skinFor } from "../../../shared/skin";
import { adoptAppearance, themeFor } from "../../../shared/theme";
import type { ClientMessage } from "../../../shared/wire";
import { appearance, type ClientState, keys, mascots, provide, pushSnapshot, styles, workspaces } from "../context";
import { writeKeys } from "../keys";
import { saveAppearance, saveLaunch, saveMascots, saveNotify } from "../look";
import { freshMascotId } from "../mascot";
import { pollAccountUsage } from "../sweeps";

export function lookVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    /**
     * The selection is adopted rather than trusted: it arrives from a client,
     * and `adoptMascot` is what turns "a number somebody dragged too far" into
     * the nearest legal one. A sheet that does not exist is refused there and
     * falls back, so what gets written is always something that can be drawn.
     *
     * A message naming a mascot that is not there is dropped rather than
     * creating one. Settings only ever edits something it is looking at, so this
     * is a message from a window whose list is a moment out of date, and
     * resurrecting a deleted mascot is a worse answer than losing one drag.
     */
    case "set-mascot": {
      const one = mascots.list.find((m) => m.id === msg.id);
      if (!one) return true;
      saveMascots({
        ...mascots,
        // Id and name first, so the file stays readable to the person it says
        // can edit it by hand.
        list: mascots.list.map((m) =>
          m.id === msg.id ? { id: m.id, name: m.name, ...adoptMascot(msg.mascot) } : m,
        ),
      });
      return true;
    }

    /**
     * A copy of the one you are looking at, not a fresh default: you press this
     * when the thing in front of you is nearly right, and starting from the
     * default frog would throw away the sheet and the cell size you had just
     * found. It becomes the active one, because adding something you then have
     * to go and click is a step that decided nothing.
     */
    case "add-mascot": {
      const from = mascots.list.find((m) => m.id === (msg.from ?? mascots.default)) ?? mascots.list[0]!;
      const id = freshMascotId(mascots.list);
      saveMascots({
        ...mascots,
        // Capped here rather than left for the adopter, or a name copied enough
        // times would come back forty characters shorter than it went in.
        list: [...mascots.list, { ...from, id, name: `${from.name} copy`.slice(0, 40) }],
      });
      return true;
    }

    /**
     * The last one cannot go. An empty list would mean a working agent with
     * nothing in its row, which is the one thing the mascot exists to prevent —
     * so the button is hidden rather than the message refused, and this is the
     * backstop for the window that had two of them a second ago.
     */
    case "remove-mascot": {
      if (mascots.list.length < 2) return true;
      const list = mascots.list.filter((m) => m.id !== msg.id);
      if (list.length === mascots.list.length) return true;
      saveMascots({
        default: list.some((m) => m.id === mascots.default) ? mascots.default : list[0]!.id,
        list,
      });
      return true;
    }

    case "rename-mascot": {
      const name = msg.name.trim().slice(0, 40);
      if (!name) return true;
      saveMascots({ ...mascots, list: mascots.list.map((m) => (m.id === msg.id ? { ...m, name } : m)) });
      return true;
    }

    case "set-default-mascot": {
      if (!mascots.list.some((m) => m.id === msg.id)) return true;
      saveMascots({ ...mascots, default: msg.id });
      return true;
    }

    /**
     * `bindKey` is where the checking is, and it is shared with the client for
     * the usual reason: the action has to be one of the ones that exist and the
     * key has to be one a person can press, and two spellings of that would
     * disagree about exactly the case that matters. It returns the overrides
     * unchanged when it refuses, so a bad message is a no-op rather than an
     * error nobody is listening for.
     */
    case "bind-key": {
      provide("keys", bindKey(keys, msg.key, msg.action));
      writeKeys(keys);
      pushSnapshot();
      return true;
    }

    case "reset-keys": {
      provide("keys", {});
      writeKeys(keys);
      pushSnapshot();
      return true;
    }

    /**
     * `themeFor` is the check and the fallback in one, which is the shape
     * `mascotFor` has and is right for the same reason: an id naming nothing is
     * what a downgrade looks like, and the default drawn is a better answer than
     * a refusal nobody is listening for. What gets written is therefore always
     * an id this version can draw.
     */
    case "set-theme":
      saveAppearance({ ...appearance, themeId: themeFor(msg.themeId, styles.themes).id });
      return true;

    /**
     * The same shape `set-theme` has, and nothing more, because the difference
     * between the two is entirely on the client: a skin moves the line weight
     * and the type ramp, so applying one re-measures every terminal, whereas a
     * theme never does. That belongs where the measuring happens — nothing here
     * resizes anything, for the reason `set-terminal-appearance` gives below.
     */
    case "set-skin":
      saveAppearance({ ...appearance, skinId: skinFor(msg.skinId, styles.skins).id });
      return true;

    case "set-agents-kururu-mcp-only":
      if (typeof msg.profileId !== "string") return true;
      workspaces.setAgentsKururuMcpOnly(msg.profileId, msg.on === true);
      return true;

    case "set-agent-placement":
      // Refused rather than defaulted, `set-profile-column-color`'s line: a word
      // that is not one of the three is not a choice to round to the nearest.
      if (typeof msg.profileId !== "string") return true;
      if (typeof msg.workspaceId === "string") {
        if (msg.placement !== null && !isAgentPlacement(msg.placement)) return true;
        workspaces.setWorkspaceAgentPlacement(msg.profileId, msg.workspaceId, msg.placement);
      } else if (isAgentPlacement(msg.placement)) {
        workspaces.setAgentPlacement(msg.profileId, msg.placement);
      }
      return true;

    case "set-workspace-mobile":
      if (typeof msg.profileId !== "string" || typeof msg.workspaceId !== "string") return true;
      workspaces.setWorkspaceMobile(msg.profileId, msg.workspaceId, msg.on === true);
      return true;

    case "set-launch":
      saveLaunch(adoptLaunch(msg.launch));
      // Which login the bar reads may just have changed hands.
      void pollAccountUsage();
      return true;

    case "set-notify":
      saveNotify(adoptNotify(msg.notify));
      return true;

    /**
     * Adopted rather than trusted — a font size arrives as a number somebody
     * typed, and it is the one setting in kururu that reaches a pty: the cell
     * follows the size, the proposed grid follows the cell, and every client
     * watching that terminal is resized to whatever policy picks. `adoptAppearance`
     * clamps it, so the worst a bad message can do is a legal grid.
     *
     * Nothing is resized here. The size still comes the only way it ever comes —
     * a pane measures its box and proposes, `applySize` decides — so a font
     * change is a client re-measuring, not a server deciding a shape.
     */
    case "set-terminal-appearance":
      saveAppearance(adoptAppearance({ ...appearance, terminal: msg.terminal }));
      return true;
  }
  return false;
}
