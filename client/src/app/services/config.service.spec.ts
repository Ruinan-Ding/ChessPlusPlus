import { TestBed } from '@angular/core/testing';
import { ConfigService } from './config.service';

/**
 * The setup screen is the only thing standing between a pasted config and a
 * room that can never start: whatever it accepts, load_config() has to accept
 * too. These pin the checks that used to differ, so a config saved here is one
 * the server will take.
 */
describe('ConfigService validation, against the server\'s', () => {
  let service: ConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConfigService);
  });

  /** The smallest thing both validators call valid. */
  const minimal = () => ({
    version: '1.0',
    board: { radius: 3 },
    units: {
      king: { id: 'king', name: 'K', symbol: 'K', move: 1, value: 0, hp: 20, attack: 5, defense: 0, commander: true },
    },
    abilities: {},
    setup: { white: { '0,3': 'king' }, black: { '0,-3': 'king' } },
    rules: { maxTurns: 0, turnTimeLimit: 0 },
  });

  it('takes the config both engines agree on', () => {
    expect(service.validateGameRules(minimal()).valid).toBeTrue();
  });

  it('refuses a radius that is not a whole number', () => {
    // load_config wants an int; 11.5 passed here and was rejected there, with
    // an INVALID_CONFIG the setup screen never had a chance to show.
    const config: any = minimal();
    config.board.radius = 11.5;
    expect(service.validateGameRules(config).valid).toBeFalse();
  });

  it('refuses rules that are not an object', () => {
    const config: any = minimal();
    config.rules = [];
    expect(service.validateGameRules(config).valid).toBeFalse();
  });

  it('fills in what an older config predates, as _normalise_config does', () => {
    // Saved before `defense` and `rules.objective` existed. Rejecting it would
    // make every room holding one permanently unstartable.
    const config: any = minimal();
    delete config.units.king.defense;
    delete config.rules.objective;
    expect(service.validateGameRules(config).valid).toBeTrue();
    expect(config.units.king.defense).toBe(0);
    // Commanders on both sides, so regicide is what it was played as.
    expect(config.rules.objective).toBe('regicide');
  });

  it('calls a commanderless setup elimination, not a regicide it cannot win', () => {
    const config: any = minimal();
    delete config.units.king.commander;
    delete config.rules.objective;
    expect(service.validateGameRules(config).valid).toBeTrue();
    expect(config.rules.objective).toBe('elimination');
  });
});
