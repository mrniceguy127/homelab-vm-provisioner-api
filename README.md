# homelab-vm-provisioner-api

Express API for the `homelab-vm-provisioner-cli` Python module.

This service stores VM configs, validates requests, calls the Python provisioner, exposes VM inventory/details endpoints, and provides both snapshot and streaming log access.

When this repository is checked out as part of the full `homelab-vm-provisioner` workspace, prefer the workspace root `setup`, `build`, and `start` scripts for end-to-end setup and local runs.

## Architecture

- `src/app.js`: Express routes and HTTP error handling.
- `src/validation.js`: Request schema validation with `zod`.
- `src/config-store.js`: Stores API-managed YAML configs and SSH public keys.
- `src/network-model.js`: Persists tenant/network-group metadata, allocates `/28` subnets, and enriches saved VM configs with stable owner/network identity.
- `src/provisioner.js`: Spawns the Python bridge and handles log reads/streams.
- `bridge/hlvmp_bridge.py`: JSON bridge into the workspace `homelab-vm-provisioner-cli` repo.
- `../homelab-vm-provisioner-cli/`: Git submodule containing the real Python VM provisioner.

## Requirements

- Node.js 18+
- Python 3
- Python provisioner dependencies installed
- A libvirt host environment if you want real VM lifecycle operations to succeed

The provisioner repo is the source of truth for actual VM creation, destruction, state inspection, and libvirt integration.

## Install

If you did not clone with submodules, initialize them first:

```bash
git submodule update --init --recursive
```

For the full workspace setup from the workspace root, including Python provisioner setup and npm installs, run:

```bash
./setup
```

If system packages are already installed on the host, run:

```bash
./setup --skip-system-packages
```

After setup completes, build the workspace:

```bash
./build
```

For a rebuild after dependencies are already installed, just run `./build`.
./build
```

1. Install Node dependencies:

```bash
npm install
```

2. Install the Python provisioner dependencies:

```bash
python3 -m pip install -e ../homelab-vm-provisioner-cli
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

At startup it securely runs `sudo -v` so later `virsh`/libvirt commands can use `sudo` only where needed. During the same startup preflight it also repairs ownership under the legacy API runtime directory plus the provisioner `configs/` and `vm/` directories so future config/state files stay user-owned.

Default port: `3001`

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Express listen port |
| `PROVISIONER_CLI_PATH` | `../homelab-vm-provisioner-cli` | Path to the Python provisioner checkout |
| `PROVISIONER_DATA_DIR` | `data` | Provisioner data root resolved relative to the provisioner checkout |
| `HLVMP_API_RUNTIME_DIR` | `./runtime` | Legacy migration source for older API-managed config, key, and VM data files |
| `HLVMP_NETWORK_POOL_CIDR` | `10.80.0.0/16` | Global private pool used for managed network-group subnet allocation |
| `HLVMP_NETWORK_GROUP_PREFIX_LENGTH` | `28` | Prefix length assigned to each new network group |
| `HLVMP_PYTHON_BIN` | `python3` | Python executable used for the bridge process |

## Provisioner Paths

The API now uses the provisioner repo's default directories instead of the old API-local `runtime/` folder:

- `../homelab-vm-provisioner-cli/data/configs/<vm>.yaml`: Saved YAML config per VM
- `../homelab-vm-provisioner-cli/data/vm/metadata/users.json`: Persisted tenant/user records
- `../homelab-vm-provisioner-cli/data/vm/metadata/network-groups.json`: Persisted network-group records and subnet allocations
- `../homelab-vm-provisioner-cli/data/vm/keys/users/<file>.pub`: Uploaded tenant SSH public keys
- `../homelab-vm-provisioner-cli/data/vm/scripts/<file>.sh`: Uploaded post-cloud-init setup scripts
- `../homelab-vm-provisioner-cli/data/vm/data/<vm>/`: Default per-VM rendered data directory
- `public/`: Built client files served by the API

If `sshPublicKey` is present in a create request, the API writes the public key to `../homelab-vm-provisioner-cli/data/vm/keys/users/` and rewrites `config.vm.ssh_key_file` to a provisioner-data-relative path before saving the YAML file.

If `sshPublicKey` is omitted but `config.vm.ssh_key_file` is present, it may be provisioner-data-relative or absolute, and must resolve to a readable file.

If `setupScript` is present in a create request, the API writes the script to `../homelab-vm-provisioner-cli/data/vm/scripts/` and rewrites `config.scripts.setup_script_file` to a provisioner-data-relative path before saving the YAML file.

If `setupScript` is omitted but `config.scripts.setup_script_file` is present, it may be provisioner-data-relative or absolute, and must resolve to a readable file.

Legacy files under `runtime/` are migrated into these provisioner-default directories during API startup.

## Tenant Networking Model

Networking is now tenant and network-group based instead of one flat VM network.

