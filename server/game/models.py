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
        return f"Challenge {self.challenger} → {self.responder} ({self.status})"
    
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
