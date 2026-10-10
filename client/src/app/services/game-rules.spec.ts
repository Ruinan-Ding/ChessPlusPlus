import { TestBed } from '@angular/core/testing';
import { ConfigService, DEFAULT_GAME_CONFIG } from './config.service';
import { PREVIOUS_GAME_CONFIG, migrateConfig } from './game-rules';
import { activeVet, rankedUnit } from './unit-stats';
import { captureZoneValues, rangedDamage } from './hex-rules';
import { bankEndedPhases, halftimeUpAwards, scheduledPoints, cpAwarded, unitPoints, scheduleEnding, withdrawalRefund } from './match-score';
import { turnPointsBy, movesPerTurn, scoringPhases, overtimeFirstPly, overtimeLastTurn, stageAt } from './phases';
import { abilityDescription } from './ability-description';
import parity from './config-parity.json';
const invalid = parity.format2Refused;
import expected from './game-rules-parity.json';

describe('Versioned gameplay configuration', () => {
  const fresh = (): any => structuredClone(DEFAULT_GAME_CONFIG);
  it('keeps the balance draft while using format 2.0', () => {
    expect(DEFAULT_GAME_CONFIG.version).toBe('2.0');
    expect(DEFAULT_GAME_CONFIG.ruleset).toEqual({ id: 'default', revision: null });
    expect((DEFAULT_GAME_CONFIG as any).rules).toBeUndefined();
  });
  it('migrates old numbers and freezes formerly implicit rules', () => {
    const raw: any = structuredClone(PREVIOUS_GAME_CONFIG);
    raw.rules.pointsAtStart = 31; raw.rules.cpPhaseOffset = 7;
    raw.unusedExtension={note:'ignored by format 1'};
    const saved = migrateConfig(raw);
    expect(saved.unusedExtension).toBeUndefined();
    expect(saved.economy.pointsAtStart).toBe(31);
    expect(saved.match.phases.map((p: any) => p.cpAward)).toEqual([7,14,21]);
    expect(saved.veterancy.fullHealPhase).toBe(3);
    expect(saved.ruleset.revision).toBeNull();
    expect(migrateConfig(saved)).toEqual(saved);
    expect(raw.version).toBe('1.0');
    saved.units.pawn.hp = 99;
    expect(raw.units.pawn.hp).toBe(12);
  });
  it('refuses every shared malformed field and cross-field inconsistency', () => {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(ConfigService);
    for (const edit of invalid) {
      const config = fresh(); let node = config;
      for (const key of edit.path.slice(0,-1)) node = node[key];
      node[edit.path.at(-1)!] = edit.value;
      expect(service.validateGameRules(config).valid).withContext(edit.path.join('.')).toBeFalse();
    }
  });
  it('fills missing current fields while preserving explicit releases and zero', () => {
    const raw = fresh(); delete raw.combat; delete raw.abilities; raw.ruleset.revision = 1; raw.economy.pointsAtStart = 0;
    const saved = migrateConfig(raw);
    expect(saved.combat).toEqual(DEFAULT_GAME_CONFIG.combat);
    expect(saved.abilities).toEqual(DEFAULT_GAME_CONFIG.abilities);
    expect(saved.abilities).not.toBe(DEFAULT_GAME_CONFIG.abilities);
    expect(saved.ruleset.revision).toBe(1);
    expect(saved.economy.pointsAtStart).toBe(0);
  });
  it('matches the hand-calculated two-phase, two-overtime-stage contract', () => {
    const config = migrateConfig(expected.config);
    const board: any = { '0,11': {unit_id:'king',color:'white',uid:'w',hp:60,vet:0},
      '0,-11':{unit_id:'king',color:'black',uid:'b',hp:60,vet:0} };
    let bank: any = {}, history: any[] = [];
    for (let ply=1; ply<=18; ply++) {
      history.push(...halftimeUpAwards(config,board,history,ply));
      bank = bankEndedPhases(bank,config,board,history,ply);
      if (ply%2===0) expect(scheduledPoints(bank,'white',ply,config)).withContext(`ply ${ply}`).toBe(expected.pointsEachAfterOwnTurn[ply/2-1]);
      expect(scheduleEnding(bank,ply,config)).toBeNull();
    }
    expect(bank).toEqual(expected.bank);
    for (const color of ['white','black'] as const) {
      expect(config.match.cpAtStart+cpAwarded(bank,color,0,config)).toBe(expected.finalCp[color]);
      expect(unitPoints(config,history,color)).toBe(expected.finalUp[color]);
    }
    expect(scheduledPoints(bank,'black',18,config)).toBe(97);
    expect(scheduleEnding(bank,19,config)).toEqual({winner:'white',reason:'overtime'});
    expect(stageAt(11,config)).toBe('Round B Halftime');
    expect(['battlefield','reserve','base'].map(z=>movesPerTurn(1,z,config))).toEqual([3,2,1]);
    expect(['battlefield','reserve','base'].map(z=>movesPerTurn(15,z,config))).toEqual([2,3,4]);
    expect(['battlefield','reserve','base'].map(z=>movesPerTurn(17,z,config))).toEqual([3,4,5]);
  });
  it('uses four phases and four overtime stages without fixed phase indexes', () => {
    const config = fresh(); config.match.phases.push(structuredClone(config.match.phases.at(-1)));
    config.match.overtime.stages.push(structuredClone(config.match.overtime.stages.at(-1)));
    expect(scoringPhases(config)).toEqual([1,2,3,4]);
    expect(overtimeFirstPly(config)).toBe(95);
    expect(overtimeLastTurn(config)).toBe(62);
    const bank = Object.fromEntries([1,2,3,4].map(p=>[p,{white:0,black:0}]));
    expect(scheduleEnding(bank,124,config)).toBeNull();
    expect(scheduleEnding(bank,125,config)).toEqual({winner:'black',reason:'overtime'});
  });
  it('keeps before-halftime, after-halftime and postmatch income independent', () => {
    const config=fresh();Object.assign(config.match.phases[0],{pointsBeforeHalftime:4,pointsPerTurn:7,postmatchPointsPerTurn:9,grant:0});
    const points=(ply:number)=>turnPointsBy('white',ply,config);
    expect(points(16)-points(6)).toBe(20);
    expect(points(26)-points(16)).toBe(35);
    expect(points(28)-points(26)).toBe(9);
  });
  it('skips disabled halftime and postmatch and banks at the next stage', () => {
    const config=fresh();config.match.opening.turns=1;
    config.stageRules.opening.moves={battlefield:[1],reserve:[1],base:[1]};
    config.match.phases=[{...config.match.phases[0],turns:2,halftimeAfter:0,postmatchTurns:0}];
    config.match.winConditions.earlyPhaseLosses=[];config.match.winConditions.points.enabled=false;
    const board:any={'0,11':{unit_id:'king',uid:'wk',color:'white',hp:60},'0,-11':{unit_id:'king',uid:'bk',color:'black',hp:60}};
    expect(overtimeFirstPly(config)).toBe(7);
    expect(halftimeUpAwards(config,board,[],5)).toEqual([]);
    expect(bankEndedPhases({},config,board,[],5)).toEqual({});
    const bank=bankEndedPhases({},config,board,[],7);
    expect(bank['1']).toBeDefined();expect(scheduleEnding(bank,7,config)).toBeNull();
  });
  it('does not share capture-zone answers between distinct configs', () => {
    const a=fresh(),b=fresh();a.scoring.zones=[{kind:'middle',owner:'',center:[0,0],radius:0,worth:9}];b.scoring.zones=[];
    expect(Object.fromEntries(captureZoneValues(11,a))).toEqual({'0,0':9});
    expect(captureZoneValues(11,b).size).toBe(0);
    expect(Object.fromEntries(captureZoneValues(11,a))).toEqual({'0,0':9});
  });
  it('applies configurable refunds, ranged floors and kit unlocks', () => {
    const config=fresh();config.economy.walkHomeRefund={valueMultiplier:2,fee:3,missingHpMultiplier:2,minimum:2};
    const unit:any={unit_id:'pawn',color:'white',uid:'p',hp:7,max_hp:12,vet:1,panel:'br',veterancyHpActive:false};
    expect(withdrawalRefund(config,unit)).toBe(11);
    expect(withdrawalRefund(config,{...unit,hp:0})).toBe(2);
    config.combat.minRangedDamage=3;expect(rangedDamage(4,4,config)).toBe(3);
    config.veterancy.kitZones=['reserve'];config.veterancy.statUnlock=0;
    expect(activeVet(unit,unit.panel,config)).toBe(1);
    expect(rankedUnit({...unit,hp:12},config,1).hp).toBe(14);
    expect(activeVet({...unit,panel:undefined},undefined,config)).toBe(-1);
    config.economy.walkHomeRefund={valueMultiplier:1,fee:1,missingHpMultiplier:1,minimum:1};
    expect(withdrawalRefund(config,{...unit,panel:undefined,max_hp:undefined,hp:12})).toBe(11);
  });
  it('describes edited ability numbers and implicit legacy radii accurately', () => {
    const config=fresh();const entry=config.abilities.catalogue['king-call'];
    Object.assign(entry,{cost:17,heal:6,enemyDamage:4,radius:2});
    const description=abilityDescription(entry,config);
    expect(description).toContain('17 UP');expect(description).toContain('heal 6 HP');expect(description).toContain('2 hex');
    expect(description).not.toContain('{');
    const armyCall={...entry};delete armyCall.radius;
    expect(abilityDescription(armyCall,config)).toContain('unlimited');
    expect(abilityDescription({description:'-{abs:mov} MOV',mov:-4},config)).toBe('-4 MOV');
    expect(abilityDescription(config.abilities.catalogue['bishop-cast'],config)).toContain('Choose an enemy within 1 hex');
    for(const ability of Object.values(config.abilities.catalogue))expect(abilityDescription(ability,config)).not.toContain('{');
    expect(abilityDescription(PREVIOUS_GAME_CONFIG.abilities.catalogue['bishop-cast'],config)).not.toContain('{');
  });
  it('refuses non-finite geometry values before they reach rendering', () => {
    TestBed.configureTestingModule({});
    for (const value of [NaN,Infinity,-Infinity]) {
      const config=fresh();config.scoring.layout.columnRatio=value;
      expect(TestBed.inject(ConfigService).validateGameRules(config).valid).toBeFalse();
    }
  });

});
