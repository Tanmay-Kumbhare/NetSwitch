// IPv4 subnet maths used by the Interface detail page and the backend /api/interfaces/:key.
const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const p = s.split('.');
  return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

export function subnetInfo(ip, prefix) {
  if (!isIPv4(ip) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error('bad ip/prefix');
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const addr = toInt(ip);
  const network = (addr & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = prefix >= 31 ? (prefix === 32 ? 1 : 2) : Math.max(0, 2 ** (32 - prefix) - 2);
  return {
    ip, prefix,
    mask: toIp(mask), wildcard: toIp(~mask >>> 0),
    network: toIp(network), broadcast: toIp(broadcast),
    firstHost: prefix >= 31 ? toIp(network) : toIp(network + 1),
    lastHost: prefix >= 31 ? toIp(broadcast) : toIp(broadcast - 1),
    hosts,
  };
}

export const sameSubnet = (a, b, prefix) => subnetInfo(a, prefix).network === subnetInfo(b, prefix).network;
