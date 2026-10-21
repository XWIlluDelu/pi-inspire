import type { Page } from "@playwright/test";
import { browserTestToken } from "./navigation";

/** Fixture administration is a trusted non-browser client, not a cookie client.
 * Product requests still exercise the real browser-key authentication path. */
export function hostRequest(page: Page): Page["request"] {
  const methods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "fetch",
  ]);
  return new Proxy(page.request, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (
        typeof property !== "string" ||
        !methods.has(property) ||
        typeof member !== "function"
      )
        return typeof member === "function" ? member.bind(target) : member;
      return (
        url: string,
        options: { headers?: Record<string, string> } = {},
      ) => {
        if (new URL(url, page.url()).origin !== new URL(page.url()).origin)
          throw new Error(
            "Fixture credentials must stay on the test Host origin",
          );
        return member.call(target, url, {
          ...options,
          headers: {
            Authorization: `Bearer ${browserTestToken}`,
            ...options.headers,
          },
        });
      };
    },
  });
}
