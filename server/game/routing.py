from django.urls import re_path
from typing import Any, cast
from . import consumers

# Cast the ASGI app to Any to satisfy Pyright's re_path overload expectations
ASGI_APP = consumers.GameConsumer.as_asgi()

websocket_urlpatterns = [
    re_path(r'ws/game/(?P<room_name>[\w-]+)/$', cast(Any, ASGI_APP)),
]