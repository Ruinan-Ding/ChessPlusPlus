"""
Shared utilities for game consumer operations
"""
import json
import logging
from datetime import timedelta
from django.utils import timezone
from django.core.cache import cache

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


def get_challenge_expiration_time():
    """Get the expiration time for a new challenge (30 seconds from now)"""
    return timezone.now() + timedelta(seconds=30)


def get_room_group_name(room_name: str) -> str:
    """Get the channel group name for a room"""
    return f'game_{room_name}'
