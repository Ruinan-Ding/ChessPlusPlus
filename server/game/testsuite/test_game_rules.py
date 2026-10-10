"""Versioned configuration, altered gameplay, and shared browser/server contracts."""
import copy
import json
from pathlib import Path
from unittest.mock import patch
from django.test import SimpleTestCase
from game.engine.config_loader import DEFAULT_CONFIG, build_initial_board, load_config
from game.engine.game_rules import PREVIOUS_CONFIG, section_of
from game.engine import phases, scoring, economy, panels, game_logic
from game.engine.unit_stats import active_vet, ranked_unit, unit_stats

FIXTURES = Path(__file__).resolve().parents[3] / 'client/src/app/services'

class GameRulesTests(SimpleTestCase):
    def test_default_is_current_format_with_an_unreleased_balance(self):
        config = load_config()
        self.assertEqual(config['version'], '2.0')
        self.assertEqual(config['ruleset'], {'id': 'default', 'revision': None})
        self.assertNotIn('rules', config)

    def test_legacy_import_preserves_implicit_rules_and_explicit_overrides(self):
        raw = copy.deepcopy(PREVIOUS_CONFIG)
        raw['rules'].update(pointsAtStart=31, cpPhaseOffset=7, rangeFalloff=0.5)
        config = load_config(raw)
        self.assertEqual(config['units'], raw['units'])
        self.assertEqual(config['economy']['pointsAtStart'], 31)
        self.assertEqual([p['cpAward'] for p in config['match']['phases']], [7,14,21])
        self.assertEqual(config['combat']['rangeFalloff'], 0.5)
        self.assertEqual(config['veterancy']['fullHealPhase'], 3)
        self.assertEqual(config['ruleset']['revision'], None)
        self.assertEqual(raw['version'], '1.0')
        with patch.dict(DEFAULT_CONFIG['economy'], pointsAtStart=999):
            self.assertEqual(load_config(raw)['economy']['pointsAtStart'], 31)
        raw['rules'].pop('pointsAtStart')
        with patch.dict(DEFAULT_CONFIG['economy'], pointsAtStart=999):
            self.assertEqual(load_config(raw)['economy']['pointsAtStart'], 10)

    def test_import_is_idempotent_and_detached_from_its_source_and_defaults(self):
        legacy = copy.deepcopy(PREVIOUS_CONFIG)
        legacy['unusedExtension'] = {'note': 'ignored by format 1'}
        config = load_config(legacy)
        self.assertNotIn('unusedExtension', config)
        self.assertEqual(load_config(config), config)
        saved = copy.deepcopy(config)
        with patch.dict(DEFAULT_CONFIG['combat'], minStrikeDamage=9):
            self.assertEqual(load_config(saved), saved)
        config['units']['pawn']['hp'] = 99
        self.assertEqual(PREVIOUS_CONFIG['units']['pawn']['hp'], 12)

    def test_every_shared_invalid_edit_is_refused(self):
        for edit in json.loads((FIXTURES/'config-parity.json').read_text(encoding='utf-8'))['format2Refused']:
            with self.subTest(path=edit['path']):
                config = copy.deepcopy(DEFAULT_CONFIG)
                node = config
                for key in edit['path'][:-1]: node = node[key]
                node[edit['path'][-1]] = edit['value']
                with self.assertRaises(ValueError): load_config(config)

    def test_missing_domain_fields_fill_defaults_but_revision_stays_draft(self):
        raw = copy.deepcopy(DEFAULT_CONFIG)
        del raw['economy']['pointsAtStart']
        del raw['combat']
        del raw['abilities']
        saved = load_config(raw)
        self.assertEqual(saved['abilities'], DEFAULT_CONFIG['abilities'])
        with patch.dict(DEFAULT_CONFIG['abilities']['catalogue']['warcry'], atk=99):
            self.assertEqual(load_config(saved)['abilities']['catalogue']['warcry']['atk'], 8)
        self.assertEqual(load_config(raw)['combat'], DEFAULT_CONFIG['combat'])
        self.assertEqual(load_config(raw)['economy']['pointsAtStart'], 10)
        raw['ruleset']['revision']=1
        self.assertEqual(load_config(raw)['ruleset']['revision'],1)

    def test_hand_calculated_short_match_income_banks_and_ending(self):
        expected = json.loads((FIXTURES/'game-rules-parity.json').read_text(encoding='utf-8'))
        config = load_config(expected['config'])
        board = build_initial_board(config).to_dict()
        history, bank = [], {}
        for ply in range(1, expected['lastPly']+1):
            history.extend(scoring.halftime_up_awards(config, board, history, ply))
            bank = scoring.bank_ended_phases(bank, config, board, history, ply)
            if ply % 2 == 0:
                turn = phases.turn_of(ply)
                self.assertEqual(economy.points_of('white', ply, history, config, bank), expected['pointsEachAfterOwnTurn'][turn-1])
            self.assertIsNone(scoring.schedule_ending(bank, ply, config))
        self.assertEqual(bank, expected['bank'])
        for color in ('white','black'):
            self.assertEqual(config['match']['cpAtStart']+scoring.cp_awarded(bank,color,0,config),expected['finalCp'][color])
            self.assertEqual(economy.unit_points_of(color,history,config),expected['finalUp'][color])
        self.assertEqual(economy.points_of('black',18,history,config,bank),97)
        self.assertEqual(scoring.schedule_ending(bank,19,config),('white','overtime'))
        self.assertEqual(phases.stage_at(11,config),'Round B Halftime')
        self.assertEqual([phases.moves_per_turn(1,z,config) for z in ('battlefield','reserve','base')],[3,2,1])
        self.assertEqual([phases.moves_per_turn(15,z,config) for z in ('battlefield','reserve','base')],[2,3,4])
        self.assertEqual([phases.moves_per_turn(17,z,config) for z in ('battlefield','reserve','base')],[3,4,5])

    def test_four_phases_and_four_overtime_stages_have_no_three_phase_assumption(self):
        config = copy.deepcopy(DEFAULT_CONFIG)
        config['match']['phases'].append(copy.deepcopy(config['match']['phases'][-1]))
        config['match']['overtime']['stages'].append(copy.deepcopy(config['match']['overtime']['stages'][-1]))
        config = load_config(config)
        self.assertEqual(list(phases.scoring_phases(config)),[1,2,3,4])
        self.assertEqual(phases.overtime_first_ply(config),95)
        self.assertEqual(phases.overtime_last_turn(config),62)
        bank = {str(p):{'white':0,'black':0} for p in range(1,5)}
        self.assertIsNone(scoring.schedule_ending(bank,124,config))
        self.assertEqual(scoring.schedule_ending(bank,125,config),('black','overtime'))

    def test_per_match_capture_layout_and_empty_zones_do_not_share_answers(self):
        one = copy.deepcopy(DEFAULT_CONFIG);two=copy.deepcopy(DEFAULT_CONFIG)
        one['scoring']['zones']=[{'kind':'middle','owner':'','center':[0,0],'radius':0,'worth':9}]
        two['scoring']['zones']=[]
        self.assertEqual(scoring.capture_zone_values(11,one),{'0,0':9})
        self.assertEqual(scoring.capture_zone_values(11,two),{})
        self.assertEqual(scoring.capture_zone_values(11,one),{'0,0':9})

    def test_configured_refund_fees_damage_and_price_multiplier(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['economy']['walkHomeRefund']={'valueMultiplier':2,'fee':3,'missingHpMultiplier':2,'minimum':2}
        unit={'unit_id':'pawn','color':'white','hp':7,'max_hp':12}
        self.assertEqual(economy.withdrawal_refund(config,unit),11)
        unit['hp']=0
        self.assertEqual(economy.withdrawal_refund(config,unit),2)

    def test_configured_counter_and_ranged_floor(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['combat'].update(counterattacks=False,minRangedDamage=3)
        self.assertEqual(game_logic.ranged_damage(4,4,config),3)
        board=build_initial_board(config)
        board.set(0,0,'pawn','white',hp=12,max_hp=12)
        board.set(1,0,'pawn','black',hp=12,max_hp=12)
        result=game_logic.resolve_combat(board,(0,0),(1,0),config)
        self.assertEqual(result['counter_damage'],0)
        self.assertEqual(board.get(0,0)['hp'],12)

    def test_configured_veterancy_awards_and_zero_star_unlock(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(startingRank=1,award=2,statUnlock=0,passiveUnlock=1,abilityUnlock=2,kitZones=['reserve'])
        self.assertEqual(panels.unit_veterancy('p','0,0',[],7,11,config=config),3)
        unit={'unit_id':'pawn','color':'white','uid':'p','hp':12,'max_hp':12,'vet':1,'panel':'br','veterancyHpActive':False}
        self.assertEqual(active_vet(unit,config),1)
        self.assertEqual(ranked_unit(unit,config,1)['hp'],14)
        self.assertEqual(active_vet({**unit,'panel':None},config),-1)
        unranked={**unit,'panel':None,'hp':12};unranked.pop('max_hp')
        self.assertEqual(economy.withdrawal_refund(config,unranked),11)
        config['veterancy']['postmatchAwards']=False
        config['veterancy']['firstPhaseStartAward']=False
        self.assertEqual(panels.unit_veterancy('p','0,0',[],71,11,config=config),1)

    def test_disabled_halftime_and_postmatch_use_the_next_phase_boundary(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['match']['opening']['turns']=1
        config['stageRules']['opening']['moves']={z:[1] for z in ('battlefield','reserve','base')}
        config['match']['phases']=[dict(config['match']['phases'][0],turns=2,halftimeAfter=0,postmatchTurns=0)]
        config['match']['winConditions']['earlyPhaseLosses']=[]
        config['match']['winConditions']['points']['enabled']=False
        board=build_initial_board(config).to_dict()
        config=load_config(config)
        self.assertEqual(phases.overtime_first_ply(config),7)
        self.assertFalse(phases.is_postmatch(5,config))
        self.assertEqual(scoring.halftime_up_awards(config,board,[],5),[])
        self.assertEqual(scoring.bank_ended_phases({},config,board,[],5),{})
        bank=scoring.bank_ended_phases({},config,board,[],7)
        self.assertIn('1',bank)
        self.assertIsNone(scoring.schedule_ending(bank,7,config))
        self.assertEqual(panels.unit_veterancy('p','0,0',[],7,11,config=config),1)

    def test_each_panel_healing_rate_and_battlefield_exclusion(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['panels'].update(baseHealPerTurn=2,reserveHealPerTurn=3)
        self.assertEqual(panels.mended_in_base('white',1,True,[(5,False),(7,None)],9,config),5)
        self.assertEqual(panels.mended_since('white',1,5,config),2)

    def test_reserve_kit_control_uses_its_panel_slot_without_spending_a_field_action(self):
        from types import SimpleNamespace
        from game.engine.ability_rules import AbilityContext, initial_state, actions_used
        from game.engine.board import parse_coord, coord_key, HEX_DIRECTIONS
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(startingRank=3,kitZones=['battlefield','reserve','base'])
        config['economy']['upAtStart']=100
        config['units']['bishop']['move']=0
        reserve=next(k for k,v in panels.gateway_hexes(11).items() if v['color']=='white')
        config['setup']={'white':{'0,11':'king',reserve:'bishop'},'black':{'0,-11':'king'}}
        board=build_initial_board(config).to_dict()
        q,r=parse_coord(reserve)
        target=next(coord_key(q+dq,r+dr) for dq,dr in HEX_DIRECTIONS.values() if panels.on_battlefield(q+dq,r+dr,11) and coord_key(q+dq,r+dr) not in board)
        board[target]={'unit_id':'pawn','color':'black','uid':'enemy','hp':14,'max_hp':14,'vet':3}
        state=SimpleNamespace(config_snapshot=config,ability_state=initial_state(),turn_number=7,current_turn='alice',player_white='alice',player_black='bob',board_state=board,move_history=[],phase_bank={})
        context=AbilityContext(state)
        source=context.recipients()[reserve]
        context.cast({'id':'bishop-cast','unitUid':source['uid'],'targetUid':'enemy'})
        self.assertEqual(context.data['controls']['enemy']['color'],'white')
        self.assertEqual(context.history[-2]['sourcePanel'],'br')
        state.move_history=context.history
        self.assertEqual(actions_used(state,'white'),0)
        self.assertEqual(panels.panel_movers(context.history,7,'white')['reserve'],{source['uid']})
        self.assertIsNone(panels.panel_allowance(config,context.history,source,7,context.data))

    def test_early_unlock_and_panel_source_apply_aura_with_configured_radius(self):
        from types import SimpleNamespace
        from game.engine.ability_rules import AbilityContext, initial_state
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(passiveUnlock=0,kitZones=['battlefield','base','reserve'])
        config['setup']={'white':{'0,11':'king','-12,11':'queen','-10,11':'pawn'},'black':{'0,-11':'king'}}
        config['abilities']['catalogue']['persuade']['radius']=2
        config=load_config(config)
        state=SimpleNamespace(config_snapshot=config,ability_state=initial_state(),turn_number=1,current_turn='alice',player_white='alice',player_black='bob',board_state=build_initial_board(config).to_dict(),move_history=[],phase_bank={})
        context=AbilityContext(state);context.begin_turn('white',1)
        self.assertEqual(context.data['buffs']['w-10,11']['atk'],1)
        self.assertEqual(context.data['buffs']['w-10,11']['effects'][0]['expiresAt'],3)
        context.begin_turn('white',3)
        self.assertEqual(context.data['buffs']['w-10,11']['atk'],1)
        config['veterancy']['kitZones']=['battlefield']
        context.begin_turn('white',5)
        self.assertNotIn('w-10,11',context.data['buffs'])

    def test_phase_income_rates_are_independent_of_neighboring_phases(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        phase=config['match']['phases'][0]
        phase.update(pointsBeforeHalftime=4,pointsPerTurn=7,postmatchPointsPerTurn=9,grant=0)
        before=phases.turn_points_by('white',6,config)
        self.assertEqual(phases.turn_points_by('white',16,config)-before,5*4)
        self.assertEqual(phases.turn_points_by('white',26,config)-phases.turn_points_by('white',16,config),5*7)
        self.assertEqual(phases.turn_points_by('white',28,config)-phases.turn_points_by('white',26,config),9)

    def test_non_finite_numbers_are_refused_before_geometry_or_economy(self):
        for value in (float('nan'),float('inf'),float('-inf')):
            config=copy.deepcopy(DEFAULT_CONFIG);config['scoring']['layout']['columnRatio']=value
            with self.subTest(value=value),self.assertRaises(ValueError):load_config(config)


from django.test import TransactionTestCase
from game.models import GameState
from game.testsuite import test_consumers as live
_receive_until = live._receive_until
_both_ready_then_start = live._both_ready_then_start

class ConfiguredMatchLiveTests(TransactionTestCase):
    async def _start_custom_review_match(self, config):
        game, white, black = await live.CustomConfigLiveIntegrationTests._join_room(self)
        await white.send_json_to({'type':'change_game_mode','mode':'custom','gameId':game.game_id})
        await _receive_until(white,'game_mode_changed');await _receive_until(black,'game_mode_changed')
        await white.send_json_to({'type':'set_custom_config','config':config})
        await _receive_until(white,'custom_config_saved');await _receive_until(black,'custom_config_saved')
        await _both_ready_then_start(white,black,game.game_id,hostColor='white')
        snapshot=await _receive_until(white,'game_started');await _receive_until(black,'game_started')
        return game,white,black,snapshot

    async def _commit_review_turn(self, game, white, black, snapshot, command):
        await white.send_json_to({'type':'commit_turn','gameId':game.game_id,'turnNumber':snapshot['turnNumber'],
            'revision':snapshot['revision'],'sequence':1,'commands':[command,{'type':'pass_turn'}]})
        reply=await _receive_until(white,('game_state_update','error','invalid_move'))
        self.assertEqual(reply['type'],'game_state_update',reply)
        self.assertEqual(reply.get('committedTurn'),snapshot['turnNumber'],reply)
        self.assertEqual(reply,await _receive_until(black,'game_state_update'))
        return await GameState.objects.aget(game_id=game.game_id)

    async def test_wounded_withdrawal_retains_activation_in_an_enabled_base(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(startingRank=1,kitZones=['battlefield','base'])
        config['panels']['baseHealPerTurn']=0
        config['setup']={'white':{'0,11':'king','-11,11':'pawn'},'black':{'0,-11':'king'}}
        game,white,black,snapshot=await self._start_custom_review_match(config)
        try:
            snapshot['boardState']['-11,11']['hp']=5
            await GameState.objects.filter(game_id=game.game_id).aupdate(board_state=snapshot['boardState'])
            state=await self._commit_review_turn(game,white,black,snapshot,
                {'type':'make_move','from':'-11,11','to':'-12,11','withdraw':True,'more':True})
            record=next(m for m in state.move_history if m.get('withdrawn'))
            self.assertEqual((record['unit']['hp'],record['unit']['max_hp'],record['unit']['veterancyHpActive']),(5,14,True))
            for _ in range(2):
                rebuilt=panels.panel_occupancy(state.config_snapshot,11,state.move_history,ply=state.turn_number)['-12,11']
                self.assertEqual((rebuilt['hp'],rebuilt['max_hp'],rebuilt['veterancyHpActive']),(5,14,True))
            self.assertEqual(economy.unit_points_of('white',state.move_history,state.config_snapshot),12)
        finally:
            await white.disconnect();await black.disconnect()

    async def test_zero_refund_withdrawal_commits_and_remains_zero_after_rejoin(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['economy']['walkHomeRefund'].update(minimum=0,fee=100)
        config['panels']['baseHealPerTurn']=0
        config['setup']={'white':{'0,11':'king','-11,11':'pawn'},'black':{'0,-11':'king'}}
        game,white,black,snapshot=await self._start_custom_review_match(config)
        try:
            state=await self._commit_review_turn(game,white,black,snapshot,
                {'type':'make_move','from':'-11,11','to':'-12,11','withdraw':True,'more':True})
            record=next(m for m in state.move_history if m.get('withdrawn'))
            self.assertEqual(record['refund'],0)
            self.assertNotIn('-11,11',state.board_state)
            self.assertEqual(panels.panel_occupancy(config,11,state.move_history,ply=2)['-12,11']['hp'],12)
            await white.send_json_to({'type':'request_game_state'})
            restored=await _receive_until(white,'game_state_update')
            self.assertEqual(economy.unit_points_of('white',restored['moveHistory'],restored['config']),10)
        finally:
            await white.disconnect();await black.disconnect()

    async def test_multiplied_wrap_price_is_recorded_and_cannot_be_underfunded(self):
        for available in (24,23):
            with self.subTest(available=available):
                config=copy.deepcopy(DEFAULT_CONFIG)
                config['economy'].update(upAtStart=available,wrapPriceMultiplier=2)
                config['setup']={'white':{'0,11':'king','-12,1':'pawn'},'black':{'0,-11':'king'}}
                game,white,black,snapshot=await self._start_custom_review_match(config)
                try:
                    await GameState.objects.filter(game_id=game.game_id).aupdate(turn_number=7)
                    snapshot['turnNumber']=7
                    command={'type':'panel_move','from':'-12,1','to':'11,1'}
                    if available==24:
                        state=await self._commit_review_turn(game,white,black,snapshot,command)
                        record=next(m for m in state.move_history if m.get('panelMove'))
                        self.assertEqual(record['price'],24)
                        self.assertEqual(economy.unit_points_of('white',state.move_history,state.config_snapshot),0)
                    else:
                        await white.send_json_to({'type':'commit_turn','gameId':game.game_id,'turnNumber':7,
                            'revision':snapshot['revision'],'sequence':1,'commands':[command,{'type':'pass_turn'}]})
                        error=await _receive_until(white,'error')
                        self.assertEqual(error['code'],'INVALID_MOVE')
                        state=await GameState.objects.aget(game_id=game.game_id)
                        self.assertEqual(state.turn_number,7);self.assertEqual(state.move_history,[])
                finally:
                    await white.disconnect();await black.disconnect()

    async def test_normal_heal_uses_base_profile_when_battlefield_kit_is_disabled(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(startingRank=1,kitZones=[])
        config['stageRules']['opening']['normalHeal']=True
        config['units']['bishop']['veterancy']['heal']=[20,20,20,20]
        config['units']['pawn']['hp']=30
        config['setup']={'white':{'0,11':'king','0,0':'bishop','1,0':'pawn'},'black':{'0,-11':'king'}}
        game,white,black,snapshot=await self._start_custom_review_match(config)
        try:
            snapshot['boardState']['1,0']['hp']=1
            await GameState.objects.filter(game_id=game.game_id).aupdate(board_state=snapshot['boardState'])
            state=await self._commit_review_turn(game,white,black,snapshot,
                {'type':'make_move','from':'0,0','to':'0,0','heal':'1,0','more':True})
            self.assertEqual(state.board_state['1,0']['hp'],9)
            self.assertEqual(next(m for m in state.move_history if m.get('healedHex'))['healed_amount'],8)
        finally:
            await white.disconnect();await black.disconnect()

    async def test_start_snapshot_includes_configured_zero_star_panel_aura(self):
        config=copy.deepcopy(DEFAULT_CONFIG)
        config['veterancy'].update(passiveUnlock=0,kitZones=['battlefield','base'])
        config['setup']={'white':{'0,11':'king','-12,11':'queen','-11,11':'pawn'},'black':{'0,-11':'king'}}
        game,white,black=await live.CustomConfigLiveIntegrationTests._join_room(self)
        try:
            await white.send_json_to({'type':'change_game_mode','mode':'custom','gameId':game.game_id})
            await _receive_until(white,'game_mode_changed');await _receive_until(black,'game_mode_changed')
            await white.send_json_to({'type':'set_custom_config','config':config})
            await _receive_until(white,'custom_config_saved');await _receive_until(black,'custom_config_saved')
            await _both_ready_then_start(white,black,game.game_id, hostColor='white')
            snapshot=await _receive_until(white,'game_started')
            self.assertEqual(snapshot['abilityState']['buffs']['w-11,11']['atk'],1)
        finally:
            await white.disconnect();await black.disconnect()

    async def test_custom_match_is_frozen_and_completes_over_two_real_asgi_connections(self):
        expected=json.loads((FIXTURES/'game-rules-parity.json').read_text(encoding='utf-8'))
        with patch('game.consumers.RATE_LIMIT_MAX_MESSAGES',1000):
            game,white,black=await live.CustomConfigLiveIntegrationTests._join_room(self)
            try:
                await white.send_json_to({'type':'change_game_mode','mode':'custom','gameId':game.game_id})
                await _receive_until(white,'game_mode_changed');await _receive_until(black,'game_mode_changed')
                await white.send_json_to({'type':'set_custom_config','config':expected['config']})
                await _receive_until(white,'custom_config_saved');await _receive_until(black,'custom_config_saved')
                await _both_ready_then_start(white,black,game.game_id,hostColor='white')
                start=await _receive_until(white,'game_started');await _receive_until(black,'game_started')
                self.assertEqual(start['config'],expected['config'])
                for ply in range(1,19):
                    mover,other=(white,black) if ply%2 else (black,white)
                    with patch.dict(DEFAULT_CONFIG['economy'],pointsAtStart=999):
                        await mover.send_json_to({'type':'pass_turn'})
                        sent=await _receive_until(mover,('turn_passed','error'))
                        received=await _receive_until(other,('turn_passed','error'))
                    self.assertEqual(sent['type'],'turn_passed',sent)
                    self.assertEqual(sent,received)
                    stored=await GameState.objects.aget(game_id=game.game_id)
                    self.assertEqual(stored.turn_number,ply+1)
                    self.assertEqual(stored.config_snapshot,expected['config'])
                    if ply==8:
                        await black.send_json_to({'type':'request_game_state'})
                        restored=await _receive_until(black,'game_state_update')
                        self.assertEqual(restored['config'],expected['config'])
                result=await _receive_until(white,'game_over');await _receive_until(black,'game_over')
                self.assertEqual(result['winner'],'alice')
                self.assertEqual(result['endReason'],'overtime')
                self.assertEqual(stored.phase_bank,expected['bank'])
                self.assertEqual(economy.unit_points_of('white',stored.move_history,stored.config_snapshot),39)
            finally:
                await white.disconnect();await black.disconnect()
