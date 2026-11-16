// "Packet anatomy" for the Wireshark practical: the DNS probe NetSwitch really sends, byte by byte,
// wrapped in the IPv4/UDP/Ethernet structure it travels in. Header values come from the live adapter where known.
import { buildQuery } from '../probes/dnsPacket.js';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

export function describeDnsProbe({ srcIp = '10.97.128.167', dstIp = '1.1.1.1', id = 0x1a2b } = {}) {
  const dns = buildQuery(id, 'example.com');
  const labels = [{ name: 'Transaction ID', bytes: dns.subarray(0, 2), meaning: `matches the reply to this probe (0x${id.toString(16)})` },
    { name: 'Flags', bytes: dns.subarray(2, 4), meaning: '0x0100 = standard query, recursion desired' },
    { name: 'QDCOUNT', bytes: dns.subarray(4, 6), meaning: '1 question' },
    { name: 'ANCOUNT / NSCOUNT / ARCOUNT', bytes: dns.subarray(6, 12), meaning: '0 answers, 0 authority, 0 additional' },
    { name: 'QNAME', bytes: dns.subarray(12, dns.length - 4), meaning: '"example.com" as length-prefixed labels: 07 example 03 com 00' },
    { name: 'QTYPE', bytes: dns.subarray(dns.length - 4, dns.length - 2), meaning: '0x0001 = A record' },
    { name: 'QCLASS', bytes: dns.subarray(dns.length - 2), meaning: '0x0001 = IN (Internet)' }];
  const udpLen = 8 + dns.length; const ipLen = 20 + udpLen;
  return {
    layers: [
      { layer: 'Link: Ethernet II (IEEE 802.3 framing)', size: 14, fields: [['Destination MAC', '6 B', 'next hop = the gateway, found with ARP'], ['Source MAC', '6 B', 'this adapter'], ['EtherType', '2 B', '0x0800 = IPv4']] },
      { layer: 'Network: IPv4', size: 20, fields: [['Version / IHL', '1 B', '4 / 5 words'], ['Total length', '2 B', `${ipLen}`], ['TTL', '1 B', 'set by the OS (Windows default 128)'], ['Protocol', '1 B', '17 = UDP'], ['Header checksum', '2 B', 'computed by the OS'], ['Source address', '4 B', srcIp], ['Destination address', '4 B', dstIp]] },
      { layer: 'Transport: UDP', size: 8, fields: [['Source port', '2 B', 'ephemeral, chosen by the OS'], ['Destination port', '2 B', '53 (DNS)'], ['Length', '2 B', `${udpLen}`], ['Checksum', '2 B', 'computed by the OS']] },
      { layer: 'Application: DNS query', size: dns.length, fields: labels.map((l) => [l.name, `${l.bytes.length} B`, `${hex(l.bytes)}  : ${l.meaning}`]) },
    ],
    dnsHex: hex(dns), totalFrameBytes: 14 + ipLen,
    wiresharkFilter: `udp.port == 53 && ip.dst == ${dstIp}`,
    note: 'Layers 2 to 4 values marked "OS" are filled in by the network stack, so they differ per packet. Compare this table with your own Wireshark capture.',
  };
}
