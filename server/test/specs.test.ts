import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";

import {
  adoptSpecsFile,
  agreement,
  boardLine,
  changesBetween,
  cleanTyped,
  cpuLine,
  gpuLine,
  installedMemory,
  memoryLine,
  modelTokens,
  networkLine,
  parsePciLine,
  parseSpecs,
  readLine,
  shortVendor,
  sortHistory,
  SPECS_MARK,
  SPECS_SCRIPT,
  storageLine,
  validHistoryDate,
  type HistoryEntry,
  type SpecsReading,
} from "../../shared/specs";

const M = SPECS_MARK;

/** What the script printed on a two-vCPU KVM box, names and addresses changed. */
const VPS = `${M} host
box-01
${M} os
PRETTY_NAME="Ubuntu 24.04.5 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
${M} kernel
Linux 6.8.0-147-generic x86_64
${M} virt
kvm
${M} cpu
Architecture:                            x86_64
CPU(s):                                  2
Vendor ID:                               AuthenticAMD
Model name:                              AMD EPYC 9354P 32-Core Processor
Thread(s) per core:                      1
Core(s) per socket:                      2
Socket(s):                               1
Hypervisor vendor:                       KVM
L3 cache:                                32 MiB (2 instances)
${M} mem
MemTotal:        8131468 kB
SwapTotal:       2097148 kB
${M} dmi
sys_vendor=QEMU
product_name=Standard PC (i440FX + PIIX, 1996)
product_version=pc-i440fx-11.0
board_vendor=
board_name=
board_version=
bios_vendor=SeaBIOS
bios_version=rel-1.17.0-0-prebuilt.qemu.org
bios_date=04/01/2014
${M} memdev
MEMORY_DEVICE_0_SIZE=8589934592
MEMORY_DEVICE_0_LOCATOR=DIMM 0
MEMORY_DEVICE_0_TYPE=RAM
MEMORY_DEVICE_0_MANUFACTURER=QEMU
MEMORY_DEVICE_0_PART_NUMBER=Not Specified
${M} dmidecode

${M} disks
NAME="sda" TYPE="disk" SIZE="107374182400" ROTA="0" TRAN="" MODEL="QEMU HARDDISK"
NAME="sr0" TYPE="rom" SIZE="4194304" ROTA="1" TRAN="ata" MODEL="QEMU DVD-ROM"
${M} pci
0000:00:12.0 "Ethernet controller" "Red Hat, Inc." "Virtio network device" -p00 "Red Hat, Inc." "Virtio network device"
${M} drm
${M} net
--
name=eth0
mac=02:00:00:00:00:01
state=up
speed=-1
driver=virtio_net
path=/sys/devices/pci0000:00/0000:00:12.0/virtio2
`;

