"""Generic probes; readiness includes the database migration state."""
from django.db import DatabaseError, connection
from django.db.migrations.executor import MigrationExecutor
from django.http import JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe


@require_safe
@never_cache
def live(request):
    return JsonResponse({'status': 'ok'})


@require_safe
@never_cache
def ready(request):
    try:
        executor = MigrationExecutor(connection)
        available = not executor.migration_plan(executor.loader.graph.leaf_nodes())
    except DatabaseError:
        available = False
    return JsonResponse({'status': 'ok' if available else 'unavailable'}, status=200 if available else 503)
