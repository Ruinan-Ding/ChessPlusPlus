"""ASGI entry point for HTTP and game/CPU WebSockets with origin checks."""

import os
import django
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator

# Ensure settings are configured before importing app modules
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'core.settings')
django.setup()

from game import routing  # import after django.setup()

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(
            URLRouter(
                routing.websocket_urlpatterns
            )
        )
    ),
})
