"""
Shared utilities for game consumer operations
"""
import json
import logging
from datetime import timedelta
from django.utils import timezone
from django.core.cache import cache

from .models import GameChallenge, PlayerConnection

logger = logging.getLogger('game')


def structured_log(level: str, event: str, **kwargs) -> None:
    """Log a structured JSON message to the game logger.

    Args:
        level: Log level as string ('info','warning','error','debug')
        event: Short event name
        kwargs: Additional context to include
    """
    payload = {'event': event, 'ts': timezone.now().isoformat()}
    payload.update(kwargs)
    try:
        text = json.dumps(payload, default=str)
    except Exception:
        text = str(payload)
    if level == 'info':
        logger.info(text)
    elif level == 'warning':
        logger.warning(text)
    elif level == 'error':
        logger.error(text)
    else:
        logger.debug(text)


def get_idempotency(key: str):
    """Return stored value for an idempotency key, or None."""
    if not key:
        return None
    try:
        return cache.get(f'idem:{key}')
    except Exception as e:
        logger.warning(f'Idempotency cache get failed: {e}')
        return None


def set_idempotency(key: str, value, timeout: int = 60):
    """Set an idempotency key in cache with timeout seconds."""
    if not key:
        return
    try:
        cache.set(f'idem:{key}', value, timeout)
    except Exception as e:
        logger.warning(f'Idempotency cache set failed: {e}')


async def send_json_response(consumer, data: dict) -> None:
    """
    Send a JSON response to a WebSocket consumer
    
    Args:
        consumer: AsyncWebsocketConsumer instance
        data: Dictionary to send as JSON
    """
    try:
        await consumer.send(text_data=json.dumps(data))
    except Exception as e:
        logger.error(f"Error sending response to {consumer.channel_name}: {e}")


async def send_error(consumer, code: str, message: str) -> None:
    """
    Send a standardized error response
    
    Args:
        consumer: AsyncWebsocketConsumer instance
        code: Error code (e.g., 'INVALID_USERNAME')
        message: Human-readable error message
    """
    await send_json_response(consumer, {
        'type': 'error',
        'code': code,
        'message': message
    })


async def broadcast_to_group(channel_layer, group_name: str, message: dict) -> None:
    """
    Broadcast a message to all members of a group
    
    Args:
        channel_layer: The channel layer
        group_name: Name of the group (e.g., 'game_lobby')
        message: Message dictionary to broadcast
    """
    try:
        await channel_layer.group_send(group_name, {
            'type': 'broadcast_message',
            'data': message
        })
    except Exception as e:
        logger.error(f"Error broadcasting to {group_name}: {e}")


def expire_stale_challenges() -> int:
    """Drop invites nobody answered, and let the players they pinned go.

    Shared, so the two callers cannot drift apart: the consumer runs it before
    deciding who is busy, and the cleanup_game_state management command runs it
    as the manual escape hatch. The command used to only mark the rows
    'expired' and leave both players sitting at status 'invited' - which every
    invite check refuses as busy - so the documented way out of the jam did not
    actually end it.

    Returns how many challenges were cleared.
    """
    stale = list(GameChallenge.objects.filter(  # type: ignore
        status='pending', expires_at__lt=timezone.now()))
    if not stale:
        return 0
    names = {name for c in stale for name in (c.challenger, c.responder)}
    GameChallenge.objects.filter(pk__in=[c.pk for c in stale]).delete()  # type: ignore
    # 'invited' outlives the invite it described, and is refused as busy.
    PlayerConnection.objects.filter(  # type: ignore
        username__in=names, status='invited').update(status='online')
    return len(stale)


def get_challenge_expiration_time():
    """When a new challenge stops counting (30 seconds from now).

    Longer than the 5-second countdown the lobby shows the responder, on
    purpose: that countdown is the deadline for somebody who is there to see
    it, and auto-declines. This is the backstop for a responder who is not -
    a closed tab never declines, and the invite would otherwise sit 'pending'
    forever with both players stuck 'invited'. Swept by
    _expire_stale_challenges on the next invite anybody sends.
    """
    return timezone.now() + timedelta(seconds=30)


def get_room_group_name(room_name: str) -> str:
    """Get the channel group name for a room"""
    return f'game_{room_name}'
