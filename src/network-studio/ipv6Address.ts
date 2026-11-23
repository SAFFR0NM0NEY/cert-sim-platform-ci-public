import { ipv4 } from "./addressing.ts";
export function ipv6(input: string): bigint | null {
  if (!input || /[%\[\]\s]/.test(input)) return null;
  let value = input;
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":"),
      address = ipv4(value.slice(colon + 1));
    if (colon < 0 || address === null) return null;
    value = `${value.slice(0, colon + 1)}${(address >>> 16).toString(16)}:${(address & 65535).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [],
    right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}
export function formatIPv6(value: bigint): string {
  const parts = Array.from({ length: 8 }, (_, i) =>
    Number((value >> BigInt((7 - i) * 16)) & 65535n),
  );
  let bestStart = -1,
    bestLength = 1;
  for (let i = 0; i < 8; i++)
    if (parts[i] === 0) {
      let end = i;
      while (end < 8 && parts[end] === 0) end++;
      if (end - i > bestLength) {
        bestStart = i;
        bestLength = end - i;
      }
      i = end - 1;
    }
  if (bestStart < 0) return parts.map((p) => p.toString(16)).join(":");
  return `${parts
    .slice(0, bestStart)
    .map((p) => p.toString(16))
    .join(":")}::${parts
    .slice(bestStart + bestLength)
    .map((p) => p.toString(16))
    .join(":")}`;
}
export function mask6(prefix: number): bigint {
  return prefix === 0
    ? 0n
    : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
}
export function sameSubnet6(a: string, b: string, prefix: number): boolean {
  const av = ipv6(a),
    bv = ipv6(b);
  return (
    av !== null && bv !== null && (av & mask6(prefix)) === (bv & mask6(prefix))
  );
}
export function usableIPv6(value: string): boolean {
  const n = ipv6(value);
  return n !== null && n > 1n && n >> 120n !== 255n && n >> 32n !== 65535n;
}
export function linkLocal6(value: string): boolean {
  const n = ipv6(value);
  return n !== null && n >> 118n === 1018n;
}
