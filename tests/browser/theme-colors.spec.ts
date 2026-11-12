import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { VISUAL_PREFERENCES_STORAGE_KEY } from "../../src/visual-preferences";
import {
  renderedColorSamples,
  renderedColors,
  resolvedColor,
} from "./support/colors";
import {
  openFixtureSession,
  pairAndOpen,
  pairedPage,
} from "./support/navigation";

type Pair = {
  ink: string;
  backgrounds: string[];
  minimum: number;
};

const color = (role: string) => `var(--${role})`;
const pairs = (
  inks: readonly string[],
  surfaces: readonly string[],
  minimum = 4.5,
): Pair[] =>
  surfaces.flatMap((surface) =>
    inks.map((ink) => ({
      ink,
      backgrounds: [color(surface)],
      minimum,
    })),
  );
const surfaces = [
  "bg-stage",
  "bg-rail",
  "bg-context",
  "bg-surface",
  "bg-raised",
  "bg-inset",
  "bg-control",
  "bg-prompt",
] as const;
const statusInks = ["warning-ink", "error-ink", "info-ink", "success-ink"];
const tint = (role: string, percent: number) =>
  `color-mix(in srgb, var(--${role}) ${percent}%, transparent)`;

// Surface colors and state fills come from the shipped stylesheet. The probes
// isolate those pairs without a second, hand-built copy of component markup.
const sharedPairs: Pair[] = [
  ...pairs(["ink", "body", "muted", "faint", "accent-deep"], surfaces),
  ...pairs(["accent-focus"], surfaces, 3),
  ...pairs(statusInks, ["bg-stage", "bg-surface", "bg-raised"]),
  ...pairs(["warning-ink"], ["bg-rail", "bg-file-canvas"]),
  ...pairs(["error-ink"], ["bg-inset", "bg-file-canvas"]),
  ...pairs(["activity-success-ink"], ["bg-stage"]),
  ...pairs(["activity-event"], ["bg-stage"], 3),
  ...pairs(
    ["on-accent"],
    ["accent-fill", "accent-fill-hover", "accent-fill-active"],
  ),
  ...pairs(["on-status"], ["error", "error-fill-hover", "error-fill-active"]),
  ...pairs(["on-status"], ["warning"], 3),
  ...surfaces.flatMap((surface) =>
    [
      ["accent-deep", "accent"],
      ["warning-ink", "warning"],
      ["error-ink", "error"],
      ["info-ink", "info"],
    ].map(([ink, mark]) => ({
      ink: ink!,
      backgrounds: [color(surface), tint(mark!, 10)],
      minimum: 4.5,
    })),
  ),
  ...["warning", "error"].flatMap((severity) =>
    [[], [tint(severity, 8)]].map((hover) => ({
      ink: `${severity}-ink`,
      backgrounds: [color("bg-canvas"), color(`${severity}-tint`), ...hover],
      minimum: 4.5,
    })),
  ),
  {
    ink: "activity-event-ink",
    backgrounds: [color("bg-stage"), tint("activity-event", 10)],
    minimum: 4.5,
  },
  {
    ink: "warning-ink",
    backgrounds: [color("bg-file-canvas"), color("warning-tint")],
    minimum: 4.5,
  },
];

test.use({ contextOptions: { reducedMotion: "reduce" } });

// Preserve the documented palette identities alongside the actual contrast checks.
const paletteIdentity = {
  wisteria: [
    ["#6E5494", "#FAF9FC", "#684E8E", "#4663AC"],
    ["#B39DDB", "#16151D", "#B39DDB", "#7AA2F7"],
  ],
  hydrangea: [
    ["#1F7A68", "#FBFBF9", "#1E7564", "#6554B8"],
    ["#5EC4AE", "#151A17", "#5EC4AE", "#A393EB"],
  ],
  lycoris: [
    ["#BC5042", "#FCFBF9", "#B5493B", "#4A6696"],
    ["#EE8474", "#1A1515", "#EE8474", "#88A4E0"],
  ],
  chimonanthus: [
    ["#B36010", "#FCFBF8", "#A6570B", "#6652BA"],
    ["#EAA03E", "#181613", "#EAA03E", "#A490F0"],
  ],
  "classic-jade": [
    ["#007D78", "#F6F8F7", "#E9EEEB"],
    ["#52D2C9", "#171C19", "#232B26"],
  ],
  "classic-amber": [
    ["#D95A00", "#F8F7F5", "#EEECE8"],
    ["#FF781F", "#171A1E", "#23272C"],
  ],
  mono: null,
} as const;

