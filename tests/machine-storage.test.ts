import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMountinfo, percent, readStorage, createMachineStorageNode } from '../apps/agent-node/src/machine-storage.ts';

const backslash = String.fromCharCode(92);

/** A mount table with the kinds of mount the rules tell apart. Modeled on /proc/self/mountinfo. */
const table = [
  '25 31 0:23 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw',
  '26 31 0:24 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw',
  '27 31 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=64726056k,nr_inodes=16181514,mode=755',
  '28 27 0:25 / /dev/pts rw,nosuid,noexec,relatime shared:3 - devpts devpts rw,gid=5,mode=620',
  '29 31 0:26 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=12953392k,mode=755',
  '30 25 0:27 / /sys/firmware/efi/efivars rw,nosuid,nodev,noexec,relatime shared:8 - efivarfs efivarfs rw',
  '31 1 253:2 / / rw,relatime shared:1 - ext4 /dev/vda2 rw,discard,errors=remount-ro',
  '33 27 0:28 / /dev/shm rw,nosuid,nodev shared:4 - tmpfs tmpfs rw',
  '35 25 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:10 - cgroup2 cgroup2 rw,nsdelegate',
  '40 31 0:29 / /tmp rw,nosuid,nodev shared:6 - tmpfs tmpfs rw,size=2097152k',
  '41 31 0:31 / /var/tmp rw,nosuid,nodev shared:9 - tmpfs tmpfs rw,size=1048576k',
  '42 31 0:32 / /run/lock rw,nosuid,nodev,noexec,relatime shared:11 - tmpfs tmpfs rw,size=5120k',
  '50 31 253:16 / /data00 rw,relatime shared:20 - ext4 /dev/vdb rw',
  // The same disk mounted again under a folder: the same space, not more of it.
  '51 31 253:16 /home /data00/home rw,relatime shared:21 - ext4 /dev/vdb rw',
  // A disk mounted at a path with a space, written the way the kernel writes it.
  '52 31 8:17 / /mnt/Team' + backslash + '040Files rw,relatime shared:22 - ext4 /dev/sdb1 rw',
  // An image file on another disk, mounted through a loop device.
  '53 31 7:1 / /mnt/image rw,relatime shared:23 - squashfs /dev/loop0 ro',
  // A shared filesystem, where the owner keeps files, and one the system keeps for itself.
  '54 31 0:35 / /pool rw,relatime shared:24 - zfs pool/data rw',
  '54 31 0:36 / /run/kvm rw,relatime shared:27 - 9p host rw,trans=virtio',
  // An image that is always as full as it was made: saying it is full tells nothing.
  '54 31 253:5 / /mnt/iso ro,relatime shared:28 - iso9660 /dev/sr0 ro',
  // The root of a container.
  '55 31 0:33 / rw,relatime shared:25 - overlay overlay rw,lowerdir=/var/lib/docker/x,upperdir=/var/lib/docker/y',
].join(String.fromCharCode(10));

test('挂载表只留真正放东西的文件系统：伪文件系统、多余的 tmpfs、重复的盘和 loop 设备都不要', () => {
  const mounts = parseMountinfo(table).map(entry => entry.mount);
  // The root, the data disk once, the two temp mounts programs write to, the disk at a path
  // with a space, and the shared pool. Not the copies, loops, images or the system's own.
  // The root first, then the rest in the order a person reads them.
  assert.deepEqual(mounts, ['/', '/data00', '/mnt/Team Files', '/pool', '/tmp', '/var/tmp']);
  // In a container the root is an overlay. It is kept, as the root is where the owner looks.
  const container = parseMountinfo(['55 31 0:33 / / rw,relatime shared:25 - overlay overlay rw,lowerdir=/x,upperdir=/y',
    '56 31 0:34 / /somewhere rw,relatime shared:26 - overlay overlay rw'].join(String.fromCharCode(10)));
  assert.deepEqual(container.map(entry => entry.mount), ['/']);
});

