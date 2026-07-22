# Northstar

## Mission

Build **inspire**, displayed as **ins$\pi$re**, into a high-quality graphical home for Pi Coding Agent. The name is both the word “inspire” and “inspect Pi rendering”: the product makes Pi’s conversations and activity easier to inspect while preserving Pi as the agent underneath.

The product begins as a Linux local web application for personal daily use. Its interface should grow toward a scientific workbench rather than remain a generic chat page: conversations are central, while sessions, agent activity, files, changes, and later artifacts or subagents occupy coherent surrounding surfaces.

## Success criteria

- A user can conduct normal Pi work through the browser without returning to the terminal for the primary conversation loop.
- Assistant output streams smoothly and settles into accurate Markdown, syntax-highlighted code, tables, links, inline mathematics, and display mathematics.
- Existing Pi sessions can be found, opened, continued, named, and switched without creating a second conversation history.
- Text, project-file references, pasted or dropped images, and ordinary file attachments can be submitted from the conversation composer.
- Thinking and tool activity use distinguishable cards whose default visibility can be configured independently as hidden, collapsed, or expanded.
- The initial interface already has the adaptable workbench structure needed for future files, changes, session trees, subagents, timelines, and artifact previews.
- The application uses the user’s existing Pi models, credentials, settings, extensions, skills, prompts, project context, and session records wherever Pi exposes them safely.
- Launch behavior is user-selectable between resuming the previous session and showing a useful welcome page.
- The first release is dependable for personal Linux use; later remote access and desktop packaging can reuse the same product surface rather than require a rewrite.

## Hard constraints

- Pi remains the authoritative agent runtime and its session records remain the authoritative conversation history; inspire must not create a parallel conversation database.
- The browser never receives stored provider credentials, private keys, or unrestricted direct access to the local machine. Privileged Pi and filesystem operations stay in a trusted local host process.
- The interface must render untrusted model and artifact content defensively. Raw HTML is not trusted by default, mathematical rendering cannot enable trusted commands, and active artifact content requires isolation.
- One process at a time owns writes to a given Pi session. This is a general Pi usage rule handled as ordinary product behavior, not a burden the user must understand or manage manually.
- Remote access, when introduced, keeps sessions, settings, and credentials on the connected machine by default; the public service relays connections rather than becoming the canonical data store.
- The open-source implementation may borrow product ideas from reference applications but must not copy unavailable, minified, or ambiguously licensed proprietary GUI code.
