"""Keep the Windows spawn entry point importable before Django initializes."""
def initialise():
    import django
    django.setup()
    import logging
    logging.getLogger("game.consumers").setLevel(logging.WARNING)


def run(request, cached):
    import asyncio
    from .cpu import analyse
    return asyncio.run(analyse(request, cached))
