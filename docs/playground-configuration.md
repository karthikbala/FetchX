# Playground configuration

The playground policy lives beside the identity project template in the gateway configuration. Existing projects and keys keep their template binding. The database initializer adds the playground policy and profile tables and records the transport on new credit reservations. Existing reservations retain their amounts and states.

## Example policy

This example allows HTTP and Browser over Direct and reviewed US proxy routes. The credit weights and spending ceiling are example values for operator review. Merge the playground settings and mode weights into the existing control-plane configuration. Keep the existing project template, native credit policy version, trial amount, and native weights. Review the operation ceiling against the rates and bandwidth limits in the deployment.

```json
{
  "controlPlane": {
    "playground": {
      "enabled": true,
      "reviewed": true,
      "version": "playground-v1",
      "maxProfilesPerProject": 100,
      "routes": {
        "http": {
          "direct": true,
          "datacenter": ["US"],
          "residential": ["US"]
        },
        "browser": {
          "direct": true,
          "datacenter": ["US"],
          "residential": ["US"]
        }
      }
    },
    "creditPolicy": {
      "reviewed": true,
      "version": "existing-native-v1",
      "trialCredits": 25,
      "weights": {
        "direct": 1
      },
      "maxEstimatedMicroUsdPerOperation": 40000,
      "modeWeights": {
        "reviewed": true,
        "version": "playground-credits-v1",
        "http": {
          "direct": 1,
          "datacenter": 2,
          "residential": 3
        },
        "browser": {
          "direct": 4,
          "datacenter": 5,
          "residential": 6
        }
      }
    }
  }
}
```

HTTP allows GET and HEAD. Browser accepts GET navigation. Both use a single exact HTTPS origin and bounded requests, bytes, redirects, and duration. `maxProfilesPerProject` counts distinct admitted origins across policy versions. Multiple paths on an origin reuse its profile for that mode and policy version. The first admitted operation binds the policy version to its settings. Use a new reviewed version when changing a bound policy. Use a new mode-weight version when changing playground credit weights.

## Route requirements

- **Direct** uses `country: null` and a zero provider-cost estimate. It still consumes the configured operation credits.
- **US datacenter** requires a configured US pool, available proxy members, and reviewed pricing for the selected transport. A fixed-fee pool that covers both transports uses schema version 2 with `transports: ["http", "browser"]`. A project and profile scoped browser attestation uses schema version 2 with `transport: "browser"`. Target-scoped pricing is checked after the user supplies a URL. See the [V2 API pricing policies](api-v2.md).
- **US residential** requires an enabled provider for US, a configured bandwidth rate, and enough provider, gateway, daily, and project allowance for the reservation. The operation ceiling must cover both the provider estimate and the customer traffic estimate. A provider hold makes the route unavailable.
- **Browser** requires a pinned executable with a matching version and SHA-256 digest. For standard Chromium, set `v2.browser_probe.engine` to `chromium` and put `executablePath`, `version`, and `sha256` under `v2.browser_probe.runtime`. The accepted, unexpired `pinned-relay-egress-v2` evidence must match the engine, binary, platform, and architecture. An explicitly configured free CloakBrowser build also requires a reviewed unlicensed entitlement. The runtime check applies across projects. See the [browser probe runtime requirements](api-v2-browser-probe.md).

## Validate before enabling dispatch

1. Validate the staged configuration locally. This reads the settings and checks the local browser executable. It prints the policy versions and a browser availability reason, without contacting a source or provider.

   ```sh
   node --input-type=module - /path/to/staged-gateway.json <<'NODE'
   import {readFile} from 'node:fs/promises';
   import {playgroundPolicy} from './src/control-playground.mjs';
   import {reviewedCreditPolicy} from './src/control-credits.mjs';
   import {browserProbeRuntime} from './src/v2-browser-policy.mjs';

   const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
   const playground = playgroundPolicy(config);
   if (!playground) throw new Error('playground_disabled');
   const credits = reviewedCreditPolicy(config);
   const browser = await browserProbeRuntime(config);
   console.log(JSON.stringify({
     playgroundVersion: playground.version,
     modeWeightVersion: credits.modeWeights?.version ?? null,
     browserAvailable: browser.available,
     browserReason: browser.reason ?? null
   }));
   NODE
   ```

2. On an isolated deployment with synthetic providers, sign in to an existing project and check `GET /control/projects/:id`. Verify the HTTP and Browser entries and the available countries for each route. Send `POST /control/projects/:id/playground/prepare` with a valid session and CSRF token, a public HTTPS URL, GET, and the intended mode and route. Verify the selected key, route, and credit quote. Check that preparation leaves the profile count, operation count, and credit balance unchanged.
3. Run the focused fixture suite against an explicitly disposable local PostgreSQL database. Use the path to an installed test browser for browser fixture coverage.

   ```sh
   TEST_DATABASE_URL='postgresql://127.0.0.1:5432/gateway_test_playground' \
     BROWSER_TEST_EXECUTABLE='/path/to/test-browser' \
     node --test --test-concurrency=1 \
     test/control-playground.test.mjs test/control-credits.test.mjs \
     test/v2-public-render.test.mjs test/v2-browser.test.mjs
   ```

4. Before approving live traffic, verify the configured US egress and the expected source response with a separately authorized canary. Confirm that recovery by the original operation key returns the same operation and accounting without dispatching again.

To disable new playground dispatch, set `controlPlane.playground.enabled` to `false` and apply the normal configuration reload or restart. Keep the existing template, policy and profile records, captures, keys, and accounting rows for recovery. Check the original Fetch and Render lookup routes after rollback.
