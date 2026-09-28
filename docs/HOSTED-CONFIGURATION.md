# Optional hosted configuration

Nothing in this file is required for writing locally. This repository has no production credentials and does not provision or deploy a hosted backend.

If you operate a compatible **test deployment**, copy `.env.example` to `.env.local` and configure:

| Setting | Meaning |
|---|---|
| `VITE_HOSTED_ENABLED` | Explicitly set `true` only after verifying the compatible deployment |
| `VITE_SUPABASE_URL` | Your deployment’s HTTPS Supabase origin |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Its public `sb_publishable_…` client key |
| `VITE_HOSTED_ORIGIN` | The HTTPS web portal used to finish submission; no default |

`VITE_` settings are bundled into the frontend. They must never contain a service-role key, provider key, password or other server secret. The public adapter deliberately accepts the modern publishable-key format rather than arbitrary JWT credentials. Rebuild after changing build-time settings.

The compatible deployment must provide the schema, row-level authorization and hosted functions expected by the adapters. Creating an empty Supabase project is not sufficient. The private CanIScreenwrite.com backend is a separate deployment and is not included in this source release. Use synthetic data and a staging portal until end-to-end access and submission tests pass.

The writer loads the hosted client only after an explicit online action. Missing configuration produces a visible unavailable message. It does not prevent local authoring. Connection credentials are not included in project exchange.

iPhone hosted configuration is separately opt-in through the documented `QICreativeHostedEnabled`, `QICreativeSupabaseURL` and `QICreativePublishableKey` settings in [the iPhone service guide](../iphone/QiCanIScreenwrite/Services/README.md). Keep that configuration disabled until the corresponding backend and physical-device workflow are verified.
