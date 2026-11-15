import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

export function useComposerTextareaSize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  inputWrapRef: RefObject<HTMLDivElement | null>,
  value: string,
  expanded: boolean,
  maxHeightRatio = 0.4,
): boolean {
  const [canExpand, setCanExpand] = useState(false);
  const resizeEditor = useCallback(() => {
    const element = textareaRef.current;
    const wrap = inputWrapRef.current;
    if (!element || !wrap) return;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const main = wrap.closest("main");
    const composer = wrap.closest(".composer");
    const dock = wrap.closest(".composer-dock");
    const lineMinimum =
      Number.parseFloat(getComputedStyle(element).minHeight) || 0;
    let chrome = 0;
    let readingLimit = Infinity;
    if (composer) {
      const style = getComputedStyle(composer);
      const insets = (node: Element) => {
        const css = getComputedStyle(node);
        return [
          css.paddingTop,
          css.paddingBottom,
          css.borderTopWidth,
          css.borderBottomWidth,
        ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
      };
      const siblings = [...composer.children].filter((node) => {
        const css = getComputedStyle(node);
        return (
          node !== wrap &&
          css.display !== "none" &&
          css.position !== "absolute" &&
          css.position !== "fixed"
        );
      });
      // Measure the actual controls, not unused flex space in a minimum-height
      // form; otherwise each resize can turn that space into a larger minimum.
      chrome =
        insets(composer) +
        insets(wrap) +
        (Number.parseFloat(style.rowGap) || 0) * siblings.length +
        siblings.reduce((sum, node) => {
          const css = getComputedStyle(node);
          return (
            sum +
            node.getBoundingClientRect().height +
            (Number.parseFloat(css.marginTop) || 0) +
            (Number.parseFloat(css.marginBottom) || 0)
          );
        }, 0);
    }
    if (composer instanceof HTMLElement && dock) {
      // Flex layout can share a short dock with widgets, but never compress the
      // toolbar or the editor below one readable line.
      composer.style.setProperty(
        "--composer-min-height",
        `${chrome + lineMinimum}px`,
      );
      const stage = dock.closest<HTMLElement>(".reading-stage");
      if (stage) {
        const dockStyle = getComputedStyle(dock);
        const support = [...dock.children]
          .filter((node) => node !== composer)
          .reduce((sum, node) => {
            const css = getComputedStyle(node);
            const height = node.matches(".extension-dock, .command-activity")
              ? Number.parseFloat(css.minHeight) || 0
              : node.getBoundingClientRect().height;
            return (
              sum +
              height +
              (Number.parseFloat(css.marginTop) || 0) +
              (Number.parseFloat(css.marginBottom) || 0)
            );
          }, 0);
        const height = stage.getBoundingClientRect().height;
        const editorAndReadingSpace =
          height -
          chrome -
          support -
          (Number.parseFloat(dockStyle.paddingTop) || 0) -
          (Number.parseFloat(dockStyle.paddingBottom) || 0);
        const readingMinimum = Math.max(
          0,
          Math.min(144, height * 0.28, editorAndReadingSpace - lineMinimum),
        );
        stage.style.setProperty("--reading-min-height", `${readingMinimum}px`);
        readingLimit = editorAndReadingSpace - readingMinimum;
      }
    }
    const dockChrome =
      dock && composer
        ? dock.getBoundingClientRect().height -
          composer.getBoundingClientRect().height
        : 0;
    const available = Math.max(
      lineMinimum,
      Math.min(
        viewportHeight * 0.8,
        readingLimit,
        Math.min(
          main?.getBoundingClientRect().height || viewportHeight,
          viewportHeight,
        ) -
          chrome -
          dockChrome -
          64,
      ),
    );
    const compactLimit = Math.min(viewportHeight * maxHeightRatio, available);
    const limit = expanded ? available : compactLimit;
    const scrollTop = element.scrollTop;
    element.style.maxHeight = `${limit}px`;
    // Measure without a scrollbar changing line wrapping. scrollHeight is an
    // integer; one pixel of room keeps fractional line boxes from overflowing.
    element.style.overflowY = "hidden";
    element.style.height = "auto";
    element.style.height = `${
      expanded ? limit : Math.min(element.scrollHeight + 1, limit)
    }px`;
    // The dock may shrink the editor below its requested height. Let native
    // overflow follow that final height without affecting the fit measurement.
    const overflowing = element.scrollHeight > element.clientHeight;
    element.style.removeProperty("overflow-y");
    element.scrollTop = scrollTop;
    setCanExpand(available > compactLimit + 1 && overflowing);
  }, [expanded, inputWrapRef, maxHeightRatio, textareaRef]);

  useLayoutEffect(() => {
    resizeEditor();
  }, [resizeEditor, value]);

  useLayoutEffect(() => {
    const stage = inputWrapRef.current?.closest<HTMLElement>(".reading-stage");
    return () => {
      stage?.style.removeProperty("--reading-min-height");
    };
  }, [inputWrapRef]);

  useLayoutEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resizeEditor);
    };
    const wrap = inputWrapRef.current;
    const observer = new ResizeObserver(schedule);
    if (wrap) {
      observer.observe(wrap);
      const main = wrap.closest("main");
      if (main) observer.observe(main);
      const dock = wrap.closest(".composer-dock");
      if (dock) observer.observe(dock);
    }
    const typography = new MutationObserver(schedule);
    typography.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-content-text-size"],
    });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      typography.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [inputWrapRef, resizeEditor]);

  return canExpand;
}
