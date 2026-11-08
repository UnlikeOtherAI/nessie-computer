#!/usr/bin/python3
"""Unprivileged local software settings. No HTTP listener or remote navigation."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gio, GLib, Gtk, WebKit2  # noqa: E402

APP_ID = "works.nessie.Executor"
CLI = "/usr/bin/nessie-executor"
LAUNCHER = "/usr/bin/nessie-executor-app"
PAGE = Path(__file__).resolve().with_name("index.html").as_uri()
ACTIVE = {"downloading", "waiting", "installing", "restarting"}


def update_arguments(request):
    """Translate a finite protocol, never a command line supplied by the page."""
    if not isinstance(request, dict):
        raise ValueError("Invalid update request")
    operation = request.get("operation")
    if operation in ("status", "check", "install", "remind") and set(request) == {"operation"}:
        return ["updates", operation, "--json"]
    if (operation == "automatic" and set(request) == {"operation", "enabled"}
            and isinstance(request["enabled"], bool)):
        return ["updates", "automatic", "on" if request["enabled"] else "off", "--json"]
    raise ValueError("Unsupported update request")


def read_update(request):
    arguments = update_arguments(request)
    environment = {key: value for key, value in os.environ.items() if key not in {
        "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
        "PYTHONPATH", "PYTHONHOME", "NESSIE_EXECUTOR_PACKAGED_CLI",
    }}
    result = subprocess.run([CLI, *arguments], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            cwd="/", env=environment, timeout=15, check=True)
    if len(result.stdout) > 16384:
        raise ValueError("Oversized update status")
    status = json.loads(result.stdout)
    if (not isinstance(status, dict) or not isinstance(status.get("installedVersion"), str)
            or not isinstance(status.get("canInstall"), bool)):
        raise ValueError("Invalid update status")
    return status


class ExecutorSettings(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.add_main_option("background", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             "Monitor local update offers without opening a window.", None)
        self.window = None
        self.view = None
        self.polling = False
        self.announced = None
        self.installed_version = None
        self.requests = 0
        self.work = concurrent.futures.ThreadPoolExecutor(max_workers=2)

    def do_startup(self):
        Gtk.Application.do_startup(self)
        self.hold()
        GLib.timeout_add_seconds(15, self.poll)
        self.poll({"operation": "check"})

    def do_command_line(self, command):
        if "--background" not in command.get_arguments()[1:]:
            self.activate()
        return 0

    def do_activate(self):
        if self.window is None:
            self.create_window()
        self.window.present()

    def create_window(self):
        self.window = Gtk.ApplicationWindow(application=self, title="Nessie Executor")
        self.window.set_default_size(640, 520)
        self.window.set_icon_name("computer-symbolic")
        self.window.connect("delete-event", lambda window, _event: window.hide_on_delete())
        manager = WebKit2.UserContentManager()
        manager.connect("script-message-received::executor", self.message)
        manager.register_script_message_handler("executor")
        self.view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(),
                                   user_content_manager=manager)
        settings = self.view.get_settings()
        settings.set_allow_file_access_from_file_urls(False)
        settings.set_allow_universal_access_from_file_urls(False)
        settings.set_enable_developer_extras(False)
        self.view.connect("decide-policy", self.navigation)
        self.view.connect("permission-request", lambda _view, request: request.deny() or True)
        self.view.get_context().connect("download-started", lambda _context, download: download.cancel())
        self.view.load_uri(PAGE)
        self.window.add(self.view)
        self.window.show_all()

    @staticmethod
    def navigation(_view, decision, decision_type):
        if decision_type in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
                             WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            if decision.get_navigation_action().get_request().get_uri() != PAGE:
                decision.ignore()
                return True
        return False

    def query(self, request, complete):
        if self.requests >= 4:
            complete(None, True)
            return
        self.requests += 1
        future = self.work.submit(read_update, request)

        def finished(result):
            try:
                value, failed = result.result(), False
            except (OSError, ValueError, subprocess.SubprocessError):
                value, failed = None, True
            GLib.idle_add(deliver, value, failed)

        def deliver(value, failed):
            self.requests -= 1
            complete(value, failed)
            return False

        future.add_done_callback(finished)

    def message(self, _manager, result):
        if self.view.get_uri() != PAGE:
            return
        try:
            raw = result.get_js_value().to_json(0)
            if len(raw) > 4096:
                return
            message = json.loads(raw)
            if not isinstance(message, dict) or set(message) != {"id", "command", "args"}:
                return
            request_id = message["id"]
            if type(request_id) is not int or not 0 < request_id < 2147483647:
                return
            if message["command"] != "executor_update_control":
                raise ValueError("Unsupported console command")
            args = message["args"]
            if not isinstance(args, dict) or set(args) != {"request"}:
                raise ValueError("Invalid console arguments")
            update_arguments(args["request"])
            self.query(args["request"], lambda value, failed: self.reply(request_id, value, failed))
        except (ValueError, TypeError, KeyError):
            if isinstance(locals().get("request_id"), int):
                self.reply(request_id, None, True)

    def reply(self, request_id, value, failed):
        if self.view is not None and self.view.get_uri() == PAGE:
            script = "window.executorLinuxReply(" + json.dumps(request_id) + "," \
                + json.dumps(value, ensure_ascii=True) + "," + json.dumps(failed) + ")"
            self.view.evaluate_javascript(script, -1, None, None, None, None, None)

    def poll(self, request=None):
        if self.polling:
            return True
        self.polling = True

        def complete(status, failed):
            self.polling = False
            if failed:
                return
            version = status["installedVersion"]
            if self.installed_version is not None and version != self.installed_version:
                arguments = [LAUNCHER]
                if self.window is None or not self.window.get_visible():
                    arguments.append("--background")
                # The fixed root-owned package launcher selects the new console.
                os.execv(LAUNCHER, arguments)
            self.installed_version = version
            offer = (status.get("notify") is True and status.get("automatic") is False
                     and status["canInstall"] and status.get("availableVersion")
                     and status.get("phase") not in ACTIVE)
            if not offer:
                self.announced = None
            elif self.announced != status["availableVersion"]:
                self.announced = status["availableVersion"]
                self.activate()
                # The shared page reads status and presents its durable reminder dialog.
                if self.view.get_uri() == PAGE:
                    self.view.evaluate_javascript(
                        "window.dispatchEvent(new CustomEvent('executor://update-available'))",
                        -1, None, None, None, None, None)

        self.query(request or {"operation": "status"}, complete)
        return True


if __name__ == "__main__":
    raise SystemExit(ExecutorSettings().run(sys.argv))
