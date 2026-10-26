# Connection modules

A connection module supplies an optional local ingress path to the same loopback INSΠRE host. It owns only its companion-process lifecycle, private configuration, state, and user-service integration; it never owns or stops the host.

A module lives in its own directory with a `manifest.json` naming one `.mjs` runner and its supported actions. The generic launcher dispatches it through:

```bash
inspire connection <module> <action>
```

From a source checkout, use `npm run inspire -- connection <module> <action>`; the `./inspire`
wrapper is also available on Linux/macOS. `inspire connection list` lists installed modules.
The shipped [SSH reverse module](../docs/ssh-reverse.md) provides Linux setup and service instructions.

Modules use isolated configuration and state paths under their own identifiers, so more than one may run at once. The core host remains responsible only for Pi, browser authentication, and generic proxy-safe request handling.
