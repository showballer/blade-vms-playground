"""SQLite handle lifetime regressions; retained references prevent GC hiding leaks."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from blade_acquisition.storage import RecordingStore


class StorageConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.real_connect = sqlite3.connect

    @contextmanager
    def track(self, configure=None, factory=sqlite3.Connection):
        connections = []

        def connect(*args, **kwargs):
            database = self.real_connect(*args, **kwargs, factory=factory)
            connections.append(database)
            if configure:
                configure(database)
            return database

        with patch("blade_acquisition.storage.sqlite3.connect", side_effect=connect):
            try:
                yield connections
            finally:
                # Test cleanup only, after assertions have checked production close.
                # Retaining these references keeps a missing close reproducible on POSIX too.
                for database in connections:
                    database.close()

    def assert_closed(self, connections):
        self.assertTrue(connections, "Expected at least one real SQLite connection")
        for database in connections:
            with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed database"):
                database.execute("SELECT 1")

    def test_successful_initialization_updates_and_reads_close_and_commit(self):
        with self.track() as connections:
            store = RecordingStore(self.root)
            self.assert_closed(connections)
            writer = store.create({"name": "closed index handles"})
            self.assert_closed(connections)
            writer.finish(None)
            self.assert_closed(connections)
            records = store.list()
            self.assertEqual(records[0]["id"], writer.id)
            self.assertEqual(records[0]["status"], "complete", "A new connection must read committed data")
            self.assert_closed(connections)
            # A live SQLite handle prevents this on Windows even if POSIX allowed it.
            renamed = self.root / "index-rename-check.sqlite3"
            store.index_path.rename(renamed)
            renamed.rename(store.index_path)

    def test_corrupt_index_handle_closes_before_original_is_renamed(self):
        store = RecordingStore(self.root)
        writer = store.create({"name": "recover from manifests"})
        writer.finish(None)
        store.index_path.write_bytes(b"test fixture corrupt sqlite, not production data")
        real_rename = Path.rename
        with self.track() as connections:
            def rename(source, destination):
                self.assert_closed(connections)
                return real_rename(source, destination)

            with patch.object(Path, "rename", rename):
                recovered = RecordingStore(self.root)
            self.assert_closed(connections)
            self.assertEqual(recovered.list()[0]["id"], writer.id)
            self.assert_closed(connections)
            self.assertEqual(len(list(self.root.glob("recordings-corrupt-*.sqlite3"))), 1)

    def test_initialization_operational_error_closes_without_renaming(self):
        class LockedIndex(sqlite3.Connection):
            def execute(self, query, *args, **kwargs):
                raise sqlite3.OperationalError("fixture index locked")

        with self.track(factory=LockedIndex) as connections:
            with self.assertRaisesRegex(sqlite3.OperationalError, "index locked"):
                RecordingStore(self.root)
            # Call the base method because the fixture overrides execute.
            for database in connections:
                with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed database"):
                    sqlite3.Connection.execute(database, "SELECT 1")
        self.assertTrue((self.root / "recordings.sqlite3").exists())
        self.assertEqual(list(self.root.glob("recordings-corrupt-*")), [])

    def test_failed_write_rolls_back_and_closes_before_error_is_reported(self):
        store = RecordingStore(self.root)

        class FailedWrite(sqlite3.Connection):
            def execute(self, query, *args, **kwargs):
                result = super().execute(query, *args, **kwargs)
                if query.startswith("INSERT"):
                    raise sqlite3.OperationalError("fixture error after insert")
                return result

        with self.track(factory=FailedWrite) as connections:
            store.update_index({"id": "a" * 32, "startedAt": 1, "name": "must roll back"})
            self.assertIn("error after insert", store.index_error)
            self.assert_closed(connections)
        self.assertEqual(store.list(), [], "Failed transaction must not commit the inserted row")

    def test_commit_error_rolls_back_and_closes(self):
        store = RecordingStore(self.root)
        transactions = []

        def configure(database):
            def authorize(action, argument, *_):
                if action == sqlite3.SQLITE_TRANSACTION:
                    transactions.append(argument)
                    if argument == "COMMIT":
                        return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK

            database.set_authorizer(authorize)

        with self.track(configure=configure) as connections:
            store.update_index({"id": "b" * 32, "startedAt": 2, "name": "commit denied"})
            self.assertIsNotNone(store.index_error)
            self.assertIn("COMMIT", transactions)
            self.assertIn("ROLLBACK", transactions)
            self.assert_closed(connections)
        self.assertEqual(store.list(), [])

    def test_failed_read_closes_before_manifest_fallback(self):
        store = RecordingStore(self.root)
        writer = store.create({"name": "fallback survives"})
        writer.finish(None)

        class FailedRead(sqlite3.Connection):
            def execute(self, query, *args, **kwargs):
                if query.startswith("SELECT manifest"):
                    raise sqlite3.DatabaseError("fixture read failure")
                return super().execute(query, *args, **kwargs)

        with self.track(factory=FailedRead) as connections:
            self.assertEqual(store.list()[0]["id"], writer.id)
            self.assert_closed(connections)

    def test_worker_threads_keep_separate_connections_and_close_them(self):
        store = RecordingStore(self.root)
        close_results = []

        class ThreadConnection(sqlite3.Connection):
            def close(self):
                super().close()
                close_results.append(True)

        def write_and_read(index):
            store.update_index({"id": f"{index:032x}", "startedAt": index, "name": "thread fixture"})
            return store.list()

        created = []

        def connect(*args, **kwargs):
            database = self.real_connect(*args, **kwargs, factory=ThreadConnection)
            created.append(database)
            return database

        with patch("blade_acquisition.storage.sqlite3.connect", side_effect=connect):
            with ThreadPoolExecutor(max_workers=4) as workers:
                results = list(workers.map(write_and_read, range(8)))
        self.assertTrue(all(results))
        self.assertEqual(len(created), 16)
        self.assertEqual(len(close_results), len(created), "Each worker connection must close in its owning thread")
        self.assertEqual(len(store.list()), 8)
