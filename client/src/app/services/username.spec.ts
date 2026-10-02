import { parseUsernameInput } from './username';

describe('parseUsernameInput', () => {
  it('accepts a single #key after an ASCII name, with independent limits', () => {
    expect(parseUsernameInput('Alice123#test key')).toEqual({ username: 'Alice123', tripcodeKey: 'test key' });
    expect(parseUsernameInput('a'.repeat(24) + '#' + 'k'.repeat(128))).not.toBeNull();
    for (const name of ['', 'a'.repeat(25), 'Name#' + 'k'.repeat(129), 'Name#', 'Name#one#two', 'A B', 'Álice', 'Name!CODE']) {
      expect(parseUsernameInput(name)).withContext(name).toBeNull();
    }
  });

  it('counts Unicode code points and preserves the whole key at its boundary', () => {
    const name = 'A'.repeat(24);
    for (const key of ['😀'.repeat(128), 'a😀'.repeat(64)]) {
      expect(parseUsernameInput(`${name}#${key}`)).toEqual({ username: name, tripcodeKey: key });
    }
    expect(parseUsernameInput(`${name}#${'😀'.repeat(129)}`)).toBeNull();
  });
});
