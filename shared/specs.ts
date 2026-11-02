/**
 * What each machine is made of: the parts read off it over ssh, the parts
 * the user typed in beside them, and a short history of what changed.
 *
 * It exists for the day a machine will not turn on. That is exactly when
 * nothing can be asked of it, and what is in the box was last written down
 * in a research note nobody can find — so the reading is kept, with the time
 * it was taken, and drawn whether the machine answers or not. A part the
 * machine cannot report (the power supply, who sold it, what it cost) is
 * typed in, and a part it can report may be typed in too, because the user
 * knows the card is an ASRock when `lspci` only knows it is a Navi 24.
 *
 * Where the two say different things both are kept and both are shown, and
 * the row says they differ. Neither wins: the typed one can be out of date
 * after a swap nobody wrote down, and the read one can be a reading from
 * before the swap, taken while the machine was still the old one. Telling
 * the two apart is the user's, and `agreement` only decides whether to point
 * at it — by model numbers, counts and sizes, never by spelling, since
 * "Gigabyte B550M K" and "Gigabyte Technology Co., Ltd. B550M K" are one
 * board.
 *
 * The history is the third thing, because after a swap the question is what
 * used to be there. The user writes lines into it, and a reading that finds
 * a part different from the last reading writes one of its own
 * (`changesBetween`), so a swap made while nobody was looking is still on
 * the record the next time the machine answers.
 *
 * The reading is one fixed script (`SPECS_SCRIPT`), for `server/src/machines.ts`'s
 * reason: a client names a machine and nothing else, and what runs there
 * is kururu's own and only reads. Everything it reads is readable without
 * root — `lscpu`, `/sys/class/dmi/id`, the memory devices systemd's udev
 * keeps from the SMBIOS tables, `lsblk`, `lspci`, `/sys/class/net` — and
 * `dmidecode` is asked only when the login already is root and udev had
 * nothing. Linux only, like the gauges: a Mac answers with nothing, and is
 * told so.
 *
 * Pure, and in `shared/` for `shared/machines.ts`'s reason: the parse and
 * the comparisons are the parts worth testing, and the types are what both
 * halves draw.
 */

// ---------------------------------------------------------------------------
// What a reading holds
// ---------------------------------------------------------------------------

export interface CpuInfo {
  /** `lscpu`'s Model name: "AMD Ryzen 5 5500 6-Core Processor". */
  model: string;
  vendor: string | null;
  arch: string | null;
  sockets: number | null;
  /** Physical cores across every socket. */
  cores: number | null;
  /** Logical CPUs: what a VPS sells as vCPUs. */
  threads: number | null;
  maxMhz: number | null;
  l3: string | null;
}

export interface MemoryModule {
  /** Bytes. */
  size: number;
  /** DDR4, DDR5 — or RAM, which is what QEMU calls it. */
  type: string | null;
  /** MT/s, as rated. */
  speed: number | null;
  maker: string | null;
  part: string | null;
  /** The slot it is in, as the board labels it: DIMM_A2, "DIMM 0". */
  slot: string | null;
}

export interface MemoryInfo {
  /** `MemTotal`, in bytes: what the kernel was left with, which is a little under what is installed. */
  total: number;
  swap: number | null;
  /** What is in the slots, when the tables said. Empty when nothing could read them. */
  modules: MemoryModule[];
}

export interface BoardInfo {
  vendor: string | null;
  name: string | null;
  version: string | null;
  /** The whole machine's maker and model, which is all a VM has: "QEMU Standard PC (i440FX + PIIX, 1996)". */
  system: string | null;
  biosVendor: string | null;
  biosVersion: string | null;
  biosDate: string | null;
}

export interface DiskInfo {
  name: string;
  model: string | null;
  /** Bytes. */
  size: number;
  rotational: boolean | null;
  /** nvme, sata, usb — empty for a virtual disk. */
  transport: string | null;
}

/** A PCI device, as `lspci -mm` names it. */
export interface PciDevice {
  slot: string;
  vendor: string;
  name: string;
  /** Who made the card around the chip, when that is somebody else: ASRock around AMD's Navi 24. */
  brand: string | null;
}

export interface GpuInfo extends PciDevice {
  /** Video memory in bytes, where the driver says (amdgpu does). */
  memory: number | null;
}

export interface NicInfo {
  /** The interface: enp5s0, wlan0. */
  name: string;
  /** Its model, from `lspci` or the USB descriptor, or null when neither said. */
  model: string | null;
  brand: string | null;
  mac: string | null;
  state: string | null;
  /** Mb/s, when the link has one. */
  speed: number | null;
  driver: string | null;
  wireless: boolean;
  usb: boolean;
}

/** One reading of a machine. Every part may be missing: a box with no `lspci` is still a box. */
export interface SpecsReading {
  at: number;
  hostname: string | null;
  /** os-release's PRETTY_NAME. */
  os: string | null;
  /** `uname -srm`. */
  kernel: string | null;
  /** What `systemd-detect-virt` said — kvm, qemu, vmware — or null on hardware. */
  virt: string | null;
  cpu: CpuInfo | null;
  memory: MemoryInfo | null;
  board: BoardInfo | null;
  disks: DiskInfo[];
  gpus: GpuInfo[];
  nics: NicInfo[];
}

// ---------------------------------------------------------------------------
// What the user types
// ---------------------------------------------------------------------------

