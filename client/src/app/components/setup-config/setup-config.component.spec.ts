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
        catch { return { valid: false, errors: ['Invalid JSON syntax'] }; }
      },
    } as any;
    const ws = { messages$: new Subject(), sendMessage: () => {} } as any;
    const navigation = { setIntentionalNavigation: (to: string) => intents.push(to) } as any;
    const c = new SetupConfigComponent(router, configService, ws, navigation);
    c.ngOnInit();
    return c;
  };

  beforeEach(() => {
    writeStore('local', 'returnToGameRoom', 'room-1');
    writeStore('local', 'gameRoomToken', 'tok-1');
    spyOn(window, 'confirm').and.returnValue(true);
    spyOn(window, 'alert');
  });

  afterEach(() => {
    removeStore('local', 'returnToGameRoom');
    removeStore('local', 'gameRoomToken');
  });

  it('keeps the way back to the room through a save that fails, and takes it once one works', () => {
    const c = editor();
    c.jsonConfig = '{ not json';
    c.onBack();
    // Refused: still here, and still knows which room it came from. This used
    // to clear both before asking, so the next Back went to the lobby.
    expect(navigated).toEqual([]);
    expect(intents).toEqual([]);
    expect(readStore('local', 'returnToGameRoom')).toBe('room-1');
    expect(readStore('local', 'gameRoomToken')).toBe('tok-1');

    c.jsonConfig = '{ "fixed": true }';
    c.onBack();
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
    expect(intents).toEqual(['game-room']);
    expect(readStore('local', 'returnToGameRoom')).toBeNull();
  });

  it('goes back to the room without saving when told not to', () => {
    (window.confirm as jasmine.Spy).and.returnValue(false);
    const c = editor();
    c.jsonConfig = '{ not json';
    c.onBack();
    expect(navigated).toEqual([[['/game-room', 'room-1'], { queryParams: { token: 'tok-1' } }]]);
  });
});
