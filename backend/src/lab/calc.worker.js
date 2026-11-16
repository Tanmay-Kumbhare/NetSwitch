// Runs on a separate OS thread (worker_threads). CPU-bound work lives here so the event loop is never blocked.
import { parentPort, threadId } from 'node:worker_threads';

const rad = (deg) => (deg * Math.PI) / 180;
function countPrimes(n) { // sieve of Eratosthenes
  const sieve = new Uint8Array(n + 1); let c = 0;
  for (let i = 2; i <= n; i++) { if (!sieve[i]) { c++; for (let j = i * i; j <= n; j += i) sieve[j] = 1; } }
  return c;
}
export function compute(op, arg) {
  switch (op) {
    case 'sin': return Math.sin(rad(arg));
    case 'cos': return Math.cos(rad(arg));
    case 'tan': if (Math.abs(Math.cos(rad(arg))) < 1e-12) throw new Error('tan undefined'); return Math.tan(rad(arg));
    case 'sqrt': if (arg < 0) throw new Error('sqrt of negative'); return Math.sqrt(arg);
    case 'log': if (arg <= 0) throw new Error('log needs a positive argument'); return Math.log10(arg);
    case 'primes': if (!Number.isInteger(arg) || arg < 2 || arg > 20_000_000) throw new Error('primes needs 2..20000000'); return countPrimes(arg);
    default: throw new Error(`unknown op ${op}`);
  }
}
parentPort?.on('message', ({ op, arg }) => {
  const t0 = process.hrtime.bigint();
  try { parentPort.postMessage({ ok: true, value: compute(op, arg), threadId, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); }
  catch (e) { parentPort.postMessage({ ok: false, error: e.message, threadId }); }
});
