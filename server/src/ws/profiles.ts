/**
 * Profiles: making, switching, naming and deleting them, a profile's own login — and restarting the server, which every profile shares.
 *
 * One area of what a client can ask over its socket, cut out of the switch
 * that was `index.ts`'s; `dispatch.ts` asks each area in turn and stops at
 * the one that answers. Each case is as it was, with `return true` where the
 * switch had `return`.
 */
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../shared/wire";
import { type ClientState, logins, workspaces } from "../context";
import { requestRestart } from "../index";
import { pollAccountUsage } from "../sweeps";
import { fillPane, killAll } from "../terminals";

export function profileVerbs(ws: WebSocket, st: ClientState, msg: ClientMessage): boolean {
  switch (msg.type) {
    // The three that change which profile is on screen also ask the account
    // again straight away: with logins per profile the bar is that profile's,
    // and a minute of the previous one's numbers under a new name is a minute
    // of the bar lying.
    case "new-profile":
      workspaces.newProfile(msg.name);
      fillPane(workspaces.focusedPaneId);
      void pollAccountUsage();
      return true;

    case "switch-profile":
      workspaces.switchProfile(msg.profileId);
      void pollAccountUsage();
      return true;

    case "rename-profile":
      workspaces.renameProfile(msg.profileId, msg.name);
      return true;

    // A key off the wire is held to two things: its shape, in `setProfileLogin`,
    // and membership of the list this server last offered. The second is the
    // one that matters — a well-formed key naming a directory kururu never made
    // would be pointed at anyway, and refusing it here is what makes the list
    // the whole of what can be chosen. The account may just have changed hands,
    // so the bar is asked again as the other three do.
    case "set-profile-login":
      if (typeof msg.profileId !== "string") return true;
      if (msg.loginKey !== null && !logins.some((login) => login.key === msg.loginKey)) return true;
      workspaces.setProfileLogin(msg.profileId, msg.loginKey);
      void pollAccountUsage();
      return true;

    case "delete-profile":
      killAll(workspaces.deleteProfile(msg.profileId));
      void pollAccountUsage();
      return true;

    case "restart-server":
      /**
       * Put this server back on current code, which costs a reconnect and
       * nothing else — the agents are in the pty host, a process over.
       *
       * Exiting *is* the restart: only something supervising this process can
       * bring a new one up, and `server/run.mjs` is what does, on this exit code
       * specifically so that an ordinary crash is not mistaken for a request.
       * Unsupervised there is nobody to ask, and exiting would take the server
       * away rather than replace it — so it says so instead of doing half of it.
       * That includes a server whose supervisor was there once and has since
       * died, which is why this asks `supervised()` and not the environment.
       */
      {
        const refused = requestRestart("a window asked for a restart (prefix+B)");
        if (refused) console.error(`kururu: ${refused}`);
      }
      return true;
  }
  return false;
}
