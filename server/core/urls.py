"""HTTP routes for operational probes and the Django administration site."""
from django.contrib import admin
from django.urls import path
from . import health

urlpatterns = [
    path('health/live/', health.live, name='health-live'),
    path('health/ready/', health.ready, name='health-ready'),
    path('admin/', admin.site.urls),
]
