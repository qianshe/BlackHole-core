import { BlockList, isIP } from 'node:net';
import type { NetworkScope } from '../../packages/contracts/dist/connections.js';

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
const restricted = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) restricted.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) restricted.addSubnet(address, prefix, 'ipv6');

/**
 * A publishing declaration, NOT a reachability test. A hostname can use split
 * DNS regardless of its suffix; unknown hosts therefore remain private unless
 * the operator explicitly publishes the entry. RFC 4193 ULA / RFC 4291 link-local
 * and IPv4-mapped local addresses can never be promoted by that declaration.
 */
export function networkScope(hostname: string, declared: 'private' | 'public' = 'private'): NetworkScope {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const version = isIP(host);
  if (version) {
    const type = version === 4 ? 'ipv4' : 'ipv6';
    if (loopback.check(host, type)) return 'loopback';
    if (restricted.check(host, type)) return 'private';
    return declared;
  }
  if (!host.includes('.') || ['.local', '.lan', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix))) return 'private';
  return declared;
}