- one `users.json` record per tenant/user
- one `network-groups.json` record per tenant-owned libvirt network group
- one libvirt network per network group
- one `/28` subnet per network group by default, allocated from `HLVMP_NETWORK_POOL_CIDR`
- one stable MAC/IP reservation per VM inside its assigned network group
- same-group traffic allowed by default and overrideable per VM
- hypervisor host access allowed by default and overrideable per VM
- private LAN access denied by default and enabled only per VM for admin-owned VMs
- port forwarding modeled per VM and reconciled against the VM's assigned managed IP

The managed networking reconciler now renders VM policy into application-owned nftables tables. See `docs/vm-networking-nftables.md` for the table schema, reconcile flow, rollback, and verification checklist.

## Developer Commands

**Build** (docs only, no tests):
```bash
npm run build
```

**Test**:
```bash
npm test              # Lint + unit tests
npm run coverage      # Lint + tests + coverage report
```

**Docs**:
```bash
npm run docs:build
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
      "owner_user_id": "user-admin",
      "network_group_id": "ng-admin",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40,
      "allow_sudo": true,
      "allow_same_group_traffic": true,
      "allow_host_access": true,
      "allow_private_lan_access": false,
      "internet_access": true,
      "trust": "trusted",
      "template": "base"
    },
    "packages": ["git", "tmux"],
    "ports": [
      {
        "host": 2222,
        "guest": 22,
        "proto": "tcp",
        "description": "SSH",
        "enabled": true
      }
    ]
  },
  "sshPublicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example",
  "setupScript": "#!/usr/bin/env bash\necho ready >/tmp/hlvmp-ready"
}
```

### Validation Rules

- `config.vm.name`: required, max 63 chars
- `config.vm.name`: must also be unique across saved configs and all libvirt VM names already present on the host
- `config.vm.user`: required
- `config.vm.owner_user_id`: optional in requests, auto-filled to the default admin tenant when omitted
- `config.vm.network_group_id`: optional in requests, auto-filled to the default owner group when omitted
- `config.vm.ssh_key_file`: must be absolute and readable when `sshPublicKey` is not provided
- `config.vm.ram_mb`, `vcpus`, `disk_gb`: required positive integers
- `config.vm.trust`: `trusted` or `untrusted`
- `config.vm.allow_same_group_traffic`, `allow_host_access`, `allow_private_lan_access`, `internet_access`: optional booleans controlling per-VM network policy
- `config.network.*`: managed by the API and reconciler; create requests only need the `vm.network_group_id` reference
- `config.ports[*].host` and `guest`: integers in `1..65535`
- `config.ports[*].proto`: `tcp` or `udp`
- `config.ports[*].enabled`: optional boolean
- `config.ports[*].description`: optional text label
- `config.dns.resolvers[*]`: valid IP addresses
- `config.scripts.setup_script_file`: must be absolute and readable when `setupScript` is not provided
- `setupScript`: optional non-empty string

## API Endpoints

### `GET /health`

Simple health endpoint.

Response:

```json
{
  "ok": true
}
```

### `GET /api/users`

Returns persisted tenant/user records. The current migration creates one default admin user when none exists yet.

### `GET /api/network-groups`

Returns persisted network-group records, including allocated subnet and profile metadata.

### `POST /api/network-groups`

Creates a new tenant-owned network group. New groups allocate the first free `/28` from `HLVMP_NETWORK_POOL_CIDR` unless a specific imported subnet is supplied during migration.

Request body:

```json
{
  "ownerUserId": "user-admin",
  "name": "default-admin",
  "profile": "isolated_nat"
}
```

### `PATCH /api/vms/:name/policy`

Updates one or more saved per-VM network policy flags, then runs the managed networking reconciler.

Request body:

```json
{
  "allow_same_group_traffic": false,
  "allow_host_access": false,
  "allow_private_lan_access": true,
  "internet_access": true
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
      "owner_user_id": "user-admin",
      "network_group_id": "ng-admin",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40,
      "allow_same_group_traffic": true,
      "allow_private_lan_access": false,
      "internet_access": true
    }
  },
  "sshPublicKey": "ssh-ed25519 AAAAC3... user@example"
}
```

Response `201`:

