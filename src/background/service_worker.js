const openHeraTab = () => chrome.tabs.create({
    url: chrome.runtime.getURL('index.html')
});

// Prefer the native side panel. Browsers without this Chrome-specific API
// open Hera in a regular extension tab instead.
if (chrome.sidePanel?.setPanelBehavior) {
    Promise.resolve(
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    ).catch((error) => console.error(error));
} else {
    chrome.action.onClicked.addListener(() => {
        openHeraTab().catch((error) => console.error(error));
    });
}

// Create a context menu item on installation
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "heraai-send",
        title: "HeraAi'a Gönder",
        contexts: ["selection"]
    });
});

// Listener for context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "heraai-send" && info.selectionText) {
        chrome.storage.local.set({ selectedText: info.selectionText }, () => {
            if (tab?.windowId && chrome.sidePanel?.open) {
                chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
                    // Writing to storage is enough for the side panel to pick up later.
                });
            } else {
                openHeraTab().catch((error) => console.error(error));
            }
        });
    }
});

// Forward messages from content script to side panel
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message.type === 'HERAAI_CROP_DONE') {
        chrome.runtime.sendMessage(message).catch(() => {
            // Side panel might not be open, ignore
        });
    }
});
