import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { ConnectionDialogComponent } from './connection-dialog.component';
import { WebsocketService } from '../../services/websocket.service';

describe('ConnectionDialogComponent controls', () => {
  let fixture: ComponentFixture<ConnectionDialogComponent>;
  let reconnecting: BehaviorSubject<boolean>;
  let attempts: BehaviorSubject<number>;
  let failed: BehaviorSubject<boolean>;
  let transport: jasmine.SpyObj<WebsocketService>;
  let navigate: jasmine.Spy;

  beforeEach(() => {
    reconnecting = new BehaviorSubject(false);
    attempts = new BehaviorSubject(0);
    failed = new BehaviorSubject(false);
    transport = jasmine.createSpyObj('WebsocketService', ['reconnectToServer', 'playOffline'], {
      reconnecting$: reconnecting.asObservable(), reconnectAttempts$: attempts.asObservable(),
      connectionFailed$: failed.asObservable(),
    });
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    TestBed.configureTestingModule({ imports: [ConnectionDialogComponent], providers: [
      { provide: WebsocketService, useValue: transport }, { provide: Router, useValue: { navigate } },
    ] });
    fixture = TestBed.createComponent(ConnectionDialogComponent);
    fixture.detectChanges();
  });

  const click = (selector: string) => {
    const button = fixture.nativeElement.querySelector(selector) as HTMLButtonElement;
    expect(button).toBeTruthy(); button.click(); fixture.detectChanges();
  };

  it('offers offline play on the first attempt and dismisses when the transport stops reconnecting', () => {
    expect(fixture.nativeElement.querySelector('.connection-dialog-overlay')).toBeNull();
    reconnecting.next(true); attempts.next(1); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Attempt 1 of 5');
    transport.playOffline.and.callFake(() => { reconnecting.next(false); failed.next(false); });
    click('.offline-button');
    expect(transport.playOffline).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('.connection-dialog-overlay')).toBeNull();
  });

  it('retries from the failed screen and releases every subscription on destruction', () => {
    failed.next(true); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Connection Failed');
    click('.retry-button');
    expect(transport.reconnectToServer).toHaveBeenCalledTimes(1);
    const component = fixture.componentInstance;
    fixture.destroy();
    reconnecting.next(true); attempts.next(4); failed.next(false);
    expect(component.isReconnecting).toBeFalse();
    expect(component.attemptCount).toBe(0);
    expect(component.connectionFailed).toBeTrue();
  });

  it('returns to login through the rendered failed-screen button', () => {
    failed.next(true); fixture.detectChanges(); click('.login-button');
    expect(navigate).toHaveBeenCalledOnceWith(['/']);
  });
});
