# homelab-vm-provisioner-api

Express API for the `homelab-vm-provisioner` Python module.

This service stores VM configs, validates requests, calls the nested Python provisioner, exposes VM inventory/details endpoints, and provides both snapshot and streaming log access.

When this repository is checked out as part of the full `homelab-vm-provisioner-webapp` workspace, prefer the workspace root `setup`, `build`, and `start` scripts for end-to-end setup and local runs.

## Architecture

- `src/app.js`: Express routes and HTTP error handling.
- `src/validation.js`: Request schema validation with `zod`.
- `src/config-store.js`: Stores API-managed YAML configs and SSH public keys.
- `src/provisioner.js`: Spawns the Python bridge and handles log reads/streams.
- `bridge/hlvmp_bridge.py`: JSON bridge into the nested `homelab-vm-provisioner` repo.
- `homelab-vm-provisioner/`: Git submodule containing the real Python VM provisioner.

## Requirements

- Node.js 18+
- Python 3
- Nested Python provisioner dependencies installed
- A libvirt host environment if you want real VM lifecycle operations to succeed

The nested provisioner is the source of truth for actual VM creation, destruction, state inspection, and libvirt integration.

## Install

If you did not clone with submodules, initialize them first:

```bash
git submodule update --init --recursive
```

For the full workspace setup from the workspace root, including Python provisioner setup, npm installs, client build, and deployment of the client bundle into the API `public/` directory, run:

```bash
./setup
```

If system packages are already installed on the host, run:

```bash
./setup --skip-system-packages
```

For a repeatable rebuild after dependencies are already installed, run:

```bash
./build
```

1. Install Node dependencies:

```bash
npm install
```

2. Install the nested Python provisioner dependencies:

```bash
python3 -m pip install -e ./homelab-vm-provisioner
```

3. Start the API:

```bash
npm start
```

Or from the workspace root:

```bash
./start
```

The API must be started as your normal user, not as `root`.

At startup it securely runs `sudo -v` so later `virsh`/libvirt commands can use `sudo` only where needed. During the same startup preflight it also repairs ownership under the legacy API runtime directory plus the nested provisioner `configs/` and `vm/` directories so future config/state files stay user-owned.

Default port: `3000`

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Express listen port |
| `HLVMP_PROVISIONER_DIR` | `./homelab-vm-provisioner` | Path to the nested Python provisioner checkout |
| `HLVMP_API_RUNTIME_DIR` | `./runtime` | Legacy migration source for older API-managed config, key, and VM data files |
| `HLVMP_PYTHON_BIN` | `python3` | Python executable used for the bridge process |

## Provisioner Paths

The API now uses the nested Python provisioner's default directories instead of the old API-local `runtime/` folder:

- `homelab-vm-provisioner/configs/<vm>.yaml`: Saved YAML config per VM
- `homelab-vm-provisioner/vm/keys/users/<file>.pub`: Uploaded tenant SSH public keys
- `homelab-vm-provisioner/vm/scripts/<file>.sh`: Uploaded post-cloud-init setup scripts
- `homelab-vm-provisioner/vm/data/<vm>/`: Default per-VM rendered data directory
- `public/`: Built client files served by the API

If `sshPublicKey` is present in a create request, the API writes the public key to `homelab-vm-provisioner/vm/keys/users/` and rewrites `config.vm.ssh_key_file` to the resulting absolute path before saving the YAML file.

If `sshPublicKey` is omitted but `config.vm.ssh_key_file` is present, that path must already be absolute and readable on disk.

If `setupScript` is present in a create request, the API writes the script to `homelab-vm-provisioner/vm/scripts/` and rewrites `config.scripts.setup_script_file` to the resulting absolute path before saving the YAML file.

If `setupScript` is omitted but `config.scripts.setup_script_file` is present, that path must already be absolute and readable on disk.

Legacy files under `runtime/` are migrated into these provisioner-default directories during API startup.

## Developer Commands

