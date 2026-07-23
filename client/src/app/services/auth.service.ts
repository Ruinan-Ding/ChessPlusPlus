import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private usernameSubject = new BehaviorSubject<string>('');
  public username$ = this.usernameSubject.asObservable();
  
  constructor() { 
    const storedUsername = localStorage.getItem('username');
    if (storedUsername) {
      this.usernameSubject.next(storedUsername);
    }
  }
  
  setUsername(username: string): void {
    localStorage.setItem('username', username);
    this.usernameSubject.next(username);
  }
  
  getUsername(): string {
    return this.usernameSubject.value;
  }

  // ponytail: anonymous per-browser secret, not a real credential. Swap this
  // for real session/JWT storage if real accounts are added later.
  getIdentitySecret(): string {
    let secret = localStorage.getItem('identitySecret');
    if (!secret) {
      // crypto.getRandomValues works in insecure contexts (e.g. a plain-HTTP
      // LAN address for local play); crypto.randomUUID() does not.
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      secret = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('identitySecret', secret);
    }
    return secret;
  }

  isLoggedIn(): boolean {
    return !!this.usernameSubject.value;
  }
  
  logout(): void {
    localStorage.removeItem('username');
    this.usernameSubject.next('');
  }
}