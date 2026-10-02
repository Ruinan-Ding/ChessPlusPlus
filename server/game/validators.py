"""
Message and data validators for WebSocket communication
"""
import base64
import re

from django.core import signing
from django.utils.crypto import salted_hmac


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


MAX_BASE_USERNAME_LENGTH = 24
MAX_TRIPCODE_KEY_LENGTH = 128
TRIPCODE_LENGTH = 12
MAX_USERNAME_LENGTH = MAX_BASE_USERNAME_LENGTH + 1 + TRIPCODE_LENGTH


#: Names nobody may hold, compared as name_key() does. The client draws its
#: own notices under "System", and a player by that name was drawn as one.
RESERVED_USERNAMES = {'system'}


def name_key(username: str) -> str:
    """The form two names are compared in: names that differ only in case are
    one name. PlayerConnection.name_key holds it, unique."""
    return username.casefold()


def clean_username(username) -> str:
    """The base name: 1–24 ASCII letters/digits, with System reserved."""
    if not isinstance(username, str):
        raise ValidationError('INVALID_USERNAME', 'Username must be a non-empty string')
    if not username:
        raise ValidationError('INVALID_USERNAME', 'Username cannot be empty or only whitespace')
    if len(username) > MAX_BASE_USERNAME_LENGTH:
        raise ValidationError('USERNAME_TOO_LONG', f'Username cannot exceed {MAX_BASE_USERNAME_LENGTH} characters')
    if not re.fullmatch(r'[A-Za-z0-9]+', username):
        raise ValidationError('INVALID_USERNAME', 'Username must contain only a–z, A–Z and 0–9')
    if name_key(username) in RESERVED_USERNAMES:
        raise ValidationError('INVALID_USERNAME', f'"{username}" is reserved')
    return username


# A public suffix still requires the matching key or signed reconnect proof.
TRIPCODE_SUFFIX = re.compile(rf'!([A-Z2-7]{{{TRIPCODE_LENGTH}}})$', re.IGNORECASE)


def username_with_tripcode(username, key='', token='') -> tuple[str, str]:
    """Resolve a name and private reconnect proof without storing the key."""
    if not isinstance(username, str):
        raise ValidationError('INVALID_USERNAME', 'Username must be a non-empty string')
    username = username.strip()
    if '#' in username:
        if username.count('#') != 1 or key or token:
            raise ValidationError('INVALID_TRIPCODE', 'Use at most one # followed by a tripcode key')
        username, key = username.split('#', 1)
        if not key:
            raise ValidationError('INVALID_TRIPCODE', 'Enter a tripcode key after #')
    suffix = TRIPCODE_SUFFIX.search(username)
    base = clean_username(username[:suffix.start()] if suffix else username)
    if not isinstance(key, str):
        raise ValidationError('INVALID_TRIPCODE', 'Tripcode key must be a string')
    if len(key) > MAX_TRIPCODE_KEY_LENGTH:
        raise ValidationError('INVALID_TRIPCODE', f'Tripcode key must be at most {MAX_TRIPCODE_KEY_LENGTH} characters')
    if '#' in key:
        raise ValidationError('INVALID_TRIPCODE', 'Use at most one # followed by a tripcode key')
    proof_error = 'Tripcode could not be verified; enter its key again'
    if not isinstance(token, str) or len(token) > 200:
        raise ValidationError('INVALID_TRIPCODE', proof_error)
    if not key and not token:
        if suffix:
            raise ValidationError('INVALID_TRIPCODE', 'Enter the tripcode key to use this name')
        return base, ''
    signer = signing.Signer(salt='game.tripcode')
    if key:
        try:
            digest = salted_hmac('game.tripcode', key, algorithm='sha256').digest()
            code = base64.b32encode(digest).decode('ascii')[:TRIPCODE_LENGTH]
        except UnicodeEncodeError:
            raise ValidationError('INVALID_TRIPCODE', 'Tripcode key contains invalid Unicode characters') from None
    else:
        try:
            code = signer.unsign(token)
        except (signing.BadSignature, UnicodeEncodeError):
            raise ValidationError('INVALID_TRIPCODE', proof_error) from None
        if not re.fullmatch(rf'[A-Z2-7]{{{TRIPCODE_LENGTH}}}', code):
            raise ValidationError('INVALID_TRIPCODE', proof_error)
    if suffix and suffix.group(1).upper() != code:
        raise ValidationError('INVALID_TRIPCODE', 'Enter the tripcode key to use this name')
    return f'{base}!{code}', signer.sign(code)


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
