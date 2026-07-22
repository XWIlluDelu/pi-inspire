---
purpose: A later relay can connect the same interface to a chosen Pi machine while that machine retains its credentials, settings, projects, and sessions.
---

# Remote access

## Goal

Extend the local web product to personal remote use without turning the relay into the owner of Pi state.

This is a later-phase contract; the first release remains local-first.

## Checks

- A user can pair a machine, see whether it is online, select it, and then use the same session interface against that machine.
- The connected machine initiates or explicitly authorizes the relay connection so normal use does not require manual reverse-SSH configuration.
- The relay forwards authenticated, encrypted traffic but does not store canonical conversations, Pi settings, projects, or provider credentials.
- Machine identity and session identity remain visible so the user always knows where work executes.
- Losing the relay or browser connection does not destroy local session state or an already settled Pi entry.
- Remote control can be disabled without impairing local use.

## Non-goals

- Remote access is not required for the first personal Linux release.
- Full cloud synchronization and multi-user collaboration are outside the settled direction.