```bash
npm test
npm run coverage
npm run docs:build
npm run build
```

Helper scripts mirroring the Python provisioner workflow are also available:

```bash
./scripts/test
./scripts/coverage
./scripts/docs-build
```

## Request Model

The main write endpoints accept this shape:

```json
{
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40,
      "allow_sudo": true,
      "trust": "trusted",
      "template": "base"
    },
    "network": {
      "mode": "nat-auto"
    },
    "packages": ["git", "tmux"],
    "ports": [
      {
        "host": 2222,
        "guest": 22,
        "proto": "tcp"
      }
    ]
  },
  "sshPublicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example",
  "setupScript": "#!/usr/bin/env bash\necho ready >/tmp/hlvmp-ready"
}
```

### Validation Rules

- `config.vm.name`: required, max 12 chars
- `config.vm.name`: must also be unique across saved configs and all libvirt VM names already present on the host
- `config.vm.user`: required
- `config.vm.ssh_key_file`: must be absolute and readable when `sshPublicKey` is not provided
- `config.vm.ram_mb`, `vcpus`, `disk_gb`: required positive integers
- `config.vm.trust`: `trusted` or `untrusted`
- `config.network.mode`: `nat-auto`, `nat-custom`, or `bridge`
- `config.network.subnet_prefix`: IPv4 prefix like `192.168.240`
- `config.network.cidr`: IPv4 `/24` CIDR
- `config.network.gateway`, `vm_ip`, `dhcp_start`, `dhcp_end`: valid IP addresses
- `config.network.mac`: valid MAC address if provided
- `config.ports[*].host` and `guest`: integers in `1..65535`
- `config.ports[*].proto`: `tcp` or `udp`
- `config.dns.resolvers[*]`: valid IP addresses
- `config.scripts.setup_script_file`: must be absolute and readable when `setupScript` is not provided
- `setupScript`: optional non-empty string
- For `nat-custom`, either `subnet_prefix` must be present or all of `cidr`, `gateway`, `vm_ip`, `dhcp_start`, and `dhcp_end` must be present
- For `bridge`, `subnet_prefix` is rejected

## API Endpoints

### `GET /health`

Simple health endpoint.

Response:

```json
{
  "ok": true
}
```

### `POST /api/vms/configs`

Validates and saves a VM config without provisioning the VM.

Request body:

```json
{
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    },
    "network": {
      "mode": "nat-auto"
    }
  },
  "sshPublicKey": "ssh-ed25519 AAAAC3... user@example"
}
```

Response `201`:

```json
{
  "vmName": "devbox",
  "keyPath": "/abs/path/homelab-vm-provisioner/vm/keys/users/devbox.pub",
  "configPath": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ssh_key_file": "/abs/path/homelab-vm-provisioner/vm/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    },
    "paths": {
      "vm_data_dir": "/abs/path/homelab-vm-provisioner/vm/data/devbox"
    },
    "network": {
      "mode": "nat-auto"
    }
  }
}
```

### `POST /api/vms`

Validates and saves a VM config, then provisions the VM through the Python bridge.

This route rejects duplicate VM names. Use `POST /api/vms/:name/provision` to create a VM later from an already-saved config.

Request body: same as `POST /api/vms/configs`

Response `201`:

```json
{
  "vmName": "devbox",
  "keyPath": "/abs/path/homelab-vm-provisioner/vm/keys/users/devbox.pub",
  "configPath": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ssh_key_file": "/abs/path/homelab-vm-provisioner/vm/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    }
  },
  "provisioned": {
    "success": true,
    "output": "Created VM\n==========\n...",
    "config_path": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml"
  }
}
```

### `GET /api/vms`

Returns the merged VM view from:

- API-managed stored configs under `homelab-vm-provisioner/configs/`
- live libvirt/provisioner inspection only for those configured VM names

This endpoint intentionally returns only VMs that have saved configs.

Response `200`:

```json
{
  "vms": [
    {
      "name": "devbox",
      "configured": true,
      "exists": true,
      "status": "running",
      "ip_address": "192.168.100.50",
      "ip_source": "lease",
      "network": {
        "mode": "nat",
        "name": "devbox-net",
        "gateway": "192.168.100.1",
        "cidr": "192.168.100.0/24",
        "vm_ip": "192.168.100.50",
        "mac": "52:54:00:12:34:56"
      },
      "ports": [
        {
          "host": 2222,
          "guest": 22,
          "proto": "tcp"
        }
      ],
      "config_path": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
      "state_path": "/abs/path/homelab-vm-provisioner/vm/state/devbox.yaml",
      "log_path": "/var/log/libvirt/qemu/devbox.log",
      "log_exists": true
    }
  ]
}
```

### `GET /api/vms/:name`

Returns detailed information for one VM. This can still succeed when a stored config exists but the live provisioner inspection fails; in that case `provisionerError` will be populated.

This endpoint only works for VM names that already have saved configs.

Response `200`:

```json
{
  "vm": {
    "name": "devbox",
    "exists": true,
    "status": "running",
    "dominfo": {
      "id": "4",
      "name": "devbox",
      "state": "running"
    },
    "ip_address": "192.168.100.50",
    "ip_source": "lease",
    "network": {
      "mode": "nat",
      "name": "devbox-net",
      "gateway": "192.168.100.1",
      "cidr": "192.168.100.0/24",
      "vm_ip": "192.168.100.50",
      "mac": "52:54:00:12:34:56"
    },
    "ports": [
      {
        "host": 2222,
        "guest": 22,
        "proto": "tcp"
      }
    ],
    "admin_private_key": "/abs/path/homelab-vm-provisioner/vm/keys/admin/devbox_admin_ed25519",
    "vm_data_dir": "/abs/path/homelab-vm-provisioner/vm/data/devbox",
    "trust": "trusted",
    "config_path": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
    "config": {
      "vm": {
        "name": "devbox",
        "user": "matt",
        "ram_mb": 4096,
        "vcpus": 2,
        "disk_gb": 40
      }
    },
    "state_path": "/abs/path/homelab-vm-provisioner/vm/state/devbox.yaml",
    "state_exists": true,
    "log_path": "/var/log/libvirt/qemu/devbox.log",
    "log_exists": true,
    "configured": true,
    "storedConfigPath": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
    "storedConfig": {
      "vm": {
        "name": "devbox",
        "user": "matt",
        "ram_mb": 4096,
        "vcpus": 2,
        "disk_gb": 40
      }
    },
    "provisionerError": null
  }
}
```

Response `404`:

```json
{
  "error": "VM was not found: devbox",
  "details": null
}
```

### `GET /api/vms/:name/config`

Returns the API-managed stored config for a VM.

Response `200`:

```json
{
  "vmName": "devbox",
  "configPath": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    }
  }
}
```

### `POST /api/vms/:name/provision`

Provisions a VM from an existing saved config under `homelab-vm-provisioner/configs/<name>.yaml`.

Use this when a config already exists and you want to create the VM later without resubmitting the whole config payload.

The saved config name must still be unique across all libvirt VMs on the host at provision time.

Response `201`:

```json
{
  "name": "devbox",
  "configPath": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml",
  "provisioned": {
    "success": true,
    "output": "Created VM\n==========\n...",
    "config_path": "/abs/path/homelab-vm-provisioner/configs/devbox.yaml"
  }
}
```

### `DELETE /api/vms/:name`

Destroys the VM through the Python provisioner bridge.

This endpoint does not delete the API-managed stored config under `homelab-vm-provisioner/configs/`. That allows the same VM definition to be reviewed or reprovisioned later.

This endpoint only operates on VM names that already have saved configs.

Response `200`:

```json
{
  "name": "devbox",
  "destroyed": {
    "success": true,
    "output": "",
    "name": "devbox"
  }
}
```

### `POST /api/vms/:name/start`

Starts a configured VM through the Python provisioner bridge.