/** The parts a row is drawn for, in the order they are drawn. */
export const PARTS = ["cpu", "board", "memory", "gpu", "storage", "network", "psu", "os"] as const;
export type PartKey = (typeof PARTS)[number];

export const PART_LABELS: Record<PartKey, string> = {
  cpu: "CPU",
  board: "Motherboard",
  memory: "Memory",
  gpu: "Graphics",
  storage: "Storage",
  network: "Network",
  psu: "Power supply",
  os: "System",
};

/**
 * Parts nothing in a VM has — there is no power supply to type in for a
 * VPS — so the page leaves their rows out for a machine that read as virtual,
 * unless something was typed there anyway.
 */
export const PHYSICAL_ONLY: readonly PartKey[] = ["psu"];

/** What the user types beside the parts: the purchase, and the notes. */
export const EXTRAS = ["seller", "paid", "bought", "notes"] as const;
export type ExtraKey = (typeof EXTRAS)[number];

export type TypedKey = PartKey | ExtraKey;
export type TypedSpecs = Partial<Record<TypedKey, string>>;

const TYPED_KEYS: readonly string[] = [...PARTS, ...EXTRAS];

export function isTypedKey(key: unknown): key is TypedKey {
  return typeof key === "string" && TYPED_KEYS.includes(key);
}

/** Long enough for a model and a sentence about it; notes get a page. */
export const TYPED_MAX = 300;
export const NOTES_MAX = 4000;

/** A typed value as it is kept: trimmed, bounded, and gone when blank. */
export function cleanTyped(key: TypedKey, value: unknown): string {
  if (typeof value !== "string") return "";
  const max = key === "notes" ? NOTES_MAX : TYPED_MAX;
  const text = key === "notes" ? value.replace(/\r\n?/g, "\n").trim() : value.replace(/\s+/g, " ").trim();
  return text.slice(0, max);
}

export interface HistoryEntry {
  id: string;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, or empty when nobody knows — the grammar that sorts as text. */
  date: string;
  text: string;
  /** Who wrote it: the user, or a reading that found a part changed since the last. */
  by: "you" | "read";
}

export const HISTORY_TEXT_MAX = 500;
/** A short history: the oldest go past this, which at a line a swap is decades. */
export const HISTORY_MAX = 100;

/** A date as the history keeps it, or null for one it will not. Blank is allowed: "some time" is a date. */
export function validHistoryDate(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  if (!trimmed) return "";
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(trimmed);
  if (!match) return null;
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return trimmed;
}

/** Newest first; an undated line goes last, and lines of one date keep the order they were written in. */
export function sortHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      if (a.entry.date !== b.entry.date) {
        if (!a.entry.date) return 1;
        if (!b.entry.date) return -1;
        return a.entry.date < b.entry.date ? 1 : -1;
      }
      return b.i - a.i;
    })
    .map(({ entry }) => entry);
}

