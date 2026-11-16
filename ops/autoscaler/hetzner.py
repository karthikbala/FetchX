"""Small non-retrying Hetzner API client, constrained to approved resources.

Wire shapes follow https://docs.hetzner.cloud/cloud.spec.json. Never log the
response body (create responses can contain a root password).
"""

from decimal import Decimal, InvalidOperation, ROUND_CEILING
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from .core import SafetyError


class CloudError(SafetyError):
    def __init__(self, code="cloud_api_error", status=None, provider_code=None):
        super().__init__(code)
        self.status = status
        self.provider_code = provider_code if (status, provider_code) in ((422, "placement_error"), (412, "resource_unavailable")) else None


class UncertainCreate(CloudError):
    pass


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CloudError("cloud_redirect_refused")


def micro_eur(value):
    try:
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0:
            raise ValueError()
        return int((amount * 1000000).to_integral_value(rounding=ROUND_CEILING))
    except (InvalidOperation, ValueError, TypeError):
        raise SafetyError("invalid_cloud_price") from None


def approved_machine(payload, option=None):
    option = option or {"server_type": "cx23", "location": "hel1"}
    try:
        matches = [s for s in payload["server_types"] if s["name"] == option["server_type"]]
        if len(matches) != 1:
            raise ValueError()
        machine = matches[0]
        locations = [p for p in machine["locations"] if p["name"] == option["location"]]
        if type(machine["id"]) is not int or machine["id"] < 1 or machine["architecture"] != "x86" or len(locations) != 1:
            raise ValueError()
        for key, minimum in (("cores", 2), ("memory", 4), ("disk", 40)):
            if type(machine[key]) not in (int, float) or not machine[key] >= minimum:
                raise SafetyError("machine_below_minimum")
        if locations[0]["available"] is not True or locations[0].get("deprecation") is not None:
            raise SafetyError("approved_machine_unavailable")
        return machine["id"]
    except (KeyError, ValueError, TypeError):
        raise SafetyError("cloud_machine_invalid") from None


def approved_prices(payload, config, machine_id, option=None):
    option = option or config
    try:
        p = payload["pricing"]
        if p["currency"] != "EUR":
            raise SafetyError("cloud_currency_not_eur")
        server_type = next(s for s in p["server_types"] if s["id"] == machine_id)
        server = next(x for x in server_type["prices"] if x["location"] == option["location"])
        if type(server["included_traffic"]) is not int or server["included_traffic"] < config["max_vm_egress_bytes"] * config["max_additional_workers"]:
            raise SafetyError("included_traffic_insufficient")
        ipv4 = next(s for s in p["primary_ips"] if s["type"] == "ipv4")
        ip = next(x for x in ipv4["prices"] if x["location"] == option["location"])
        rates = micro_eur(server["price_hourly"]["net"]), micro_eur(ip["price_hourly"]["net"])
        if rates[0] > option["server_hourly_ceiling_micro_eur"] or rates[1] > option["ipv4_hourly_ceiling_micro_eur"]:
            raise SafetyError("price_ceiling")
        return rates
    except (KeyError, StopIteration, TypeError):
        raise SafetyError("cloud_pricing_invalid") from None


def select_machine(types, pricing, config, cooldowns, now):
    if pricing.get("pricing", {}).get("currency") != "EUR":
        raise SafetyError("cloud_currency_not_eur")
    eligible = []
    for option in config["machine_options"]:
        if cooldowns.get(option["server_type"] + "@" + option["location"], 0) > now:
            continue
        try:
            identity = approved_machine(types, option)
            server_rate, ip_rate = approved_prices(pricing, config, identity, option)
        except SafetyError:
            continue
        eligible.append(dict(option, type_id=identity, server_hourly_micro_eur=server_rate, ipv4_hourly_micro_eur=ip_rate))
    if not eligible:
        raise SafetyError("no_eligible_machine")
    return min(eligible, key=lambda m: (m["server_hourly_micro_eur"] + m["ipv4_hourly_micro_eur"], m["server_type"], m["location"]))


