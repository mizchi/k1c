# Cloudflare API Token for k1c

k1c uses one `CLOUDFLARE_API_TOKEN` environment variable. Cloudflare does not
ship a single "admin" checkbox, so the practical equivalent is a **Custom Token
with broad Edit permissions on every product k1c touches**. This is the
recommended default — operationally it behaves like a Pulumi-style "set the
token, done" token, and it does not need to be re-edited every time k1c grows a
new CRD kind.

If you have a hard requirement for least privilege (regulated env, shared
account, etc.), the per-CRD matrix is in [Least-privilege appendix](#least-privilege-appendix)
at the bottom.

## Recommended: one broad token

1. Open the Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
2. Pick **Create Custom Token**.
3. Set **Permissions** to the union below (Account scope + Zone scope):

   **Account permissions** (apply to "All accounts" or the specific account
   k1c will manage):

   - `Account Settings` — Read
   - `Workers Scripts` — Edit
   - `Workers KV Storage` — Edit
   - `Workers R2 Storage` — Edit
   - `D1` — Edit
   - `Queues` — Edit
   - `Vectorize` — Edit
   - `Hyperdrive` — Edit
   - `AI Gateway` — Edit
   - `Workers AI` — Read
   - `Workflows` — Edit
   - `Dispatch Namespaces` — Edit (Workers for Platforms)
   - `Stream` — Edit
   - `Turnstile` — Edit
   - `Access: Apps and Policies` — Edit
   - `Logs` — Edit
   - `Account WAF` — Edit

   **Zone permissions** (apply to "All zones" or specific zones):

   - `Zone` — Read
   - `DNS` — Edit
   - `Zone WAF` — Edit
   - `Cache Rules` — Edit
   - `Page Rules` — Edit
   - `Transform Rules` — Edit
   - `Response Header Modification` — Edit
   - `URI Rewrite Rules` — Edit
   - `Custom Hostnames` — Edit
   - `Email Routing Rules` — Edit
   - `Snippets` — Edit
   - `Stream` — Edit

4. Leave **Client IP Address Filtering** and **TTL** empty unless your security
   policy requires them.
5. Continue → **Create Token** → copy the value once (it is shown only at
   creation time).
6. Export it where k1c will read it:

   ```sh
   export K1C_ACCOUNT_ID=<your-account-id>
   export CLOUDFLARE_API_TOKEN=<paste-the-token>
   # Optional: a default zone for `<resolved-at-apply:Context:zoneId>` placeholders
   export K1C_ZONE_ID=<your-zone-id>
   ```

You can verify the token end-to-end (and discover account / zone ids) with the
bundled script:

```sh
dotenvx run -- node scripts/verify-cf-token.mjs
```

## Account-owned tokens (`cfat_…`)

Cloudflare also supports account-owned API tokens (token string begins with
`cfat_`), which are scoped to a single account and managed via the
[Account API Tokens API](https://developers.cloudflare.com/api/operations/account-api-tokens-create-token).
k1c accepts these transparently — set `CLOUDFLARE_API_TOKEN` to the `cfat_…`
value and `K1C_ACCOUNT_ID` to the owning account id. The verify script switches
to the account-scoped `tokens/verify` endpoint automatically.

## Least-privilege appendix

Mapping from k1c resource kind → required Cloudflare permission(s). Use this
to trim the recommended token above if you want a narrower scope. Tokens that
omit a row will surface as `Unauthorized` provider errors on the first
reconcile attempt for that kind.

| k1c kind                          | Scope    | Permission                                |
|-----------------------------------|----------|-------------------------------------------|
| `Worker` (and `Deployment` lower) | Account  | Workers Scripts: Edit                     |
| `WorkerVersion` / `WorkerDeployment` | Account | Workers Scripts: Edit                  |
| `WorkerCronTrigger`               | Account  | Workers Scripts: Edit                     |
| `WorkerRoute`                     | Zone     | Workers Routes: Edit                      |
| `KVNamespace`                     | Account  | Workers KV Storage: Edit                  |
| `R2Bucket` (+ Cors / Lifecycle / EventNotification / CustomDomain) | Account | Workers R2 Storage: Edit |
| `D1Database`                      | Account  | D1: Edit                                  |
| `Queue`                           | Account  | Queues: Edit                              |
| `Vectorize`                       | Account  | Vectorize: Edit                           |
| `Hyperdrive`                      | Account  | Hyperdrive: Edit                          |
| `AIGateway`                       | Account  | AI Gateway: Edit, Workers AI: Read        |
| `Workflow`                        | Account  | Workflows: Edit                           |
| `DispatchNamespace`               | Account  | Dispatch Namespaces: Edit                 |
| `StreamLiveInput` / `StreamKey` / `StreamWatermark` | Account | Stream: Edit              |
| `TurnstileWidget`                 | Account  | Turnstile: Edit                           |
| `AccessApplication` / `AccessPolicy` | Account | Access: Apps and Policies: Edit         |
| `LogpushJob`                      | Account  | Logs: Edit                                |
| `WafCustomRule` / `WafManagedRuleset` / `RateLimitRule` | Account+Zone | Account WAF: Edit, Zone WAF: Edit |
| `CustomHostname`                  | Zone     | Custom Hostnames: Edit                    |
| `CustomDomain`                    | Account  | Workers Scripts: Edit                     |
| `DnsRecord`                       | Zone     | DNS: Edit                                 |
| `CacheRule`                       | Zone     | Cache Rules: Edit                         |
| `PageRule`                        | Zone     | Page Rules: Edit                          |
| `TransformRule` / `UriRewriteRule` / `ResponseHeaderRule` | Zone | Transform Rules: Edit, Response Header Modification: Edit, URI Rewrite Rules: Edit |
| `EmailRoutingRule`                | Zone     | Email Routing Rules: Edit                 |
| `Snippet`                         | Zone     | Snippets: Edit                            |

`Account Settings: Read` + `Zone: Read` are required by every k1c invocation
(used for `verify-cf-token`, context resolution, and zone-id lookups) and are
not listed per-row.

## Why admin-first

- New CRDs land in k1c every minor release; a least-privilege token has to be
  re-edited each time, which is what made the workflow painful in the first
  place. The broad token absorbs new product surfaces without re-issuance.
- Cloudflare scopes are read at request time, not at token issue time, so a
  broader token does not cache extra blast radius — revoke + re-issue is the
  only mitigation in either model.
- For real isolation between environments (prod vs staging), prefer **separate
  accounts** with their own admin tokens over per-permission scoping of a
  single token. k1c contexts (`k1c config set-context`) keep them straight.
