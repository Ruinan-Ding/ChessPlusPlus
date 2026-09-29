import { Subject } from 'rxjs';
import { SetupConfigComponent } from './setup-config.component';
import { readStore, removeStore, writeStore } from '../../services/storage';

/**
 * Back out of the editor, and where it goes. Opened from a game room it has to
 * go back there - and a save the validator refuses must not cost it the way.
 */
describe('SetupConfigComponent', () => {
  let navigated: any[][];
  let intents: string[];
  let socket: Subject<any>;
  let marked: jasmine.Spy;

  const editor = () => {
    navigated = [];
    intents = [];
    const router = { navigate: (...args: any[]) => navigated.push(args) } as any;
    // Valid exactly when it parses: this is about Back, not about the rules.
    const configService = {
      getDefaultConfig: () => '{}',
      config$: new Subject(),
      updateConfig: (json: string) => {
        try { JSON.parse(json); return { valid: true }; }
        catch { return { valid: false, errors: ['Invalid JSON syntax', 'units: required'] }; }
      },
    } as any;
    socket = new Subject();
    const ws = { messages$: socket, sendMessage: () => {} } as any;
    const navigation = { setIntentionalNavigation: (to: string) => intents.push(to) } as any;
    marked = jasmine.createSpy('markForCheck');
    const c = new SetupConfigComponent(router, configService, ws, navigation, { markForCheck: marked } as any);
    c.ngOnInit();
    return c;
  };

  beforeEach(() => {
    writeStore('local', 'returnToGameRoom', 'room-1');
    writeStore('local', 'gameRoomToken', 'tok-1');
    // Neither is used any more; a call to one fails the spec.
    spyOn(window, 'confirm').and.throwError('confirm() called');
    spyOn(window, 'alert').and.throwError('alert() called');
  });

  afterEach(() => {
    removeStore('local', 'returnToGameRoom');
    removeStore('local', 'gameRoomToken');
  });

  it('asks before leaving changes unsaved, and Stay loses nothing', () => {
    const c = editor();
    expect(c.backLabel).toBe('Back to Room');
    c.jsonConfig = '{ "edited": true }';
    c.onBack();
    expect(c.leaving).toBeTrue();
    expect(navigated).toEqual([]);
    c.leaveChoice('stay');
    expect(c.leaving).toBeFalse();
    expect(navigated).toEqual([]);
    expect(c.jsonConfig).toBe('{ "edited": true }');
    // Escape is Stay too.
    c.onBack();
    c.onEscape();
    expect(c.leaving).toBeFalse();
    expect(navigated).toEqual([]);
  });

  it('keeps the way back to the room through a save that fails, and takes it once one works', () => {
    const c = editor();
    c.jsonConfig = '{ not json';
    c.onBack();
    c.leaveChoice('save');
    // Refused: still here, its errors over the editor, and still knows which
    // room it came from. This used to clear both before asking, so the next
    // Back went to the lobby.
    expect(navigated).toEqual([]);
    expect(c.errors).toEqual(['Invalid JSON syntax', 'units: required']);
    expect(intents).toEqual([]);
    expect(readStore('local', 'returnToGameRoom')).toBe('room-1');
    expect(readStore('local', 'gameRoomToken')).toBe('tok-1');

    c.jsonConfig = '{ "fixed": true }';
    c.onBack();
    c.leaveChoice('save');
    expect(c.errors).toEqual([]);
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
    expect(intents).toEqual(['game-room']);
    expect(readStore('local', 'returnToGameRoom')).toBeNull();
  });

  it('goes back to the room without saving when told to discard', () => {
    const c = editor();
    c.jsonConfig = '{ not json';
    c.onBack();
    c.leaveChoice('discard');
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
  });

  it('draws the server\'s answer to a save when it comes', () => {
    // The screen is OnPush: an answer on the socket was taken and never
    // drawn, so a configuration the server refused looked saved.
    const c = editor();
    socket.next({ type: 'error', code: 'INVALID_CONFIG', message: 'units.king.move must be at most 20' });
    expect(c.errors).toEqual(['units.king.move must be at most 20']);
    expect(marked).toHaveBeenCalled();
    marked.calls.reset();
    socket.next({ type: 'custom_config_saved' });
    expect(c.errors).toEqual([]);
    expect(c.savedSuccessfully).toBeTrue();
    expect(marked).toHaveBeenCalled();
  });

  it('says what is wrong with JSON that will not format, over the editor', () => {
    const c = editor();
    c.jsonConfig = '{ not json';
    c.formatJson();
    expect(c.errors.length).toBe(1);
    expect(c.errors[0]).toMatch(/^Invalid JSON: /);
    // Fixed and formatted: gone.
    c.jsonConfig = '{"a":1}';
    c.formatJson();
    expect(c.errors).toEqual([]);
    expect(c.jsonConfig).toBe('{\n  "a": 1\n}');
  });

  it('goes back to the lobby, and says so, when not opened from a room', () => {
    removeStore('local', 'returnToGameRoom');
    const c = editor();
    expect(c.backLabel).toBe('Back to Lobby');
    c.onBack();
    expect(navigated).toEqual([[['/lobby'], { queryParams: {} }]]);
  });
});