/** Today as the history writes it, in this Mac's own day. */
export function localDay(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** What is kept per machine in `specs.json`. `host` and `name` are copies, so a machine removed and added again finds its own. */
export interface StoredSpecs {
  host: string;
  name: string;
  typed: TypedSpecs;
  history: HistoryEntry[];
  reading: SpecsReading | null;
}

/** What a window is sent per machine: what is kept, and how the last attempt at a reading went. */
export interface MachineSpecs {
  typed: TypedSpecs;
  history: HistoryEntry[];
  reading: SpecsReading | null;
  /** A reading is in flight. */
  busy: boolean;
  /** Why the last attempt failed, in ssh's words, or null if it did not. */
  error: string | null;
}

export const EMPTY_SPECS: MachineSpecs = { typed: {}, history: [], reading: null, busy: false, error: null };

// ---------------------------------------------------------------------------
// The file, adopted rather than trusted
// ---------------------------------------------------------------------------

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * `specs.json` is a file a person can open, and its reading is drawn by
 * every window — so each field is taken for what it says it is or dropped,
 * and a reading too broken to have a time is no reading.
 */
export function adoptReading(raw: unknown): SpecsReading | null {
  const r = obj(raw);
  const at = num(r?.at);
  if (!r || at === null) return null;
  const cpu = obj(r.cpu);
  const memory = obj(r.memory);
  const board = obj(r.board);
  return {
    at,
    hostname: str(r.hostname),
    os: str(r.os),
    kernel: str(r.kernel),
    virt: str(r.virt),
    cpu:
      cpu && str(cpu.model)
        ? {
            model: str(cpu.model)!,
            vendor: str(cpu.vendor),
            arch: str(cpu.arch),
            sockets: num(cpu.sockets),
            cores: num(cpu.cores),
            threads: num(cpu.threads),
            maxMhz: num(cpu.maxMhz),
            l3: str(cpu.l3),
          }
        : null,
    memory:
      memory && num(memory.total) !== null
        ? {
            total: num(memory.total)!,
            swap: num(memory.swap),
            modules: list(memory.modules, 32).flatMap((m) => {
              const o = obj(m);
              const size = num(o?.size);
              return o && size !== null ? [{ size, type: str(o.type), speed: num(o.speed), maker: str(o.maker), part: str(o.part), slot: str(o.slot) }] : [];
            }),
          }
        : null,
    board: board
      ? {
          vendor: str(board.vendor),
          name: str(board.name),
          version: str(board.version),
          system: str(board.system),
          biosVendor: str(board.biosVendor),
          biosVersion: str(board.biosVersion),
          biosDate: str(board.biosDate),
        }
      : null,
    disks: list(r.disks, 32).flatMap((d) => {
      const o = obj(d);
      const name = str(o?.name);
      const size = num(o?.size);
      return o && name && size !== null ? [{ name, model: str(o.model), size, rotational: bool(o.rotational), transport: str(o.transport) }] : [];
    }),
    gpus: list(r.gpus, 16).flatMap((g) => {
      const o = obj(g);
      const slot = str(o?.slot);
      const name = str(o?.name);
      return o && slot && name ? [{ slot, vendor: str(o.vendor) ?? "", name, brand: str(o.brand), memory: num(o.memory) }] : [];
    }),
    nics: list(r.nics, 32).flatMap((n) => {
      const o = obj(n);
      const name = str(o?.name);
      return o && name
        ? [{ name, model: str(o.model), brand: str(o.brand), mac: str(o.mac), state: str(o.state), speed: num(o.speed), driver: str(o.driver), wireless: o.wireless === true, usb: o.usb === true }]
        : [];
    }),
  };
}

function adoptTyped(raw: unknown): TypedSpecs {
  const o = obj(raw);
  const out: TypedSpecs = {};
  if (!o) return out;
  for (const key of TYPED_KEYS as TypedKey[]) {
    const value = cleanTyped(key, o[key]);
    if (value) out[key] = value;
  }
  return out;
}

function adoptHistory(raw: unknown): HistoryEntry[] {
  const seen = new Set<string>();
  return list(raw, HISTORY_MAX).flatMap((e) => {
    const o = obj(e);
    const id = str(o?.id, 40);
    const date = validHistoryDate(o?.date);
    const text = typeof o?.text === "string" ? o.text.replace(/\s+/g, " ").trim().slice(0, HISTORY_TEXT_MAX) : "";
    if (!o || !id || seen.has(id) || date === null || !text) return [];
    seen.add(id);
    return [{ id, date, text, by: o.by === "read" ? ("read" as const) : ("you" as const) }];
  });
}

/** The whole file: machine id to what is kept for it. */
export function adoptSpecsFile(raw: unknown): Record<string, StoredSpecs> {
  const machines = obj(obj(raw)?.machines);
  const out: Record<string, StoredSpecs> = {};
  if (!machines) return out;
  for (const [id, value] of Object.entries(machines)) {
    const o = obj(value);
    if (!o || !id) continue;
    out[id] = {
      host: str(o.host, 253) ?? "",
      name: str(o.name, 40) ?? "",
      typed: adoptTyped(o.typed),
      history: adoptHistory(o.history),
      reading: adoptReading(o.reading),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The script, and reading what it printed
// ---------------------------------------------------------------------------

/** What starts each section's line: `@@specs@@ cpu`. A line nothing it reads can print. */
export const SPECS_MARK = "@@specs@@";

/**
 * The reading script, run under `sh -c` on the far side — see `posix` in
 * `server/src/machines.ts`, which refuses it if it ever holds a single quote
 * or a backslash, the two things that would not survive the account's login
 * shell (bash, zsh or fish) on the way in. The test says so too.
 *
 * Every line reads and nothing writes. `dmidecode` only runs when the login
 * is root already and udev kept no memory devices, so nothing here asks sudo
 * for anything; a board's serial numbers are never read, by either.
 */
export const SPECS_SCRIPT = [
  `export LC_ALL=C`,
  `echo "${SPECS_MARK} host"; uname -n`,
  `echo "${SPECS_MARK} os"; cat /etc/os-release 2>/dev/null`,
  `echo "${SPECS_MARK} kernel"; uname -srm`,
  `echo "${SPECS_MARK} virt"; systemd-detect-virt 2>/dev/null`,
  `echo "${SPECS_MARK} cpu"; lscpu 2>/dev/null`,
  `echo "${SPECS_MARK} mem"; grep -E "^(MemTotal|SwapTotal):" /proc/meminfo 2>/dev/null`,
  `echo "${SPECS_MARK} dmi"; for f in sys_vendor product_name product_version board_vendor board_name board_version bios_vendor bios_version bios_date; do echo "$f=$(cat /sys/class/dmi/id/$f 2>/dev/null)"; done`,
  `echo "${SPECS_MARK} memdev"; u=$(udevadm info -q property -p /devices/virtual/dmi/id 2>/dev/null | grep -E "^MEMORY_DEVICE_[0-9]+_(SIZE|TYPE|SPEED_MTS|MANUFACTURER|PART_NUMBER|LOCATOR)="); echo "$u"`,
  `echo "${SPECS_MARK} dmidecode"; if [ -z "$u" ] && [ "$(id -u)" = 0 ] && command -v dmidecode >/dev/null 2>&1; then dmidecode -t 17 2>/dev/null; fi`,
  `echo "${SPECS_MARK} disks"; lsblk -dbnP -o NAME,TYPE,SIZE,ROTA,TRAN,MODEL 2>/dev/null`,
  `echo "${SPECS_MARK} pci"; lspci -mm -D 2>/dev/null | grep -E "VGA|3D|Display|Ethernet|Network"`,
  `echo "${SPECS_MARK} drm"; for c in /sys/class/drm/card*; do case \${c##*/} in *-*) continue;; esac; [ -e "$c/device/vendor" ] || continue; echo "$(readlink -f $c/device) $(cat $c/device/vendor) $(cat $c/device/device 2>/dev/null) $(cat $c/device/mem_info_vram_total 2>/dev/null)"; done`,
  `echo "${SPECS_MARK} net"; for d in /sys/class/net/*; do [ -e "$d/device" ] || continue; echo "--"; echo "name=\${d##*/}"; echo "mac=$(cat $d/address 2>/dev/null)"; echo "state=$(cat $d/operstate 2>/dev/null)"; echo "speed=$(cat $d/speed 2>/dev/null)"; echo "driver=$(basename "$(readlink $d/device/driver)" 2>/dev/null)"; echo "path=$(readlink -f $d/device)"; [ -d "$d/wireless" ] && echo "wireless=1"; p=$(readlink -f $d/device/..); [ -r "$p/product" ] && echo "usb=$(cat $p/manufacturer 2>/dev/null)|$(cat $p/product 2>/dev/null)"; done`,
  `true`,
].join("\n");

/** The script's output, cut into its named sections. */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (name !== null) out.set(name, lines.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(`${SPECS_MARK} `)) {
      flush();
      name = line.slice(SPECS_MARK.length + 1).trim();
      lines = [];
    } else if (name !== null) {
      lines.push(line);
    }
  }
  flush();
  return out;
}

/** `key: value` lines (lscpu) or `key=value` lines (os-release, the dmi loop), first one of each key winning. */
function pairs(text: string, sep: ":" | "="): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (sep === "=" && /^".*"$/.test(value)) value = value.slice(1, -1);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

/** What firmware writes when it has nothing to say, which is not a value. */
const PLACEHOLDER = /^(|to be filled by o\.?e\.?m\.?|default string|not specified|not applicable|none|unknown|system product name|system manufacturer|o\.?e\.?m\.?|n\/a|0x0+|x\.x)$/i;

function real(value: string | undefined): string | null {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  return PLACEHOLDER.test(v) ? null : v.slice(0, 200);
}

const int = (value: string | undefined): number | null => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : null;
};

function cpuFrom(text: string): CpuInfo | null {
  const p = pairs(text, ":");
  const model = real(p.get("Model name"));
  if (!model) return null;
  const sockets = int(p.get("Socket(s)"));
  const perSocket = int(p.get("Core(s) per socket"));
  const threads = int(p.get("CPU(s)"));
  const max = Number.parseFloat(p.get("CPU max MHz") ?? "");
  return {
    model,
    vendor: real(p.get("Vendor ID")),
    arch: real(p.get("Architecture")),
    sockets,
    cores: perSocket !== null ? perSocket * (sockets ?? 1) : null,
    threads,
    maxMhz: Number.isFinite(max) && max > 0 ? Math.round(max) : null,
    l3: real(p.get("L3 cache")),
  };
}

function memoryFrom(text: string, modules: MemoryModule[]): MemoryInfo | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  return total === null ? null : { total, swap: kb("SwapTotal"), modules };
}

