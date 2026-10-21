# SSH reverse connection

This module creates and manages one loopback-only SSH reverse tunnel from a local INSΠRE host to a user-selected server. Its local configuration, state, control socket, and user service are isolated from the core host and from other connection modules.

User setup, lifecycle commands, service installation, and a minimal server-side example are documented in [`docs/ssh-reverse.md`](../../docs/ssh-reverse.md).
