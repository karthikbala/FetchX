# FetchX API compatibility policy

FetchX uses URL path prefixes for API major versions. `/v2` serves the
customer-facing Fetch and Render endpoints and the related discovery, usage and
recovery routes. The [v2 OpenAPI contract](openapi.json) describes that surface.
Existing provisioned integrations can continue using their [v1 workflow and job
routes](api.md) and [native v2 routes](api-v2.md) with the credentials and
profiles approved for them.

Compatible additions stay under the current major version. Examples include new
endpoints, optional request fields whose omission preserves behavior, and
additional response fields. Clients should tolerate additional response fields
and handle unfamiliar error codes conservatively. FetchX uses a new major
version for incompatible contract changes such as removing a supported route,
requiring a new field, or changing the meaning of an existing field. Project
permissions, budgets, runtime qualification and source safety checks continue to
govern what each request may do.

When retiring a supported API major, FetchX will publish the affected endpoints,
replacement guidance, and retirement date before removing them. Use the
published migration guide to verify authentication, inputs, response handling
and recovery before switching. Keep recovering saved work through its original
API and key during migration. No v1 retirement date is announced here.

API majors are separate from the service release returned by `/healthz`.
Access profiles and recipes use immutable `{id, version}` references and have
their own versions. Browser engine and binary versions track the runtime used
for rendering. A new profile, recipe, runtime or service release does not on its
own change the API major.