/** systemd's udev keeps the SMBIOS memory devices as `MEMORY_DEVICE_<n>_<FIELD>=` — readable without root, on systemd 253 and later. */
function modulesFromUdev(text: string): MemoryModule[] {
  const byIndex = new Map<number, Map<string, string>>();
  for (const line of text.split("\n")) {
    const m = /^MEMORY_DEVICE_(\d+)_([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const i = Number(m[1]);
    if (!byIndex.has(i)) byIndex.set(i, new Map());
    byIndex.get(i)!.set(m[2]!, m[3]!);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, f]) => {
      const size = Number(f.get("SIZE"));
      // An empty slot has no size, or a size of nothing.
      if (!Number.isFinite(size) || size <= 0) return [];
      return [{ size, type: real(f.get("TYPE")), speed: int(f.get("SPEED_MTS")), maker: real(f.get("MANUFACTURER")), part: real(f.get("PART_NUMBER")), slot: real(f.get("LOCATOR")) }];
    });
}

/** `dmidecode -t 17`, for an older systemd when the login is root: one `Memory Device` block per slot. */
function modulesFromDmidecode(text: string): MemoryModule[] {
  const out: MemoryModule[] = [];
  for (const block of text.split(/\n(?=Memory Device)/)) {
    if (!block.startsWith("Memory Device")) continue;
    const p = pairs(block, ":");
    const sizeMatch = /^(\d+)\s*(MB|GB|TB)$/i.exec(p.get("Size") ?? "");
    if (!sizeMatch) continue;
    const unit = { MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 }[sizeMatch[2]!.toUpperCase() as "MB" | "GB" | "TB"];
    out.push({
      size: Number(sizeMatch[1]) * unit,
      type: real(p.get("Type")),
      speed: int(p.get("Speed")),
      maker: real(p.get("Manufacturer")),
      part: real(p.get("Part Number")),
      slot: real(p.get("Locator")),
    });
  }
  return out;
}

function boardFrom(text: string): BoardInfo | null {
  const p = pairs(text, "=");
  const sysVendor = real(p.get("sys_vendor"));
  const product = real(p.get("product_name"));
  const board: BoardInfo = {
    vendor: real(p.get("board_vendor")),
    name: real(p.get("board_name")),
    version: real(p.get("board_version")),
    system: [sysVendor, product].filter(Boolean).join(" ") || null,
    biosVendor: real(p.get("bios_vendor")),
    biosVersion: real(p.get("bios_version")),
    biosDate: real(p.get("bios_date")),
  };
  return Object.values(board).some((v) => v !== null) ? board : null;
}

