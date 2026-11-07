// Minimal hand-built DNS query/response handling for UDP probes (RFC 1035). No library on purpose:
// this is a visible, explainable use of UDP sockets for the CN syllabus.
export function buildQuery(id, name = 'example.com') {
  const labels = name.split('.');
  const parts = [Buffer.from([id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])]; // header: RD=1, QDCOUNT=1
  for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
  parts.push(Buffer.from([0, 0, 1, 0, 1])); // root, QTYPE=A, QCLASS=IN
  return Buffer.concat(parts);
}

/** Returns { id, isResponse, rcode } or null for garbage. NXDOMAIN etc. still prove the path works. */
export function parseResponse(buf) {
  if (!buf || buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  return { id: buf.readUInt16BE(0), isResponse: (flags & 0x8000) !== 0, rcode: flags & 0x000f };
}
