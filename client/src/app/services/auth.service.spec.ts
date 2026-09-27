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
