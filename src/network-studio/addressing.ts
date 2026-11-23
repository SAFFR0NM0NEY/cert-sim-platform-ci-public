export function ipv4(value: string): number | null {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.some((p) => p > 255)
    ? null
    : parts.reduce((n, p) => n * 256 + p, 0) >>> 0;
}
export function mask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
export function ipString(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}
export function prefixFromMask(value: string): number | null {
  const n = ipv4(value);
  if (n === null) return null;
  for (let p = 0; p <= 32; p++) if (mask(p) === n) return p;
  return null;
}
export function sameSubnet(a: string, b: string, prefix: number): boolean {
  const ai = ipv4(a),
    bi = ipv4(b);
  return (
    ai !== null &&
    bi !== null &&
    (ai & mask(prefix)) >>> 0 === (bi & mask(prefix)) >>> 0
  );
}
export function usableIp(ip: string, prefix: number): boolean {
  const n = ipv4(ip);
  if (
    n === null ||
    !Number.isInteger(prefix) ||
    prefix < 1 ||
    prefix > 32 ||
    n === 0 ||
    n >>> 24 >= 224 ||
    n >>> 24 === 127
  )
    return false;
  if (prefix >= 31) return true;
  const host = (n & ~mask(prefix)) >>> 0;
  return host !== 0 && host !== ~mask(prefix) >>> 0;
}
