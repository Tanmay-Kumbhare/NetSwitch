import { runPs } from './ps.js';

const SCRIPT = `
$out = @(Get-NetIPConfiguration | Where-Object {
  $_.IPv4DefaultGateway -ne $null -and
  $_.NetAdapter.Status -eq 'Up' -and
  $_.InterfaceAlias -notmatch 'VMware|VMnet|VirtualBox|vEthernet|Hyper-V|Loopback' -and
  $_.InterfaceDescription -notmatch 'VMware|VirtualBox|Hyper-V|Virtual|Loopback'
} | ForEach-Object {
  $if = Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4
  [pscustomobject]@{
    alias = $_.InterfaceAlias; index = [int]$_.InterfaceIndex; description = $_.InterfaceDescription;
    ip = $_.IPv4Address[0].IPAddress; prefix = [int]$_.IPv4Address[0].PrefixLength; gateway = $_.IPv4DefaultGateway.NextHop;
    metric = [int]$if.InterfaceMetric; autoMetric = ($if.AutomaticMetric -eq 'Enabled')
  } })
ConvertTo-Json -Compress -InputObject $out
`;

export function isVirtualOrExcluded(description = '', alias = '') {
  const s = `${description} ${alias}`;
  return /vmware|vmnet|virtualbox|vbox|vethernet|hyper-v|loopback|npcap|tap-|vpn|tailscale|wireguard|bluetooth|teredo|isatap/i.test(s);
}

export function classify(description = '', alias = '') {
  if (isVirtualOrExcluded(description, alias)) return 'virtual';
  const s = `${description} ${alias}`;
  if (/remote ndis|rndis|usb|tether|android/i.test(s)) return 'usb';
  if (/wi-?fi|wireless|wlan|802\.11/i.test(s)) return 'wifi';
  return 'other';
}

/** Assigns stable ids: 'wifi', 'usb', 'other'. Strictly excludes VMware and virtual adapters. */
export function toAdapters(rows) {
  const seen = {};
  const out = [];
  for (const r of rows) {
    if (isVirtualOrExcluded(r.description, r.alias)) continue;
    const kind = classify(r.description, r.alias);
    seen[kind] = (seen[kind] || 0) + 1;
    out.push({
      id: seen[kind] > 1 ? `${kind}${r.index}` : kind,
      kind,
      eligible: kind === 'wifi' || kind === 'usb',
      alias: r.alias,
      index: r.index,
      description: r.description,
      ip: r.ip,
      prefix: r.prefix,
      gateway: r.gateway,
      metric: r.metric,
      autoMetric: r.autoMetric
    });
  }
  return out;
}

export async function discoverWindows() {
  const txt = await runPs(SCRIPT);
  const rows = JSON.parse(txt || '[]');
  return toAdapters(Array.isArray(rows) ? rows : [rows]);
}