/** lsblk's `-P` escapes anything awkward as `\xHH`, a space most often. */
function unescapeLsblk(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function disksFrom(text: string): DiskInfo[] {
  const out: DiskInfo[] = [];
  for (const line of text.split("\n")) {
    const f = new Map<string, string>();
    for (const m of line.matchAll(/([A-Z]+)="([^"]*)"/g)) f.set(m[1]!, unescapeLsblk(m[2]!).trim());
    const name = f.get("NAME");
    const size = Number(f.get("SIZE"));
    // Disks only, and not the kernel's own: zram swap, loop mounts, ramdisks.
    if (!name || f.get("TYPE") !== "disk" || /^(zram|loop|ram)/.test(name) || !Number.isFinite(size) || size <= 0) continue;
    const rota = f.get("ROTA");
    out.push({ name, model: real(f.get("MODEL")), size, rotational: rota === "1" ? true : rota === "0" ? false : null, transport: real(f.get("TRAN")) });
  }
  return out;
}

/**
 * One `lspci -mm -D` line: the slot, then quoted fields — class, vendor,
 * device — then `-r`/`-p` options, then the subsystem's vendor and device,
 * quoted and possibly empty.
 */
export function parsePciLine(line: string): { slot: string; cls: string; vendor: string; device: string; svendor: string; sdevice: string } | null {
  const slot = /^\s*(\S+)/.exec(line)?.[1];
  if (!slot) return null;
  const quoted = [...line.slice(line.indexOf(slot) + slot.length).matchAll(/"([^"]*)"/g)].map((m) => m[1]!.trim());
  if (quoted.length < 3) return null;
  return { slot, cls: quoted[0]!, vendor: quoted[1]!, device: quoted[2]!, svendor: quoted[3] ?? "", sdevice: quoted[4] ?? "" };
}

/**
 * A vendor's name as people say it. pci.ids writes "Advanced Micro Devices,
 * Inc. [AMD/ATI]" and "ASRock Incorporation", and the bracket, when there is
 * one, is the short name; otherwise the legal suffixes go.
 */
export function shortVendor(name: string): string {
  const bracket = /\[([^\]]+)\]\s*$/.exec(name)?.[1];
  if (bracket) return bracket.split("/")[0]!.trim();
  const trimmed = name
    .replace(/,?\s+(Co\.,?\s*)?(Ltd\.?|Inc\.?|Corp\.?|Corporation|Incorporation|Limited|GmbH|AG|S\.A\.|LLC)\b\.?/gi, "")
    .replace(/\s+(Technology|Technologies|Semiconductor|Computer|International|Electronics)\b/gi, "")
    .replace(/[,.\s]+$/, "")
    .trim();
  return trimmed || name;
}

/** The marketing name in pci.ids' brackets, "Navi 24 [Radeon RX 6400/6500 XT/6500M]" → "Radeon RX 6400/6500 XT/6500M". */
function marketName(device: string): string {
  return /\[([^\]]+)\]\s*$/.exec(device)?.[1]?.trim() || device;
}

function pciDevice(parsed: NonNullable<ReturnType<typeof parsePciLine>>): PciDevice {
  const vendor = shortVendor(parsed.vendor);
  const brand = parsed.svendor ? shortVendor(parsed.svendor) : null;
  return { slot: parsed.slot, vendor, name: marketName(parsed.device), brand: brand && brand !== vendor ? brand : null };
}

/** The last PCI address in a sysfs path: the device a GPU's drm node or a NIC's interface hangs off. */
function pciSlotIn(path: string): string | null {
  const all = path.match(/[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]/gi);
  return all ? all[all.length - 1]! : null;
}

const GPU_VENDORS: Record<string, string> = { "0x1002": "AMD", "0x10de": "NVIDIA", "0x8086": "Intel", "0x1af4": "Red Hat", "0x1234": "QEMU", "0x15ad": "VMware" };

function gpusFrom(pci: string, drm: string): GpuInfo[] {
  const vram = new Map<string, number>();
  const drmCards: { slot: string; vendor: string; device: string }[] = [];
  for (const line of drm.split("\n")) {
    const [path, vendor, device, mem] = line.trim().split(/\s+/);
    const slot = pciSlotIn(path ?? "");
    if (!slot || !vendor) continue;
    drmCards.push({ slot, vendor, device: device ?? "" });
    const bytes = Number(mem);
    if (Number.isFinite(bytes) && bytes > 0) vram.set(slot, bytes);
  }
  const fromPci = pci
    .split("\n")
    .map(parsePciLine)
    .filter((p): p is NonNullable<typeof p> => p !== null && /VGA|3D|Display/i.test(p.cls))
    .map((p) => ({ ...pciDevice(p), memory: vram.get(p.slot) ?? null }));
  if (fromPci.length) return fromPci;
  // No lspci on the box: the drm nodes still say whose chip it is, by number.
  return drmCards.map((c) => ({
    slot: c.slot,
    vendor: GPU_VENDORS[c.vendor.toLowerCase()] ?? c.vendor,
    name: `device ${c.device}`,
    brand: null,
    memory: vram.get(c.slot) ?? null,
  }));
}