class Hetzner:
    def __init__(self, token_path, timeout=10, opener=None):
        path = Path(token_path)
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid():
            raise SafetyError("cloud_token_permissions")
        token = path.read_text().strip()
        if not token or any(x.isspace() for x in token):
            raise SafetyError("cloud_token_invalid")
        self._token = token
        self.timeout = timeout
        # Ignore environment proxies: credentials go only to the official endpoint.
        self._opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())

    def request(self, method, path, data=None, missing_ok=False):
        if not path.startswith("/") or path.startswith("//"):
            raise SafetyError("cloud_path_invalid")
        req = urllib.request.Request("https://api.hetzner.cloud/v1" + path,
                                     data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Authorization": "Bearer " + self._token,
                                              "Content-Type": "application/json", "User-Agent": "FetchX-Autoscaler/1.0"}, method=method)
        try:
            with self._opener.open(req, timeout=self.timeout) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 404 and missing_ok:
                return None
            # POST timeouts, conflicts, 5xx and unclassified responses can be billable.
            if method == "POST" and (e.code >= 500 or e.code in (408, 409, 429)):
                raise UncertainCreate("create_uncertain", e.code) from None
            provider_code = None
            if method == "POST" and e.code in (412, 422):
                try:
                    raw = e.read(8193)
                    value = json.loads(raw) if len(raw) <= 8192 else {}
                    provider_code = value.get("error", {}).get("code")
                except (OSError, ValueError, TypeError, AttributeError):
                    pass
            raise CloudError("cloud_http_error", e.code, provider_code) from None
        except (OSError, ValueError, urllib.error.URLError):
            if method == "POST":
                raise UncertainCreate("create_uncertain") from None
            raise CloudError() from None

    def list_all(self, path, key):
        rows, page = [], 1
        while page <= 100:
            payload = self.request("GET", path + "?per_page=50&page=" + str(page))
            try:
                rows.extend(payload[key])
                next_page = payload.get("meta", {}).get("pagination", {}).get("next_page")
                if next_page is None:
                    return rows
                if type(next_page) is not int or next_page <= page:
                    raise ValueError()
                page = next_page
            except (KeyError, TypeError, ValueError):
                raise CloudError("cloud_list_invalid") from None
        raise CloudError("cloud_list_unbounded")

    def inventory(self):
        return self.list_all("/servers", "servers"), self.list_all("/primary_ips", "primary_ips")

    def pricing(self):
        return self.request("GET", "/pricing")

    def server_types(self):
        return {"server_types": self.list_all("/server_types", "server_types")}

    def create(self, name, labels, user_data, machine):
        payload = self.request("POST", "/servers", dict(name=name, labels=labels, user_data=user_data,
                               server_type=machine["server_type"], location=machine["location"], image="ubuntu-24.04",
                               start_after_create=True, automount=False,
                               public_net=dict(enable_ipv4=True, enable_ipv6=False)))
        try:
            return payload["server"]
        except (KeyError, TypeError):
            raise UncertainCreate("create_uncertain") from None

    def server(self, server_id):
        result = self.request("GET", "/servers/" + str(server_id), missing_ok=True)
        return result["server"] if result else None

    def ipv4(self, ip_id):
        result = self.request("GET", "/primary_ips/" + str(ip_id), missing_ok=True)
        return result["primary_ip"] if result else None

    def own_ipv4(self, ip_id, labels):
        return self.request("PUT", "/primary_ips/" + str(ip_id), dict(auto_delete=True, labels=labels))

    def delete_server(self, server_id):
        return self.request("DELETE", "/servers/" + str(server_id), missing_ok=True)

    def delete_ipv4(self, ip_id):
        return self.request("DELETE", "/primary_ips/" + str(ip_id), missing_ok=True)