Response `200`:

```json
{
  "name": "devbox",
  "started": {
    "success": true,
    "name": "devbox"
  }
}
```

### `POST /api/vms/:name/stop`

Stops a configured VM through the Python provisioner bridge.

Response `200`:

```json
{
  "name": "devbox",
  "stopped": {
    "success": true,
    "name": "devbox"
  }
}
```

### `POST /api/vms/:name/clone`

Creates a new saved config and clones the source VM into that new target definition.

Request body: same as `POST /api/vms/configs`

Response `201`:

```json
{
  "sourceName": "devbox",
  "vmName": "clonebox",
  "configPath": "/abs/path/homelab-vm-provisioner/configs/clonebox.yaml",
  "cloned": {
    "success": true,
    "source_name": "devbox",
    "config_path": "/abs/path/homelab-vm-provisioner/configs/clonebox.yaml"
  }
}
```

### `POST /api/vms/:name/snapshots`

Creates a restore point for a configured VM.

Response `201`:

```json
{
  "name": "devbox",
  "snapshot": {
    "success": true,
    "name": "devbox"
  }
}
```

### `POST /api/vms/:name/snapshots/:snapshotId/restore`

Restores a VM from a restore point.

Response `200`:

```json
{
  "name": "devbox",
  "snapshotId": "before-upgrade",
  "restored": {
    "success": true,
    "name": "devbox",
    "snapshotId": "before-upgrade"
  }
}
```

### `DELETE /api/vms/:name/snapshots/:snapshotId`

Deletes a restore point from a configured VM.

Response `200`:

```json
{
  "name": "devbox",
  "snapshotId": "before-upgrade",
  "deleted": {
    "success": true,
    "name": "devbox",
    "snapshotId": "before-upgrade"
  }
}
```

### `GET /api/vms/:name/logs`

Returns the latest log text from `/var/log/libvirt/qemu/<vm>.log`.

This endpoint only works for VM names that already have saved configs.

Query params:

- `lines`: optional integer, `1..5000`, default `200`

Response `200`:

```json
{
  "name": "devbox",
  "lines": 200,
  "log": "2026-06-11T10:00:00 qemu log line...\n"
}
```

### `GET /api/vms/:name/logs/stream`

Streams VM logs using Server-Sent Events.

This endpoint only works for VM names that already have saved configs.

Query params:

- `lines`: optional integer, `1..5000`, default `100`

Response headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`

Event types:

- `log`: streamed log chunks
- `error`: stderr from the `tail` process

Example stream:

```text
event: log
data: {"chunk":"2026-06-11T10:00:00 boot message\n"}

event: log
data: {"chunk":"2026-06-11T10:00:01 cloud-init finished\n"}
```

The endpoint also emits `: keep-alive` comments every 15 seconds.

## Error Responses

### Validation Failure

Response `400`:

```json
{
  "error": "Validation failed",
  "details": [
    {
      "path": "config.vm.name",
      "message": "VM names must be 12 characters or fewer"
    }
  ]
}
```

### Invalid JSON

Response `400`:

```json
{
  "error": "Request body must be valid JSON"
}
```

### Missing Stored Config or Missing Log

Response `404`:

```json
{
  "error": "Stored config was not found for VM: devbox",
  "details": null
}
```

### Duplicate Name Or Provisioner Conflict

Response `409`:

```json
{
  "error": "VM name is already in use by a saved config: devbox",
  "details": null
}
```

### Config Storage Validation

Response `422`:

```json
{
  "error": "config.vm.ssh_key_file must be an absolute path when sshPublicKey is not provided",
  "details": []
}
```

## Notes

- This API does not implement authentication yet.
- VM lifecycle behavior depends on the nested Python provisioner and the host tools it requires.
- `GET /api/vms/:name/logs` and `GET /api/vms/:name/logs/stream` read host-side libvirt QEMU logs directly.
- The bridge emits structured JSON on both success and failure so the Node layer can convert provisioner failures into HTTP responses.
