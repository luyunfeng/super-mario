// What this computer is connected to, and what it is listening for. It is a read of the
// kernel's own tables. Nothing is sent to the internet: the only reachability it reports is to
// the gateway and the name servers this computer already uses.
import { readdir, readFile, readlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import type { Json, NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

/** One address this computer has. */
export interface InterfaceAddress { name: string; address: string; family: 'IPv4' | 'IPv6'; mac: string; internal: boolean; netmask: string; cidr: string }

/** One port that something is listening for, and what is listening. */
export interface ListeningPort {
  protocol: 'tcp' | 'tcp6' | 'udp' | 'udp6';
  /** The address it takes connections on. */
  address: string;
  port: number;
  /** The process that holds it, when this computer lets that be read. */
  pid?: number;
  processName?: string;
}

/** How long one round trip to a host took. */
export interface Probe { host: string; ok: boolean; ms?: number; error?: string }

/** What one read found. */
export interface NetworkReport {
  at: string;
  os: string;
  supported: boolean;
  addresses: InterfaceAddress[];
  ports: ListeningPort[];
  probes: Probe[];
  /** Whether the process of each port could be read. False where the computer does not allow it. */
  processesKnown: boolean;
  collectedMs: number;
}

/** The addresses of this computer, without the ones that say nothing (link-local, loopback duplicates). */
export function readAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): InterfaceAddress[] {
  const out: InterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.address || entry.address === '::1' || entry.address === '127.0.0.1' || entry.address.startsWith('fe80:')) continue;
      out.push({ name, address: entry.address, family: entry.family === 'IPv6' ? 'IPv6' : 'IPv4', mac: entry.mac, internal: entry.internal, netmask: entry.netmask, cidr: entry.cidr ?? '' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

/** The local address from a line of the kernel's tables, in hex as the kernel writes it: four
 *  bytes for IPv4, little-endian within each 32-bit group for IPv6. */
function hexAddress(hex: string, ipv6: boolean): string {
  if (!ipv6) return hex.match(/.{2}/g)?.reverse().map(part => parseInt(part, 16)).join('.') ?? '';
  const bytes = hex.match(/.{2}/g) ?? [];
  const ordered: string[] = [];
  for (let group = 0; group < 4; group++) ordered.push(...bytes.slice(group * 4, group * 4 + 4).reverse());
  // The groups are written as eight 16-bit words in the order the network uses.
  const words = ordered.map((_, index) => index % 2 === 0 ? ordered.slice(index, index + 2).join('') : '').filter(Boolean);
  return words.join(':');
}

/** The ports from /proc/net/tcp, tcp6, udp and udp6. Only ones that take connections are kept. */
export function parseProcNet(text: string, protocol: 'tcp' | 'tcp6' | 'udp' | 'udp6', pidOf?: (inode: string) => { pid: number; name: string } | undefined): ListeningPort[] {
  const ipv6 = protocol.endsWith('6');
  const out: ListeningPort[] = [];
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    // sl, local, remote, state, tx:rx, tr:when, retrnsmt, uid, timeout, inode, ...
    if (parts.length < 10 || !parts[0]!.endsWith(':')) continue;
    const [, local, remote, state, , , , , , inode] = parts as [string, string, string, string, string, string, string, string, string, string];
    // tcp: a listening socket is 0A. udp: one that is bound and connected to nothing, as a
    // connected one is a client of something and takes no connections.
    const listening = protocol.startsWith('tcp') ? state === '0A' : /^0+:0+$/.test(remote);
    if (!listening) continue;
    const [host, portHex] = local.split(':');
    const owner = pidOf?.(inode);
    out.push({ protocol, address: hexAddress(host!, ipv6), port: parseInt(portHex!, 16), ...(owner ? { pid: owner.pid, processName: owner.name } : {}) });
  }
  return out.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}

/** Which process holds each socket, from the file descriptors of every process. It reads only
 *  the owner's own processes unless the computer lets more be read. */
async function socketOwners(): Promise<{ byInode: Map<string, { pid: number; name: string }>; complete: boolean }> {
  const byInode = new Map<string, { pid: number; name: string }>();
  let complete = true;
  let pids: string[];
  try { pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name)); }
  catch { return { byInode, complete: false }; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = await readdir('/proc/' + pid + '/fd'); }
    catch { complete = false; continue; }
    for (const fd of fds) {
      let link: string;
      try { link = await readlink('/proc/' + pid + '/fd/' + fd); }
      catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (!match) continue;
      let name = String(pid);
      try { name = (await readFile('/proc/' + pid + '/comm', 'utf8')).trim() || name; } catch { /* the name is not readable; the id still tells something */ }
      byInode.set(match[1]!, { pid: Number(pid), name });
    }
  }
  return { byInode, complete };
}

