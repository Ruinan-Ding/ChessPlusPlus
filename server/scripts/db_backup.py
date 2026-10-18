"""Consistent SQLite snapshots and offline restores to new files only."""
import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import tempfile


def backup_database(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise FileExistsError(f'Destination already exists: {destination}')
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{destination.name}.', dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as database:
            with closing(sqlite3.connect(temporary)) as snapshot:
                database.backup(snapshot)
                if snapshot.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise sqlite3.DatabaseError('Snapshot failed integrity verification.')
        with temporary.open('r+b') as snapshot:
            os.fsync(snapshot.fileno())
        # Orphaned sidecars can replay stale pages into an otherwise valid snapshot.
        if any(os.path.lexists(str(destination) + suffix) for suffix in ('-wal', '-shm', '-journal')):
            raise FileExistsError('Destination has SQLite sidecars; choose a new database path.')
        # Same-directory hard linking publishes atomically without replacing an existing file.
        os.link(temporary, destination)
        if os.name == 'posix':
            directory = os.open(destination.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def restore_database(source, destination, *, offline=False):
    if not offline:
        raise ValueError('Stop the backend and acknowledge the offline restore with --offline.')
    backup_database(source, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('backup', 'restore'))
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--offline', action='store_true', help='acknowledge the backend is stopped for restore')
    arguments = parser.parse_args()
    try:
        if arguments.action == 'restore':
            restore_database(arguments.source, arguments.destination, offline=arguments.offline)
        else:
            backup_database(arguments.source, arguments.destination)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f'{error}\n')
    print(f'{arguments.action.capitalize()} verified: {arguments.destination}')


if __name__ == '__main__':
    main()
