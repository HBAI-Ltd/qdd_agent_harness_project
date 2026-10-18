`loopback-test-only.pem` and `loopback-test-only.pfx` are public test fixtures for
the local TLS transport tests. The PFX password is `qdd-test-only`.

The self-signed certificate is valid from 2020 through 2040 and covers only
`127.0.0.1` and `localhost`. Tests explicitly trust it in their own connector;
the production connector keeps normal certificate and hostname verification.
The server fixture uses `native_tls::Identity::from_pkcs12`. On Windows that API
can persist the public fixture's private key in user key storage. The test does
not install a certificate into a system trust store. No private-key cleanup is
claimed; container names were not reliably identified and no unrelated keys
were enumerated or deleted. These files are not embedded into the release
executable.