/** A desktop: a B550 board, a Ryzen, two sticks, an ASRock card, a drive of each kind and a USB stick, Ethernet and a USB Wi-Fi dongle. */
const DESKTOP = `${M} host
desk
${M} os
NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
${M} kernel
Linux 6.17.1-arch1-1 x86_64
${M} virt
none
${M} cpu
Architecture:                            x86_64
CPU(s):                                  12
Vendor ID:                               AuthenticAMD
Model name:                              AMD Ryzen 5 5500
Thread(s) per core:                      2
Core(s) per socket:                      6
Socket(s):                               1
CPU(s) scaling MHz:                      52%
CPU max MHz:                             4267.0000
CPU min MHz:                             400.0000
L3 cache:                                16 MiB (1 instance)
${M} mem
MemTotal:       16303072 kB
SwapTotal:       8388604 kB
${M} dmi
sys_vendor=Gigabyte Technology Co., Ltd.
product_name=B550M K
product_version=Default string
board_vendor=Gigabyte Technology Co., Ltd.
board_name=B550M K
board_version=x.x
bios_vendor=American Megatrends International, LLC.
bios_version=F12
bios_date=03/01/2024
${M} memdev
MEMORY_DEVICE_0_SIZE=8589934592
MEMORY_DEVICE_0_LOCATOR=DIMM 0
MEMORY_DEVICE_0_TYPE=DDR4
MEMORY_DEVICE_0_SPEED_MTS=3200
MEMORY_DEVICE_0_MANUFACTURER=Kingston
MEMORY_DEVICE_0_PART_NUMBER=KF3200C16D4/8GX
MEMORY_DEVICE_1_SIZE=0
MEMORY_DEVICE_1_LOCATOR=DIMM 1
MEMORY_DEVICE_2_SIZE=8589934592
MEMORY_DEVICE_2_LOCATOR=DIMM 2
MEMORY_DEVICE_2_TYPE=DDR4
MEMORY_DEVICE_2_SPEED_MTS=3200
MEMORY_DEVICE_2_MANUFACTURER=Kingston
MEMORY_DEVICE_2_PART_NUMBER=KF3200C16D4/8GX
${M} dmidecode
${M} disks
NAME="nvme0n1" TYPE="disk" SIZE="500107862016" ROTA="0" TRAN="nvme" MODEL="Samsung SSD 970 EVO Plus 500GB"
NAME="sda" TYPE="disk" SIZE="1000204886016" ROTA="1" TRAN="sata" MODEL="WDC\\x20WD10EZEX-08WN4A0"
NAME="sdb" TYPE="disk" SIZE="15376318464" ROTA="0" TRAN="usb" MODEL="Cruzer Blade"
NAME="zram0" TYPE="disk" SIZE="4294967296" ROTA="0" TRAN="" MODEL=""
${M} pci
0000:03:00.0 "Ethernet controller" "Realtek Semiconductor Co., Ltd." "RTL8111/8168/8211/8411 PCI Express Gigabit Ethernet Controller" -r15 -p00 "Gigabyte Technology Co., Ltd" "Onboard Ethernet"
0000:0a:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 24 [Radeon RX 6400/6500 XT/6500M]" -rc7 -p00 "ASRock Incorporation" "Device 5402"
${M} drm
/sys/devices/pci0000:00/0000:00:03.1/0000:08:00.0/0000:09:00.0/0000:0a:00.0 0x1002 0x743f 4278190080
${M} net
--
name=enp3s0
mac=02:00:00:00:00:02
state=up
speed=1000
driver=r8169
path=/sys/devices/pci0000:00/0000:00:02.1/0000:03:00.0
--
name=wlan0
mac=02:00:00:00:00:03
state=down
speed=
driver=rtw88_8821cu
path=/sys/devices/pci0000:00/0000:00:08.1/0000:0b:00.3/usb1/1-4/1-4:1.0
wireless=1
usb=Realtek|802.11ac NIC
`;

const vps = parseSpecs(VPS, 1)!;
const desktop = parseSpecs(DESKTOP, 2)!;

