/**
 * Whether this process has been told to stop.
 *
 * Read by `/api/ready`, so a load balancer stops sending new requests to an
 * instance that is draining before its listener closes, rather than learning
 * about it from refused connections.
 */
let draining = false;

export function markDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}