function nicsFrom(net: string, pci: string): NicInfo[] {
  const byslot = new Map<string, PciDevice>();
  for (const line of pci.split("\n")) {
    const p = parsePciLine(line);
    if (p && /Ethernet|Network/i.test(p.cls)) byslot.set(p.slot, pciDevice(p));
  }
  const out: NicInfo[] = [];
  for (const block of net.split(/^--$/m)) {
    const f = pairs(block, "=");
    const name = real(f.get("name"));
    if (!name) continue;
    const path = f.get("path") ?? "";
    const usbLine = f.get("usb");
    const usb = usbLine !== undefined || /\/usb\d/.test(path);
    let model: string | null = null;
    let brand: string | null = null;
    if (usbLine !== undefined) {
      const [maker, product] = usbLine.split("|");
      model = real(product);
      brand = real(maker) ? shortVendor(real(maker)!) : null;
    } else if (!usb) {
      const slot = pciSlotIn(path);
      const dev = slot ? byslot.get(slot) : undefined;
      if (dev) {
        model = `${dev.vendor} ${dev.name}`;
        brand = dev.brand;
      }
    }
    const speed = int(f.get("speed"));
    out.push({
      name,
      model,
      brand,
      mac: real(f.get("mac")),
      state: real(f.get("state")),
      speed: speed !== null && speed > 0 ? speed : null,
      driver: real(f.get("driver")),
      wireless: f.get("wireless") === "1",
      usb,
    });
  }
  return out;
}

/**
 * One run of `SPECS_SCRIPT`, read. Null when nothing at all came back that
 * says what the machine is — a Mac, say, which has no `/proc` and no `lscpu`
 * — so that a run that read nothing never replaces a reading that read
 * something.
 */
export function parseSpecs(text: string, at: number): SpecsReading | null {
  const s = sections(text);
  const get = (name: string) => s.get(name) ?? "";
  const os = pairs(get("os"), "=");
  const udev = modulesFromUdev(get("memdev"));
  const modules = udev.length ? udev : modulesFromDmidecode(get("dmidecode"));
  const virt = real(get("virt"));
  const reading: SpecsReading = {
    at,
    hostname: real(get("host")),
    os: real(os.get("PRETTY_NAME")) ?? real(os.get("NAME")),
    kernel: real(get("kernel")),
    virt: virt && virt !== "none" ? virt : null,
    cpu: cpuFrom(get("cpu")),
    memory: memoryFrom(get("mem"), modules),
    board: boardFrom(get("dmi")),
    disks: disksFrom(get("disks")),
    gpus: gpusFrom(get("pci"), get("drm")),
    nics: nicsFrom(get("net"), get("pci")),
  };
  return reading.cpu || reading.memory || reading.os ? reading : null;
}

// ---------------------------------------------------------------------------
// Saying a part in a line
// ---------------------------------------------------------------------------

const GiB = 2 ** 30;

/** RAM in the binary units it is sold in: 16 GB is 16 GiB. */
export function memorySize(bytes: number): string {
  const gib = bytes / GiB;
  return gib >= 10 ? `${Math.round(gib)} GB` : `${Math.round(gib * 10) / 10} GB`.replace(".0 ", " ");
}

/** A drive in the decimal units printed on its box: a 500 GB SSD is 500,107,862,016 bytes. */
export function diskSize(bytes: number): string {
  const tb = bytes / 1e12;
  if (tb >= 1) return `${Math.round(tb * 10) / 10} TB`.replace(".0 ", " ");
  return `${Math.round(bytes / 1e9)} GB`;
}

/**
 * What the RAM installed adds up to: the modules when the tables said, else
 * `MemTotal` rounded up to a whole gigabyte — the kernel and the firmware
 * keep a few hundred megabytes of whatever is in the slots, so a 16 GB box
 * reports 15.4 and an 8 GB VPS 7.8.
 */
export function installedMemory(memory: MemoryInfo): number {
  const sum = memory.modules.reduce((n, m) => n + m.size, 0);
  return sum > 0 ? sum : Math.max(1, Math.ceil(memory.total / GiB)) * GiB;
}

function ghz(mhz: number): string {
  return `${(mhz / 1000).toFixed(2).replace(/0$/, "")} GHz`;
}

export function cpuLine(r: SpecsReading): string | null {
  const c = r.cpu;
  if (!c) return null;
  const parts = [c.model];
  if (r.virt) {
    if (c.threads !== null) parts.push(`${c.threads} vCPU${c.threads === 1 ? "" : "s"}`);
  } else {
    const counts = [c.cores !== null && `${c.cores} cores`, c.threads !== null && `${c.threads} threads`].filter(Boolean).join(", ");
    if (counts) parts.push(counts);
    if (c.maxMhz) parts.push(`up to ${ghz(c.maxMhz)}`);
  }
  return parts.join(" · ");
}

/** The board alone — vendor and model — which is what a swap changes and what the history compares. */
export function boardName(r: SpecsReading): string | null {
  const b = r.board;
  if (!b) return null;
  if (b.name) return [b.vendor && shortVendor(b.vendor), b.name].filter(Boolean).join(" ");
  return b.system;
}

export function biosLine(r: SpecsReading): string | null {
  const b = r.board;
  if (!b?.biosVersion) return null;
  return `BIOS ${b.biosVersion}${b.biosDate ? ` (${b.biosDate})` : ""}`;
}

export function boardLine(r: SpecsReading): string | null {
  const name = boardName(r);
  const bios = biosLine(r);
  if (!name && !bios) return null;
  return [name && (r.virt ? `${name}, virtual` : name), bios].filter(Boolean).join(" · ");
}