test('挂载点里的八进制转义还原成字符，不是八进制的不动', () => {
  const mounts = parseMountinfo(table);
  assert.ok(mounts.some(entry => entry.mount === '/mnt/Team Files' && entry.device === '/dev/sdb1'));
  // A backslash that does not start three octal digits is an ordinary character.
  const odd = parseMountinfo('60 31 253:18 / /a' + backslash + '08b rw shared:30 - ext4 /dev/sdc rw');
  assert.equal(odd[0]?.mount, '/a' + backslash + '08b');
  // A read-only mount is marked so, when one is kept.
  const readonly = parseMountinfo('31 1 253:2 / / ro,relatime shared:1 - ext4 /dev/vda2 ro');
  assert.equal(readonly[0]?.readOnly, true);
  assert.equal(mounts.find(entry => entry.mount === '/')?.readOnly, false);
});

test('用量按整数百分比，空的文件系统是 0', () => {
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(0, 100), 0);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(5, 5), 100);
});

test('读存储：每个挂载算出总量、已用和可用，inode 只在有的时候给；读不到的挂载跳过', async () => {
  const asked: string[] = [];
  const stat = async (path: string) => {
    asked.push(path);
    if (path === '/gone') throw Object.assign(new Error('busy'), { code: 'EACCES' });
    // A filesystem that reports no blocks has no space of its own.
    if (path === '/empty') return { bsize: 4096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 };
    if (path === '/noinodes') return { bsize: 1024, blocks: 100, bfree: 40, bavail: 30, files: 0, ffree: 0 };
    return { bsize: 4096, blocks: 1000, bfree: 400, bavail: 350, files: 200, ffree: 50 };
  };
  const report = await readStorage({
    mounts: async () => [{ mount: '/', device: '/dev/vda', fsType: 'ext4', readOnly: false, root: '/' },
      { mount: '/noinodes', device: '/dev/vdb', fsType: 'ext4', readOnly: false, root: '/' },
      { mount: '/empty', device: 'tmpfs', fsType: 'tmpfs', readOnly: false, root: '/' },
      { mount: '/gone', device: '/dev/vdc', fsType: 'ext4', readOnly: false, root: '/' }],
    stat, platform: 'linux', now: () => 1700000000000,
  });
  assert.equal(report.supported, true);
  assert.equal(report.at, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(report.mounts.map(mount => mount.mount), ['/', '/noinodes']);
  const root = report.mounts[0]!;
  assert.equal(root.totalBytes, 4096 * 1000);
  assert.equal(root.usedBytes, 4096 * 600);
  assert.equal(root.availBytes, 4096 * 350);
  assert.equal(root.usedPercent, 60);
  assert.deepEqual([root.inodesTotal, root.inodesUsed, root.inodesPercent], [200, 150, 75]);
  // A filesystem that does not count file slots is not given any.
  const noInodes = report.mounts[1]!;
  assert.equal(noInodes.usedPercent, 60);
  assert.equal('inodesTotal' in noInodes, false);
  // Every mount was asked for once, the one that could not be read included.
  assert.deepEqual(asked, ['/', '/noinodes', '/empty', '/gone']);
});

test('说不了的系统如实说明；没有挂载表时至少读根分区', async () => {
  const other = await readStorage({ platform: 'darwin', now: () => 0 });
  assert.deepEqual(other, { at: '1970-01-01T00:00:00.000Z', os: 'darwin', supported: false, mounts: [], collectedMs: 0 });
  const fallback = await readStorage({
    mounts: async () => { throw new Error('no table'); },
    stat: async () => ({ bsize: 100, blocks: 10, bfree: 5, bavail: 5, files: 0, ffree: 0 }),
    platform: 'linux', now: () => 0,
  });
  assert.equal(fallback.supported, true);
  assert.deepEqual(fallback.mounts.map(mount => mount.mount), ['/']);
});

test('节点处理器不带参数，带了参数就拒绝', async () => {
  const { handlers } = createMachineStorageNode({
    mounts: async () => [], stat: async () => ({ bsize: 0, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 }), platform: 'linux', now: () => 0,
  });
  const read = handlers['machine.storage']!;
  assert.deepEqual(await read({}, () => {}), { at: '1970-01-01T00:00:00.000Z', os: 'linux', supported: true, mounts: [], collectedMs: 0 });
  await assert.rejects(read({ path: '/etc' }, () => {}), /不接受参数/);
});
