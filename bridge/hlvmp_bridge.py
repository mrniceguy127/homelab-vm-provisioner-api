#!/usr/bin/env python3
"""JSON bridge between the Express API and ``homelab_vm_provisioner``.

This script loads the Python provisioner checkout, exposes a small CLI
surface for VM lifecycle and inspection operations, and always emits JSON so
the Node layer can map results and failures into HTTP responses.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
from pathlib import Path


API_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE_ROOT = API_ROOT.parent
PROVISIONER_ROOT = Path(
    __import__("os").environ.get("PROVISIONER_CLI_PATH")
    or WORKSPACE_ROOT / "homelab-vm-provisioner-cli"
)

if not PROVISIONER_ROOT.is_absolute():
    PROVISIONER_ROOT = WORKSPACE_ROOT / PROVISIONER_ROOT

if str(PROVISIONER_ROOT) not in sys.path:
    sys.path.insert(0, str(PROVISIONER_ROOT))

IMPORT_ERROR = None

try:
    from homelab_vm_provisioner.cli import (  # noqa: E402
        clone,
        create,
        destroy,
        list_snapshots,
        reconcile_networking,
        snapshot_create,
        snapshot_delete,
        snapshot_restore,
        start,
        stop,
    )
    from homelab_vm_provisioner.config import (  # noqa: E402
        default_vm_state_root,
        load_config,
        load_vm_state,
        state_file_for_vm,
    )
    from homelab_vm_provisioner.network import discover_vm_network, resolve_vm_ipv4  # noqa: E402
    from homelab_vm_provisioner.provision import vm_exists  # noqa: E402
except Exception as exc:  # pragma: no cover - environment bootstrap path
    IMPORT_ERROR = exc


class BridgeActionExitError(RuntimeError):
    """Raised when a provisioner action exits without returning normally."""

    def __init__(self, exit_code, output_text=""):
        self.details = {
            "code": "action_exited",
            "exit_code": exit_code,
            "output": output_text or None,
        }
        message = output_text or f"Provisioner action exited with status {exit_code}"
        super().__init__(message)


def emit(payload, exit_code=0):
    """Print a JSON payload and terminate the process.

    Args:
        payload: JSON-serializable response body.
        exit_code: Process exit code used when terminating.

    Raises:
        SystemExit: Always raised after the payload is printed.
    """

    print(json.dumps(payload, default=str))
    raise SystemExit(exit_code)


def capture_action(action, *args, **kwargs):
    """Capture stdout produced by a provisioner callable.

    Args:
        action: Callable imported from the provisioner.
        *args: Positional arguments passed to ``action``.

    Returns:
        str: Trimmed standard output produced by the action.

    Raises:
        Exception: Propagates any exception raised by ``action``.
    """

    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            action(*args, **kwargs)
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
        if exit_code in (0, None):
            return output.getvalue().strip()
        raise BridgeActionExitError(exit_code, output.getvalue().strip()) from exc

    return output.getvalue().strip()


def capture_action_result(action, *args, **kwargs):
    """Capture stdout and the return value produced by a provisioner callable."""

    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = action(*args, **kwargs)
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
        if exit_code in (0, None):
            return None, output.getvalue().strip()
        raise BridgeActionExitError(exit_code, output.getvalue().strip()) from exc

    return result, output.getvalue().strip()


def read_dominfo(vm_name):
    """Return parsed ``virsh dominfo`` output when available.

    Args:
        vm_name: Name of the VM to inspect.

    Returns:
        dict[str, str] | None: Parsed key-value pairs from ``virsh dominfo``,
        or ``None`` when the command fails.
    """

    result = subprocess.run(
        ["sudo", "virsh", "dominfo", vm_name],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None

    info = {}
    for line in result.stdout.splitlines():
        if ":" not in line:
            continue

        key, value = line.split(":", 1)
        info[key.strip().lower().replace(" ", "_")] = value.strip()

    return info


def list_virsh_vms():
    """Return VM names known to libvirt.

    Returns:
        list[str]: VM names returned by ``virsh list --all --name``.
        Returns an empty list when ``virsh`` is unavailable or the command
        fails.
    """

    result = subprocess.run(
        ["sudo", "virsh", "list", "--all", "--name"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []

    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def known_vm_names():
    """Return VM names from libvirt and persisted state files.

    Returns:
        list[str]: Sorted union of VM names known to libvirt and names inferred
        from provisioner state files.
    """

    names = set(list_virsh_vms())
    state_root = default_vm_state_root()
    if state_root.exists():
        for state_file in state_root.glob("*.yaml"):
            names.add(state_file.stem)

    return sorted(names)


def inspect_vm(vm_name):
    """Return a JSON-serializable snapshot for a VM.

    Args:
        vm_name: Name of the VM to inspect.

    Returns:
        dict[str, object]: Aggregated VM information from provisioner state,
        libvirt inspection, network discovery, and log file presence checks.
    """

    state = load_vm_state(vm_name)
    state_path = state_file_for_vm(vm_name)
    config_path = state.get("config_path")
    config_data = None
    if config_path and Path(config_path).exists():
        config_data = load_config(config_path)

    dominfo = read_dominfo(vm_name)
    ip_address, ip_source = resolve_vm_ipv4(vm_name)
    network = dict(state.get("network") or {})
    discovered_network = discover_vm_network(vm_name)
    if discovered_network:
        network.update(discovered_network)

    log_path = Path("/var/log/libvirt/qemu") / f"{vm_name}.log"

    return {
        "name": vm_name,
        "exists": vm_exists(vm_name),
        "status": dominfo.get("state") if dominfo else "unknown",
        "dominfo": dominfo,
        "ip_address": ip_address,
        "ip_source": ip_source,
        "network": network or None,
        "ports": state.get("ports") or [],
        "admin_private_key": state.get("admin_private_key"),
        "vm_data_dir": state.get("vm_data_dir"),
        "trust": state.get("trust"),
        "config_path": config_path,
        "config": config_data,
        "state_path": str(state_path),
        "state_exists": state_path.exists(),
        "log_path": str(log_path),
        "log_exists": log_path.exists(),
        "snapshots": list_snapshots(vm_name),
    }


def handle_create(config_path):
    """Create a VM from a config file and emit a JSON response.

    Args:
        config_path: Path to the YAML config file passed to the provisioner.

    Raises:
        Exception: Propagates provisioner errors.
        SystemExit: Raised by :func:`emit` after printing the JSON response.
    """

    output = capture_action(create, config_path)
    emit({"success": True, "output": output, "config_path": config_path})


def handle_destroy(vm_name):
    """Destroy a VM by name and emit a JSON response.

    Args:
        vm_name: Name of the VM to destroy.

    Raises:
        Exception: Propagates provisioner errors.
        SystemExit: Raised by :func:`emit` after printing the JSON response.
    """

    output = capture_action(destroy, vm_name)
    emit({"success": True, "output": output, "name": vm_name})


def handle_start(vm_name):
    """Start a VM and emit a JSON response."""
    output = capture_action(start, vm_name)
    emit({"success": True, "output": output, "name": vm_name})


def handle_stop(vm_name):
    """Stop a VM and emit a JSON response."""
    output = capture_action(stop, vm_name)
    emit({"success": True, "output": output, "name": vm_name})


def handle_clone(source_vm_name, config_path):
    """Clone a VM disk into a new VM and emit a JSON response."""
    output = capture_action(clone, source_vm_name, config_path)
    emit(
        {
            "success": True,
            "output": output,
            "source_name": source_vm_name,
            "config_path": config_path,
        }
    )


def handle_snapshot_create(vm_name):
    """Create a restore point and emit a JSON response."""
    output = capture_action(snapshot_create, vm_name)
    emit({"success": True, "output": output, "name": vm_name, "snapshots": list_snapshots(vm_name)})


def handle_snapshot_restore(vm_name, snapshot_id):
    """Restore a VM from a restore point and emit a JSON response."""
    output = capture_action(snapshot_restore, vm_name, snapshot_id)
    emit({"success": True, "output": output, "name": vm_name, "snapshot_id": snapshot_id})


def handle_snapshot_delete(vm_name, snapshot_id):
    """Delete a restore point and emit a JSON response."""
    output = capture_action(snapshot_delete, vm_name, snapshot_id)
    emit({"success": True, "output": output, "name": vm_name, "snapshot_id": snapshot_id})


def handle_reconcile(policy_only=False, allow_destructive=False):
    """Reconcile managed networking and emit a JSON response."""
    result, output = capture_action_result(
        reconcile_networking,
        policy_only=policy_only,
        allow_destructive=allow_destructive,
    )
    emit(
        {
            "success": True,
            "reconciled": result,
            "output": output,
        }
    )


def handle_list():
    """Emit a JSON response containing all known VMs.

    Raises:
        SystemExit: Raised by :func:`emit` after printing the JSON response.
    """

    emit({"vms": [inspect_vm(vm_name) for vm_name in known_vm_names()]})


def handle_host_list():
    """Emit a JSON response containing all libvirt VM names on the host.

    Returns only names returned by ``virsh list --all --name`` and does not add
    persisted state-only entries.

    Raises:
        SystemExit: Raised by :func:`emit` after printing the JSON response.
    """

    emit({"vms": list_virsh_vms()})


def handle_inspect(vm_name):
    """Emit a JSON response containing one VM snapshot.

    Args:
        vm_name: Name of the VM to inspect.

    Raises:
        SystemExit: Raised by :func:`emit` after printing the JSON response.
    """

    emit({"vm": inspect_vm(vm_name)})


def build_parser():
    """Build the bridge CLI argument parser.

    Returns:
        argparse.ArgumentParser: Parser for bridge lifecycle commands.
    """

    parser = argparse.ArgumentParser()
    parser.add_argument("--policy-only", action="store_true")
    parser.add_argument("--allow-destructive", action="store_true")
    parser.add_argument(
        "command",
        choices=(
            "create",
            "destroy",
            "start",
            "stop",
            "clone",
            "snapshot-create",
            "snapshot-restore",
            "snapshot-delete",
            "reconcile",
            "inspect",
            "list",
            "host-list",
        ),
    )
    parser.add_argument("values", nargs="*")
    return parser


def main():
    """Run the selected bridge command and emit structured JSON.

    Raises:
        SystemExit: Raised by :func:`emit` for both success and failure paths.
    """

    parser = build_parser()
    args = parser.parse_args()

    try:
        if IMPORT_ERROR is not None:
            raise IMPORT_ERROR

        if args.command != "reconcile" and (args.policy_only or args.allow_destructive):
            raise ValueError("Reconcile flags are only valid with the reconcile command")

        if args.command == "create":
            if len(args.values) != 1:
                raise ValueError("create requires a config path")
            handle_create(args.values[0])

        elif args.command == "destroy":
            if len(args.values) != 1:
                raise ValueError("destroy requires a VM name")
            handle_destroy(args.values[0])

        elif args.command == "start":
            if len(args.values) != 1:
                raise ValueError("start requires a VM name")
            handle_start(args.values[0])

        elif args.command == "stop":
            if len(args.values) != 1:
                raise ValueError("stop requires a VM name")
            handle_stop(args.values[0])

        elif args.command == "clone":
            if len(args.values) != 2:
                raise ValueError("clone requires a source VM name and target config path")
            handle_clone(args.values[0], args.values[1])

        elif args.command == "snapshot-create":
            if len(args.values) != 1:
                raise ValueError("snapshot-create requires a VM name")
            handle_snapshot_create(args.values[0])

        elif args.command == "snapshot-restore":
            if len(args.values) != 2:
                raise ValueError("snapshot-restore requires a VM name and snapshot ID")
            handle_snapshot_restore(args.values[0], args.values[1])

        elif args.command == "snapshot-delete":
            if len(args.values) != 2:
                raise ValueError("snapshot-delete requires a VM name and snapshot ID")
            handle_snapshot_delete(args.values[0], args.values[1])

        elif args.command == "reconcile":
            if args.values:
                raise ValueError("reconcile does not accept additional arguments")
            handle_reconcile(
                policy_only=args.policy_only,
                allow_destructive=args.allow_destructive,
            )

        elif args.command == "inspect":
            if len(args.values) != 1:
                raise ValueError("inspect requires a VM name")
            handle_inspect(args.values[0])

        elif args.command == "host-list":
            handle_host_list()

        else:
            handle_list()
    except Exception as exc:  # pragma: no cover - bridge error path
        emit(
            {
                "success": False,
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "details": getattr(exc, "details", None),
                },
            },
            exit_code=1,
        )


if __name__ == "__main__":
    main()
