"""
Message and data validators for WebSocket communication
"""


class ValidationError(Exception):
    """Raised when message validation fails"""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def validate_required_fields(data: dict, required_fields: list) -> None:
    """
    Validate that all required fields are present in data
    
    Args:
        data: Dictionary to validate
        required_fields: List of field names that must be present
        
    Raises:
        ValidationError: If any required field is missing
    """
    for field in required_fields:
        if field not in data or data[field] is None:
            raise ValidationError('MISSING_FIELD', f'Missing required field: {field}')


def validate_username(username: str) -> None:
    """
    Validate username format and length
    
    Args:
        username: Username to validate
        
    Raises:
        ValidationError: If username is invalid
    """
    if not username or not isinstance(username, str):
        raise ValidationError('INVALID_USERNAME', 'Username must be a non-empty string')
    
    if len(username) > 24:
        raise ValidationError('USERNAME_TOO_LONG', 'Username cannot exceed 24 characters')
    
    if len(username.strip()) == 0:
        raise ValidationError('INVALID_USERNAME', 'Username cannot be only whitespace')


def validate_status(status: str) -> None:
    """
    Validate player status value
    
    Args:
        status: Status value to validate
        
    Raises:
        ValidationError: If status is invalid
    """
    valid_statuses = ['online', 'configuring', 'in-game']
    if status not in valid_statuses:
        raise ValidationError('INVALID_STATUS', f'Status must be one of: {", ".join(valid_statuses)}')


def validate_game_mode(mode: str) -> None:
    """
    Validate game mode value
    
    Args:
        mode: Game mode to validate
        
    Raises:
        ValidationError: If mode is invalid
    """
    valid_modes = ['default', 'custom']
    if mode not in valid_modes:
        raise ValidationError('INVALID_GAME_MODE', f'Mode must be one of: {", ".join(valid_modes)}')


# The only settings a room carries. Named here because the consumer has to
# filter what it sends back to clients by the same list it validates against -
# anything else is echoed to the server on the next change and rejected.
GAME_OPTION_KEYS = frozenset({'reveal', 'turnTimeLimit'})


def validate_game_options(options: dict) -> None:
    """
    Validate game options structure
    
    Args:
        options: Options dictionary to validate
        
    Raises:
        ValidationError: If options are invalid
    """
    if not isinstance(options, dict):
        raise ValidationError('INVALID_OPTIONS', 'Game options must be a dictionary')
    
    for key in options.keys():
        if key not in GAME_OPTION_KEYS:
            raise ValidationError('INVALID_OPTION_KEY', f'Unknown option: {key}')
    
    if 'reveal' in options and not isinstance(options['reveal'], bool):
        raise ValidationError('INVALID_OPTION_VALUE', 'reveal option must be boolean')
    if 'turnTimeLimit' in options:
        value = options['turnTimeLimit']
        if isinstance(value, bool) or not isinstance(value, int) or value not in {0, 15, 30, 60, 120, 180, 240, 300}:
            raise ValidationError('INVALID_OPTION_VALUE', 'turnTimeLimit must be one of the supported timer values')


def validate_chat_message(content: str) -> None:
    """
    Validate chat message content
    
    Args:
        content: Message content to validate
        
    Raises:
        ValidationError: If content is invalid
    """
    if not content or not isinstance(content, str):
        raise ValidationError('INVALID_MESSAGE', 'Message must be a non-empty string')
    
    if len(content) > 1000:
        raise ValidationError('MESSAGE_TOO_LONG', 'Message cannot exceed 1000 characters')
