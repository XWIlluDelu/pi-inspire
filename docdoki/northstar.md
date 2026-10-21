# Northstar

## Mission

**Inspire** (INSΠRE) is a graphical interface for Pi Coding Agent and its extensions.

## Success criteria

- Present conversations and agent activity clearly, and support Pi's native capabilities as fully
  as possible.
- Add enhancements selectively and keep them unobtrusive. Web hosting, remote control, and optional
  Herdr support fit into the user's existing Pi workflow; file browsing and terminals provide
  familiar supporting tools.
- Give extension authors and users documentation, reusable UI components, and examples for
  interactions such as permission requests, subagent management, and question panels. They choose
  how these features work and are implemented.

## Hard constraints

- Pi and the user's configuration own agent behavior, tools, prompts, and extensions. Inspire
  provides graphical presentation and user controls, not a separate agent platform.
- Adapt Pi features through its supported public interfaces. When a required interface is missing,
  defer that graphical capability rather than modifying Pi or requiring a patched runtime.
- Target supported systems and reasonably recent dependencies. Do not turn cross-platform work into
  indefinite compatibility with ancient operating systems, shells or dependency versions.
- Prioritize material problems in current default workflows. Small edge-case fixes are allowed,
  but cross-platform work must not grow into exhaustive low-impact adaptations or test matrices.