/** "16 GB · 2 × 8 GB DDR4-3200, Kingston KF3200C16D4/8GX". */
export function memoryLine(r: SpecsReading): string | null {
  const m = r.memory;
  if (!m) return null;
  const parts = [memorySize(installedMemory(m))];
  if (m.modules.length) {
    const groups = new Map<string, number>();
    for (const mod of m.modules) {
      const kind = [memorySize(mod.size), mod.type && mod.type !== "RAM" && `${mod.type}${mod.speed ? `-${mod.speed}` : ""}`].filter(Boolean).join(" ");
      groups.set(kind, (groups.get(kind) ?? 0) + 1);
    }
    const layout = [...groups.entries()].map(([kind, n]) => (n > 1 ? `${n} × ${kind}` : kind)).join(" + ");
    const makers = r.virt ? [] : [...new Set(m.modules.map((mod) => [mod.maker, mod.part].filter(Boolean).join(" ")).filter(Boolean))];
    // One stick with no type to tell is the total said twice — every VM's "DIMM 0".
    if (layout !== parts[0] || makers.length) parts.push(makers.length ? `${layout}, ${makers.join(" / ")}` : layout);
  }
  return parts.join(" · ");
}

export function gpuName(g: GpuInfo): string {
  return [g.brand, `${g.vendor} ${g.name}`].filter(Boolean).join(" ");
}

export function gpuLine(r: SpecsReading): string | null {
  if (!r.gpus.length) return null;
  return r.gpus.map((g) => [gpuName(g), g.memory && memorySize(g.memory)].filter(Boolean).join(", ")).join(" + ");
}

export function diskName(d: DiskInfo): string {
  const kind = d.transport === "nvme" ? "NVMe" : d.transport === "usb" ? "USB" : d.transport === "sata" ? "SATA" : null;
  const what = [diskSize(d.size), kind, d.rotational === true && kind !== "USB" ? "spinning" : null].filter(Boolean).join(", ");
  return `${d.model ?? d.name} (${what})`;
}

export function storageLine(r: SpecsReading): string | null {
  return r.disks.length ? r.disks.map(diskName).join(" + ") : null;
}

export function nicName(n: NicInfo): string {
  const model = [n.brand, n.model].filter(Boolean).join(" ");
  return `${n.name}${model ? `: ${model}` : ""}`;
}

export function networkLine(r: SpecsReading): string | null {
  if (!r.nics.length) return null;
  return r.nics
    .map((n) => {
      const link = n.speed ? (n.speed >= 1000 ? `${n.speed / 1000} Gb/s` : `${n.speed} Mb/s`) : null;
      return [nicName(n), n.wireless ? "Wi-Fi" : null, link].filter(Boolean).join(", ");
    })
    .join(" + ");
}

export function osLine(r: SpecsReading): string | null {
  return [r.os, r.kernel].filter(Boolean).join(" · ") || null;
}

/** What a part's row says was read, or null when the reading has nothing for it — a power supply, always. */
export function readLine(part: PartKey, r: SpecsReading | null): string | null {
  if (!r) return null;
  switch (part) {
    case "cpu":
      return cpuLine(r);
    case "board":
      return boardLine(r);
    case "memory":
      return memoryLine(r);
    case "gpu":
      return gpuLine(r);
    case "storage":
      return storageLine(r);
    case "network":
      return networkLine(r);
    case "os":
      return osLine(r);
    case "psu":
      return null;
  }
}

/** Whether a part can be read at all. A power supply says nothing to software. */
export function readable(part: PartKey): boolean {
  return part !== "psu";
}

// ---------------------------------------------------------------------------
// Whether what was typed and what was read agree
// ---------------------------------------------------------------------------

/**
 * The tokens that name a model: letters and digits together, or a number of
 * three digits or more — `b550m`, `5500`, `rm1000i`, `6400` — and none of the
 * figures every part has: a clock, a size with its unit, a year, a DDR
 * generation.
 */
export function modelTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9.]+/)) {
    const t = raw.replace(/^\.+|\.+$/g, "");
    if (t.length < 3 || !/\d/.test(t)) continue;
    if (/^\d+\.\d+$/.test(t)) continue;
    if (/^\d+(\.\d+)?(b|k|kb|m|mb|mib|g|gb|gib|t|tb|tib|hz|mhz|ghz|w|mts|nm|mm|gbps|mbps)$/.test(t)) continue;
    if (/^(19|20)\d\d$/.test(t)) continue;
    if (/^(ddr|lpddr|gddr)\d+x?$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

/** Sizes written in a typed value, in bytes: "16 GB", "1TB", "500 GB". Units read as the part is sold — binary for RAM, decimal for drives. */
function typedSizes(text: string, binary: boolean): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(gb|gib|g|tb|tib|t)\b/gi)) {
    const n = Number(m[1]!.replace(",", "."));
    const unit = m[2]!.toLowerCase();
    const tera = unit.startsWith("t");
    out.push(n * (binary || unit.endsWith("ib") ? (tera ? 2 ** 40 : GiB) : tera ? 1e12 : 1e9));
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.1 * Math.max(a, b);

/** The words of a system's name that mean something: "Omarchy (Arch) with Limine" → omarchy, arch, limine. */
function osWords(text: string): Set<string> {
  const stop = new Set(["linux", "with", "and", "the", "gnu", "lts", "release", "edition"]);
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !stop.has(w)));
}

