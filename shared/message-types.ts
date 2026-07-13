/**
 * WebSocket message type constants shared between client and server.
 *
 * Using constants avoids string typos and makes it easy to search for
 * every handler that deals with a particular message type.
 */

// -- Lobby ----------------------------------------------------------------
export const JOIN_LOBBY           = 'join_lobby';
export const LEAVE_LOBBY          = 'leave_lobby';
export const CHAT_MESSAGE         = 'chat_message';
export const CHANGE_USERNAME      = 'change_username';
export const SET_STATUS           = 'set_status';
export const REQUEST_USER_LIST    = 'request_user_list';
export const HEARTBEAT            = 'heartbeat';

// -- Challenges -----------------------------------------------------------
export const GAME_CHALLENGE       = 'game_challenge';
export const CHALLENGE_ACCEPT     = 'challenge_accept';
export const CHALLENGE_DECLINE    = 'challenge_decline';

// -- Game Room (pre-game) -------------------------------------------------
export const JOIN_GAME_ROOM       = 'join_game_room';
export const LEAVE_GAME_ROOM      = 'leave_game_room';
export const GAME_ROOM_MESSAGE    = 'game_room_message';
export const PLAYER_READY         = 'player_ready';
export const PLAYER_UNREADY       = 'player_unready';
export const CHANGE_GAME_MODE     = 'change_game_mode';
export const REQUEST_REVEAL_MODE  = 'request_reveal_mode';
export const REVEAL_RESPONSE      = 'reveal_response';
export const START_GAME           = 'start_game';
export const CANCEL_GAME_COUNTDOWN = 'cancel_game_countdown';

// -- Gameplay (in-game) ---------------------------------------------------
export const MAKE_MOVE            = 'make_move';
export const RESIGN               = 'resign';
export const OFFER_DRAW           = 'offer_draw';
export const RESPOND_DRAW         = 'respond_draw';
export const REQUEST_GAME_STATE   = 'request_game_state';

// -- Server -> Client broadcasts -------------------------------------------
export const GAME_STATE_UPDATE    = 'game_state_update';
export const GAME_STARTED         = 'game_started';
export const GAME_OVER            = 'game_over';
export const MOVE_MADE            = 'move_made';
export const DRAW_OFFERED         = 'draw_offered';
export const DRAW_RESPONSE        = 'draw_response';
export const INVALID_MOVE         = 'invalid_move';
