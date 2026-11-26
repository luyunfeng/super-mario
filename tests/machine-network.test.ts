import assert from 'node:assert/strict';
import test from 'node:test';
import { createMachineNetworkNode, parseProcNet, readAddresses, readNetwork } from '../apps/agent-node/src/machine-network.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n';

test('the listening sockets are read from the kernel tables, by the right columns', () => {
  const tcp = HEADER + [
    '   0: 0100007F:B303 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 3142731324 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3142731325 1 0000000000000000 100 0 0 10 0',
    // A connection someone made, which takes nothing: not kept.
    '   2: 0100007F:A781 0100007F:23A3 01 00000000:00000000 00:00000000 00000000     0        0 3152297370 2 0000000000000000 0',
  ].join('\n');
  const ports = parseProcNet(tcp, 'tcp', inode => inode === '3142731325' ? { pid: 1234, name: 'sshd' } : undefined);
  assert.deepEqual(ports, [
    { protocol: 'tcp', address: '0.0.0.0', port: 22, pid: 1234, processName: 'sshd' },
    { protocol: 'tcp', address: '127.0.0.1', port: 0xb303 },
  ]);
  // udp has no listening state: a socket bound and connected to nothing is kept, a client's is not.
  const udp = HEADER + [
    '29812: 3600007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   992        0 23743 2 0000000000000000 0',
    ' 7104: 0100007F:A781 0100007F:23A3 01 00000000:00000000 00:00000000 00000000     0        0 3152297370 2 0000000000000000 0',
  ].join('\n');
  assert.deepEqual(parseProcNet(udp, 'udp'), [{ protocol: 'udp', address: '127.0.0.54', port: 53 }]);
});

test('the addresses of the computer leave out the ones that say nothing of it', () => {
  const addresses = readAddresses({
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    eth0: [
      { address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '10.0.0.5/24' },
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 0 },
    ],
  });
  assert.deepEqual(addresses, [{ name: 'eth0', address: '10.0.0.5', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, netmask: '255.255.255.0', cidr: '10.0.0.5/24' }]);
});

test('one read gives the addresses, the ports with their processes where known, and the probes', async () => {
  const tables: Record<string, string> = {
    tcp: HEADER + '   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100 1 0 0',
    tcp6: '', udp: '', udp6: '',
  };
  const report = await readNetwork({
    addresses: () => [{ name: 'eth0', address: '10.0.0.5', family: 'IPv4', mac: '', internal: false, netmask: '', cidr: '' }],
    table: async protocol => tables[protocol] ?? '',
    owners: async () => ({ byInode: new Map([['100', { pid: 1234, name: 'sshd' }]]), complete: true }),
    probes: async () => [{ host: '10.0.0.1', ok: true, ms: 2 }],
    now: (() => { let clock = 1000; return () => (clock += 5); })(),
  });
  assert.equal(report.supported, true);
  assert.equal(report.addresses.length, 1);
  assert.deepEqual(report.ports, [{ protocol: 'tcp', address: '0.0.0.0', port: 22, pid: 1234, processName: 'sshd' }]);
  assert.equal(report.processesKnown, true);
  assert.deepEqual(report.probes, [{ host: '10.0.0.1', ok: true, ms: 2 }]);
  assert.equal(report.collectedMs, 5);
  assert.equal(Number.isNaN(Date.parse(report.at)), false);
  // When the computer does not let other processes be read, that is said and not hidden.
  const partial = await readNetwork({
    addresses: () => [], table: async protocol => tables[protocol] ?? '',
    owners: async () => ({ byInode: new Map(), complete: false }), probes: async () => [],
  });
  assert.equal(partial.processesKnown, false);
  assert.equal(partial.ports[0]!.pid, undefined);
});

test('the reading takes no arguments, and on a system without the files it says so', async () => {
  const node = createMachineNetworkNode({ platform: 'win32' });
  await assert.rejects(node.handlers['machine.network']!({ extra: 1 }, () => {}), /不接受参数/);
  const report = await node.handlers['machine.network']({}, () => {}) as Json as { supported: boolean; ports: unknown[] };
  assert.equal(report.supported, false);
  assert.deepEqual(report.ports, []);
});
