import { TestBed } from '@angular/core/testing';
import { ConfigService, DEFAULT_GAME_CONFIG } from './config.service';

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
    // The damage floor takes the CURRENT default, not the 0 that was in force
    // when a config this old was written. Nothing here can tell such a
    // snapshot from a config authored today that simply did not mention the
    // field, and filling in 0 would hand that one the dead matchups the floor
    // exists to remove - a pawn unable to scratch a shieldman, all game.
    expect(config.rules.minStrikeDamage).toBe(1);
  });

  it('refuses a damage floor that would make a blow heal what it hit', () => {
    // Negative is not merely unbalanced: strikeDamage would return a negative
    // number and the engine subtracts it. _validate_config refuses it too, so
    // the setup screen and the server reject the same configs.
    const config: any = minimal();
    config.rules.minStrikeDamage = -1;
    expect(service.validateGameRules(config).valid).toBeFalse();

    config.rules.minStrikeDamage = 0.5;
    expect(service.validateGameRules(config).valid).toBeFalse();

    // 0 is a real setting - it is the rule the game shipped with.
    config.rules.minStrikeDamage = 0;
    expect(service.validateGameRules(config).valid).toBeTrue();
  });

  it('fills the counted rules in at their defaults, and refuses a negative one', () => {
    // They were constants before they were config: a config that predates
    // them is read at the numbers every game was played under.
    const config: any = minimal();
    expect(service.validateGameRules(config).valid).toBeTrue();
    expect(config.rules.panelMoversPerTurn).toBe(3);
    expect(config.rules.postmatchEntries).toBe(5);
    expect(config.rules.homecomingsPerSetupTurn).toBe(3);
    expect(config.rules.cpAtStart).toBe(5);
    expect(config.rules.cpPhaseOffset).toBe(5);

    for (const key of ['panelMoversPerTurn', 'postmatchEntries', 'homecomingsPerSetupTurn', 'cpAtStart', 'cpPhaseOffset']) {
      const bad: any = minimal();
      bad.rules[key] = -1;
      expect(service.validateGameRules(bad).valid).withContext(key).toBeFalse();
      bad.rules[key] = 1.5;
      expect(service.validateGameRules(bad).valid).withContext(key).toBeFalse();
      bad.rules[key] = 0;
      expect(service.validateGameRules(bad).valid).withContext(key).toBeTrue();
    }
  });

  it('still loads a config that says phaseInitEntries, at the new key\'s default', () => {
    // The postmatch's allowance was `phaseInitEntries` while the extra turn
    // opened a phase. The old key is not migrated: nothing rejects a rule key
    // it does not know, so a room snapshot saved before the rename loads, and
    // reads `postmatchEntries` at its default rather than at what it said.
    const config: any = minimal();
    config.rules.phaseInitEntries = 2;
    expect(service.validateGameRules(config).valid).toBeTrue();
    expect(config.rules.postmatchEntries).toBe(5);
  });

  it('refuses an explicit null floor, the way load_config does', () => {
    // Both normalisers only fill an ABSENT key, so an explicit null survives
    // on each side. This used to read it through `?? 0`, call it valid, and
    // hand the server a config that raised "must be an integer >= 0, got
    // None" - a room that would not start, after a setup screen that said it
    // would. Whatever this accepts, load_config has to accept too.
    const config: any = minimal();
    config.rules.minStrikeDamage = null;
    expect(service.validateGameRules(config).valid).toBeFalse();
  });

  it('calls a commanderless setup elimination, not a regicide it cannot win', () => {
    const config: any = minimal();
    delete config.units.king.commander;
    delete config.rules.objective;
    expect(service.validateGameRules(config).valid).toBeTrue();
    expect(config.rules.objective).toBe('elimination');
  });

  /**
   * The ability ids have to join up. **Only the client reads abilities**, so
   * this is the only validator that can catch a catalogue that does not: the
   * server's deliberately leaves them alone, the engine never touching them.
   * A pool or a path naming an ability that is not there reaches the room as
   * a blank slot rather than an error, which is the kind of thing a config
   * editor should be told about while they are still editing.
   */
  it('takes a catalogue whose ids all join up', () => {
    // A pair for the pool, and a path of three - each ability in one slot.
    const config: any = minimal();
    config.abilities = {
      slots: 2,
      pool: ['zap', 'zip'],
      paths: [{ id: 'way', name: 'Way', cost: 1,
                passive: 'calm', skill: 'jab', ultimate: 'end' }],
      catalogue: {
        zap: { id: 'zap', name: 'Zap', target: 'enemy', damage: 3 },
        zip: { id: 'zip', name: 'Zip', target: 'friendly', mov: 1 },
        calm: { id: 'calm', name: 'Calm', target: 'friendly', def: 1 },
        jab: { id: 'jab', name: 'Jab', target: 'enemy', damage: 2 },
        end: { id: 'end', name: 'End', target: 'universal', points: 4 },
      },
    };
    expect(service.validateGameRules(config)).toEqual({ valid: true });
  });

  it('refuses a pool or a path that names an ability the catalogue has not got', () => {
    const base: any = minimal();
    base.abilities = { pool: ['zap'], paths: [], catalogue: {} };
    expect(service.validateGameRules(base).valid).toBeFalse();

    const path: any = minimal();
    path.abilities = {
      pool: [],
      paths: [{ id: 'way', name: 'Way', cost: 1,
                passive: 'zap', skill: 'missing', ultimate: 'zap' }],
      catalogue: { zap: { id: 'zap', name: 'Zap', target: 'enemy' } },
    };
    const result = service.validateGameRules(path);
    expect(result.valid).toBeFalse();
    expect(result.errors!.some(e => e.includes('skill'))).toBeTrue();
  });

  it('refuses a catalogue entry that does not carry its own id', () => {
    // The map key and the entry's id are two statements of one fact, and the
    // room reads whichever is nearer - so they must not be able to disagree.
    const config: any = minimal();
    config.abilities = {
      pool: ['zap'], paths: [],
      catalogue: { zap: { id: 'zapp', name: 'Zap', target: 'enemy' } },
    };
    expect(service.validateGameRules(config).valid).toBeFalse();
  });

  it("refuses a unit in the other side's panels, and a commander in a panel", () => {
    expect(service.validateGameRules(structuredClone(DEFAULT_GAME_CONFIG)).valid).toBeTrue();
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.setup.black['-17,11'] = 'rook';   // white's base
    config.setup.white['-17,10'] = 'king';   // a king in a panel
    const result = service.validateGameRules(config);
    // White's setup is read first, as _validate_config reads it.
    expect(result.errors).toEqual([
      'setup.white puts its commander at -17,10, in a panel - a commander starts on the battlefield',
      "setup.black puts a unit at -17,11, in white's panels",
    ]);
  });

  it("reads a vertex-up board's panels off the pixel, as the server does", () => {
    // -14,5: below the middle on an edge-up board (r >= 0), above it on a
    // vertex-up one (q + 2r < 0) - the one place the two readings part.
    const config: any = minimal();
    config.board.radius = 11;
    config.units.pawn = { ...config.units.king, id: 'pawn', commander: false };
    config.setup = { white: { '0,11': 'king', '-14,5': 'pawn' }, black: { '0,-11': 'king' } };
    expect(service.validateGameRules(structuredClone(config)).valid).toBeTrue();
    config.board.orientation = 'vertex-up';
    expect(service.validateGameRules(config).errors)
      .toEqual(["setup.white puts a unit at -14,5, in black's panels"]);
  });

  it('refuses a misspelt unit field, and a stat left out', () => {
    // `"atack": 20` loaded, drew ATK 0 on the hex and struck for 1.
    const config: any = minimal();
    config.units.king.atack = 20;
    delete config.units.king.attack;
    expect(service.validateGameRules(config).errors).toEqual([
      'units.king.attack must be an integer >= 0',
      'units.king has unknown field "atack"',
    ]);
  });

  it("refuses a unit's own ability that is not a friendly one it can cast on itself", () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.units.pawn.ability = 'nope';
    config.units.rook.ability = 'sap';        // an enemy ability
    config.units.knight.ability = 'bastion';  // a passive
    // In the config's unit order: king, queen, rook, bishop, knight, ..., pawn.
    expect(service.validateGameRules(config).errors).toEqual([
      'units.rook.ability must be a friendly ability - it is cast on the unit itself',
      'units.knight.ability must be a friendly ability - it is cast on the unit itself',
      'units.pawn.ability names unknown ability "nope"',
    ]);
  });

  it("refuses an ability's numbers that are not whole, or out of range", () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    const cat = config.abilities.catalogue;
    cat.dash.cooldown = 1.5;
    cat.dash.turns = 0;
    cat.focus.uses = 0;
    cat.bulwark.target = 'ally';
    cat.mire.dmg = 4;
    expect(service.validateGameRules(config).errors).toEqual([
      'abilities.catalogue.dash.cooldown must be an integer >= 0',
      'abilities.catalogue.dash.turns must be an integer >= 1',
      'abilities.catalogue.focus.uses must be an integer >= 1',
      'abilities.catalogue.bulwark.target must be friendly, enemy or universal',
      'abilities.catalogue.mire has unknown field "dmg"',
    ]);
  });

  it('refuses a number an ability of its kind never reads', () => {
    // Cleave's `points` paid nobody; a universal ultimate's `atk` boosted
    // nothing. A number that does nothing is a number someone expects to.
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    const cat = config.abilities.catalogue;
    cat.cleave.points = 5;
    cat.ruin.atk = 2;
    cat.bastion.cost = 3;
    cat.dash.damage = 4;
    cat['arc-bolt'].turns = 2;
    expect(service.validateGameRules(config).errors).toEqual([
      'abilities.catalogue.dash.damage does nothing on a friendly ability',
      'abilities.catalogue.arc-bolt.turns does nothing on an ability that changes no stat',
      'abilities.catalogue.bastion.cost does nothing on a passive',
      'abilities.catalogue.cleave.points does nothing on an enemy ability',
      'abilities.catalogue.ruin.atk does nothing on a universal ability',
    ]);
  });

  it('refuses a pool that cannot be picked in pairs, and an ability in two slots', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.abilities.pool.push('anchor');     // odd, and already Bastion's skill
    config.abilities.slots = 3;
    expect(service.validateGameRules(config).errors).toEqual([
      '"abilities.pool" must hold an even number of abilities - they are picked in pairs',
      '"abilities.slots" must be an even whole number - picks come in pairs',
      '"abilities" names "anchor" in more than one slot',
    ]);
  });

  it('still takes a config with no abilities at all', () => {
    const config: any = minimal();
    delete config.abilities;
    expect(service.validateGameRules(config).valid).toBeTrue();
  });
});
