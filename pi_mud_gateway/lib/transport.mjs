// The caller owns connection lifecycle and event parsing. Tests inject both I/O and time.
export function sendMudCommand(transport, command) {
  transport.write(command + '\n');
}

export async function collectMudEvents(waitMs, wait, queue) {
  await wait(waitMs);
  const events = [...queue];
  queue.length = 0;
  return events;
}