```json
{
  "vmName": "devbox",
  "keyPath": "/abs/path/homelab-vm-provisioner-cli/vm/keys/users/devbox.pub",
  "configPath": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "owner_user_id": "user-admin",
      "network_group_id": "ng-admin",
      "ssh_key_file": "/abs/path/homelab-vm-provisioner-cli/vm/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40,
      "ip_address": "10.80.0.2",
      "mac_address": "52:54:00:11:22:33"
    },
    "paths": {
      "vm_data_dir": "/abs/path/homelab-vm-provisioner-cli/vm/data/devbox"
    },
    "network": {
      "profile": "isolated_nat",
      "network_group_id": "ng-admin",
      "subnet_cidr": "10.80.0.0/28",
      "vm_ip": "10.80.0.2"
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
  "keyPath": "/abs/path/homelab-vm-provisioner-cli/vm/keys/users/devbox.pub",
  "configPath": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
  "rawConfig": "vm:\n  name: devbox\n...",
  "config": {
    "vm": {
      "name": "devbox",
      "user": "matt",
      "ssh_key_file": "/abs/path/homelab-vm-provisioner-cli/vm/keys/users/devbox.pub",
      "ram_mb": 4096,
      "vcpus": 2,
      "disk_gb": 40
    }
  },
  "provisioned": {
    "success": true,
    "output": "Created VM\n==========\n...",
    "config_path": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml"
  }
}
```

### `GET /api/vms`

Returns the merged VM view from:

- API-managed stored configs under `homelab-vm-provisioner-cli/configs/`
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
      "config_path": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
      "state_path": "/abs/path/homelab-vm-provisioner-cli/vm/state/devbox.yaml",
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
    "admin_private_key": "/abs/path/homelab-vm-provisioner-cli/vm/keys/admin/devbox_admin_ed25519",
    "vm_data_dir": "/abs/path/homelab-vm-provisioner-cli/vm/data/devbox",
    "trust": "trusted",
    "config_path": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
    "config": {
      "vm": {
        "name": "devbox",
        "user": "matt",
        "ram_mb": 4096,
        "vcpus": 2,
        "disk_gb": 40
      }
    },
    "state_path": "/abs/path/homelab-vm-provisioner-cli/vm/state/devbox.yaml",
    "state_exists": true,
    "log_path": "/var/log/libvirt/qemu/devbox.log",
    "log_exists": true,
    "configured": true,
    "storedConfigPath": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
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
  "configPath": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
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

Provisions a VM from an existing saved config under `homelab-vm-provisioner-cli/configs/<name>.yaml`.

Use this when a config already exists and you want to create the VM later without resubmitting the whole config payload.

The saved config name must still be unique across all libvirt VMs on the host at provision time.

Response `201`:

```json
{
  "name": "devbox",
  "configPath": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml",
  "provisioned": {
    "success": true,
    "output": "Created VM\n==========\n...",
    "config_path": "/abs/path/homelab-vm-provisioner-cli/configs/devbox.yaml"
  }
}
```

### `DELETE /api/vms/:name`

Destroys the VM through the Python provisioner bridge.

This endpoint does not delete the API-managed stored config under `homelab-vm-provisioner-cli/configs/`. That allows the same VM definition to be reviewed or reprovisioned later.

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

Creates a new saved config and performs a full VM clone from the source VM into that new target definition.

This route requires the source VM to exist with a cloneable source disk.

Request body: same as `POST /api/vms/configs`

Response `201`:

```json
{
  "sourceName": "devbox",
  "vmName": "clonebox",
  "configPath": "/abs/path/homelab-vm-provisioner-cli/configs/clonebox.yaml",
  "cloned": {
    "success": true,
    "source_name": "devbox",
    "config_path": "/abs/path/homelab-vm-provisioner-cli/configs/clonebox.yaml"
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
      "message": "VM names must be 63 characters or fewer"
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
- VM lifecycle behavior depends on the Python provisioner and the host tools it requires.
- `GET /api/vms/:name/logs` and `GET /api/vms/:name/logs/stream` read host-side libvirt QEMU logs directly.
- The bridge emits structured JSON on both success and failure so the Node layer can convert provisioner failures into HTTP responses.

---

# Async Job System

The API integrates with a PostgreSQL-backed job queue for async VM provisioning workflows. Jobs are enqueued by the API and processed by the [worker daemon](../homelab-vm-provisioner-worker).

## Architecture

```
API (enqueues jobs) → Database Service (job queue) → Worker Daemon (executes jobs)
                                ↓
                          PostgreSQL
```

## Job Types

The API enqueues these job types:

| Job Type | Description | Payload |
|----------|-------------|---------|
| `provision_vm` | Create a new VM from config | `{config, ssh_public_key?, setup_script?}` |
| `destroy_vm` | Destroy an existing VM | `{vm_name}` |
| `clone_vm` | Clone a VM from another | `{source_vm_name, config, ssh_public_key?, setup_script?}` |
| `start_vm` | Start a stopped VM | `{vm_name}` |
| `stop_vm` | Stop a running VM | `{vm_name}` |
| `reconcile_vm_networking` | Reconcile network config and firewall rules | `{vm_records, network_groups}` |
| `snapshot_create` | Create a VM snapshot | `{vm_name, payload}` |
| `snapshot_restore` | Restore a VM from snapshot | `{vm_name, snapshot_id, metadata}` |
| `snapshot_delete` | Delete a VM snapshot | `{vm_name, snapshot_id, metadata}` |

## Job Lifecycle

1. **Queued**: API creates job via database service
2. **Claimed**: Worker claims job using row-level locking (safe for multiple workers)
3. **Running**: Worker marks job as running
4. **Succeeded/Failed**: Worker updates job with result or error
5. **Events**: Worker appends event log entries throughout execution

## Job Service

Located in `src/job-service.js`, the job service provides a clean interface for creating jobs:

```javascript
import { createJobService } from './job-service.js';

