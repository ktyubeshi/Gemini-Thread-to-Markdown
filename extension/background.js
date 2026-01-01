const configureActionRules = () => {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: "gemini.google.com" },
          }),
        ],
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
};

chrome.runtime.onInstalled.addListener(configureActionRules);
chrome.runtime.onStartup.addListener(configureActionRules);
