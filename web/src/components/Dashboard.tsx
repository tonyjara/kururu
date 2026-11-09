/**
 * What each of the Dashboard's fixed tabs draws, and the icon its strip
 * wears — the window's half of `shared/dashboard.ts`.
 *
 * A record keyed by every id in `DASHBOARD_TABS`, so that adding a tab there
 * is a type error here until it has a view: the list says a tab exists, this
 * says what it is, and neither can get ahead of the other. Everything else a
 * tab needs — a place in a strip, being dragged within the Dashboard, a pane
 * to be split into — it has by being drawn by `Panes.tsx` like any other.
 */
import type { ReactNode } from "react";
import { dashboardTabLabel, isDashboardTab, type DashboardTab } from "../../../shared/dashboard";
import type { Profile } from "../../../shared/model";
import type { IconName } from "../icons";
import { ProfileBoard } from "./ProfileBoard";

interface DashView {
  icon: IconName;
  /** What the tab's tooltip says it is. */
  title: string;
  draw: (profile: Profile) => ReactNode;
}

const VIEWS: Record<DashboardTab, DashView> = {
  "dash:board": {
    icon: "board",
    title: "The profile's board: cards for any workspace",
    draw: (profile) => <ProfileBoard profile={profile} />,
  },
};

/** A fixed tab's body, or nothing for an id this build does not know. */
export function DashboardView({ tab, profile }: { tab: string; profile: Profile }) {
  return isDashboardTab(tab) ? <>{VIEWS[tab].draw(profile)}</> : null;
}

/** What a fixed tab's strip shows: its icon, its name and its tooltip. */
export function dashTabFace(tab: string): { icon: IconName; label: string; title: string } {
  const view = isDashboardTab(tab) ? VIEWS[tab] : null;
  return { icon: view?.icon ?? "board", label: dashboardTabLabel(tab), title: view?.title ?? dashboardTabLabel(tab) };
}
