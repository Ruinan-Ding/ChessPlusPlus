import commandFields from '../../../../shared/replay-command-fields.json';

export type UnitColor = 'white' | 'black';
export type CommandType = keyof typeof commandFields;
type Fields = {
  from: string; to: string; attack: string; heal: string; withdraw: boolean; more: boolean;
  id: string; unitUid: string; targetUid: string; extraUid: string; hex: string; pairId: string; reason: string;
};
// A field belonging to another command is absent, rather than an unchecked index.
type Command<T extends { type: CommandType }> = T & { [K in Exclude<keyof Fields, keyof T>]?: never };
export type GameCommand =
  | Command<{ type: 'make_move'; from: string; to: string; attack?: string; heal?: string; withdraw?: boolean; more?: boolean }>
  | Command<{ type: 'panel_move' | 'enter_board'; from: string; to: string }>
  | Command<{ type: 'panel_attack'; from: string; to: string; attack: string; more?: boolean }>
  | Command<{ type: 'pass_turn' }>
  | Command<{ type: 'cast_ability'; id: string; unitUid?: string; targetUid?: string; extraUid?: string; hex?: string; pairId?: string }>
  | Command<{ type: 'pick_pair' | 'reset_pair' | 'pick_path'; id: string }>
  | Command<{ type: 'result'; reason: string }>;

export type CommandInput = { type?: unknown } & { [K in keyof Fields]?: unknown } & Record<string, unknown>;
/** Imported actions stay untrusted until their step is reached. */
export interface ReplayAction { ply: unknown; color: unknown; command: CommandInput; }
export interface RecordedAction { ply: number; color: UnitColor; command: GameCommand; }
export const REPLAY_COMMANDS = new Set<string>(Object.keys(commandFields));

export function replayCommand(raw: unknown): CommandInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const fields = typeof input['type'] === 'string' && Object.hasOwn(commandFields, input['type'])
    ? (commandFields as Record<string, string[]>)[input['type']] : ['type'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

/** Writers already have a typed intent; strip extensions without revalidating a live UI action. */
export function recordCommand(command: GameCommand): GameCommand { return replayCommand(command) as GameCommand; }

/** Shape validation only; the engine still decides whether the action is legal. */
export function parseGameCommand(raw: unknown): GameCommand {
  const command = replayCommand(raw);
  for (const field of ['attack', 'heal'] as const) if (command[field] === null) delete command[field];
  if (command.withdraw === false) delete command.withdraw;
  if (typeof command.type !== 'string' || !REPLAY_COMMANDS.has(command.type)) throw new Error('Invalid action fields.');
  for (const [field, value] of Object.entries(command)) {
    if (field === 'more' || field === 'withdraw') {
      if (typeof value !== 'boolean') throw new Error('Invalid action fields.');
    } else if (typeof value !== 'string' || value.length > 256) throw new Error('Invalid action identifier.');
  }
  for (const field of ['from', 'to', 'attack', 'heal', 'hex'] as const) if (command[field] !== undefined) {
    const value = command[field];
    if (typeof value !== 'string' || !/^-?\d+,-?\d+$/.test(value)
        || !value.split(',').map(Number).every(Number.isSafeInteger)) throw new Error('Invalid coordinates.');
    command[field] = value.split(',').map(Number).join(',');
  }
  const required = (fields: Array<keyof Fields>) => {
    if (fields.some(field => typeof command[field] !== 'string' || !command[field])) throw new Error('Missing action fields.');
  };
  switch (command.type) {
    case 'make_move': case 'panel_move': case 'enter_board': required(['from', 'to']); break;
    case 'panel_attack': required(['from', 'to', 'attack']); break;
    case 'cast_ability': case 'pick_pair': case 'reset_pair': case 'pick_path': required(['id']); break;
    case 'result': required(['reason']); break;
    case 'pass_turn': break;
  }
  // Every field was allowlisted and checked above, including each variant's required fields.
  return command as GameCommand;
}
