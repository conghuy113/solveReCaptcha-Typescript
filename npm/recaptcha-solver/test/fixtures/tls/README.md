# Local TLS test fixture

The certificate and private key in this directory are public test data, used
only by loopback test servers. Never use them for a deployment or install them
in the system trust store. The certificate has only the `localhost` DNS SAN;
connections to `127.0.0.1` intentionally fail hostname verification.

Tests trust the certificate only in isolated Node child processes through
`NODE_EXTRA_CA_CERTS`. Other cases check that untrusted certificates are rejected.
The fixture is valid from 2020 to 2120 and is excluded from the npm package by
the package's `files` allowlist.
