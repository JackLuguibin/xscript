#!/usr/bin/env python3
"""卡密 (license) tool for packaged XScript apps.

    python scripts/xscript_license.py keygen --out keys/            # private.pem + public.b64
    python scripts/xscript_license.py cards  --db licenses.db --count 50 --days 30 --app com.me.game
    python scripts/xscript_license.py issue  --key keys/private.pem --device <ANDROID_ID> --days 30
    python scripts/xscript_license.py list   --db licenses.db
    python scripts/xscript_license.py revoke --db licenses.db XS-ABCD-EFGH-IJKL-MNOP

Tokens: base64url(payload JSON) "." base64url(ECDSA P-256 SHA-256 DER signature). The app
embeds only the public key (pack.properties `license_pubkey`). Keep private.pem secret;
anyone holding it can mint licenses.

Online activation (`--license-server` at pack time) is served by `scripts/xscript_cloud.py`
with `--licenses licenses.db --key private.pem`: a card code is bound to the first device
that activates it and the server returns a signed token. `issue` makes offline tokens for
one device (or `--device '*'` for any device) that the user pastes into the app.

Needs `cryptography` (pip install cryptography).
"""

import argparse
import base64
import json
import os
import secrets
import sqlite3
import sys
import time

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_private(path):
    from cryptography.hazmat.primitives import serialization

    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def public_b64(private_key):
    """Base64 SubjectPublicKeyInfo DER, the format BuildConfig.LICENSE_PUBKEY expects."""
    from cryptography.hazmat.primitives import serialization

    der = private_key.public_key().public_bytes(serialization.Encoding.DER,
                                                serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode("ascii")


def keygen(out_dir):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    os.makedirs(out_dir, exist_ok=True)
    priv_path = os.path.join(out_dir, "private.pem")
    if os.path.exists(priv_path):
        raise SystemExit("%s exists; refusing to overwrite a signing key" % priv_path)
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    fd = os.open(priv_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    pub = public_b64(key)
    with open(os.path.join(out_dir, "public.b64"), "w") as f:
        f.write(pub + "\n")
    return priv_path, pub


def sign(private_key, payload):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = private_key.sign(body, ec.ECDSA(hashes.SHA256()))
    return b64url(body) + "." + b64url(sig)


def verify(public_key_b64, token):
    """Payload dict if the signature is valid (no device / expiry checks), else None."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        pub = serialization.load_der_public_key(base64.b64decode(public_key_b64))
        body_s, sig_s = token.strip().split(".")
        body = b64url_decode(body_s)
        pub.verify(b64url_decode(sig_s), body, ec.ECDSA(hashes.SHA256()))
        return json.loads(body.decode("utf-8"))
    except (ValueError, InvalidSignature):
        return None


def new_card(prefix="XS"):
    groups = ["".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(4)]
    return prefix + "-" + "-".join(groups)


def issue(private_key, device, days=0, app="*", card=None, now=None):
    now = int(now or time.time())
    payload = {
        "card": card or new_card(),
        "device": device or "*",
        "app": app or "*",
        "iat": now,
        "exp": now + int(days * 86400) if days else 0,
    }
    return sign(private_key, payload), payload


# ---------------------------------------------------------------- card database

SCHEMA = """
CREATE TABLE IF NOT EXISTS cards (
    card TEXT PRIMARY KEY,
    days REAL NOT NULL DEFAULT 0,          -- validity after activation; 0 = permanent
    app TEXT NOT NULL DEFAULT '*',
    note TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    device TEXT,                           -- bound on first activation
    model TEXT,
    activated INTEGER,
    expires INTEGER,                       -- epoch seconds, 0 = permanent
    revoked INTEGER NOT NULL DEFAULT 0
);
"""


class CardDB(object):
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def create(self, count, days=0, app="*", note="", prefix="XS"):
        now = int(time.time())
        cards = []
        with self.db:
            while len(cards) < count:
                c = new_card(prefix)
                try:
                    self.db.execute("INSERT INTO cards(card, days, app, note, created) VALUES (?,?,?,?,?)",
                                    (c, float(days), app or "*", note, now))
                    cards.append(c)
                except sqlite3.IntegrityError:
                    continue
        return cards

    def get(self, card):
        row = self.db.execute("SELECT * FROM cards WHERE card = ?", (card.strip().upper(),)).fetchone()
        return dict(row) if row else None

    def list(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM cards ORDER BY created, card")]

    def revoke(self, card, revoked=True):
        with self.db:
            cur = self.db.execute("UPDATE cards SET revoked = ? WHERE card = ?", (1 if revoked else 0, card.strip().upper()))
        return cur.rowcount > 0

    def unbind(self, card):
        """Let a card move to another device (keeps the expiry)."""
        with self.db:
            cur = self.db.execute("UPDATE cards SET device = NULL WHERE card = ?", (card.strip().upper(),))
        return cur.rowcount > 0

    def activate(self, private_key, card, device, app, model="", now=None):
        """Bind `card` to `device` (first use) and return (token, None) or (None, error)."""
        now = int(now or time.time())
        row = self.get(card)
        if row is None:
            return None, "卡密不存在"
        if row["revoked"]:
            return None, "卡密已停用"
        if row["app"] not in ("*", app):
            return None, "卡密不属于此应用"
        if row["device"] and row["device"] != device:
            return None, "卡密已绑定其他设备"
        if not row["device"]:
            expires = now + int(row["days"] * 86400) if row["days"] else 0
            with self.db:
                self.db.execute("UPDATE cards SET device = ?, model = ?, activated = ?, expires = ? WHERE card = ?",
                                (device, model, now, expires, row["card"]))
            row = self.get(card)
        if row["expires"] and row["expires"] <= now:
            return None, "卡密已过期"
        payload = {"card": row["card"], "device": device, "app": app, "iat": now, "exp": int(row["expires"] or 0)}
        return sign(private_key, payload), None

    def check_token(self, payload):
        """Server-side re-verification: "ok", "revoked", "expired" or "unknown"."""
        row = self.get(payload.get("card", ""))
        if row is None:
            return "unknown"
        if row["revoked"]:
            return "revoked"
        if row["device"] and payload.get("device") not in ("*", row["device"]):
            return "revoked"
        if row["expires"] and row["expires"] <= time.time():
            return "expired"
        return "ok"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen", help="create a signing key pair")
    k.add_argument("--out", default="keys")
    c = sub.add_parser("cards", help="create card codes in a database")
    c.add_argument("--db", required=True)
    c.add_argument("--count", type=int, default=10)
    c.add_argument("--days", type=float, default=0, help="validity after activation (0 = permanent)")
    c.add_argument("--app", default="*", help="applicationId the cards work for")
    c.add_argument("--note", default="")
    c.add_argument("--prefix", default="XS")
    i = sub.add_parser("issue", help="sign an offline token for one device")
    i.add_argument("--key", required=True)
    i.add_argument("--device", required=True, help="ANDROID_ID shown in the app, or '*'")
    i.add_argument("--days", type=float, default=0)
    i.add_argument("--app", default="*")
    l_ = sub.add_parser("list", help="list cards")
    l_.add_argument("--db", required=True)
    r = sub.add_parser("revoke", help="disable cards")
    r.add_argument("--db", required=True)
    r.add_argument("cards", nargs="+")
    u = sub.add_parser("unbind", help="release cards from their device")
    u.add_argument("--db", required=True)
    u.add_argument("cards", nargs="+")
    v = sub.add_parser("verify", help="check a token against a public key")
    v.add_argument("--pub", required=True, help="public.b64 file")
    v.add_argument("token")
    a = ap.parse_args(argv)

    if a.cmd == "keygen":
        path, pub = keygen(a.out)
        print("private key: %s (keep it secret)" % path)
        print("license_pubkey=%s" % pub)
    elif a.cmd == "cards":
        for card in CardDB(a.db).create(a.count, a.days, a.app, a.note, a.prefix):
            print(card)
    elif a.cmd == "issue":
        token, payload = issue(load_private(a.key), a.device, a.days, a.app)
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        print(token)
    elif a.cmd == "list":
        for row in CardDB(a.db).list():
            exp = row["expires"]
            state = "revoked" if row["revoked"] else ("unused" if not row["device"] else "active")
            print("%s  %-7s  days=%-5g  app=%s  device=%s  expires=%s  %s" % (
                row["card"], state, row["days"], row["app"], row["device"] or "-",
                time.strftime("%Y-%m-%d %H:%M", time.localtime(exp)) if exp else ("never" if row["device"] else "-"),
                row["note"]))
    elif a.cmd in ("revoke", "unbind"):
        db = CardDB(a.db)
        for card in a.cards:
            ok = db.revoke(card) if a.cmd == "revoke" else db.unbind(card)
            print("%s %s" % (card, "ok" if ok else "not found"))
    elif a.cmd == "verify":
        with open(a.pub) as f:
            payload = verify(f.read().strip(), a.token)
        print(json.dumps(payload, ensure_ascii=False) if payload else "invalid signature")
        return 0 if payload else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
