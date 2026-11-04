# Per-visitor sandboxes (0.4.0)

Portal defaults to local Microsandbox 0.7.11 microVMs. DSH remains the trusted orchestrator for authentication, model requests and conversation storage. Only read_file is exposed to visitors today; Python, shell and write tools are not automatically enabled. Real Python tests verify private read/write capability for future tool integrations.

## Automatic preparation

Click Start in Portal. It checks/upgrades the plugin, downloads a pinned SDK and a digest-pinned Python image, and reports progress. Components are cached in the user directory; no manual Microsandbox or Docker installation is needed. Plain chat creates no visitor VM. The first tool call creates one; later calls reuse it.

Supported targets are Windows x64/ARM64 with WHP, Linux x64/ARM64 with KVM, and Apple Silicon macOS with ARM64 Node.js. Node.js 22+ is required. Only Windows x64 has been tested locally; macOS and Linux still need acceptance testing. Intel Macs are unsupported.

Enabling Windows Hypervisor Platform may require a user action and restart. Linux requires access to /dev/kvm. Administrator privileges, firmware settings and OS restarts cannot be silently arranged. Preparation failures are visible and retryable; tools never fall back to host execution.

Portal installs dsh-a2a-server@^0.4.0 from npm. For local development, build the dsh-a2a checkout with pnpm install and pnpm build, then set A2A_PLUGIN_SOURCE to its absolute path in the terminal launching Portal. The npm release does not need this override. Standalone configurations select isolation.execution: microsandbox. Existing configs without that field retain read-only mode, which has no VM boundary. The docker backend remains available for compatibility.

## File boundaries and persistence

| Data | Inside the VM | Local persistence |
| --- | --- | --- |
| Selected public data | /source, read-only copy | Original host directory is never mounted |
| Current visitor files | /work, read/write | Exclusive persistent virtual disk |
| Other visitors | Not mounted | Separate disks |
| Sessions, protocol state, credentials | Not mounted | Trusted backend storage |

Public data includes .hop/handoff.md. Before each tool call it is validated and copied; changes stop that visitor VM before replacing its public projection, then restart with the same private disk. Trees are capped at 512 MiB and 100000 entries, so large datasets increase tool latency. Microsandbox public projections exclude entries named node_modules at any depth, case-insensitively, including dependency links. Their contents are never traversed; the original project's dependencies are neither moved nor deleted. Other symlinks, junctions, hard links, special files and nested filesystems remain rejected. Private workspace imports and Docker raw mounts do not use this exclusion and still reject all links.

Portal stores VM mappings at ~/.a2a/workspaces/<agent>/.microsandbox/<peer>/record.json and read-only public projections beside them. Existing <peer>/ files are imported on first boot and retained as migration sources. New /work files persist in the virtual disk; they are **not synchronized back to the old host folder**. A generated-file download/export interface has not been added.

The SDK, native state and VM disks live under ~/.a2a/sandbox-runtime, overridable with A2A_SANDBOX_HOME before startup. Back up both the private mapping directory and runtime state. Do not delete either or run destroy/remove on user VMs; those actions delete disks. Removing a peer credential does not automatically delete its files.

Identity is agent + authenticated peer, not conversation or message. Multiple contexts for one peer share a VM and private files. People sharing a token share this identity; issue independent credentials.

## Lifecycle and quotas

After the last tool finishes, 30 idle seconds pause the VM; 10 idle minutes stop it. Pausing retains memory. Stopping releases runtime resources and keeps disks. New tool calls resume a paused VM or restart a stopped VM with its original disk. Active or queued work prevents idle transitions, and calls for one visitor are serialized.

Each backend allows four resident VMs including paused ones. At capacity, the oldest idle VM stops early; if every VM is busy, new tool work is rejected. Normal backend shutdown stops its VMs. A new controller reclaims recorded instances abandoned by a previous controller, without destroying disks. Abrupt power loss or forced termination can still lose unflushed writes.

VMs have one CPU, 512 MiB RAM, a 256 MiB root disk and 512 MiB private disk. Networking is disabled. Tools run as UID 1000 with a 30-second execution timeout and 256 KB output cap. The public projection is read-only/noexec/nosuid/nodev; private disks are nosuid/nodev. The host user, hypervisor and pinned image remain trusted; this is not an absolute defense against virtualization vulnerabilities.

read_file defaults to public data; root: workspace selects the current visitor's disk. Text reads remain bounded to UTF-8 files up to 2 MiB, 32000 returned characters and 500 lines/entries per call. Backend conversation records are not tool-readable.

## Migration and verification

Stop the old agent and start with the new Portal. It copies current visitors' legacy directories outside public data, verifies the copy and removes the old source. Conflicting destinations are never overwritten. First VM boot imports that visitor's private files and refuses conflicting content. Archive private leftovers for removed visitors outside public data manually.

Automatic public briefings still update .hop/handoff.md and appear in Portal. Trusted owner maintenance runs on the host, outside the visitor sandbox.

Run pnpm typecheck, pnpm test, pnpm test:package and pnpm test:microsandbox. The last command automatically prepares real microVMs and synthetic files to exercise public mutation denial, private CRUD, peer separation, link attacks, network/credential isolation, cancellation, lifecycle, persistence and abandoned-instance recovery.

Set A2A_MSB_WALLCLOCK=1 for a full ten-minute wall-clock lifecycle test. Otherwise controlled time triggers actual native VM transitions. A2A_MSB_TEST_RUNTIME optionally reuses a test runtime cache. Legacy Docker validation remains pnpm test:docker and requires a local Linux Docker engine plus the image built from docker/Dockerfile.
