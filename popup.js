const copyBtn = document.getElementById("copyBtn");
const statusDiv = document.getElementById("status");

function setStatus(message, { error = false } = {}) {
  statusDiv.textContent = message;
  statusDiv.className = error ? "error" : "";
}

copyBtn.addEventListener("click", async () => {
  setStatus("処理中...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("アクティブなタブを取得できませんでした。");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractMarkdownFromPage,
    });

    if (!result) throw new Error("会話が見つかりませんでした。");
    if (typeof result === "object" && result.error) throw new Error(result.error);
    if (typeof result !== "string") throw new Error("想定外の結果が返りました。");

    await writeToClipboard(result);
    setStatus("コピー完了！");
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    console.error(err);
    setStatus(err?.message ?? String(err), { error: true });
  }
});

async function writeToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (err) {
    // フォールバック: 一部環境では user activation の扱いで失敗するため
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    textarea.remove();
    if (!ok) throw err;
  }
}

function extractMarkdownFromPage() {
  try {
    if (!location.hostname.endsWith("gemini.google.com")) {
      return { error: "Geminiのページではありません。" };
    }

    const root = document.querySelector("main") || document.body;
    if (!root) return { error: "ページの解析に失敗しました。" };

    const nodes = collectConversationNodes(root);
    if (nodes.length === 0) {
      return {
        error:
          "会話要素を特定できませんでした。Gemini側のDOM構造が変更された可能性があります。",
      };
    }

    const title = getThreadTitle();
    const output = [`# ${title}`, ""];

    for (const node of nodes) {
      const speaker = getSpeaker(node);
      const content = getBestContentNode(node);
      const markdown = htmlToMarkdown(content).trim();
      if (!markdown) continue;

      output.push(`## ${speaker}`);
      output.push(markdown);
      output.push("", "---", "");
    }

    return cleanupMarkdown(output.join("\n"));
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }

  function getThreadTitle() {
    const raw = (document.title || "").trim();
    const cleaned = raw.replace(/^Gemini\s*-\s*/i, "").trim();
    return cleaned || "Gemini";
  }

  function collectConversationNodes(searchRoot) {
    const userSelectors = [
      "user-query",
      '[data-test-id="user-query"]',
      '[data-message-role="user"]',
      '[data-message-author="user"]',
    ];
    const modelSelectors = [
      "model-response",
      '[data-test-id="model-response"]',
      '[data-message-role="assistant"]',
      '[data-message-author="assistant"]',
    ];
    const selector = [...userSelectors, ...modelSelectors].join(",");

    let candidates = Array.from(searchRoot.querySelectorAll(selector));

    // 追加フォールバック: 会話ターンがまとめられている場合
    if (candidates.length === 0) {
      const turns = Array.from(
        searchRoot.querySelectorAll(
          '[data-test-id*="turn" i], [data-testid*="turn" i], [role="listitem"]'
        )
      );
      candidates = turns.filter((el) => (el.textContent || "").trim().length > 0);
    }

    candidates = uniqueElements(candidates).sort(compareDomOrder);
    candidates = removeContainedElements(candidates);
    return candidates;

    function uniqueElements(elements) {
      const out = [];
      const seen = new Set();
      for (const el of elements) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
      return out;
    }

    function removeContainedElements(sortedElements) {
      const out = [];
      for (const el of sortedElements) {
        let contained = false;
        for (const prev of out) {
          if (prev.contains(el)) {
            contained = true;
            break;
          }
        }
        if (!contained) out.push(el);
      }
      return out;
    }

    function compareDomOrder(a, b) {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    }
  }

  function getSpeaker(node) {
    const tag = (node.tagName || "").toLowerCase();
    if (
      tag === "user-query" ||
      node.matches?.(
        'user-query, [data-test-id="user-query"], [data-message-role="user"], [data-message-author="user"]'
      )
    ) {
      return "User";
    }
    if (
      tag === "model-response" ||
      node.matches?.(
        'model-response, [data-test-id="model-response"], [data-message-role="assistant"], [data-message-author="assistant"]'
      )
    ) {
      return "Gemini";
    }

    const classText = String(node.className || "");
    if (/user/i.test(classText)) return "User";
    return "Gemini";
  }

  function getBestContentNode(node) {
    const selectors = [
      // よくある「本文」らしきコンテナ候補
      "[data-message-text]",
      "[data-test-id*=\"message\" i]",
      "message-content",
      ".message-content",
      ".markdown",
      ".content",
      "article",
      "section",
    ];
    for (const sel of selectors) {
      const el = node.querySelector?.(sel);
      if (el && (el.textContent || "").trim().length > 0) return el;
    }
    return node;
  }

  function htmlToMarkdown(element) {
    if (!element) return "";

    const clone = element.cloneNode(true);
    cleanup(clone);

    const md = convertChildren(clone, {
      listDepth: 0,
      inBlockquote: false,
    });

    return md;

    function cleanup(rootEl) {
      const removeSelectors = [
        "button",
        "svg",
        "mat-icon",
        "script",
        "style",
        "textarea",
        "input",
        '[role="button"]',
        ".feedback-container",
        ".edit-button",
        ".speech_icon",
      ];
      for (const sel of removeSelectors) {
        rootEl.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }

    function convertChildren(parent, ctx) {
      const parts = [];
      for (const child of parent.childNodes) {
        parts.push(convertNode(child, ctx));
      }
      return parts.join("");
    }

    function convertNode(node, ctx) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeText(node.nodeValue || "");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const el = node;
      const tag = el.tagName.toLowerCase();

      if (tag === "br") return "\n";

      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
        const level = Number(tag.slice(1));
        const text = cleanupMarkdownInline(convertChildren(el, ctx)).trim();
        if (!text) return "";
        return `\n${"#".repeat(level)} ${text}\n\n`;
      }

      if (tag === "p") {
        const text = cleanupMarkdownInline(convertChildren(el, ctx)).trim();
        if (!text) return "";
        return `${text}\n\n`;
      }

      if (tag === "hr") return "\n---\n\n";

      if (tag === "blockquote") {
        const inner = cleanupMarkdown(convertChildren(el, { ...ctx, inBlockquote: true })).trim();
        if (!inner) return "";
        const lines = inner.split("\n").map((l) => (l ? `> ${l}` : ">"));
        return `\n${lines.join("\n")}\n\n`;
      }

      if (tag === "pre") {
        const codeEl = el.querySelector("code");
        const lang = detectLanguage(el, codeEl);
        const code = (codeEl ? codeEl.textContent : el.textContent) || "";
        const normalized = normalizeCode(code);
        if (!normalized.trim()) return "";
        const fence = makeFence(normalized);
        const langPart = lang ? lang : "";
        return `\n${fence}${langPart}\n${normalized}\n${fence}\n\n`;
      }

      if (tag === "code") {
        // inline code（pre直下は pre で処理される）
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        const fence = makeInlineFence(text);
        return `${fence}${text}${fence}`;
      }

      if (tag === "a") {
        const href = el.getAttribute("href") || "";
        const text = cleanupMarkdownInline(convertChildren(el, ctx)).trim() || href;
        if (!href) return text;
        if (href.startsWith("javascript:")) return text;
        const url = toAbsoluteUrl(href);
        return `[${text}](${url})`;
      }

      if (tag === "img") {
        const src = el.getAttribute("src") || "";
        if (!src || src.startsWith("data:")) return "";
        const alt = (el.getAttribute("alt") || "image").trim();
        return `![${alt}](${toAbsoluteUrl(src)})`;
      }

      if (tag === "strong" || tag === "b") {
        const inner = cleanupMarkdownInline(convertChildren(el, ctx)).trim();
        if (!inner) return "";
        return `**${inner}**`;
      }

      if (tag === "em" || tag === "i") {
        const inner = cleanupMarkdownInline(convertChildren(el, ctx)).trim();
        if (!inner) return "";
        return `*${inner}*`;
      }

      if (tag === "ul" || tag === "ol") {
        return convertList(el, ctx);
      }

      if (tag === "li") {
        // li は親の ul/ol から処理される前提（ここに来た場合は素直に子を展開）
        return convertChildren(el, ctx);
      }

      // div/span 等: 子要素を連結
      const combined = convertChildren(el, ctx);

      // ブロック要素っぽいものは段落区切りを入れる
      if (isBlockLike(tag)) {
        const trimmed = cleanupMarkdown(combined).trim();
        if (!trimmed) return "";
        return `${trimmed}\n\n`;
      }

      return combined;
    }

    function isBlockLike(tag) {
      return (
        tag === "div" ||
        tag === "section" ||
        tag === "article" ||
        tag === "main" ||
        tag === "header" ||
        tag === "footer" ||
        tag === "figure" ||
        tag === "figcaption"
      );
    }

    function convertList(listEl, ctx) {
      const isOrdered = listEl.tagName.toLowerCase() === "ol";
      const items = Array.from(listEl.children).filter(
        (c) => c.tagName && c.tagName.toLowerCase() === "li"
      );
      if (items.length === 0) return "";

      let index = 1;
      const lines = [];
      for (const li of items) {
        lines.push(convertListItem(li, {
          ...ctx,
          listDepth: ctx.listDepth + 1,
          listOrdered: isOrdered,
          listIndex: index++,
        }));
      }
      return `${lines.join("\n")}\n\n`;
    }

    function convertListItem(li, ctx) {
      const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1));
      const bullet = ctx.listOrdered ? `${ctx.listIndex}. ` : "- ";

      const childParts = [];
      const nestedLists = [];

      for (const child of li.childNodes) {
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          (child.tagName.toLowerCase() === "ul" || child.tagName.toLowerCase() === "ol")
        ) {
          nestedLists.push(child);
          continue;
        }
        childParts.push(convertNode(child, ctx));
      }

      const text = cleanupMarkdownInline(childParts.join("")).replace(/\s+\n/g, "\n").trim();
      const headLine = `${indent}${bullet}${text || ""}`.trimEnd();

      const nestedMdParts = [];
      for (const nl of nestedLists) {
        nestedMdParts.push(convertList(nl, ctx).trimEnd());
      }
      const nestedMd = nestedMdParts.filter(Boolean).join("\n");

      if (!nestedMd) return headLine;
      return `${headLine}\n${nestedMd}`;
    }

    function detectLanguage(preEl, codeEl) {
      const fromClass = (value) => {
        const m = String(value || "").match(/language-([a-z0-9_+-]+)/i);
        return m ? m[1] : "";
      };
      return (
        fromClass(codeEl?.className) ||
        fromClass(preEl.className) ||
        String(codeEl?.getAttribute("data-language") || preEl.getAttribute("data-language") || "")
      ).trim();
    }

    function normalizeCode(code) {
      return String(code).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/g, "");
    }

    function makeFence(code) {
      const matches = String(code).match(/`+/g) || [];
      const max = matches.reduce((m, s) => Math.max(m, s.length), 0);
      const len = Math.max(3, max + 1);
      return "`".repeat(len);
    }

    function makeInlineFence(text) {
      const matches = String(text).match(/`+/g) || [];
      const max = matches.reduce((m, s) => Math.max(m, s.length), 0);
      return "`".repeat(max + 1);
    }

    function toAbsoluteUrl(href) {
      try {
        return new URL(href, location.href).toString();
      } catch {
        return href;
      }
    }

    function escapeText(text) {
      return String(text).replace(/\u00a0/g, " ");
    }
  }

  function cleanupMarkdownInline(text) {
    return String(text).replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n");
  }

  function cleanupMarkdown(text) {
    return String(text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
