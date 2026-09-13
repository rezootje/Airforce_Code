# OAuth integration decision

The native CLI callback is:

```text
http://localhost:43821/oauth/callback
```

This exact URI is registered for Airforce's public/native client. Api.Airforce allows loopback HTTP using `localhost` and requires exact redirect matching.

The implementation uses the system browser, Authorization Code flow, PKCE S256, cryptographic state, a short-lived loopback-only listener, exact host/path validation, and an explicit timeout. No confidential client secret is embedded in the NPM package. A busy callback port produces an actionable error.

The public client ID is `airforce_r4tSOJrCkGPs3MT2TeJTl7Va`. The CLI requests `profile chat` by default. Add `images` in user configuration and sign in again if image generation is needed. Access tokens authenticate `/v1/*` with a Bearer header, expire after 24 hours, and currently have no refresh token.

`airforce login` opens the system browser, validates the callback, exchanges the code, calls `/oauth/userinfo`, and saves the token only after all checks pass. `airforce login --no-browser` prints the authorization URL for manual opening. `airforce logout` revokes a saved OAuth token and removes it locally.

References: [Api.Airforce OAuth provider documentation](https://api.airforce/docs/oauth-provider/) and [RFC 8252 native-app loopback redirects](https://www.rfc-editor.org/rfc/rfc8252#section-7.3).
