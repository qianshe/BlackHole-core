// Process-local authoritative endpoint; no VS Code runtime dependency.
let port: number | undefined;
export function managedPortValue(): number | undefined { return port; }
export function useManagedPort(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error('port_invalid');
  port = value;
}
