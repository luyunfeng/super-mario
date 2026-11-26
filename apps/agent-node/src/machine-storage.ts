// How full the disks of this computer are. One read answers it: the mounted filesystems that
// hold real storage, each with its capacity and its inodes. It is a stat of each mount, not a
// walk of the files, so it is fast and reads nothing of the owner's.
import { readFile, statfs } from 'node:fs/promises';
import type { NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

/** One mounted filesystem and how full it is. */
export interface MountStat {
  /** Where it is mounted, as the owner would name it. */
  mount: string;
  /** What it is mounted from. */
  device: string;
  /** The kind of filesystem. */
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  /** What a program without special rights may still write. Reserved blocks are not in it. */
  availBytes: number;
  usedPercent: number;
  /** The file slots, when the filesystem counts them. */
  inodesTotal?: number;
  inodesUsed?: number;
  inodesPercent?: number;
  readOnly: boolean;
}

/** What one read found. */
export interface StorageReport {
  at: string;
  os: string;
  /** False where this computer cannot say, as on a system without the calls for it. */
  supported: boolean;
  mounts: MountStat[];
  /** How long the read took. */
  collectedMs: number;
}

/** Filesystems that hold no storage of the owner's. What they show is made up by the kernel,
 *  or is an image that is always as full as it was made. The list is the reference's. */
const pseudo = new Set([
  'proc', 'procfs', 'sysfs', 'devtmpfs', 'devfs', 'devpts', 'cgroup', 'cgroup2', 'pstore', 'securityfs',
  'debugfs', 'tracefs', 'configfs', 'fusectl', 'hugetlbfs', 'mqueue', 'autofs', 'rpc_pipefs', 'nfsd',
  'binfmt_misc', 'efivarfs', 'bpf', 'nsfs', 'ramfs', 'selinuxfs', 'squashfs', 'iso9660', 'erofs', 'udf',
  'lxcfs', 'fuse.lxcfs', 'fuse.portal', 'fuse.gvfsd-fuse', 'sockfs', 'pipefs', 'anon_inodefs',
  'fdesc', 'volfs', 'nullfs', 'vmhgfs', 'sysvipc',
]);

/** The folders under which the system keeps its own workings. */
const SYSTEM_PATHS = ['/proc', '/sys', '/dev', '/run'];
const underSystemPath = (mount: string) => SYSTEM_PATHS.some(path => mount === path || mount.startsWith(path + '/'));

const BACKSLASH = String.fromCharCode(92);

/** The octal escapes the mount table writes paths with: a space is written as backslash
 *  040. Read one character at a time, so that the escapes are not read twice. */
function unescape(value: string): string {
  let out = '';
  for (let index = 0; index < value.length;) {
    const digits = value.slice(index + 1, index + 4);
    const octal = digits.length === 3 && Array.from(digits).every(digit => digit >= '0' && digit <= '7');
    if (value[index] === BACKSLASH && octal) {
      out += String.fromCharCode(Number.parseInt(digits, 8));
      index += 4;
    } else {
      out += value[index];
      index += 1;
    }
  }
  return out;
}

interface Entry { mount: string; device: string; fsType: string; readOnly: boolean; root: string }

/** Whether a mount holds real storage, or is a temp mount whose fullness would stop work. */
function wanted(entry: Entry): boolean {
  if (!entry.mount || pseudo.has(entry.fsType)) return false;
  // A temp filesystem that programs write to is worth watching: full, builds and agents fail.
  if (entry.fsType === 'tmpfs') return entry.mount === '/tmp' || entry.mount === '/var/tmp';
  // The root of a container is an overlay. Overlays elsewhere are not looked into.
  if (entry.fsType === 'overlay') return entry.mount === '/';
  // A filesystem that is shared or virtualised counts where it holds the owner's files, and
  // not where the system keeps its own workings.
  if (['zfs', 'virtiofs', '9p'].includes(entry.fsType)) return !underSystemPath(entry.mount);
  // A directory of another filesystem mounted elsewhere shows the same space twice.
  if (entry.root !== '/' && entry.mount !== '/' && entry.fsType !== 'btrfs') return false;
  // A loop device is an image file on another disk, and counting it would count that twice.
  return !/^\/dev\/loop\d+$/.test(entry.device);
}

/** The mounts of this computer from the kernel's own table. */
export function parseMountinfo(text: string): Entry[] {
  const out: Entry[] = [];
  const seenMount = new Set<string>();
  const seenDevice = new Set<string>();
  for (const line of text.split('\n')) {
    const cut = line.indexOf(' - ');
    if (cut < 0) continue;
    const before = line.slice(0, cut).split(/\s+/).filter(Boolean);
    const after = line.slice(cut + 3).split(/\s+/).filter(Boolean);
    // before: id, parent, major:minor, root, mount point, options. after: type, source, options.
    if (before.length < 6 || after.length < 2) continue;
    const entry: Entry = {
      mount: unescape(before[4]!), device: unescape(after[1]!), fsType: after[0]!, root: unescape(before[3]!),
      readOnly: before[5]!.split(',').includes('ro') || (after[2] ?? '').split(',').includes('ro'),
    };
    if (!wanted(entry) || seenMount.has(entry.mount)) continue;
    // One block device is counted once, under the first place it is mounted.
    if (/^\/dev\//.test(entry.device)) {
      if (seenDevice.has(entry.device)) continue;
      seenDevice.add(entry.device);
    }
    seenMount.add(entry.mount);
    out.push(entry);
  }
  // The root first, then by name, so that the page shows them in a steady order.
  return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

/** How full one mount is, rounded to a whole percent. An empty filesystem is 0, not NaN. */
export function percent(used: number, total: number): number {
  return total > 0 ? Math.round(used / total * 100) : 0;
}

/** The mounts of this computer, as far as it can say. */
export async function readStorage(options: {
  mounts?: () => Promise<Entry[]>;
  stat?: (path: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number }>;
  platform?: string;
  now?: () => number;
} = {}): Promise<StorageReport> {
  const stat = options.stat ?? statfs;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const started = now();
  if (platform !== 'linux') return { at: new Date(started).toISOString(), os: platform, supported: false, mounts: [], collectedMs: 0 };
  let entries: Entry[];
  try {
    entries = options.mounts ? await options.mounts() : parseMountinfo(await readFile('/proc/self/mountinfo', 'utf8'));
  } catch {
    // Without the table nothing can be named. The root is tried, as it is on every computer.
    entries = [{ mount: '/', device: '', fsType: '', readOnly: false, root: '/' }];
  }
  const mounts: MountStat[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(entry.mount);
      // A filesystem that reports no blocks has no space of its own to show.
      if (s.blocks === 0 || s.bsize <= 0) continue;
      const total = s.blocks * s.bsize;
      const used = (s.blocks - s.bfree) * s.bsize;
      mounts.push({
        mount: entry.mount, device: entry.device, fsType: entry.fsType, readOnly: entry.readOnly,
        totalBytes: total, usedBytes: used, availBytes: s.bavail * s.bsize, usedPercent: percent(used, total),
        ...(s.files > 0 ? { inodesTotal: s.files, inodesUsed: s.files - s.ffree, inodesPercent: percent(s.files - s.ffree, s.files) } : {}),
      });
    } catch {
      // A mount that cannot be read now, such as one that is going away, is left out.
    }
  }
  return { at: new Date(started).toISOString(), os: platform, supported: true, mounts, collectedMs: Math.max(now() - started, 0) };
}

/** The handler a machine offers for reading its storage. It takes no arguments. */
export function createMachineStorageNode(options: Parameters<typeof readStorage>[0] = {}) {
  const handlers: Record<string, NodeHandler> = {
    'machine.storage': async params => {
      if (Object.keys(params).length) throw new Error('读取存储不接受参数');
      return await readStorage(options) as unknown as import('../../../packages/plugin-sdk/src/index.ts').Json;
    },
  };
  return { handlers };
}

