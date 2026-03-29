// Allows users to open the side panel by clicking on the action toolbar icon
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// Create a context menu item on installation
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "heraai-send",
        title: "HeraAi'a Gönder",
        contexts: ["selection"]
    });
});

// Listener for context menu clicks
chrome.contextMenus.onClicked.addListener((info, _tab) => {
    if (info.menuItemId === "heraai-send" && info.selectionText) {
        chrome.storage.local.set({ selectedText: info.selectionText }, () => {
            // Open the side panel if it's not open (requires user action context generally, 
            // but writing to storage triggers storage listener in App.jsx anyway)
        });
    }
});

// Forward messages from content script to side panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'HERAAI_CROP_DONE') {
        chrome.runtime.sendMessage(message).catch(() => {
            // Side panel might not be open, ignore
        });
    }
});
