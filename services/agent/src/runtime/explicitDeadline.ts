/** Optional caller-owned deadline; ordinary runs do not schedule a timer. */
export function scheduleExplicitDeadline(milliseconds: number | undefined, expire: () => void): () => void {
  if (milliseconds === undefined) return () => undefined;
  const deadline = Date.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { expire(); return; }
    // Node overflows larger delays to 1 ms. Split long, explicit deadlines
    // without imposing a product maximum or silently expiring them early.
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  arm();
  return () => clearTimeout(timer);
}
