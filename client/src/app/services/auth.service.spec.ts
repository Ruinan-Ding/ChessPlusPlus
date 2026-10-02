import { AuthService } from './auth.service';

/**
 * The identity secret is what lets a player take their own name back - on a
 * rejoin, and on a reconnect in the middle of a match. It has to stay the same
 * for the life of the page whatever the browser lets it store.
 */
describe('AuthService identity secret', () => {
  afterEach(() => localStorage.removeItem('identitySecret'));

  it('keeps one secret for the page when the browser refuses to store it', () => {
    // Site data blocked: every read comes back empty, every write is refused.
    // The secret was read back from storage alone, so each call made a new one
    // and a reconnect could not prove the name the page had just claimed.
    spyOn(Storage.prototype, 'getItem').and.throwError('denied');
    spyOn(Storage.prototype, 'setItem').and.throwError('denied');
    const auth = new AuthService();
    const first = auth.getIdentitySecret();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.getIdentitySecret()).toBe(first);
  });

  describe('the name', () => {
    const clear = () => {
      localStorage.removeItem('username');
      sessionStorage.removeItem('username');
    };
    beforeEach(clear);
    afterEach(clear);

    it("keeps a tab its own name, whatever another tab does", () => {
      // One shared name was overwritten by a second tab's guest name, and the
      // first tab's next reload rejoined its room as the guest and lost it.
      localStorage.setItem('username', 'alice');
      expect(new AuthService().getUsername()).toBe('alice');
      const firstTab = sessionStorage.getItem('username');
      expect(firstTab).toBe('alice');   // pinned to the tab on the first read

      // Another tab: a session of its own, the same local storage.
      sessionStorage.removeItem('username');
      const second = new AuthService();
      second.setUsername('Guest123456', false);   // handed a guest name
      expect(localStorage.getItem('username')).toBe('alice');
      second.setUsername('bob');                   // then chose one
      expect(localStorage.getItem('username')).toBe('bob');

      // The first tab reloads: its session, and its name, come back.
      sessionStorage.setItem('username', firstTab!);
      expect(new AuthService().getUsername()).toBe('alice');
    });
  });

  it('keeps the stored secret, and stores a new one where it can', () => {
    localStorage.setItem('identitySecret', 'stored-secret');
    expect(new AuthService().getIdentitySecret()).toBe('stored-secret');

    localStorage.removeItem('identitySecret');
    const made = new AuthService().getIdentitySecret();
    // A later page - a reload - reads the same one back.
    expect(localStorage.getItem('identitySecret')).toBe(made);
    expect(new AuthService().getIdentitySecret()).toBe(made);
  });
});

describe('AuthService tripcode credentials', () => {
  const clear = () => {
    for (const store of [localStorage, sessionStorage]) {
      store.removeItem('username');
      store.removeItem('tripcodeToken');
    }
  };
  beforeEach(clear);
  afterEach(clear);

  it('holds the key in memory and replaces it with the server proof', () => {
    const auth = new AuthService();
    auth.setUsername('Alice', true, '');
    auth.setTripcodeKey('test key');
    expect(auth.getTripcodeCredentials()).toEqual({ tripcodeKey: 'test key' });
    expect(sessionStorage.getItem('tripcodeKey')).toBeNull();
    expect(localStorage.getItem('tripcodeKey')).toBeNull();
    auth.setUsername('Alice!ABCDEFGHIJK2', true, 'private-proof');
    expect(auth.getTripcodeCredentials()).toEqual({ tripcodeToken: 'private-proof' });
    expect(new AuthService().getTripcodeCredentials()).toEqual({ tripcodeToken: 'private-proof' });
  });

  it('keeps a guest tab separate from the chosen name and proof', () => {
    const auth = new AuthService();
    auth.setUsername('Alice!ABCDEFGHIJK2', true, 'private-proof');
    auth.setUsername('Guest123456', false, '');
    expect(new AuthService().getTripcodeCredentials()).toEqual({});
    expect(localStorage.getItem('tripcodeToken')).toBe('private-proof');
    sessionStorage.removeItem('username');
    expect(new AuthService().getTripcodeCredentials()).toEqual({ tripcodeToken: 'private-proof' });
  });

  it('keeps acknowledged credentials in memory when storage is blocked and clears them on logout', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('denied');
    spyOn(Storage.prototype, 'setItem').and.throwError('denied');
    const auth = new AuthService();
    auth.setTripcodeKey('test key');
    auth.setUsername('Alice!ABCDEFGHIJK2', true, 'private-proof');
    expect(auth.getTripcodeCredentials()).toEqual({ tripcodeToken: 'private-proof' });
    auth.logout();
    expect(auth.getTripcodeCredentials()).toEqual({});
    expect(auth.getUsername()).toBe('');
  });
});
