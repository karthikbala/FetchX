# Trial and purchased credits

The free offer provides up to 1,000 trial credits once per verified account. Eligible direct and reviewed datacenter requests use the existing trial tariff and the workspace's configured daily limit. A configured Playground can also offer reviewed trial residential HTTP and qualified browser routes. These use the operator's trial mode weights and existing provider budget. Creating another project does not add free credits.

On upgrade, FetchX counts historical trial grants across the account, including grants to disabled projects. Any difference up to 1,000 goes to the oldest active project on the approved template. Existing reservations and usage keep their original records. The account receipt preserves the lifetime entitlement if its original project is removed.

| One-time purchase | Credits |
| --- | ---: |
| $2 | 10,000 |
| $8 | 50,000 |
| $20 | 150,000 |
| $100 | 1,000,000 |

Verified live payments add the full purchase to the selected project's paid balance. Packs have no automatic renewal or expiry. Sandbox payments leave both balances unchanged.

| Reviewed HTTP route | Credits per started block | Billing block |
| --- | ---: | ---: |
| Direct or datacenter | 1 | 1,000,000 bytes |
| Residential | 5 | 250,000 bytes |

Paid HTTP transfer includes both directions and counts every hop in the operation. Proxy overhead and any metered DNS consume part of the transfer limit. Set `max_transfer_mb` to opt into a different limit, from 0.25 to 20 decimal MB in steps of 0.25. Set `max_credits` to reject a quote that would reserve more credits than authorized. The gateway reserves the quoted maximum before dispatch and rounds measured bytes once across the entire operation.

A verified no-dispatch outcome or a FetchX-owned failure releases the customer reservation. A known source failure can still consume credits for verified traffic. When the meter proves that transfer reached the authorized limit, the maximum debit is known. Otherwise an uncertain byte count retains the original hold. Provider spending reservations follow their own accounting rules. A replay uses the saved tariff, result, and debit.

Purchases are used in order. A verified reversal removes the remaining capacity from that purchase and preserves recorded usage and holds. A payment hold pauses paid dispatch until the mapped incident is resolved. Existing verified grants remain usable when Checkout is disabled.

The operator enables paid routes through the reviewed `controlPlane.paidCreditPolicy` configuration. Each eligible profile, route class, country, and provider is reviewed separately. `residentialBudget` is the shared paid residential budget and the Evomi allocation used to qualify Checkout. Its maximums are 60 GB lifetime and 1 GB per UTC day, with a provider estimate of $1 per decimal GB. An optional reviewed `dataImpulseResidentialBudget` applies an additional provider ceiling under that shared budget. It does not increase the allocation backing Checkout. The existing private and legacy budgets, prior reservations, and rate estimates remain in force for their own operations.

Checkout checks the remaining paid allocation against the new purchase, pending live orders, and outstanding paid credits. The residential customer tariff still covers 250,000 bytes per five credits, or 50,000 bytes per credit within that block. For sales capacity, the gateway allows 50,820 provider bytes per credit. This rounds up the 250,000-byte default block plus a 4,096-byte provider read allowance across five credits. Every pack can fit individually at a clean launch. One of each would require 61.4922 GB of capacity, above the 60 GB lifetime ceiling.

A larger transfer ceiling with low measured usage can leave a provider hold much larger than the customer's debit. An uncertain dispatch or a refunded customer reservation can also retain provider capacity. Keep headroom in the funded allocation, including when other systems share the provider account. Reconcile provider usage against authoritative provider evidence. Customer settlement and refunds do not automatically release provider holds.

Reviewed Playground HTTP and Browser requests charge their configured fixed credits per operation. Public URL HTTP settles on measured transfer. Upgraded projects use a unified balance for both.

Billing and usage report the unified `credit_balance` for upgraded projects and separate balances before upgrade. The paid balance reports `granted`, `available`, `reserved`, `used`, `held`, `revoked_unused`, and `payment_hold`. Transfer accounting reports the saved tariff, billable bytes, the number of started billing blocks, and the settled credit debit.

## Resolve a held paid credit reservation

An operator can settle held customer credits once authoritative evidence establishes the billable transfer for the project and operation. Verify the evidence and its association to the operation before running the command. An estimate, an aggregate invoice that cannot be tied to the operation, or an incomplete byte observation is insufficient.

Save the following fields in an owner-only regular JSON file with permissions such as `0600`. Set the project and operation to the exact recorded identifiers. Keep the source evidence in protected storage and record only its SHA-256 digest in the input.

```json
{
  "project": "cp_01234567-89ab-cdef-0123-456789abcdef",
  "operation": "01234567-89ab-cdef-0123-456789abcdef",
  "metered_bytes": 250001,
  "evidence": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "reason": "provider_usage_verified",
  "operator": "operator-id",
  "attested": true
}
```

Use `provider_usage_verified`, `meter_evidence_verified`, or `no_traffic_verified` as the reason. The last reason requires zero bytes. Record verified billable bytes up to the original transfer limit. The stored tariff calculates the credit debit. Supply the gateway database connection in the private environment.

```sh
node src/paid-credit-reconcile-cli.mjs /protected/path/verified.json
```

The command saves the original hold, byte count, tariff-derived debit, digest, reason, and operator attestation in a receipt and settles customer credits in one transaction. Repeating the same digest and byte count returns the existing result. A conflicting receipt or a reservation outside the held state is rejected. The command keeps the provider reservation, source outcome, session, payment holds, and grant reversals intact.
