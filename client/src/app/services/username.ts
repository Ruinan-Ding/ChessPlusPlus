export const USERNAME_INPUT_ERROR =
  'Use 1–24 letters or numbers, optionally followed by one # and a key of up to 128 characters.';

/** The server atomically claims this candidate or assigns another free guest name. */
export function randomUsername(taken: readonly string[] = []): string {
  const occupied = new Set(taken.map(name => name.toLowerCase()));
  let name: string;
  do {
    const parts = crypto.getRandomValues(new Uint32Array(2));
    name = 'Player' + Array.from(parts, part => part.toString(16).padStart(8, '0')).join('');
  } while (occupied.has(name.toLowerCase()));
  return name;
}

export function parseUsernameInput(value: string): { username: string; tripcodeKey: string } | null {
  // /u counts Unicode code points, including emoji, rather than UTF-16 units.
  const match = /^([A-Za-z0-9]{1,24})(?:#([^#]{1,128}))?$/u.exec(value.trim());
  return match ? { username: match[1], tripcodeKey: match[2] ?? '' } : null;
}
