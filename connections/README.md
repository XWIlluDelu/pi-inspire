# Connection modules

Each module manages a connection to the loopback Inspire Host, with its own process,
configuration, state and service. Stopping a connection leaves the Host running.

A module lives in its own directory with a `manifest.json` naming one `.mjs` runner and its supported actions. The generic launcher dispatches it through:

```bash
inspire connection <module> <action>
```

From a source checkout, use `npm run inspire -- connection <module> <action>`; the `./inspire`
wrapper is also available on Linux/macOS. `inspire connection list` lists installed modules.
The shipped [SSH reverse module](../docs/ssh-reverse.md) provides Linux setup and service instructions.
