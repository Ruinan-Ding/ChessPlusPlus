import { TestBed } from '@angular/core/testing';
import { ConfigService, PREVIOUS_GAME_CONFIG as DEFAULT_GAME_CONFIG, COUNTED_RULES } from './config.service';
import parity from './config-parity.json';

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

  it('refuses non-object roots without throwing during normalization', () => {
    for (const value of [undefined, null, [], [1], true, false, 0, 1, '', 'text']) {
      const result = service.validateGameRules(value);
      expect(result.valid).withContext(JSON.stringify(value)).toBeFalse();
      expect(result.errors?.length).toBeGreaterThan(0);
    }
  });

  it('preserves the active config and emits nothing when an update is refused', () => {
    const custom = edited(['units', 'pawn', 'hp'], 13);
    expect(service.updateConfig(JSON.stringify(custom)).valid).toBeTrue();
    const active = service.getConfig(), emitted: any[] = [];
    const subscription = service.config$.subscribe(config => emitted.push(config));
    try {
      for (const json of ['{ not json', 'null', '[]', 'true', '1', '"text"',
        JSON.stringify({ ...custom, units: null })]) {
        expect(service.updateConfig(json).valid).withContext(json).toBeFalse();
        expect(service.getConfig()).toBe(active);
        expect(emitted).toEqual([active]);
      }
    } finally { subscription.unsubscribe(); }
  });

  it('refuses malformed units even when a legacy config omits the objective', () => {
    for (const value of [null, [], true, 1, 'text']) {
      const config = edited(['units', 'pawn'], value);
      delete config.rules.objective;
      expect(service.validateGameRules(config).valid).toBeFalse();
    }
  });

  it('requires explicit definitions for unit and ability IDs that resemble object properties', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const unknownPool = edited(['abilities', 'pool', 0], id);
      expect(service.validateGameRules(unknownPool).valid).withContext('unknown ' + id).toBeFalse();
      const config: any = minimal();
      config.units = { [id]: { ...config.units.king, id, ability: id } };
      config.setup = { white: { '0,3': id }, black: { '0,-3': id } };
      config.abilities = { slots: 2, pool: [id, 'paired'], catalogue: {
        [id]: { id, name: id, target: 'friendly', atk: 1 },
        paired: { id: 'paired', name: 'Paired', target: 'enemy', damage: 1 },
      } };
      expect(service.validateGameRules(JSON.parse(JSON.stringify(config))).valid).withContext(id).toBeTrue();
    }
  });

  it('refuses boolean board radii even when the setup fits a numeric radius of one', () => {
    const config: any = minimal();
    config.setup = { white: { '0,1': 'king' }, black: { '0,-1': 'king' } };
    config.board.radius = 1;
    expect(service.validateGameRules(config).valid).toBeTrue();
    for (const radius of [true, false]) {
      config.board.radius = radius;
      const result = service.validateGameRules(config);
      expect(result.valid).withContext(String(radius)).toBeFalse();
      expect(result.errors?.some(e => e.includes('board.radius'))).toBeTrue();
    }
  });

  it('takes the config both engines agree on', () => {
    expect(service.validateGameRules(minimal()).valid).toBeTrue();
  });

  /** The shipped config with one key set - or, with `drop`, removed. */
  const edited = (path: (string | number)[], value: unknown, drop = false) => {
    const config: any = JSON.parse(JSON.stringify(DEFAULT_GAME_CONFIG));
    let node = config;
    for (const key of path.slice(0, -1)) node = node[key];
    if (drop) delete node[path[path.length - 1]];
    else node[path[path.length - 1]] = value;
    return config;
  };

  it('refuses every edit in the shared cases, as load_config does', () => {
    // test_config_parity.py runs the same file through load_config. Each of
    // these was a config the setup screen passed and the server refused: an
    // explicit null read through `??` as though it were absent, or a second
    // unit on a hex that construction then quietly wrote over.
    for (const { path, value } of parity.refused) {
      expect(service.validateGameRules(edited(path, value)).valid)
        .withContext(`${path.join('.')} = ${JSON.stringify(value)}`).toBeFalse();
    }
  });

  it('accepts integer-valued JSON floats in the same shared cases as the backend', () => {
    for (const { path, value } of parity.accepted) {
      expect(service.validateGameRules(edited(path, value)).valid)
        .withContext(`${path.join('.')} = ${value}`).toBeTrue();
    }
  });

  it('ships distinct display names for every ability in the catalogue', () => {
    const names = Object.values(DEFAULT_GAME_CONFIG.abilities.catalogue).map(entry => entry.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('accepts zero pair delay and older radial CP skills without the new area fields', () => {
    const config: any = structuredClone(DEFAULT_GAME_CONFIG);
    config.abilities.pairPickDelay = 0;
    for (const id of ['anchor', 'cleave', 'surge']) {
      for (const field of ['area', 'splashRange', 'outerRange', 'outerAtk', 'outerHel', 'outerMov']) delete config.abilities.catalogue[id][field];
    }
    delete config.abilities.catalogue.cleave.heal;
    expect(service.validateGameRules(config).valid).toBeTrue();
    delete config.abilities.pairPickDelay;
    expect(service.validateGameRules(config).valid).toBeTrue();
  });

  it('accepts an explicit empty capture permission list', () => {
    expect(service.validateGameRules(edited(['units', 'pawn', 'captureZones'], [])).valid).toBeTrue();
  });

  it('takes every field in the shared cases left out, at its default', () => {
    for (const path of parity.absent) {
      expect(service.validateGameRules(edited(path, undefined, true)).valid)
        .withContext(path.join('.')).toBeTrue();
    }
  });

  it("refuses two kings on one hex rather than dealing black's over white's", () => {
    const config: any = minimal();
    config.setup = { white: { '0,0': 'king' }, black: { '0,0': 'king' } };
    const result = service.validateGameRules(config);
    expect(result.valid).toBeFalse();
    expect(result.errors!.join()).toContain('one unit a hex');
  });

  it('keeps old ring-1 attack lists valid when minimum range is absent', () => {
    const config: any = edited(['units', 'archer', 'attackRange'], 4);
    delete config.units.archer.attackMinRange;
    expect(service.validateGameRules(config).valid).toBeTrue();
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
    expect(config.rules.cpAtStart).toBe(5);
    expect(config.rules.cpPhaseOffset).toBe(10);
    expect(config.rules.upAtStart).toBe(10);
    expect(config.rules.pointsAtStart).toBe(10);

    for (const key of COUNTED_RULES) {
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
    expect(config.rules.postmatchEntries).toBeUndefined();
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
    // A hex of white's base the shipped squad leaves free: on one it holds,
    // the second unit on a hex is refused as well.
    config.setup.black['-13,4'] = 'rook';    // white's base
    config.setup.white['-17,10'] = 'king';   // a king in a panel
    const result = service.validateGameRules(config);
    // White's setup is read first, as _validate_config reads it.
    expect(result.errors).toEqual([
      'setup.white puts its commander at -17,10, in a panel - a commander starts on the battlefield',
      "setup.black puts a unit at -13,4, in white's panels",
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
    cat.warcry.uses = 0;
    cat.bulwark.target = 'ally';
    cat.mire.dmg = 4;
    expect(service.validateGameRules(config).errors).toEqual([
      'abilities.catalogue.warcry.uses must be an integer >= 1',
      'abilities.catalogue.bulwark.target must be friendly, enemy, universal or all-enemies',
      'abilities.catalogue.dash.cooldown must be an integer >= 0',
      'abilities.catalogue.dash.turns must be an integer >= 1',
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
    cat.strike.turns = 2;
    expect(service.validateGameRules(config).errors).toEqual([
      'abilities.catalogue.dash.damage does nothing on a friendly ability',
      'abilities.catalogue.strike.turns does nothing on an ability that changes no stat',
      'abilities.catalogue.bastion.cost does nothing on defensive-armor',
      'abilities.catalogue.cleave.points does nothing on hex-cleave',
      'abilities.catalogue.ruin.atk does nothing on ruin',
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
