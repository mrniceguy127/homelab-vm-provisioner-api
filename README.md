# homelab-vm-provisioner-api

Express API for the `homelab-vm-provisioner` Python module.

This service stores VM configs, validates requests, calls the nested Python provisioner, exposes VM inventory/details endpoints, and provides both snapshot and streaming log access.

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

1. Initialize submodules:

```bash
git submodule update --init --recursive
```

2. Install Node dependencies:

```bash
npm install
```

3. Install the nested Python provisioner dependencies:

```bash
python3 -m pip install -e ./homelab-vm-provisioner
```

4. Start the API:

```bash
npm start
```

Default port: `3000`

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Express listen port |
| `HLVMP_PROVISIONER_DIR` | `./homelab-vm-provisioner` | Path to the nested Python provisioner checkout |
| `HLVMP_API_RUNTIME_DIR` | `./runtime` | Root for saved configs, user SSH keys, and VM data paths managed by the API |
| `HLVMP_PYTHON_BIN` | `python3` | Python executable used for the bridge process |

## Runtime Files

The API writes its own runtime-managed files under `runtime/` by default:

- `runtime/configs/<vm>.yaml`: Saved YAML config per VM
- `runtime/keys/users/<file>.pub`: Uploaded tenant SSH public keys
- `runtime/vm-data/<vm>/`: Default generated `paths.vm_data_dir` used in saved configs

If `sshPublicKey` is present in a create request, the API writes the public key to `runtime/keys/users/` and rewrites `config.vm.ssh_key_file` to the resulting absolute path before saving the YAML file.

If `sshPublicKey` is omitted but `config.vm.ssh_key_file` is present, that path must already be absolute and readable on disk.

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
  "sshPublicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example"
}
```

### Validation Rules

- `config.vm.name`: required, max 12 chars
- `config.vm.user`: required
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
  "keyPath": "/abs/path/runtime/keys/users/devbox.pub",
  "configPath": "/abs/path/runtime/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ssh_key_file": "/abs/path/runtime/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    },
    "paths": {
      "vm_data_dir": "/abs/path/runtime/vm-data/devbox"
    },
    "network": {
      "mode": "nat-auto"
    }
  }
}
```

### `POST /api/vms`

Validates and saves a VM config, then provisions the VM through the Python bridge.

Request body: same as `POST /api/vms/configs`

Response `201`:

```json
{
  "vmName": "devbox",
  "keyPath": "/abs/path/runtime/keys/users/devbox.pub",
  "configPath": "/abs/path/runtime/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ssh_key_file": "/abs/path/runtime/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    }
  },
  "provisioned": {
    "success": true,
    "output": "Created VM\n==========\n...",
    "config_path": "/abs/path/runtime/configs/devbox.yaml"
  }
}
```

### `GET /api/vms`

Returns the merged VM view from:

- libvirt and provisioner state via the Python bridge
- API-managed stored configs under `runtime/configs/`

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
      "config_path": "/abs/path/runtime/configs/devbox.yaml",
      "state_path": "/abs/path/homelab-vm-provisioner/vm/state/devbox.yaml",
      "log_path": "/var/log/libvirt/qemu/devbox.log",
      "log_exists": true
    }
  ]
}
```

### `GET /api/vms/:name`

Returns detailed information for one VM. This can still succeed when a stored config exists but the live provisioner inspection fails; in that case `provisionerError` will be populated.

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
    "vm_data_dir": "/abs/path/runtime/vm-data/devbox",
    "trust": "trusted",
    "config_path": "/abs/path/runtime/configs/devbox.yaml",
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
    "storedConfigPath": "/abs/path/runtime/configs/devbox.yaml",
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
  "configPath": "/abs/path/runtime/configs/devbox.yaml",
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

### `DELETE /api/vms/:name`

Destroys the VM through the Python provisioner bridge.

This endpoint does not delete the API-managed stored config under `runtime/configs/`. That allows the same VM definition to be reviewed or reprovisioned later.

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

### `GET /api/vms/:name/logs`

Returns the latest log text from `/var/log/libvirt/qemu/<vm>.log`.

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

### Bridge/Provisioner Conflict

Response `409`:

```json
{
  "error": "VM not found: devbox",
  "details": {
    "success": false,
    "error": {
      "type": "RuntimeError",
      "message": "VM not found: devbox"
    }
  }
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