for (const palette of PALETTE_PREFERENCES) {
  test(`${palette} paints the saved theme and retains contrast in both luminosities`, async ({
    page,
  }) => {
    // Let the real prepaint script and stylesheet run before React.
    await page.route("**/*", (route) => {
      const request = route.request();
      return request.resourceType() === "script" &&
        new URL(request.url()).pathname !== "/theme-init.js"
        ? route.abort()
        : route.continue();
    });
    await page.addInitScript(() => {
      const match = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = match(query);
        if (query === "(display-mode: window-controls-overlay)")
          Object.defineProperty(result, "matches", { value: true });
        return result;
      };
    });
    await page.goto("/");

    for (const theme of ["light", "dark"] as const)
      await test.step(theme, async () => {
        await page.evaluate(
          ({ key, palette, theme }) =>
            localStorage.setItem(key, JSON.stringify({ palette, theme })),
          { key: VISUAL_PREFERENCES_STORAGE_KEY, palette, theme },
        );
        await page.emulateMedia({
          colorScheme: theme === "light" ? "dark" : "light",
        });
        await page.reload();
        const html = page.locator("html");
        await expect(html).toHaveAttribute("data-palette", palette);
        await expect(html).toHaveAttribute("data-theme", theme);
        const rail = await resolvedColor(html, "bg-rail");
        const firstPaint = await page
          .locator('meta[name="theme-color"]')
          .evaluate((meta) => {
            const probe = document.createElement("span");
            probe.style.color = meta.getAttribute("content") ?? "";
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          });
        expect(firstPaint).toBe(rail);
        const activityMinimum = [
          "wisteria",
          "hydrangea",
          "lycoris",
          "chimonanthus",
        ].includes(palette)
          ? 4.5
          : 3;
        const colorPairs = [
          ...sharedPairs,
          ...pairs(
            ["activity-tool", "activity-think"],
            ["bg-stage"],
            activityMinimum,
          ),
        ];
        const identity = await page.evaluate((colorPairs) => {
          const roles = getComputedStyle(document.documentElement);
          document.querySelector("[data-color-probes]")?.remove();
          const probes = document.createElement("div");
          probes.dataset.colorProbes = "";
          for (const { ink, backgrounds } of colorPairs) {
            for (const role of [
              ink,
              ...backgrounds.flatMap((background) =>
                [...background.matchAll(/var\(--([\w-]+)\)/gu)].map(
                  (match) => match[1]!,
                ),
              ),
            ])
              if (!roles.getPropertyValue(`--${role}`).trim())
                throw new Error(`Missing palette role: --${role}`);
            let container = probes;
            for (const background of backgrounds) {
              const surface = document.createElement("div");
              surface.style.backgroundColor = background;
              container.append(surface);
              container = surface;
            }
            const sample = document.createElement("span");
            sample.dataset.testid = "color-pair";
            sample.style.color = `var(--${ink})`;
            container.append(sample);
          }
          document.body.append(probes);
          return Object.fromEntries(
            [
              "accent",
              "accent-focus",
              "accent-soft",
              "accent-tint",
              "activity-tool",
              "activity-think",
              "activity-error",
              "activity-event",
              "bg-stage",
              "bg-prompt",
              "bg-surface",
              "nav-active-bg",
              "error",
            ].map((role) => [
              role,
              roles.getPropertyValue(`--${role}`).trim().toUpperCase(),
            ]),
          );
        }, colorPairs);
        const samples = await renderedColorSamples(
          page.getByTestId("color-pair"),
        );
        expect(samples).toHaveLength(colorPairs.length);
        for (const [
          index,
          { ink, backgrounds, minimum },
        ] of colorPairs.entries()) {
          expect
            .soft(
              samples[index]!.contrast,
              `${ink} on ${backgrounds.join(" + ")}`,
            )
            .toBeGreaterThanOrEqual(minimum);
        }
        const colors = paletteIdentity[palette]?.[theme === "light" ? 0 : 1];
        if (colors) {
          const [accent, stage] = colors;
          expect(identity).toMatchObject({ accent, "bg-stage": stage });
          if (colors.length === 3)
            expect(identity["bg-prompt"]).toBe(colors[2]);
          if (colors.length === 4) {
            expect(identity).toMatchObject({
              "activity-tool": colors[2],
              "activity-think": colors[3],
              "accent-focus": accent,
              "accent-soft": "TRANSPARENT",
              "nav-active-bg": identity["accent-tint"],
            });
            expect(identity["bg-prompt"]).not.toBe(identity["bg-surface"]);
            expect(identity.error).not.toBe(accent);
          }
        }
        expect(identity["activity-tool"]).not.toBe(identity["activity-error"]);
        expect(identity["activity-think"]).not.toBe(identity["activity-tool"]);
        expect(identity["activity-event"]).toBe(identity["activity-tool"]);
      });
  });
}

