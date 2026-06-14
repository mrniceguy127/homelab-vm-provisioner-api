# VM Networking nftables

Managed libvirt-backed VM networks now reconcile their policy exclusively through application-owned nftables tables while still leaving libvirt in charge of bridge creation, DHCP reservations, dnsmasq, NAT, and guest attachment.

## Table Schema

The nftables backend owns these tables completely and replaces them atomically on every reconcile:

```nft
table inet hvp_filter {
    chain forward {
        type filter hook forward priority -10; policy accept;
    }

    chain input {
        type filter hook input priority -10; policy accept;
    }
}

table ip hvp_nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
    }
}

table bridge hvp_bridge_filter {
    chain forward {
        type filter hook forward priority -10; policy accept;
    }
}
```

Rule families:

- `hvp_filter.forward`: DNATed forwarded-port traffic, cross-group isolation, private-LAN policy, internet egress policy
- `hvp_filter.input`: DHCP/DNS-to-gateway exceptions plus per-VM host-access enforcement
- `hvp_nat.prerouting`: host-port DNAT rules
- `hvp_nat.postrouting`: reserved for future managed SNAT/MASQUERADE work; currently empty because libvirt still owns NAT
- `hvp_bridge_filter.forward`: same-bridge VM-to-VM filtering for guests that share one Linux bridge

## Policy Mapping

Per-VM flags now map to policy as follows for nftables-managed VMs:

- `internet_access: false`: rejects new forwarded traffic sourced by that VM after same-group/private-LAN/forwarded-port exceptions
- `allow_same_group_traffic: false`: blocks VM traffic to its own network-group subnet, including L2 traffic between VMs attached to the same bridge
- `allow_private_lan_access: false`: rejects traffic to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and `169.254.0.0/16`
- `allow_host_access: false`: rejects VM-to-hypervisor INPUT traffic after DHCP and DNS-to-gateway exceptions

Forwarded ports are rendered as paired rules:

```nft
tcp dport 2222 dnat to 10.80.0.2:22
ct status dnat ip daddr 10.80.0.2 tcp dport 22 accept
```

The `ct status dnat` match keeps forwarded-port access from bypassing same-group or cross-group isolation.

## Reconciliation Flow

Managed reconcile now performs these steps:

1. Load saved VM/network-group configuration.
2. Build the desired libvirt network model.
3. Build the desired nftables model.
4. Read the current `hvp_filter`, `hvp_nat`, and `hvp_bridge_filter` tables.
5. Replace managed nft tables atomically with one `nft -f -` batch.
6. Verify the managed tables and required chains exist.

`policy_only` reconciles skip all libvirt mutations, so policy toggles never redefine networks, recreate bridges, or require VM reboots.

## Rollback

Rollback is release-based:

1. Deploy the previous application version.
2. Re-run reconcile.
3. Verify the prior networking policy is restored.

## Verification Checklist

- Confirm `reconcile` succeeds.
- Run `sudo nft list table inet hvp_filter`, `sudo nft list table ip hvp_nat`, and `sudo nft list table bridge hvp_bridge_filter`.
- Toggle `internet_access` and verify egress changes immediately without rebooting the VM.
- Toggle `allow_same_group_traffic` and verify same-subnet traffic is allowed or rejected as expected, including between VMs that sit on the same bridge.
- Toggle `allow_private_lan_access` and verify RFC1918/CGNAT/link-local access matches policy.
- Toggle `allow_host_access` and verify hypervisor services become reachable or blocked while DHCP/DNS still work.
- Verify each configured port forward appears in `hvp_nat.prerouting` and remains reachable externally.
- Verify standalone `nat-auto` and `nat-custom` VMs also receive nftables-managed port-forward and isolation rules.

## Compatibility Notes

- Existing saved configs remain valid; `allow_host_access` defaults to `true` when absent.
- Legacy standalone `nat-auto` and `nat-custom` VM flows are still supported, but their host policy is now reconciled through the same application-owned nftables tables.