describe("the script", () => {
  /**
   * It is handed to `sh -c` inside single quotes through whatever the
   * account's login shell is, so neither may appear in it — `posix` in
   * `server/src/machines.ts` refuses it at run time, and this says so first.
   */
  it("holds no single quote and no backslash", () => {
    expect(SPECS_SCRIPT).not.toMatch(/['\\]/);
  });

  /**
   * Run for real, the way ssh's far side runs it: a login shell handed
   * `sh -c '<script>'`. On a Mac most of it finds nothing, which is the
   * point of every `2>/dev/null` — it still runs to the end, prints every
   * section in order and exits 0.
   */
  for (const shell of ["bash", "zsh"]) {
    it(`runs to the end under ${shell}`, () => {
      const out = spawnSync(shell, ["-c", `sh -c '${SPECS_SCRIPT}'`], { encoding: "utf8", timeout: 20_000 });
      expect(out.status).toBe(0);
      const marks = out.stdout.split("\n").filter((line) => line.startsWith(M)).map((line) => line.slice(M.length + 1));
      expect(marks).toEqual(["host", "os", "kernel", "virt", "cpu", "mem", "dmi", "memdev", "dmidecode", "disks", "pci", "drm", "net"]);
    });
  }
});

describe("parseSpecs", () => {
  it("reads a VPS", () => {
    expect(vps.hostname).toBe("box-01");
    expect(vps.virt).toBe("kvm");
    expect(cpuLine(vps)).toBe("AMD EPYC 9354P 32-Core Processor · 2 vCPUs");
    expect(memoryLine(vps)).toBe("8 GB");
    expect(boardLine(vps)).toBe("QEMU Standard PC (i440FX + PIIX, 1996), virtual · BIOS rel-1.17.0-0-prebuilt.qemu.org (04/01/2014)");
    expect(storageLine(vps)).toBe("QEMU HARDDISK (107 GB)");
    expect(networkLine(vps)).toBe("eth0: Red Hat Virtio network device");
    expect(gpuLine(vps)).toBeNull();
    expect(readLine("os", vps)).toBe("Ubuntu 24.04.5 LTS · Linux 6.8.0-147-generic x86_64");
  });

  it("reads a desktop: the board, the sticks in their slots, the card's maker, the drives and both links", () => {
    expect(desktop.virt).toBeNull();
    expect(cpuLine(desktop)).toBe("AMD Ryzen 5 5500 · 6 cores, 12 threads · up to 4.27 GHz");
    expect(boardLine(desktop)).toBe("Gigabyte B550M K · BIOS F12 (03/01/2024)");
    // "x.x" and "Default string" are firmware saying nothing.
    expect(desktop.board?.version).toBeNull();
    expect(memoryLine(desktop)).toBe("16 GB · 2 × 8 GB DDR4-3200, Kingston KF3200C16D4/8GX");
    expect(desktop.memory?.modules.map((m) => m.slot)).toEqual(["DIMM 0", "DIMM 2"]);
    expect(gpuLine(desktop)).toBe("ASRock AMD Radeon RX 6400/6500 XT/6500M, 4 GB");
    // zram is the kernel's, not a drive; lsblk's \x20 is a space.
    expect(storageLine(desktop)).toBe("Samsung SSD 970 EVO Plus 500GB (500 GB, NVMe) + WDC WD10EZEX-08WN4A0 (1 TB, SATA, spinning) + Cruzer Blade (15 GB, USB)");
    expect(networkLine(desktop)).toBe("enp3s0: Gigabyte Realtek RTL8111/8168/8211/8411 PCI Express Gigabit Ethernet Controller, 1 Gb/s + wlan0: Realtek 802.11ac NIC, Wi-Fi");
    expect(desktop.nics[1]).toMatchObject({ usb: true, wireless: true, driver: "rtw88_8821cu", speed: null });
  });

  it("takes dmidecode's sticks when udev kept none", () => {
    const text = DESKTOP.replace(/MEMORY_DEVICE_[^\n]*\n/g, "").replace(
      `${M} dmidecode\n`,
      `${M} dmidecode\nHandle 0x0011, DMI type 17, 92 bytes\nMemory Device\n\tSize: 16 GB\n\tLocator: DIMM_A2\n\tType: DDR4\n\tSpeed: 3600 MT/s\n\tManufacturer: G Skill\n\tPart Number: F4-3600C16-16GVKC\n\nHandle 0x0012, DMI type 17, 92 bytes\nMemory Device\n\tSize: No Module Installed\n\tLocator: DIMM_B1\n`,
    );
    const r = parseSpecs(text, 3)!;
    expect(r.memory?.modules).toEqual([{ size: 16 * 2 ** 30, type: "DDR4", speed: 3600, maker: "G Skill", part: "F4-3600C16-16GVKC", slot: "DIMM_A2" }]);
  });

  it("is null for a machine that said nothing it can read, so it never replaces a reading that did", () => {
    expect(parseSpecs("", 1)).toBeNull();
    expect(parseSpecs(`${M} host\nmac-mini\n${M} kernel\nDarwin 25.0.0 arm64\n`, 1)).toBeNull();
  });

  it("rounds MemTotal up to what is installed when no stick could be read", () => {
    expect(installedMemory({ total: 8131468 * 1024, swap: null, modules: [] })).toBe(8 * 2 ** 30);
    expect(installedMemory({ total: 15.4 * 2 ** 30, swap: null, modules: [] })).toBe(16 * 2 ** 30);
  });
});

describe("the names", () => {
  it("says a vendor as people do", () => {
    expect(shortVendor("Advanced Micro Devices, Inc. [AMD/ATI]")).toBe("AMD");
    expect(shortVendor("Gigabyte Technology Co., Ltd.")).toBe("Gigabyte");
    expect(shortVendor("Gigabyte Technology Co., Ltd")).toBe("Gigabyte");
    expect(shortVendor("ASRock Incorporation")).toBe("ASRock");
    expect(shortVendor("Realtek Semiconductor Co., Ltd.")).toBe("Realtek");
    expect(shortVendor("Micro-Star International Co., Ltd. [MSI]")).toBe("MSI");
    expect(shortVendor("Intel Corporation")).toBe("Intel");
    expect(shortVendor("Red Hat, Inc.")).toBe("Red Hat");
  });

  it("reads an lspci -mm line with or without its options and subsystem", () => {
    expect(parsePciLine(`0000:0a:00.0 "VGA compatible controller" "AMD" "Navi 24" -rc7 -p00 "ASRock Incorporation" "Device 5402"`)).toEqual({
      slot: "0000:0a:00.0",
      cls: "VGA compatible controller",
      vendor: "AMD",
      device: "Navi 24",
      svendor: "ASRock Incorporation",
      sdevice: "Device 5402",
    });
    expect(parsePciLine(`0000:00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 620" "" ""`)?.svendor).toBe("");
    expect(parsePciLine("garbage")).toBeNull();
  });

  it("keeps model numbers and drops the figures every part has", () => {
    expect([...modelTokens("AMD Ryzen 5 5500, 6 cores / 12 threads, 3.6 GHz base, 4.2GHz boost")]).toEqual(["5500"]);
    expect([...modelTokens("Gigabyte B550M K")]).toEqual(["b550m"]);
    expect([...modelTokens("16 GB DDR4-3200, bought 2026")]).toEqual(["3200"]);
    expect([...modelTokens("Corsair RM1000i")]).toEqual(["rm1000i"]);
    expect(modelTokens("QFly (model unknown)").size).toBe(0);
  });
});

describe("agreement", () => {
  it("matches a board by its model, however the vendor is spelt", () => {
    expect(agreement("board", "Gigabyte B550M K", desktop)).toBe(true);
    expect(agreement("board", "Gigabyte GA-A320M-H", desktop)).toBe(false);
  });

  it("checks a CPU's model and its counts, each where it can", () => {
    expect(agreement("cpu", "AMD Ryzen 5 5500 — 6 cores / 12 threads, 3.6 GHz base, 4.2 GHz max boost", desktop)).toBe(true);
    expect(agreement("cpu", "Ryzen 5 PRO 1600", desktop)).toBe(false);
    expect(agreement("cpu", "Ryzen 5 5500, 8 cores", desktop)).toBe(false);
    expect(agreement("cpu", "2 vCPU (plan)", vps)).toBe(true);
    expect(agreement("cpu", "4 vCPU", vps)).toBe(false);
  });

  it("compares memory by size and generation, and a drive by size in the units on its box", () => {
    expect(agreement("memory", "16 GB DDR4 — probably carried over", desktop)).toBe(true);
    expect(agreement("memory", "32 GB", desktop)).toBe(false);
    expect(agreement("memory", "16 GB DDR5", desktop)).toBe(false);
    expect(agreement("memory", "8 GB (plan)", vps)).toBe(true);
    expect(agreement("storage", "100 GB NVMe (plan)", vps)).toBe(true);
    expect(agreement("storage", "Samsung 970 EVO", desktop)).toBe(true);
  });

  it("finds the card behind its brand", () => {
    expect(agreement("gpu", "ASRock Radeon RX 6400", desktop)).toBe(true);
    expect(agreement("gpu", "Sapphire RX 580", desktop)).toBe(false);
  });

  it("says nothing when there is nothing to compare on", () => {
    expect(agreement("network", "QFly (model unknown)", desktop)).toBeNull();
    expect(agreement("psu", "Corsair RM1000i", desktop)).toBeNull();
    expect(agreement("board", "", desktop)).toBeNull();
    expect(agreement("board", "Gigabyte B550M K", null)).toBeNull();
  });

  it("knows a system by its distribution's name", () => {
    expect(agreement("os", "Omarchy (Arch) with Limine", desktop)).toBe(true);
    expect(agreement("os", "Fedora 41", desktop)).toBe(false);
  });
});

describe("changesBetween", () => {
  const swap = (from: SpecsReading, to: Partial<SpecsReading>): SpecsReading => ({ ...from, ...to });

  it("writes a line for a swapped board and a flashed BIOS", () => {
    const before = swap(desktop, {
      cpu: { ...desktop.cpu!, model: "AMD Ryzen 5 PRO 1600 Six-Core Processor" },
      board: { ...desktop.board!, name: "A320M-H-CF", biosVersion: "F30" },
    });
    expect(changesBetween(before, desktop)).toEqual([
      "CPU: AMD Ryzen 5 PRO 1600 Six-Core Processor → AMD Ryzen 5 5500",
      "Motherboard: Gigabyte A320M-H-CF → Gigabyte B550M K",
      "BIOS: F30 → F12",
    ]);
  });

  it("writes nothing for what an update changes, a link's state, or a USB stick", () => {
    const later = swap(desktop, {
      kernel: "Linux 6.18.0-arch1-1 x86_64",
      memory: { ...desktop.memory!, total: desktop.memory!.total - 4096 },
      disks: desktop.disks.filter((d) => d.transport !== "usb"),
      nics: desktop.nics.map((n) => ({ ...n, state: "down", speed: null })),
    });
    expect(changesBetween(desktop, later)).toEqual([]);
  });

  it("notices a stick that died, and not a reading that could not see the sticks", () => {
    const one = swap(desktop, { memory: { ...desktop.memory!, modules: desktop.memory!.modules.slice(0, 1) } });
    expect(changesBetween(desktop, one)).toEqual(["Memory: 16 GB, 8 GB DDR4, 8 GB DDR4 → 8 GB, 8 GB DDR4"]);
    const blind = swap(desktop, { memory: { ...desktop.memory!, modules: [] } });
    expect(changesBetween(desktop, blind)).toEqual([]);
  });

  it("writes nothing where either reading had nothing", () => {
    expect(changesBetween(desktop, swap(desktop, { gpus: [] }))).toEqual([]);
  });
});

describe("what is kept", () => {
  it("takes a date in the three grammars that sort as text, or none", () => {
    expect(validHistoryDate("2026")).toBe("2026");
    expect(validHistoryDate("2026-10")).toBe("2026-10");
    expect(validHistoryDate(" 2026-10-31 ")).toBe("2026-10-31");
    expect(validHistoryDate("")).toBe("");
    expect(validHistoryDate("2026-13")).toBeNull();
    expect(validHistoryDate("31/10/2026")).toBeNull();
    expect(validHistoryDate(20261031)).toBeNull();
  });

  it("sorts the history newest first, undated last, a day's lines newest first", () => {
    const line = (id: string, date: string): HistoryEntry => ({ id, date, text: id, by: "you" });
    const sorted = sortHistory([line("a", "2026-10"), line("b", ""), line("c", "2026-10-31"), line("d", "2026-10-31"), line("e", "2025")]);
    expect(sorted.map((e) => e.id)).toEqual(["d", "c", "a", "e", "b"]);
  });

  it("cleans a typed value: one line for a part, paragraphs for the notes", () => {
    expect(cleanTyped("psu", "  Corsair\n RM1000i  ")).toBe("Corsair RM1000i");
    expect(cleanTyped("notes", "  one\r\ntwo  ")).toBe("one\ntwo");
    expect(cleanTyped("board", "x".repeat(400))).toHaveLength(300);
    expect(cleanTyped("board", 7)).toBe("");
  });

  it("adopts the file rather than trusting it", () => {
    const file = adoptSpecsFile({
      machines: {
        m1: {
          host: "box",
          name: "Box",
          typed: { psu: "Corsair RM1000i", password: "never", board: 3 },
          history: [
            { id: "h1", date: "2026-10", text: "swapped", by: "read" },
            { id: "h1", date: "2026-10", text: "duplicate id" },
            { id: "h2", date: "yesterday", text: "bad date" },
            { id: "h3", date: "2026", text: "   " },
          ],
          reading: { at: "soon" },
        },
        m2: "nonsense",
      },
    });
    expect(Object.keys(file)).toEqual(["m1"]);
    expect(file.m1!.typed).toEqual({ psu: "Corsair RM1000i" });
    expect(file.m1!.history).toEqual([{ id: "h1", date: "2026-10", text: "swapped", by: "read" }]);
    expect(file.m1!.reading).toBeNull();
    expect(adoptSpecsFile({ machines: { m1: { reading: desktop } } }).m1!.reading).toEqual(desktop);
    expect(adoptSpecsFile(null)).toEqual({});
  });
});
