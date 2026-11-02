# Reviewed datacenter address preference

Normal V2 HTTP operations can prefer a public IPv4 answer when the operator has
reviewed the exact project, access-profile version, country, and Oxylabs pool.
This changes address selection for the native source and trusted resolver HTTPS
bootstrap. It does not change the workflow/session/fetch API, country admission,
provider selection, browser behavior, pricing entitlement, or retry policy.

Configure `v2.datacenterAddressPreferences` with reviewed entries. For example,
the following synthetic policy applies only to the named project/profile and US
country pool. Compute its fingerprint with the existing operator-only
`datacenterPoolFingerprint(config.proxies, 'US')` helper after configuring the
complete pool. The fingerprint includes every eligible country member and its
exact URL; never return this fingerprint or the private pool to API callers.

```json
{
  "schema_version": 1,
  "id": "reviewed-source-us-ipv4",
  "reviewed": true,
  "project": "example-project",
  "access_profiles": [{"id": "example.http", "version": 1}],
  "country": "US",
  "provider": "oxylabs",
  "pool_id": "operator-assigned-pool",
  "pool_fingerprint_sha256": "<operator-computed 64-character lowercase SHA-256>",
  "transport": "http",
  "preference": "ipv4"
}
```

The project must already be allowed to use that exact profile version, and its
profile must allow datacenter routing in the selected country. An applied
policy fails closed on a changed pool, ambiguous scope, or revoked profile
routing permission. Invalid policy shapes fail with
`address_preference_configuration`. Configuration without this optional list
keeps current address order. Other providers, direct routing, and unmatched
profiles/countries keep current address order.

Every DNS answer is checked for public address safety before selecting a family.
A mixed public/private answer remains rejected; IPv4 preference never removes a
private answer from validation. The first public IPv4 is selected when present;
a valid IPv6-only answer remains usable. Resolution still asks for all families.
There is one selected CONNECT destination, with no fallback connection after a
failed or uncertain source/proxied-resolver transport. Hostname URL, HTTP Host,
TLS SNI, certificate verification, proxy affinity and accounting remain intact.

Successful source DNS diagnostics add `address_preference: "ipv4"` and
`selected_family: 4` (or `6` for IPv6-only). Trusted resolver fallback also records
`resolver_bootstrap_family`. These fields contain no addresses, pool details,
policy identifiers, credentials, or source responses. Existing error diagnostics
remain unchanged.

Pricing and address preference are independent operator policies. Expanding the
configured pool requires separate review of any fixed-fee or prepaid pricing
binding; this preference never grants free traffic or source access.
