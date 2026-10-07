import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type NavigationContext = 'setup' | 'game-room' | 'lobby' | 'none';

/** Tracks intentional route changes so connected screens can retain their socket. */
@Injectable({
  providedIn: 'root'
})
export class NavigationStateService {
  // Track whether we're intentionally navigating between connected components
  private intentionalNavigationSubject = new BehaviorSubject<boolean>(false);
  
  // Track the current navigation context
  private navigationContextSubject = new BehaviorSubject<NavigationContext>('none');
  
  /**
   * Set intentional navigation flag before navigating to setup or game room.
   * This tells the lobby component to keep the WebSocket connection alive.
   */
  setIntentionalNavigation(context: NavigationContext): void {
    this.intentionalNavigationSubject.next(true);
    this.navigationContextSubject.next(context);
  }
  
  /**
   * Clear the intentional navigation flag after the navigation is complete.
   * Should be called in ngOnInit of the target component.
   */
  clearIntentionalNavigation(): void {
    this.intentionalNavigationSubject.next(false);
  }
  
  isIntentionalNavigation(): boolean {
    return this.intentionalNavigationSubject.value;
  }
  
  getNavigationContext(): NavigationContext {
    return this.navigationContextSubject.value;
  }
  
  /**
   * Complete cleanup - call when truly disconnecting (logout, page refresh, etc.)
   */
  reset(): void {
    this.intentionalNavigationSubject.next(false);
    this.navigationContextSubject.next('none');
  }
}
