"""Bounded, synthetic-only startup probe; never imported by production."""

import faulthandler
import sys
import time


def main():
    started = time.monotonic()

    def stage(name):
        print(f"desktop-diagnostic stage={name} elapsed={time.monotonic() - started:.3f}",
              file=sys.stderr, flush=True)

    faulthandler.enable(file=sys.stderr)
    faulthandler.dump_traceback_later(30, repeat=False, file=sys.stderr)
    try:
        stage("offline_guard_start")
        from tests import _offline_network_guard  # noqa: F401

        stage("offline_guard_ready")
        from offerpilot import desktop

        stage("desktop_import_ready")
        original_create = desktop.create_desktop_app
        original_run = desktop._DesktopServer.run

        def create(*args, **kwargs):
            stage("create_app_start")
            result = original_create(*args, **kwargs)
            stage("create_app_ready")
            return result

        def run(self, *args, **kwargs):
            stage("server_run_start")
            try:
                return original_run(self, *args, **kwargs)
            finally:
                stage("server_run_return")

        desktop.create_desktop_app = create
        desktop._DesktopServer.run = run
        return desktop.main()
    finally:
        faulthandler.cancel_dump_traceback_later()
        stage("bootstrap_return")


if __name__ == "__main__":
    raise SystemExit(main())
