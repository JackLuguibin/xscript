"""登录 IP 白名单: parse and match IPv4 / IPv6 addresses and CIDR ranges."""

from __future__ import annotations

import ipaddress
from typing import Iterable

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


def parse_entry(text: str) -> Network:
    """'203.0.113.7', '10.0.0.0/8', '2001:db8::/32' → network. ValueError on anything else."""
    t = (text or "").strip()
    if not t or any(c.isspace() for c in t):
        raise ValueError("无效的 IP 或网段: %r" % text)
    try:
        return ipaddress.ip_network(t, strict=False)
    except ValueError:
        raise ValueError("无效的 IP 或网段: %s" % t) from None


def normalize(entries: Iterable[str]) -> list[str]:
    """Validated, de-duplicated entries in input order (a bare address stays a bare address)."""
    out: list[str] = []
    for e in entries:
        net = parse_entry(e)
        text = str(net.network_address) if net.num_addresses == 1 and "/" not in e else str(net)
        if text not in out:
            out.append(text)
    return out


def _addr(ip: str):
    a = ipaddress.ip_address((ip or "").strip().split("%")[0])
    # ::ffff:1.2.3.4 is how dual-stack sockets show IPv4 clients.
    return a.ipv4_mapped if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped else a


def allowed(ip: str, entries: Iterable[str] | None) -> bool:
    """True when the list is empty (feature off) or `ip` is inside one of the entries."""
    nets = [parse_entry(e) for e in (entries or [])]
    if not nets:
        return True
    try:
        a = _addr(ip)
    except ValueError:
        return False
    return any(a.version == n.version and a in n for n in nets)
