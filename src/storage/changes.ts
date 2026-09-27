/**
 * Coarse change detector for polling UIs (the extension sidebar). Any
 * session-scoped write bumps a monotonic epoch; the UI asks for the current
 * epoch once per tick and only fetches details when it moved.
 *
 * The epoch is seeded from the boot wall clock and incremented per change, so
 * it stays strictly greater than every epoch a previous daemon process ever
 * reported — a restart itself reads as "everything changed", which is exactly
 * what the UI should do after a restart.
 */
export class ChangeTracker {
  private base = Date.now();
  private n = 0;

  bump(): void {
    this.n += 1;
  }

  epoch(): number {
    return this.base + this.n;
  }
}
