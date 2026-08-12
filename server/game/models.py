from django.db import models
from django.utils import timezone
from typing import Any
import uuid


def generate_uuid():
    """Generate a UUID string for use as default primary key."""
    return str(uuid.uuid4())


class GameRoom(models.Model):
    """Represents an active game room"""
    STATUS_CHOICES = [
        ('waiting', 'Waiting for players'),
        ('ready', 'All players ready'),
        ('started', 'Game in progress'),
        ('closed', 'Game closed'),
    ]
    
    game_id = models.CharField(max_length=36, unique=True, primary_key=True, default=generate_uuid)
    host = models.CharField(max_length=24)  # Username of the host/inviter
    opponent = models.CharField(max_length=24)  # Username of the opponent
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='waiting')
    game_mode = models.CharField(max_length=10, default='default')  # 'default' or 'custom'
    game_options = models.JSONField(default=dict)  # {'reveal': True/False, etc}
    # Full custom board/unit config (board, units, setup, rules), saved from the
    # setup screen. Only applied at game start when game_mode == 'custom'.
    custom_config = models.JSONField(default=dict)
    # Access tokens for secure game room entry
    host_token = models.CharField(max_length=64, blank=True, default='')
    opponent_token = models.CharField(max_length=64, blank=True, default='')
    token_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    
    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['host']),
            models.Index(fields=['opponent']),
            models.Index(fields=['status']),
        ]
    
    def __str__(self):
        return f"Game {self.game_id} - {self.host} vs {self.opponent} ({self.status})"
    # Explicit manager annotation for static analysis
    objects: Any = models.Manager()
    # Explicit DoesNotExist annotation for static analysis
    DoesNotExist: Any


class GameChallenge(models.Model):
    """Represents an outstanding game invitation/challenge"""
    STATUS_CHOICES = [
        ('pending', 'Waiting for response'),
        ('accepted', 'Challenge accepted'),
        ('declined', 'Challenge declined'),
        ('expired', 'Challenge expired'),
    ]
    
    challenge_id = models.CharField(max_length=36, unique=True, primary_key=True, default=generate_uuid)
    challenger = models.CharField(max_length=24, db_index=True)
    responder = models.CharField(max_length=24, db_index=True)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    
    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['challenger']),
            models.Index(fields=['responder']),
            models.Index(fields=['status']),
        ]
        unique_together = [['challenger', 'responder']]
    
    def __str__(self):
        return f"Challenge {self.challenger} -> {self.responder} ({self.status})"
    
    def is_expired(self):
        return timezone.now() > self.expires_at
    # Explicit manager annotation for static analysis
    objects: Any = models.Manager()
    # Explicit DoesNotExist annotation for static analysis
    DoesNotExist: Any


class PlayerConnection(models.Model):
    """Tracks active WebSocket connections per user"""
    STATUS_CHOICES = [
        ('online', 'In lobby'),
        ('invited', 'Has pending invite'),
        ('configuring', 'In setup screen'),
        ('in-game', 'In game room'),
    ]
    
    username = models.CharField(max_length=24, unique=True, primary_key=True)
    channel_name = models.CharField(max_length=255)  # Channels consumer channel name
    # ponytail: anonymous per-browser secret, not a real credential. Swap this
    # field's role for a password/OAuth-backed check if real accounts are added.
    secret = models.CharField(max_length=64, blank=True, default='')
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='online')
    connected_at = models.DateTimeField(auto_now_add=True)
    last_activity = models.DateTimeField(auto_now=True)
    
    class Meta:
        ordering = ['username']
    
    def __str__(self):
        return f"{self.username} ({self.status})"
    # Explicit manager annotation for static analysis
    objects: Any = models.Manager()
    # Explicit DoesNotExist annotation for static analysis
    DoesNotExist: Any


class PlayerReadyStatus(models.Model):
    """Tracks player ready state within a game room"""
    game_id = models.ForeignKey(GameRoom, on_delete=models.CASCADE, related_name='player_ready_statuses')
    username = models.CharField(max_length=24)
    is_ready = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        unique_together = [['game_id', 'username']]
        indexes = [
            models.Index(fields=['game_id', 'is_ready']),
        ]
    
    def __str__(self):
        return f"{self.username} in {self.game_id} - {'Ready' if self.is_ready else 'Not Ready'}"
    # Explicit manager annotation for static analysis
    objects: Any = models.Manager()
    # Explicit DoesNotExist annotation for static analysis
    DoesNotExist: Any


class GameState(models.Model):
    """
    Tracks the live state of an active game.
    Created when both players finish the countdown and the game starts.
    """
    END_REASON_CHOICES = [
        ('', 'In progress'),
        ('elimination', 'All enemy units eliminated'),
        ('resign', 'Resignation'),
        ('timeout', 'Timeout'),
        ('draw_agreed', 'Draw by agreement'),
        ('draw_max_turns', 'Draw by max turns'),
        ('disconnect', 'Disconnect forfeit'),
    ]

    game = models.OneToOneField(GameRoom, on_delete=models.CASCADE, related_name='state', primary_key=True)
    # Full board representation as JSON  - dict of "q,r" -> {unit_id, color}
    board_state = models.JSONField(default=dict)
    # Username of whoever's turn it is
    current_turn = models.CharField(max_length=24)
    turn_number = models.PositiveIntegerField(default=1)
    # Ordered list of moves: [{from_coord, to_coord, unit_id, color, turn, captured?, timestamp}]
    move_history = models.JSONField(default=list)
    # Side assignments
    player_white = models.CharField(max_length=24)
    player_black = models.CharField(max_length=24)
    # End-of-game fields
    winner = models.CharField(max_length=24, blank=True, default='')
    end_reason = models.CharField(max_length=20, choices=END_REASON_CHOICES, blank=True, default='')
    # Frozen copy of the GameConfig used at game start (prevents mid-game config edits from corrupting state)
    config_snapshot = models.JSONField(default=dict)
    # Draw offer tracking
    draw_offered_by = models.CharField(max_length=24, blank=True, default='')
    # When the current turn started - persisted so reconnect resyncs report the
    # real turn clock instead of fabricating "now"
    turn_started_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=['current_turn']),
            models.Index(fields=['end_reason']),
        ]

    def __str__(self):
        status = f"Turn {self.turn_number}" if not self.end_reason else self.end_reason
        return f"State for {self.pk} - {status}"

    @property
    def is_finished(self) -> bool:
        return self.end_reason != ''

    # Explicit manager annotation for static analysis
    objects: Any = models.Manager()
    # Explicit DoesNotExist annotation for static analysis
    DoesNotExist: Any
