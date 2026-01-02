const copyBtn = document.getElementById("copyBtn");
const statusDiv = document.getElementById("status");
const includeCanvasCheckbox = document.getElementById("includeCanvas");

// 設定の読み込み
document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("includeCanvas");
  if (saved !== null) {
    includeCanvasCheckbox.checked = saved === "true";
  }
});

function setStatus(message, { error = false } = {}) {
  statusDiv.textContent = message;
  statusDiv.className = error ? "error" : "";
}

copyBtn.addEventListener("click", async () => {
  setStatus("処理中...");

  // 設定の保存
  const includeCanvas = includeCanvasCheckbox.checked;
  localStorage.setItem("includeCanvas", includeCanvas);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("アクティブなタブを取得できませんでした。");

    const execPromise = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractMarkdownFromPage,
      args: [includeCanvas], // 引数として渡す
    });

    const [{ result }] = await withTimeout(
      execPromise,
      includeCanvas ? 60_000 : 20_000,
      "タイムアウトしました。Canvasが多い/開けない状態の可能性があります。必要ならCanvasを手動で開いてから再実行してください。"
    );

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

function withTimeout(promise, ms, message) {
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

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

async function extractMarkdownFromPage(includeCanvas) {
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

    // Canvas処理
    if (includeCanvas) {
      const canvasSections = await extractAllCanvasContent(root);
      if (canvasSections.length > 0) {
        for (const section of canvasSections) {
          output.push("", "---", "", section);
        }
      } else {
        // 取得できず、かつ参照がある場合は警告
        const hasCanvasRef = checkForCanvasReference(root);
        if (hasCanvasRef) {
          output.push("", "---", "", "> [!WARNING]", "> **Canvas content not found.**", "> Auto-open failed. Please **OPEN the Side Panel MANUALLY** and select the **\"Code\" (コード)** tab.");
        }
      }
    }

    return cleanupMarkdown(output.join("\n"));
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }


  function captureUiState(root) {
    const closeBtnSel =
      'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]';
    const sidebarWasOpen = !!document.querySelector(closeBtnSel);
    const sidePanel = sidebarWasOpen ? findSidePanel() : null;

    const windowScroll = { x: window.scrollX, y: window.scrollY };

    const activeSidebarTabLabel = (() => {
      if (!sidePanel) return null;
      const tabs = Array.from(sidePanel.querySelectorAll('button[role="tab"], button[role="radio"]'));
      const active = tabs.find((t) =>
        t.getAttribute("aria-selected") === "true" || t.getAttribute("aria-pressed") === "true"
      );
      const label = (active?.textContent || active?.getAttribute("aria-label") || "").trim();
      return label || null;
    })();

    const hadMonacoOpen = !!document.querySelector(".monaco-editor .view-line");
    const currentCanvasTitle = (() => {
      const titleEl = document.querySelector('div[class*="title-m"]');
      const title = (titleEl?.textContent || "").trim();
      return title || null;
    })();

    const sidePanelScrollTop = sidePanel ? sidePanel.scrollTop : null;

    const { container: createdContainer } = findCreatedSectionContainer(root) || {};
    const fileListScrollTop =
      createdContainer && typeof createdContainer.scrollTop === "number"
        ? createdContainer.scrollTop
        : null;

    const monacoScrollable = document.querySelector(".monaco-editor .scrollable-element");
    const monacoScroll = monacoScrollable
      ? { top: monacoScrollable.scrollTop, left: monacoScrollable.scrollLeft }
      : null;

    const immersivePanelOpen = isImmersivePanelOpen();

    return {
      sidebarWasOpen,
      activeSidebarTabLabel,
      hadMonacoOpen,
      currentCanvasTitle,
      windowScroll,
      sidePanelScrollTop,
      fileListScrollTop,
      monacoScroll,
      immersivePanelOpen,
    };
  }

  async function restoreUiState(root, state) {
    const closeBtnSel =
      'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]';
    const shouldCloseImmersive = !state?.immersivePanelOpen;

    try {
      if (state?.windowScroll) {
        window.scrollTo(state.windowScroll.x, state.windowScroll.y);
      }

      if (!state?.sidebarWasOpen) {
        const closeBtn = document.querySelector(closeBtnSel);
        if (closeBtn) {
          closeBtn.click();
          await waitFor(() => !document.querySelector(closeBtnSel), {
            timeout: 1500,
            interval: 100,
          });
        }
        if (shouldCloseImmersive) {
          await closeImmersivePanel();
        }
        return;
      }

      await ensureSidebarOpen(root);
      const sidePanel = findSidePanel();

      if (state.hadMonacoOpen && state.currentCanvasTitle) {
        await ensureFileListVisible(root);
        await openFileByTitle(root, state.currentCanvasTitle);

        if (sidePanel) ensureCodeTabSelected(sidePanel);

        if (state.monacoScroll) {
          await waitFor(() => document.querySelector(".monaco-editor .scrollable-element"), {
            timeout: 1500,
            interval: 100,
          });
          const monacoScrollable = document.querySelector(".monaco-editor .scrollable-element");
          if (monacoScrollable) {
            monacoScrollable.scrollTop = state.monacoScroll.top;
            monacoScrollable.scrollLeft = state.monacoScroll.left;
          }
        }
      } else {
        if (sidePanel && state.activeSidebarTabLabel) {
          const tabs = Array.from(sidePanel.querySelectorAll('button[role="tab"], button[role="radio"]'));
          const target = tabs.find((t) => {
            const label = ((t.textContent || "") || (t.getAttribute("aria-label") || "")).trim();
            return label === state.activeSidebarTabLabel;
          });
          target?.click();
        }

        if (!state.hadMonacoOpen) {
          const monacoOpen = !!document.querySelector(".monaco-editor .view-line");
          if (monacoOpen && sidePanel) {
            if (!clickBackButton(sidePanel)) {
              clickFilesTab(sidePanel);
            }
            await waitFor(() => !document.querySelector(".monaco-editor .view-line"), {
              timeout: 1500,
              interval: 100,
            });
          }
        }

        if (typeof state.fileListScrollTop === "number") {
          await ensureFileListVisible(root);
          const { container } = findCreatedSectionContainer(root) || {};
          if (container) container.scrollTop = state.fileListScrollTop;
        }
      }

      if (sidePanel && typeof state.sidePanelScrollTop === "number") {
        sidePanel.scrollTop = state.sidePanelScrollTop;
      }

      if (shouldCloseImmersive) {
        await closeImmersivePanel();
      }
    } catch (e) {
      console.warn("UI restore failed (best-effort):", e);
    }
  }

  async function extractAllCanvasContent(root) {
    const uiState = captureUiState(root);
    const results = [];
    const processedTitles = new Set();
    const processedContentHashes = new Set(); // 内容重複チェック用（念のため）

    const totalStart = Date.now();
    const MAX_TOTAL_MS = 45_000;

    try {
      try {
        // 1. まず現在の表示を取得してみる
        let currentContent = getCanvasContent();
        if (currentContent) {
          const titleMatch = currentContent.match(/## Canvas: (.*)\n/);
          const title = titleMatch ? titleMatch[1].trim() : "Untitled";
          processedTitles.add(title);
          results.push(currentContent);
        }

        // 2. サイドバーを開く
        await ensureSidebarOpen(root);
        await ensureFileListVisible(root);

        // 3. 「作成済み」等のセクションからファイル名一覧を取得
        // React/Angularの再レンダリング対策として、要素そのものではなく「タイトル名」で管理する
        const titles = listCreatedFileTitles(root);

        if (titles.length > 0) {
          let everOpenedEditor = false;

          // 各タイトルについて、都度要素を探してクリック -> 取得
          for (const title of titles) {
            if (Date.now() - totalStart > MAX_TOTAL_MS) break;

            try {
              const listReady = await ensureFileListVisible(root);
              if (!listReady) {
                console.warn("File list is not visible. Aborting canvas extraction loop.");
                break;
              }

              // 既に取得済みならスキップ (currentContentで取れている場合など)
              if (processedTitles.has(title)) continue;

              const clicked = await openFileByTitle(root, title);
              if (!clicked) {
                console.warn(`Failed to click file: ${title}`);
                continue;
              }

              // サイドバー内のCodeタブを押す (もしあれば)
              const closeBtn = document.querySelector(
                'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]'
              );
              let sidePanel = null;
              if (closeBtn) {
                sidePanel =
                  closeBtn.closest("side-navigation-v2") ||
                  closeBtn.closest("aside") ||
                  closeBtn.closest(".content");
              }
              if (sidePanel) {
                // Codeタブへの切り替え待ち (少しタイムラグがある場合があるためwaitForに入れる)
                await waitFor(
                  async () => {
                    ensureCodeTabSelected(sidePanel);
                    return true;
                  },
                  { timeout: 1000, interval: 200 }
                );
              }

              // コンテンツ取得
              // DOM上のタイトルが取れなくても、ループ中の title (ファイル名) を正とする
              const remainingMs = MAX_TOTAL_MS - (Date.now() - totalStart);
              if (remainingMs <= 0) break;
              const content = await waitFor(
                () => {
                  const c = getCanvasContent({ titleFallback: title });
                  // 自明なエラーチェック: まだロード中か？
                  if (!c) return null;
                  return c;
                },
                { timeout: Math.min(8000, remainingMs), interval: 200 } // 初回は少し長めでもよい
              );

              if (content) {
                results.push(content);
                processedTitles.add(title);
                everOpenedEditor = true;
              } else {
                // 1度もエディタが開けていないなら、以降も成功確率が低いので早期終了
                if (!everOpenedEditor) break;
              }

              const listRestored = await ensureFileListVisible(root);
              if (!listRestored) {
                console.warn("Failed to restore file list after reading canvas content.");
                break;
              }

            } catch (err) {
              console.warn(`Error processing file "${title}":`, err);
            }
          }
        } else {
          // もし「作成済み」セクションが見つからない、または空の場合
          // 従来のロジック（ボタン総当たり）にフォールバック、または
          // 単一ファイルとして扱う（既にstep 1で取得済みならOK）

          // フォールバック: 旧来の "items" 取得ロジック
          const { items, sidePanel } = getCanvasSidebarItems(root);
          if (items.length > 0) {
            // ... (既存のループ処理があればここに入れるが、今回はtitlesが取れない＝構造が違う、とみなして無理に深追いしない)
            // ただし、「作成済み」以外のセクションにあるファイル（Refinedなど）も考慮するなら
            // ここで getCanvasSidebarItems を呼ぶのもあり。
            // いったん「作成済み」が空なら何もしない（step 1の結果のみ）
          }

          // もしボタンで「開く」があるなら（サイドバーじゃなくてチップ表示の場合など）
          if (results.length === 0) {
            const opened = await tryClickOpenButton(root);
            if (opened) {
              await waitFor(() => getCanvasContent(), { timeout: 3000 });
              const content = getCanvasContent();
              if (content) results.push(content);
            }
          }
        }
      } catch (e) {
        console.warn("Error extracting multiple canvas contents:", e);
      }

      return results;
    } finally {
      await restoreUiState(root, uiState);
    }
  }

  function findCreatedSectionContainer(root) {
    const scopes = [];
    if (root) scopes.push(root);
    if (root !== document) scopes.push(document);

    const seen = new Set();
    for (const scope of scopes) {
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);

      // 1. 言語非依存: source-container 内に sidebar-immersive-chip があるものを優先
      const containers = Array.from(scope.querySelectorAll("div.source-container"));
      const chipContainer = containers.find((c) => c.querySelector("sidebar-immersive-chip"));
      if (chipContainer) return { container: chipContainer, scope };

      // 2. 見つからなければ従来ヘッダーに紐づく source-container を探す（多言語対応しつつフォールバック）
      const headers = Array.from(scope.querySelectorAll("div.section-header, div.gds-title-s"));
      const targetHeader = headers.find((el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        return ["作成済み", "created", "files", "ファイル"].includes(text);
      });
      if (targetHeader) {
        let container = targetHeader.nextElementSibling;
        while (container && !container.classList.contains("source-container")) {
          container = container.nextElementSibling;
          if (!container || container.tagName === "SECTION" || container.classList.contains("section-header")) {
            container = null;
            break;
          }
        }
        if (container) return { container, scope };
      }
    }

    return { container: null, scope: null };
  }

  function listCreatedFileTitles(root) {
    const { container } = findCreatedSectionContainer(root);
    if (!container) {
      // セクションが見つからない場合、もしかしたらセクション分けがないかも？
      // その場合は sidebar-immersive-chip 全体から取る策もあるが、誤爆避けのため慎重に。
      // いったん空を返す（フォールバックへ）
      return [];
    }

    if (!isElementVisible(container)) return [];

    // 3. コンテナ内のチップからタイトルを収集
    const titleEls = Array.from(container.querySelectorAll("sidebar-immersive-chip .immersive-title"));
    const titles = titleEls.map(el => (el.textContent || "").trim()).filter(t => t.length > 0);

    // 重複排除して返す
    return Array.from(new Set(titles));
  }

  async function openFileByTitle(root, title) {
    // 再検索：タイトルに一致するチップを探してクリック
    // listCreatedFileTitles と同じロジックでコンテナを特定
    const { container } = findCreatedSectionContainer(root);
    if (!container || !isElementVisible(container)) return false;

    // コンテナ内でタイトル一致するチップを探す
    // 完全一致で検索
    const chips = Array.from(container.querySelectorAll("sidebar-immersive-chip"));
    const targetChip = chips.find(chip => {
      const titleEl = chip.querySelector(".immersive-title");
      return titleEl && (titleEl.textContent || "").trim() === title;
    });

    if (targetChip) {
      // 仮想スクロール対策：見えていないとクリックできないことがあるためスクロールさせる
      // Click target correction: the actual clickable element is often inside the chip
      const clickable = targetChip.querySelector(".container, .clickable") || targetChip;
      clickable.scrollIntoView({ block: "center", behavior: "auto" });
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }

    return false;
  }

  async function ensureSidebarOpen(root) {
    const closeBtnSel =
      'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]';

    // サイドバーが開いているか確認（要素が可視ならOK）
    const sidePanel = findSidePanel();
    if (sidePanel && isElementVisible(sidePanel)) return;

    const closeSidebarBtn = document.querySelector(closeBtnSel);
    if (closeSidebarBtn) return; // 既に開いている（ボタンがある）

    const openSidebarBtn = findSidebarToggleButton();

    if (openSidebarBtn) {
      openSidebarBtn.click();
      await waitFor(() => {
        const closeBtn = document.querySelector(closeBtnSel);
        const panel = findSidePanel();
        return !!(closeBtn || (panel && isElementVisible(panel)));
      }, { timeout: 2500 });
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return el.getClientRects().length > 0;
  }

  function isFileListVisible(root) {
    const { container } = findCreatedSectionContainer(root);
    return !!(container && isElementVisible(container));
  }

  function getMatIconName(el) {
    if (!el) return "";
    const iconEl = el.matches?.("mat-icon, [data-mat-icon-name]") ? el : el.querySelector?.("mat-icon, [data-mat-icon-name]");
    if (!iconEl) return "";
    const attr =
      (iconEl.getAttribute("data-mat-icon-name") ||
        iconEl.getAttribute("fonticon") ||
        "").trim().toLowerCase();
    const text = (iconEl.textContent || "").trim().toLowerCase();
    return attr || text;
  }

  function buttonHasIcon(button, names = []) {
    if (!button) return false;
    const name = getMatIconName(button);
    if (!name) return false;
    return names.some((n) => name === n.toLowerCase());
  }

  function findSidebarToggleButton() {
    // 最優先: data-test-id で特定（言語非依存、意図したボタンのみ）
    const dataTestIcon = document.querySelector('mat-icon[data-test-id="studio-sidebar-icon"]');
    if (dataTestIcon) {
      const btn = dataTestIcon.closest("button");
      if (btn) return btn;
    }

    const explicit = document.querySelector("studio-sidebar-button button");
    if (explicit) return explicit;

    const candidates = Array.from(document.querySelectorAll("button"));
    return (
      candidates.find((btn) => {
        // サイドナビ内やメインメニューのトグルは避ける
        if (btn.closest("side-navigation-v2, nav")) {
          if (buttonHasIcon(btn, ["menu"])) return false;
        }
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("sidebar")) return true;
        // アイコンで判定（home_storage が最も安定）
        if (buttonHasIcon(btn, ["home_storage", "folder_open"])) return true;
        return false;
      }) || null
    );
  }

  function findImmersivePanel() {
    return (
      document.querySelector("code-immersive-panel") ||
      document.querySelector("immersive-panel")
    );
  }

  function isImmersivePanelOpen() {
    const panel = findImmersivePanel();
    return !!(panel && isElementVisible(panel));
  }

  async function closeImmersivePanel() {
    const panel = findImmersivePanel();
    if (!panel) return true;

    const buttonSelectors = [
      "button.close-button",
      'button[aria-label*="閉じる"]',
      'button[aria-label*="Close"]',
      'button[aria-label*="close"]',
      'button[title*="閉じる"]',
      'button[title*="Close"]',
    ];

    let closeBtn =
      panel.querySelector(buttonSelectors.join(",")) ||
      Array.from(panel.querySelectorAll("button"))
        .find((btn) => buttonHasIcon(btn, ["close", "cancel", "clear"])) ||
      (() => {
        const matIcon = panel.querySelector('[data-mat-icon-name="close"]');
        return matIcon?.closest("button") || null;
      })();

    if (closeBtn) {
      closeBtn.click();
      const closed = await waitFor(() => !isImmersivePanelOpen(), {
        timeout: 2000,
        interval: 100,
      });
      return !!closed;
    }

    return !isImmersivePanelOpen();
  }

  function findSidePanel() {
    // 1. 閉じるボタンから親を辿る（ロケール依存しないアイコンでクリック済みでも最も確実）
    const closeBtn = document.querySelector(
      'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"], button.close-button'
    );
    if (closeBtn) {
      return (
        closeBtn.closest("side-navigation-v2") ||
        closeBtn.closest("aside") ||
        closeBtn.closest(".content")
      );
    }

    // 2. 構造ベースで side-navigation-v2 / aside を優先
    const candidates = Array.from(document.querySelectorAll("side-navigation-v2, aside"));
    const withContent = candidates.find((el) => {
      return (
        el.querySelector(".source-container") ||
        el.querySelector("sidebar-immersive-chip") ||
        el.querySelector("[data-section-id]")
      );
    });
    if (withContent) return withContent;

    // 3. テキストベースは最後のフォールバック（ロケール依存）
    return (
      candidates.find((el) => {
        const text = el.textContent || "";
        return (
          (text.includes("ファイル") && !text.includes("チャット")) ||
          (text.includes("Files") && !text.includes("Chat")) ||
          text.includes("作成済み") ||
          text.includes("Created")
        );
      }) || null
    );
  }

  function clickBackButton(scope) {
    if (!scope) return false;
    const backSelectors = [
      'button[aria-label*="戻る"]',
      'button[aria-label*="Back"]',
      'button[title*="戻る"]',
      'button[title*="Back"]',
    ];
    const labeled = scope.querySelector(backSelectors.join(","));
    if (labeled) {
      labeled.click();
      return true;
    }

    const icon = Array.from(scope.querySelectorAll("button mat-icon")).find((el) => {
      const name = (el.textContent || "").trim();
      return (
        name === "arrow_back" ||
        name === "arrow_back_ios" ||
        name === "chevron_left" ||
        name === "keyboard_backspace"
      );
    });
    if (icon) {
      const btn = icon.closest("button");
      if (btn) {
        btn.click();
        return true;
      }
    }

    return false;
  }

  function clickFilesTab(scope) {
    if (!scope) return false;
    const buttons = Array.from(scope.querySelectorAll('button[role="tab"], button[role="radio"], button'));
    const target = buttons.find((btn) => {
      const text = (btn.textContent || "").trim();
      const label = (btn.getAttribute("aria-label") || "").trim();
      const value = text || label;
      if (!value) return false;
      if (value.includes("サイドバー") || value.includes("sidebar")) return false;
      return (
        value === "ファイル" ||
        value === "Files" ||
        value.includes("ファイル一覧") ||
        value.includes("Files list")
      );
    });
    if (target) {
      target.click();
      return true;
    }
    return false;
  }

  async function ensureFileListVisible(root) {
    if (isFileListVisible(root)) return true;

    const sidePanel = findSidePanel();
    if (sidePanel) {
      if (clickBackButton(sidePanel)) {
        const ok = await waitFor(() => isFileListVisible(root), { timeout: 1500, interval: 100 });
        if (ok) return true;
      }
      if (clickFilesTab(sidePanel)) {
        const ok = await waitFor(() => isFileListVisible(root), { timeout: 1500, interval: 100 });
        if (ok) return true;
      }
    }

    // Fallback: サイドバーを閉じて開き直す
    const closeBtn = document.querySelector(
      'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]'
    );
    if (closeBtn) {
      closeBtn.click();
      await waitFor(() => !document.querySelector(
        'button[aria-label="サイドバーを閉じます"], button[aria-label="Close sidebar"]'
      ), { timeout: 1500, interval: 100 });
    }
    await ensureSidebarOpen(root);
    return isFileListVisible(root);
  }

  async function waitFor(fn, { timeout = 8000, interval = 100 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await fn();
        if (result) return result;
      } catch (e) {
        // ignore transient errors
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }

  function getCanvasSidebarItems(root) {
    const sidePanel = findSidePanel();

    // フォールバック: 全体探索は危険なのでやめる。見つからなければ空を返す。
    if (!sidePanel) return { items: [], sidePanel: null };

    // ボタン取得
    // fallbackとして使うので一応残すが、メインは listCreatedFileTitles に移行したため
    // 使われないが、万が一のために残しておく
    const buttons = Array.from(sidePanel.querySelectorAll("button"));
    const items = buttons.filter((btn) => {
      const text = (btn.textContent || "").trim();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();

      // まずアイコンだけのボタンは落とす（closeなどが混ざる可能性）
      // ただし、ファイル名がアイコンのみで表現されることは稀なので、textありが前提
      if (!text) return false;

      // 明確に除外したい操作系
      if (aria.includes("close") || aria.includes("閉じ")) return false;
      if (aria.includes("toggle") || aria.includes("切り替え")) return false;
      if (text === "閉じる" || text === "Close") return false;

      // ファイル名っぽいものだけ (拡張子がある、または特定のキーワードがないなど)
      // 厳格に拡張子チェックをする
      return /\.(html|css|js|py|json|ts|jsx|tsx|java|c|cpp|txt|md|sql|rb|go|rs|php)$/i.test(
        text
      );
    });

    return { items, sidePanel };
  }

  function ensureCodeTabSelected(scopeEl) {
    // "Code" (コード) タブ/トグルを探してクリック
    // role="tab" or role="radio" を優先。mat-button-toggle-group にも対応。
    const root = scopeEl || document;
    const tabs = Array.from(
      root.querySelectorAll('button[role="tab"], button[role="radio"]')
    );
    const codeTab = tabs.find((t) => {
      const text = (t.textContent || "").trim();
      return text.includes("Code") || text.includes("コード");
    });
    if (!codeTab) return;

    const selectedStates = [
      codeTab.getAttribute("aria-selected"),
      codeTab.getAttribute("aria-pressed"),
      codeTab.getAttribute("aria-checked"),
    ];
    const isSelected = selectedStates.some((v) => v === "true");
    if (!isSelected) {
      codeTab.click();
    }
  }

  async function tryClickOpenButton(root) {
    const openButtons = Array.from(root.querySelectorAll('button'));
    const targetBtn = openButtons.find(b => {
      const text = (b.textContent || "").trim();
      return text === "開く" || text === "Open" || b.getAttribute("aria-label")?.includes("Canvas");
    });
    if (targetBtn) {
      targetBtn.click();
      return true;
    }
    return false;
  }

  function checkForCanvasReference(root) {
    // 「開く」ボタンやアーティファクトのチップを探す簡易チェック
    // クラス名は変わりやすいため、テキストやaria-labelも補助的に使う
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], mat-chip'));
    return candidates.some(el => {
      const text = (el.textContent || "").trim();
      const label = (el.getAttribute("aria-label") || "").trim();
      return (
        text.includes("Canvas") ||
        text === "開く" ||
        text === "Open" ||
        label.includes("Canvas") ||
        (text.endsWith(".html") || text.endsWith(".js") || text.endsWith(".py")) && el.closest('.artifact-chip')
      );
    });
  }

  function getCanvasContent({ titleFallback } = {}) {
    try {
      // 1) Monaco のモデルから直接取得（最も確実）
      ensureCodeTabSelected(document);
      const monacoContent = getMonacoModelContent();
      let codeText = monacoContent?.code || null;
      let lang = monacoContent?.lang || "";

      // 2) モデルが取れない場合、DOMをスクロールしながら全行を吸い上げる
      if (!codeText) {
        codeText = readMonacoDomText();
      }

      if (!codeText) return null;

      // タイトル（ファイル名）の取得を試みる
      let title = titleFallback || "Canvas Content";
      if (!titleFallback) {
        const titleEl = document.querySelector('div[class*="title-m"]');
        if (titleEl && titleEl.textContent) {
          title = titleEl.textContent.trim();
        }
      }

      // 言語推定（モデルが教えてくれた場合を優先）
      if (!lang) {
        if (title.endsWith(".js") || title.endsWith(".ts")) lang = "javascript";
        else if (title.endsWith(".py")) lang = "python";
        else if (title.endsWith(".html")) lang = "html";
        else if (title.endsWith(".css")) lang = "css";
        else if (title.endsWith(".json")) lang = "json";
        else if (title.endsWith(".md")) lang = "markdown";
      }

      return `## Canvas: ${title}\n\n\`\`\`${lang}\n${codeText}\n\`\`\``;
    } catch (e) {
      console.warn("Canvas content extraction failed:", e);
      return null;
    }
  }

  function getMonacoModelContent() {
    try {
      const monacoApi = window.monaco;
      if (!monacoApi?.editor?.getModels) return null;
      const models = monacoApi.editor.getModels();
      if (!models || models.length === 0) return null;

      // 行数が最も多いモデルを選択（表示中エディタのモデルは多くの場合最長）
      const model = models.reduce((best, m) => {
        const count = m.getLineCount?.() || 0;
        if (!best || count > (best.count || 0)) {
          return { ref: m, count };
        }
        return best;
      }, null)?.ref;

      if (!model?.getValue) return null;
      const code = model.getValue();
      const langId =
        model.getLanguageId?.() ||
        model._languageIdentifier?.language ||
        "";

      return { code, lang: langId };
    } catch (e) {
      console.warn("Failed to read Monaco model content:", e);
      return null;
    }
  }

  function readMonacoDomText() {
    const readLines = () =>
      Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line")).map((n) =>
        (n.textContent || "").replace(/\s+$/, "")
      );

    let lines = readLines();
    if (lines.length > 0 && lines.join("").trim().length > 0 && lines.length > 1) {
      return lines.join("\n");
    }

    const scrollable = document.querySelector(".monaco-editor .scrollable-element");
    if (!scrollable) return lines.join("\n") || null;

    const originalTop = scrollable.scrollTop;
    const max = scrollable.scrollHeight;
    const step = Math.max(200, Math.floor(scrollable.clientHeight * 0.8));
    const collected = [];

    const pushLines = () => {
      const chunk = readLines();
      for (const l of chunk) {
        collected.push(l);
      }
    };

    // スクロールしながら行を収集
    pushLines();
    for (let pos = 0; pos <= max; pos += step) {
      scrollable.scrollTop = pos;
      pushLines();
    }
    scrollable.scrollTop = max;
    pushLines();
    scrollable.scrollTop = originalTop; // 可能な範囲で元位置に戻す

    // 連続重複を圧縮（仮想スクロールの重複対策）
    const compressed = [];
    for (const l of collected) {
      if (compressed.length === 0 || compressed[compressed.length - 1] !== l) {
        compressed.push(l);
      }
    }

    const text = compressed.join("\n").trim();
    return text || null;
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
        // "script", // MathJax sometimes uses script[type="math/tex"], so handle carefully below
        "style",
        "textarea",
        "input",
        '[role="button"]',
        ".feedback-container",
        ".edit-button",
        ".speech_icon",
      ];
      for (const sel of removeSelectors) {
        rootEl.querySelectorAll(sel).forEach((el) => {
          // Preserve math scripts
          if (el.tagName.toLowerCase() === "script" && (
            el.type.includes("math") || el.type.includes("tex")
          )) {
            return;
          }
          // Preserve math-related svgs if they are inside a known math container (handled by main traversal)
          // But strict removal of 'svg' here is risky if the math engine uses SVG. 
          // However, usually we want to extract the *source* NOT the SVG.
          // So we keep removing SVG, assuming we will find the source in a sibling or parent attribute.
          el.remove();
        });
      }

      // Separate pass to remove generic scripts but keep math ones
      rootEl.querySelectorAll("script").forEach(el => {
        if (!el.type.includes("math") && !el.type.includes("tex")) {
          el.remove();
        }
      });
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

      // Math / LaTeX handling
      if (
        tag === "math" ||
        el.classList.contains("katex") ||
        el.classList.contains("mjx-container") ||
        el.classList.contains("MathJax") ||
        el.classList.contains("math-inline") ||
        el.classList.contains("math-block")
      ) {
        const latex = extractLatex(el);
        if (latex) {
          const isBlock = el.classList.contains("block-math") ||
            el.classList.contains("math-block") ||
            el.style.display === "block" ||
            tag === "div" ||
            el.getAttribute("display") === "block";

          // Wrap in $$ for block, $ for inline
          // Normalize spacing
          const cleanTex = latex.trim();
          if (isBlock) {
            return `\n$$\n${cleanTex}\n$$\n\n`;
          } else {
            return `$${cleanTex}$`;
          }
        }
        // If extraction fails, fall through to default processing (might just be text)
      }

      return combined;
    }

    function extractLatex(el) {
      // 1. Look for data-math (Gemini specific) or similar
      const dataMath = el.getAttribute("data-math") || el.getAttribute("data-tex");
      if (dataMath) return dataMath;

      // 2. Look for <annotation encoding="application/x-tex"> (MathML standard)
      const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation && annotation.textContent) {
        return annotation.textContent;
      }

      // 2. Look for data attributes
      const dataTex = el.getAttribute("data-tex") || el.getAttribute("alt") || el.getAttribute("aria-label");
      if (dataTex && (dataTex.includes("\\") || dataTex.includes("="))) {
        // Simple heuristic to avoid using "image" or generic labels as latex
        return dataTex;
      }

      // 3. Look for script tags (MathJax)
      const script = el.querySelector('script[type^="math/tex"]');
      if (script && script.textContent) {
        return script.textContent;
      }

      // 4. KaTeX often has a visually hidden element with the source
      // .katex-mathml contains the mathml which might have annotation
      // .katex-html is consistent but visual only
      // Sometimes just innerText of a specific hidden span works

      return null;
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