/**
 * Whether what was typed for a part says the same as what was read: true,
 * false, or null when there is nothing the two can be compared on — "QFly
 * (model unknown)" names no model to look for, and a power supply was never
 * read. Each check that can be made must pass; a value that could only be
 * compared on one thing is judged on that one.
 */
export function agreement(part: PartKey, typed: string | undefined, r: SpecsReading | null): boolean | null {
  const text = typed?.trim();
  if (!text || !r) return null;
  const checks: boolean[] = [];
  const models = (read: string | null) => {
    if (!read) return;
    const mine = modelTokens(text);
    const theirs = modelTokens(read);
    if (mine.size && theirs.size) checks.push([...mine].some((t) => theirs.has(t)));
  };
  switch (part) {
    case "cpu": {
      models(r.cpu?.model ?? null);
      const count = (pattern: RegExp) => {
        const m = pattern.exec(text);
        return m ? Number(m[1]) : null;
      };
      const cores = count(/(\d+)\s*(?:c\b|cores?\b|núcleos?\b)/i);
      const threads = count(/(\d+)\s*(?:t\b|threads?\b|hilos?\b|v?cpus?\b)/i);
      if (cores !== null && r.cpu?.cores != null && !r.virt) checks.push(cores === r.cpu.cores);
      if (threads !== null && r.cpu?.threads != null) checks.push(threads === r.cpu.threads);
      break;
    }
    case "board":
      models(boardName(r));
      break;
    case "gpu":
      models(r.gpus.map(gpuName).join(" "));
      break;
    case "network":
      models(r.nics.map((n) => [n.brand, n.model].filter(Boolean).join(" ")).join(" "));
      break;
    case "storage": {
      models(r.disks.map((d) => d.model ?? "").join(" "));
      const sizes = typedSizes(text, false);
      if (sizes.length && r.disks.length) {
        const total = r.disks.reduce((n, d) => n + d.size, 0);
        checks.push(sizes.every((s) => near(s, total) || r.disks.some((d) => near(s, d.size))));
      }
      break;
    }
    case "memory": {
      if (!r.memory) break;
      const sizes = typedSizes(text, true);
      if (sizes.length) checks.push(near(sizes[0]!, installedMemory(r.memory)));
      const gen = /ddr(\d)/i.exec(text)?.[1];
      const types = r.memory.modules.map((m) => /ddr(\d)/i.exec(m.type ?? "")?.[1]).filter(Boolean);
      if (gen && types.length) checks.push(types.every((t) => t === gen));
      break;
    }
    case "os": {
      if (!r.os) break;
      const mine = osWords(text);
      const theirs = osWords(r.os);
      if (mine.size && theirs.size) checks.push([...mine].some((w) => theirs.has(w)));
      break;
    }
    case "psu":
      break;
  }
  return checks.length ? checks.every(Boolean) : null;
}

// ---------------------------------------------------------------------------
// What changed between two readings
// ---------------------------------------------------------------------------

/**
 * What the history compares, per part: the things a swap changes and an
 * update does not. Not the kernel or the system's version, which change every
 * week; not a link's speed or state, nor a USB stick that happened to be in.
 * The RAM is compared by what is installed, rounded, since `MemTotal` moves by
 * a few megabytes with every kernel — and by its sticks only when both
 * readings could see them, so a box whose udev stopped saying is not a box
 * whose memory changed.
 */
function historyKeys(r: SpecsReading, sticks: boolean): [string, string | null][] {
  const memory = r.memory
    ? [memorySize(installedMemory(r.memory)), ...(sticks ? r.memory.modules.map((m) => `${memorySize(m.size)}${m.type ? ` ${m.type}` : ""}`).sort() : [])].join(", ")
    : null;
  const disks = r.disks.filter((d) => d.transport !== "usb").map((d) => `${d.model ?? d.name} ${diskSize(d.size)}`).sort();
  const nics = r.nics.map((n) => n.model).filter((m): m is string => Boolean(m)).sort();
  return [
    [PART_LABELS.cpu, r.cpu?.model ?? null],
    [PART_LABELS.board, boardName(r)],
    ["BIOS", r.board?.biosVersion ?? null],
    [PART_LABELS.memory, memory],
    [PART_LABELS.gpu, r.gpus.map(gpuName).sort().join(" + ") || null],
    [PART_LABELS.storage, disks.join(" + ") || null],
    [PART_LABELS.network, [...new Set(nics)].join(" + ") || null],
  ];
}

/**
 * A history line for each part that is different from one reading to the
 * next: "Motherboard: Gigabyte A320M-H-CF → Gigabyte B550M K". Only where both
 * readings said something, so a box that lost `lspci` between two readings is
 * not written up as one that lost its graphics card.
 */
export function changesBetween(before: SpecsReading, after: SpecsReading): string[] {
  const sticks = Boolean(before.memory?.modules.length && after.memory?.modules.length);
  const old = new Map(historyKeys(before, sticks));
  const out: string[] = [];
  for (const [label, now] of historyKeys(after, sticks)) {
    const was = old.get(label);
    if (was && now && was !== now) out.push(`${label}: ${was} → ${now}`.slice(0, HISTORY_TEXT_MAX));
  }
  return out;
}

/**
 * How long a reading is good for before the machine is asked again. Hardware
 * does not move, so this is long; what catches a swap sooner is that a swap
 * means the machine was off, and a machine coming back is read at once.
 */
export const SPECS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