test("context selection and keyboard focus keep distinct color roles", async ({
  page,
}) => {
  await pairAndOpen(page);
  // Botanical accents keep focus and readable selection ink distinct.
  await page.evaluate(() =>
    Object.assign(document.documentElement.dataset, {
      palette: "wisteria",
      theme: "light",
    }),
  );
  for (const [name, surface] of [
    ["Search sessions", ".nav__search"],
    ["Search conversation", ".transcript-search"],
  ] as const) {
    const search = page.locator(surface);
    await search.getByRole("searchbox", { name, exact: true }).focus();
    await expect(search).toHaveCSS(
      "border-color",
      await resolvedColor(search, "accent-focus"),
    );
  }

  const toggle = page.getByRole("button", { name: "Toggle resources panel" });
  await toggle.click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  await expect(files).toHaveAttribute("aria-selected", "true");

  const selectionInk = await resolvedColor(files, "accent-deep");
  const focusInk = await resolvedColor(files, "accent-focus");
  const canvas = await resolvedColor(files, "bg-stage");
  expect(focusInk).not.toBe(selectionInk);
  await files.hover();
  await expect(files).toHaveCSS("color", selectionInk);
  await expect(files).toHaveCSS("background-color", canvas);
  await page.keyboard.press("Tab");
  await files.focus();
  await expect(files).toHaveCSS("outline-color", focusInk);
  await expect(files).toHaveCSS("color", selectionInk);
  expect((await renderedColors(files)).contrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole("tab", { name: "History" })).not.toHaveCSS(
    "color",
    selectionInk,
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveCSS("color", selectionInk);
  await toggle.hover();
  await expect(toggle).toHaveCSS("color", selectionInk);
  await expect(toggle).toHaveCSS(
    "background-color",
    await resolvedColor(toggle, "accent-tint"),
  );
});

test("Git conflict and stale status keep their semantic colors on hover", async ({
  page,
}) => {
  let stale = false;
  await page.route("**/api/git/status**", (route) =>
    stale
      ? route.fulfill({ status: 409, json: { error: "Git index unavailable" } })
      : route.fulfill({
          json: {
            kind: "repository",
            head: {
              kind: "branch",
              name: "review/colors",
              oid: "a".repeat(40),
            },
            files: [
              {
                path: { id: "Y29uZmxpY3QudHh0", display: "conflict.txt" },
                conflict: { code: "UU" },
                untracked: false,
              },
            ],
            total: 1,
            truncated: false,
          },
        }),
  );
  await pairedPage(page);
  await openFixtureSession(page, /Resource virtualization and sandbox fixture/);
  const git = page.getByRole("button", {
    name: /^Open Git changes: review\/colors, 1 change, 1 conflict/,
  });
  await git.hover();
  const count = git.locator(".topbar__git-count");
  await expect(count).toHaveCSS(
    "color",
    await resolvedColor(count, "error-ink"),
  );
  expect((await renderedColors(count)).contrast).toBeGreaterThanOrEqual(4.5);

  await git.click();
  stale = true;
  await page.getByRole("button", { name: "Refresh context pane" }).click();
  await expect(git).toHaveAccessibleName(/status may be stale$/);
  await git.hover();
  const branch = git.locator(".topbar__git-branch");
  await expect(branch).toHaveCSS(
    "color",
    await resolvedColor(branch, "warning-ink"),
  );
  expect((await renderedColors(branch)).contrast).toBeGreaterThanOrEqual(4.5);
  await expect(git.locator("svg")).toHaveCSS(
    "color",
    await resolvedColor(git, "warning"),
  );
});
