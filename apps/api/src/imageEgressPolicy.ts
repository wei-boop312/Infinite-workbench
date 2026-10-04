import { isIP } from "node:net";

export class ImageEgressContractError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ImageEgressContractError"; }
}
export function rejectImageEgress(code: string): never { throw new ImageEgressContractError(code); }
export const isImageEgressDomain = (host: string) => typeof host === "string" && host.length <= 253 && host === host.toLowerCase() && host.includes(".") && !isIP(host)
  && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  && !/\.(?:localhost|local|internal|home|lan|arpa)$/.test(host);
export function parseImageEgressEndpoint(input: string) {
  if (typeof input !== "string" || input.length > 2048 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9/_:.-]*$/.test(input)) rejectImageEgress("image_egress_url_invalid");
  let url: URL; try { url = new URL(input); } catch { return rejectImageEgress("image_egress_url_invalid"); }
  const rawPath = input.slice(input.indexOf("/", 8));
  if (!isImageEgressDomain(url.hostname) || url.username || url.password || url.search || url.hash || rawPath !== url.pathname
    || rawPath.includes("//") || rawPath.split("/").some(part => part === "." || part === "..")) rejectImageEgress("image_egress_url_invalid");
  return { hostname: url.hostname, port: Number(url.port || 443), path: url.pathname };
}
function v4(address: string) { return address.split(".").reduce((value, octet) => (value << 8n) + BigInt(octet), 0n); }
function v6(address: string) {
  const halves = address.split("::"), left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}
function inPrefix(value: bigint, base: bigint, prefix: number, bits: number) { return value >> BigInt(bits - prefix) === base >> BigInt(bits - prefix); }
// Conservative public-address profile, not proof of routes/firewalls. All special
// IPv4 blocks (including protocol exceptions) and IPv6 transition ranges denied.
const deniedV4 = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["168.63.129.16", 32]]
  .map(([base, prefix]) => [v4(base as string), prefix as number] as const);
const deniedV6 = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20]]
  .map(([base, prefix]) => [v6(base as string), prefix as number] as const);
export function isAllowedImageEgressAddress(address: string, family: 4 | 6): boolean {
  if (typeof address !== "string" || isIP(address) !== family || address.includes("%")) return false;
  if (family === 4) return !deniedV4.some(([base, prefix]) => inPrefix(v4(address), base, prefix, 32));
  if (address.includes(".")) return false;
  const value = v6(address);
  return inPrefix(value, v6("2000::"), 3, 128) && !deniedV6.some(([base, prefix]) => inPrefix(value, base, prefix, 128));
}
export function canonicalImageEgressAddress(address: string) {
  if (!isIP(address) || address.includes("%") || isIP(address) === 6 && address.includes(".")) rejectImageEgress("image_egress_configuration_invalid");
  return isIP(address) === 4 ? `v4:${v4(address)}` : `v6:${v6(address)}`;
}
