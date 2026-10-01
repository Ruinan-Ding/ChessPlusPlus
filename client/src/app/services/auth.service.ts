import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { readStore, removeStore, writeStore } from './storage';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private usernameSubject = new BehaviorSubject<string>('');
  public username$ = this.usernameSubject.asObservable();
  
  /**
   * **A tab's name is its own.** Session storage holds the name this tab is
   * playing under and carries it past a reload; local storage, shared by every
   * tab, only remembers the last name the player chose, as where a new tab
   * starts. One shared name was overwritten by any second tab - which is
   * handed a guest name, the first tab holding the real one - so the first
   * tab's next reload rejoined its room as the guest, was refused the seat,
   * and forfeited. Pinned to the tab on the first read for the same reason.
   */
  constructor() {
    const storedUsername = readStore('session', 'username') || readStore('local', 'username');
    if (storedUsername) {
      writeStore('session', 'username', storedUsername);
      this.usernameSubject.next(storedUsername);
    }
  }

  /** `remember` false keeps the name to this tab: a guest name the server
   * handed out because the one asked for was taken is not the player's
   * choice, and must not become every new tab's starting name. */
  setUsername(username: string, remember = true): void {
    writeStore('session', 'username', username);
    if (remember) writeStore('local', 'username', username);
    this.usernameSubject.next(username);
  }
  
  getUsername(): string {
    return this.usernameSubject.value;
  }

  /**
   * This page's identity secret, once it has one. **Kept here, not only in
   * storage**: with site data blocked the write fails quietly, and a secret
   * read back from storage alone came out new on every call - so a reconnect
   * could no longer prove the name the same page had claimed a minute before.
   * Storage is what carries it past a reload; this is what carries it
   * through one page.
   */
  private identitySecret: string | null = null;

  // ponytail: anonymous per-browser secret, not a real credential. Swap this
  // for real session/JWT storage if real accounts are added later.
  getIdentitySecret(): string {
    if (this.identitySecret) return this.identitySecret;
    let secret = readStore('local', 'identitySecret');
    if (!secret) {
      // crypto.getRandomValues works in insecure contexts (e.g. a plain-HTTP
      // LAN address for local play); crypto.randomUUID() does not.
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      secret = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      writeStore('local', 'identitySecret', secret);
    }
    this.identitySecret = secret;
    return secret;
  }

  isLoggedIn(): boolean {
    return !!this.usernameSubject.value;
  }
  
  logout(): void {
    removeStore('session', 'username');
    removeStore('local', 'username');
    this.usernameSubject.next('');
  }
}