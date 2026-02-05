import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export type NavigationContext = 'setup' | 'game-room' | 'lobby' | 'none';

/**
 * Centralized service to manage navigation state and connection flags.
 * Eliminates localStorage race conditions by using reactive state management.
 */
@Injectable({
  providedIn: 'root'
})
export class NavigationStateService {
  // Track whether we're intentionally navigating between connected components
  private intentionalNavigationSubject = new BehaviorSubject<boolean>(false);
  public readonly intentionalNavigation$: Observable<boolean> = this.intentionalNavigationSubject.asObservable();
  
  // Track the current navigation context
  private navigationContextSubject = new BehaviorSubject<NavigationContext>('none');
  public readonly navigationContext$: Observable<NavigationContext> = this.navigationContextSubject.asObservable();
  
  constructor() {}
  
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
  
  /**
   * Reset navigation context back to none.
   */
  resetNavigationContext(): void {
    this.navigationContextSubject.next('none');
  }
  
  /**
   * Check if we're currently in an intentional navigation.
   */
  isIntentionalNavigation(): boolean {
    return this.intentionalNavigationSubject.value;
  }
  
  /**
   * Get the current navigation context.
   */
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