/** How long one name lookup and one connection take, to a host this computer already uses. */
async function probe(host: string, port: number, timeoutMs: number): Promise<Probe> {
  const started = Date.now();
  try {
    // A connection is made and closed at once. Nothing is sent on it.
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port });
      socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timed out')); });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    return { host, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { host, ok: false, error: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 120) };
  }
}

export async function readNetwork(options: {
  addresses?: () => InterfaceAddress[];
  table?: (protocol: 'tcp' | 'tcp6' | 'udp' | 'udp6') => Promise<string>;
  owners?: () => Promise<{ byInode: Map<string, { pid: number; name: string }>; complete: boolean }>;
  probes?: () => Promise<Probe[]>;
  platform?: string;
  now?: () => number;
} = {}): Promise<NetworkReport> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const started = now();
  if (platform !== 'linux') return { at: new Date(started).toISOString(), os: platform, supported: false, addresses: [], ports: [], probes: [], processesKnown: false, collectedMs: 0 };
  const table = options.table ?? (protocol => readFile('/proc/net/' + protocol, 'utf8'));
  const owners = await (options.owners ?? socketOwners)();
  const ports: ListeningPort[] = [];
  for (const protocol of ['tcp', 'tcp6', 'udp', 'udp6'] as const) {
    try { ports.push(...parseProcNet(await table(protocol), protocol, inode => owners.byInode.get(inode))); }
    catch { /* a table this kernel does not have is left out */ }
  }
  // The gateway this computer uses, and the name servers it asks, are the hosts worth probing.
  const probes = await (options.probes ?? (async () => {
    const hosts: { host: string; port: number }[] = [];
    try {
      // The name servers are the hosts worth probing: the computer already asks them, and a
      // name server answers on its port. The gateway is not probed: it often takes no
      // connection on any port, and a timeout would say nothing of the network.
    } catch { /* no gateway is named; the probes are only of what is */ }
    try {
      const resolv = await readFile('/etc/resolv.conf', 'utf8');
      for (const line of resolv.split('\n')) {
        const match = /^\s*nameserver\s+(\S+)/.exec(line);
        if (match && !hosts.some(row => row.host === match[1])) hosts.push({ host: match[1]!, port: 53 });
      }
    } catch { /* no name servers are named */ }
    return Promise.all(hosts.slice(0, 4).map(row => probe(row.host, row.port, 2000)));
  }))();
  return { at: new Date(started).toISOString(), os: platform, supported: true, addresses: (options.addresses ?? readAddresses)(), ports, probes, processesKnown: owners.complete, collectedMs: Math.max(now() - started, 0) };
}

/** The handler a machine offers for reading its network. */
export function createMachineNetworkNode(options: Parameters<typeof readNetwork>[0] = {}) {
  const handlers: Record<string, NodeHandler> = {
    'machine.network': async params => {
      if (Object.keys(params).length) throw new Error('读取网络不接受参数');
      return await readNetwork(options) as unknown as Json;
    },
  };
  return { handlers };
}