const jobService = createJobService({
  repository: dbClient,
  hostId: 'local',
  rabbitMqPublisher: rabbitMqPublisher,  // Required
  logger: console
});

// Enqueue a provisioning job
const job = await jobService.provision({
  config: vmConfig,
  sshPublicKey: 'ssh-ed25519 AAA...',
  setupScript: '#!/bin/bash\necho ready'
});

// Get job status
const status = await jobService.getJobStatus(job.id);

// Cancel a queued job
await jobService.cancelJob(job.id);
```

### Available Methods

- `provision(payload)`: Enqueue provision_vm job
- `destroy(vmName)`: Enqueue destroy_vm job
- `clone(sourceVmName, payload)`: Enqueue clone_vm job
- `start(vmName)`: Enqueue start_vm job
- `stop(vmName)`: Enqueue stop_vm job
- `reconcileNetworking(payload)`: Enqueue reconcile_vm_networking job
- `snapshotCreate(vmName, payload)`: Enqueue snapshot_create job
- `snapshotRestore(vmName, snapshotId, metadata)`: Enqueue snapshot_restore job
- `snapshotDelete(vmName, snapshotId, metadata)`: Enqueue snapshot_delete job
- `getJobStatus(jobId)`: Get job details and events
- `cancelJob(jobId)`: Cancel a queued job

## Job Dispatch via RabbitMQ

The API dispatches jobs to workers via RabbitMQ. When a job is enqueued, it is:

1. Created in the database with status `'queued'`
2. Published to RabbitMQ exchange with routing key `host.<HOST_ID>`
3. Updated to status `'published'` after successful publish

Workers consume from queues bound to their target host ID and process jobs immediately.

**RabbitMQ Configuration:**

```bash
# Required environment variables in .env
QUEUE_HOST=localhost
QUEUE_PORT=3334
QUEUE_VHOST=provisioner
QUEUE_EXCHANGE=provisioner.jobs
QUEUE_ROUTING_KEY_PREFIX=host
QUEUE_API_USER=provisioner_api
QUEUE_API_PASSWORD=change-me
```

If RabbitMQ is not configured, job enqueue operations will fail with an error.

## Environment Variables for Jobs

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_ID` | (required) | Host identifier for job targeting |
| `DB_SERVICE_URL` | `http://localhost:3002` | Database microservice URL |
| `DB_SERVICE_PASSWORD` | (required) | Database microservice password |
| `QUEUE_HOST` | (required) | RabbitMQ host |
| `QUEUE_PORT` | `3334` | RabbitMQ port |
| `QUEUE_VHOST` | `provisioner` | RabbitMQ vhost |
| `QUEUE_EXCHANGE` | `provisioner.jobs` | RabbitMQ exchange name |
| `QUEUE_ROUTING_KEY_PREFIX` | `host` | Routing key prefix |
| `QUEUE_API_USER` | (required) | RabbitMQ API publisher username |
| `QUEUE_API_PASSWORD` | (required) | RabbitMQ API publisher password |

## Database Service Integration

The API communicates with the database microservice for all job operations:

```javascript
import { createDbClient } from './db.js';

const dbClient = createDbClient({
  baseUrl: process.env.DB_SERVICE_URL,
  password: process.env.DB_SERVICE_PASSWORD
});

// Enqueue job
const job = await dbClient.enqueueJob('provision_vm', hostId, payload);

// Get job with events
const job = await dbClient.getJob(jobId);
const events = await dbClient.listJobEvents(jobId);
```

See [Database Service README](../homelab-vm-provisioner-db/README.md) for full API documentation.

## Error Handling

Jobs can fail at various stages:

- **Validation**: API rejects invalid requests before enqueueing
- **Claiming**: Worker fails to acquire resource locks → job retries
- **Execution**: Provisioner CLI fails → job marked as failed with error message
- **Max Attempts**: After 3 failed attempts, job stops retrying

Failed jobs include:
- Error message in `error` field
- Detailed event log for debugging
- Retriable flag (if temporary failure)

## Monitoring Jobs

The API exposes job status endpoints:

```bash
# Get all jobs
GET /api/jobs

# Get specific job
GET /api/jobs/:id

# Get job events
GET /api/jobs/:id/events
```

See [Worker Daemon README](../homelab-vm-provisioner-worker/README.md) for worker-side documentation.

---
