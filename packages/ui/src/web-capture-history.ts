/** Retry only read-only waveform requests when another job holds the account's worker. */
export async function readCaptureHistory<T>(read: () => Promise<T>, {
  wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  active = () => true,
}: { wait?: (milliseconds: number) => Promise<void>; active?: () => boolean } = {}): Promise<T> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (cause) {
      if (!cause || typeof cause !== "object" || !("status" in cause) || cause.status !== 429 ||
          attempt >= delays.length || !active()) throw cause;
      await wait(delays[attempt]);
      // A tab/record change must not start another read after its wait finishes.
      if (!active()) throw cause;
    }
  }
}
