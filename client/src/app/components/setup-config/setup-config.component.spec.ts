import { Subject } from 'rxjs';
import { ConfigService, DEFAULT_GAME_CONFIG } from '../../services/config.service';
import { SAVE_ANSWER_MS, SetupConfigComponent } from './setup-config.component';
import { readStore, removeStore, writeStore } from '../../services/storage';

/**
 * Back out of the editor, and where it goes. Opened from a game room it has to
 * go back there - and a save the validator refuses must not cost it the way.
 */
describe('SetupConfigComponent', () => {
  let navigated: any[][];
  let intents: string[];
  let socket: Subject<any>;
  let sent: any[];
  let connected: boolean;
  let marked: jasmine.Spy;

  const editor = (service?: ConfigService) => {
    navigated = [];
    intents = [];
    const router = { navigate: (...args: any[]) => navigated.push(args) } as any;
    // Valid exactly when it parses: this is about Back, not about the rules.
    const configService = service ?? {
      getDefaultConfig: () => '{}',
      config$: new Subject(),
      updateConfig: (json: string) => {
        try { JSON.parse(json); return { valid: true }; }
        catch { return { valid: false, errors: ['Invalid JSON syntax', 'units: required'] }; }
      },
    } as any;
    socket = new Subject();
    sent = [];
    connected = true;
    const ws = { messages$: socket, sendMessage: (m: any) => sent.push(m), isConnected: () => connected } as any;
    const navigation = { setIntentionalNavigation: (to: string) => intents.push(to) } as any;
    marked = jasmine.createSpy('markForCheck');
    const auth = { getUsername: () => 'me' } as any;
    const c = new SetupConfigComponent(
      router, configService, ws, navigation, { markForCheck: marked } as any, auth);
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

  it('opens the active custom config as saved and leaves without a discard prompt', () => {
    const service = new ConfigService(), custom = structuredClone(DEFAULT_GAME_CONFIG);
    custom.units.pawn.hp = 17;
    expect(service.updateConfig(JSON.stringify(custom)).valid).toBeTrue();
    const c = editor(service);
    try {
      expect(JSON.parse(c.jsonConfig).units.pawn.hp).toBe(17);
      expect(c.savedConfig).toBe(c.jsonConfig);
      expect(c.hasUnsavedChanges).toBeFalse();
      c.onBack();
      expect(c.leaving).toBeFalse();
      expect(navigated.length).toBe(1);
      expect(sent.map(m => m.type)).not.toContain('set_custom_config');
    } finally { c.ngOnDestroy(); }
  });

  it('prompts before discarding a real edit whose old 32-bit checksum collides', () => {
    const service = new ConfigService(), config = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.pawn.name = 'Aa';
    expect(service.updateConfig(JSON.stringify(config)).valid).toBeTrue();
    const c = editor(service);
    try {
      config.units.pawn.name = 'BB';
      c.jsonConfig = JSON.stringify(config);
      expect(c.hasUnsavedChanges).toBeTrue();
      c.onBack();
      expect(c.leaving).toBeTrue();
      expect(navigated).toEqual([]);
    } finally { c.ngOnDestroy(); }
  });

  it('keeps explicitly configured __proto__ unit edits in the unsaved comparison', () => {
    const service = new ConfigService(), config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units = { ...config.units, ['__proto__']: { ...config.units.pawn, id: '__proto__' } };
    expect(service.updateConfig(JSON.stringify(config)).valid).toBeTrue();
    const c = editor(service);
    try {
      config.units['__proto__'].hp += 1;
      c.jsonConfig = JSON.stringify(config);
      expect(c.hasUnsavedChanges).toBeTrue();
      c.onBack();
      expect(c.leaving).toBeTrue();
      expect(navigated).toEqual([]);
    } finally { c.ngOnDestroy(); }
  });

  it('keeps an edited real config unsaved until the room accepts it', () => {
    const service = new ConfigService(), c = editor(service);
    try {
      const edited = JSON.parse(c.jsonConfig);
      edited.units.pawn.hp = 17;
      c.jsonConfig = JSON.stringify(edited);
      c.onBack(); c.leaveChoice('save');
      expect(c.saving).toBeTrue();
      expect(c.hasUnsavedChanges).toBeTrue();
      socket.next({ type: 'error', code: 'INVALID_CONFIG', message: 'refused' });
      expect(c.hasUnsavedChanges).toBeTrue();
      expect(navigated).toEqual([]);
    } finally { c.ngOnDestroy(); }
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
    socket.next({ type: 'custom_config_saved' });
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
    expect(intents).toEqual(['game-room']);
    expect(readStore('local', 'returnToGameRoom')).toBeNull();
  });

  it('goes back to the room once its server takes the save, and not before', () => {
    // It went the moment the save was sent: a refusal arrived to a screen
    // already gone, and the match started on the old config.
    const c = editor();
    c.jsonConfig = '{ "edited": true }';
    c.onBack();
    c.leaveChoice('save');
    expect(sent.map(m => m.type)).toEqual(['set_custom_config']);
    expect(c.saving).toBeTrue();
    expect(navigated).toEqual([]);
    expect(c.hasUnsavedChanges).toBeTrue();
    socket.next({ type: 'custom_config_saved' });
    expect(c.saving).toBeFalse();
    expect(c.hasUnsavedChanges).toBeFalse();
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
  });

  it('stays, with the server\'s reason and the changes still unsaved, when it refuses', () => {
    const c = editor();
    c.jsonConfig = '{ "edited": true }';
    c.onBack();
    c.leaveChoice('save');
    socket.next({ type: 'error', code: 'INVALID_CONFIG', message: 'units.king.move must be at most 20' });
    expect(navigated).toEqual([]);
    expect(c.saving).toBeFalse();
    expect(c.errors).toEqual(['units.king.move must be at most 20']);
    // Not saved, so Back asks again rather than leaving it behind quietly.
    expect(c.hasUnsavedChanges).toBeTrue();
    c.onBack();
    expect(c.leaving).toBeTrue();
    // Any refusal while a save waits is its answer.
    c.leaveChoice('save');
    socket.next({ type: 'error', code: 'PERMISSION_DENIED', message: 'Only the host can set the game config' });
    expect(navigated).toEqual([]);
    expect(c.errors).toEqual(['Only the host can set the game config']);
  });

  it('calls a save unsaved when the room\'s server never answers', () => {
    jasmine.clock().install();
    try {
      const c = editor();
      c.jsonConfig = '{ "edited": true }';
      c.onBack();
      c.leaveChoice('save');
      jasmine.clock().tick(SAVE_ANSWER_MS);
      expect(c.saving).toBeFalse();
      expect(c.errors).toEqual(['The server did not answer, so this may not have been saved. Try again.']);
      expect(navigated).toEqual([]);
      expect(c.hasUnsavedChanges).toBeTrue();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('refuses a save with the server away, sending nothing to go out later', () => {
    // The socket queues what it cannot send, and sent it on its return -
    // after "not saved", and after a player told so had chosen Discard.
    const c = editor();
    connected = false;
    c.jsonConfig = '{ "edited": true }';
    c.onBack();
    c.leaveChoice('save');
    expect(sent).toEqual([]);
    expect(c.saving).toBeFalse();
    expect(navigated).toEqual([]);
    expect(c.errors).toEqual(['Not connected to the server, so this was not saved. Try again once it is back.']);
    expect(c.hasUnsavedChanges).toBeTrue();
  });

  it('saves a solo room\'s config itself - no server answers for one', () => {
    // 'local' is the solo room. Its save went to the server in the lobby,
    // which has no room for it, and "Saved!" never showed.
    writeStore('local', 'returnToGameRoom', 'local');
    const c = editor();
    c.jsonConfig = '{ "edited": true }';
    c.onBack();
    c.leaveChoice('save');
    expect(sent.map(m => m.type)).not.toContain('set_custom_config');
    expect(c.savedSuccessfully).toBeTrue();
    expect(navigated.length).toBe(1);
    expect(navigated[0][0]).toEqual(['/game-room', 'local']);
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
