import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { readStore, removeStore, writeStore } from './storage';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly usernameSubject = new BehaviorSubject<string>('');
  readonly username$ = this.usernameSubject.asObservable();
  private tripcodeKey = '';
  private tripcodeToken = '';
  
  // Cache the secret when browser storage is unavailable.
  private identitySecret: string | null = null;

  // Session storage owns this tab's identity; local storage seeds new tabs.
  constructor() {
    const tabName = readStore('session', 'username');
    const storedUsername = tabName || readStore('local', 'username');
    this.tripcodeToken = readStore(tabName ? 'session' : 'local', 'tripcodeToken') || '';
    if (storedUsername) {
      writeStore('session', 'username', storedUsername);
      writeStore('session', 'tripcodeToken', this.tripcodeToken);
      this.usernameSubject.next(storedUsername);
    }
  }

  /** Guest names stay in this tab; chosen names also seed new tabs. */
  setUsername(username: string, remember = true, tripcodeToken?: string): void {
    if (tripcodeToken !== undefined) {
      this.tripcodeToken = tripcodeToken;
      this.tripcodeKey = '';
    }
    writeStore('session', 'username', username);
    writeStore('session', 'tripcodeToken', this.tripcodeToken);
    if (remember) {
      writeStore('local', 'username', username);
      writeStore('local', 'tripcodeToken', this.tripcodeToken);
    }
    this.usernameSubject.next(username);
  }
  
  getUsername(): string {
    return this.usernameSubject.value;
  }

  getBaseUsername(): string {
    return this.getUsername().replace(/![A-Z2-7]{12}$/, '');
  }

  hasTripcode(): boolean {
    return !!this.tripcodeToken;
  }

  /** The entered key lives only in memory until the server acknowledges it. */
  setTripcodeKey(key: string): void {
    this.tripcodeKey = key;
  }

  getTripcodeCredentials(): { tripcodeKey?: string; tripcodeToken?: string } {
    if (this.tripcodeKey) return { tripcodeKey: this.tripcodeKey };
    return this.tripcodeToken ? { tripcodeToken: this.tripcodeToken } : {};
  }

  // ponytail: anonymous browser identity; replace with session authentication
  // if accounts are introduced.
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
    removeStore('session', 'tripcodeToken');
    removeStore('local', 'tripcodeToken');
    this.tripcodeKey = '';
    this.tripcodeToken = '';
    this.usernameSubject.next('');
  }
}
