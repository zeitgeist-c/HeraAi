# Chat UI Compact & Actions Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact chat message cards, move stop button to input area, icon-only actions, add retry action for user messages with mode-aware context.

**Architecture:** ChatMessage component gets compact padding/spacing, icon-only action buttons in header row (hover-visible + focus visible), cancel button removed from skeleton. App.jsx gets stop button replacing send button during streaming, retry handler using message mode metadata, and user messages now store `mode` field for retry context.

**Tech Stack:** React 19, Tailwind CSS, Lucide icons, react-markdown

---

## File Structure

### Modified Files
- `src/components/ChatMessage.jsx`
- `src/App.jsx`
- `src/locales/en.json`
- `src/locales/tr.json`

---

## Task 1: `src/components/ChatMessage.jsx` — Compact Layout & Icon-Only Actions

- [ ] **Import additions**: Add `RefreshCw` to lucide-react imports (already have: `Bot, User, Copy, Check, Image as ImageIcon, FileText, Pencil`)
- [ ] **Remove `onCancel` prop**: Delete from function signature and all usage
- [ ] **Add `onRetry` prop**: to function signature

```js
const ChatMessage = memo(({ message, onEdit, isPending, onRetry }) => {
```

- [ ] **Reduce outer container padding**: `p-4` → `px-4 py-2.5`
- [ ] **Reduce gap**: `gap-3` → `gap-2.5`
- [ ] **Reduce avatar size**: `w-8 h-8` → `w-7 h-7`, icon `w-5 h-5` → `w-4 h-4`, add `mt-0.5` for alignment
- [ ] **Remove `pt-1`** from content flex container
- [ ] **Reduce `space-y-2`** → `space-y-1`
- [ ] **Restructure header**: Replace simple `<span>` with a flex row. Left: name label. Right: action icons (opacity-0 group-hover:opacity-100, also visible on focus-within for keyboard/touch)

```jsx
<div className="flex items-center justify-between">
  <span className="text-[11px] font-semibold text-muted-foreground">
    {isBot ? t('chat.gemini') : t('chat.you')}
  </span>
  {/* Actions moved to header row */}
  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
    {isBot && message.content && (
      <button onClick={handleCopyMessage}
        title={t('chat.tooltips.copy')}
        aria-label={t('chat.tooltips.copy')}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    )}
    {!isBot && message.content && (
      <>
        <button onClick={() => onRetry?.(message)}
          title={t('chat.tooltips.retry')}
          aria-label={t('chat.tooltips.retry')}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => onEdit?.(message.content)}
          title={t('chat.tooltips.edit')}
          aria-label={t('chat.tooltips.edit')}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </>
    )}
  </div>
</div>
```

- [ ] **Remove the entire old action buttons block** (lines 133-152 in current file: the `opacity-0 group-hover:opacity-100` div with text labels)
- [ ] **Compact skeleton**: Replace loading skeleton min-h and bar heights

```jsx
{isBot && isPending && !message.content ? (
  <div className="space-y-1.5 min-h-[28px] pt-0.5">
    <div className="h-2.5 bg-muted-foreground/15 rounded w-3/4 animate-pulse" />
    <div className="h-2.5 bg-muted-foreground/15 rounded w-1/2 animate-pulse" />
  </div>
) : (...)}
```

Note: `pt-0.5` on skeleton keeps it aligned with content position. The skeleton and content share the same container so there's no height jump when stream starts — the skeleton bars are replaced by content text in the same DOM position.

- [ ] **Reduce font size on name header**: `text-xs` → `text-[11px]`
- [ ] **Add `group-focus-within`** to action container so keyboard navigation can reveal buttons
- [ ] **Ensure hit area**: `p-1.5` gives ~28x28px minimum hit area (within spec of ~24x24)

## Task 2: `src/App.jsx` — Stop Button, Retry Logic, Mode Metadata

### 2a: Stop Button in Input Area (lines ~898-904)

- [ ] **Import `Square`** from lucide-react
- [ ] **Replace send button** with conditional send/stop:

```jsx
<button
  onClick={isGenerating ? cancelStream : handleSend}
  disabled={!isGenerating && (!input.trim() && attachments.length === 0)}
  title={isGenerating ? t('chat.tooltips.stop') : ''}
  className={`flex items-center justify-center p-2 rounded-lg transition-all shadow-sm ${
    isGenerating
      ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90 animate-pulse'
      : 'bg-primary text-primary-foreground hover:bg-primary/90'
  } disabled:opacity-50 disabled:pointer-events-none`}
>
  {isGenerating ? <Square className="w-4 h-4" /> : <Send className="w-4 h-4" />}
</button>
```

- [ ] **Remove `onCancel` prop** from ChatMessage rendering in App.jsx (was line 732 `onCancel={isLastAssistant ? cancelStream : undefined}`)
- [ ] **Add `onRetry` prop** to ChatMessage rendering:

```jsx
<ChatMessage
  key={msg.id ?? idx}
  message={msg}
  isPending={isLastAssistant && isGenerating}
  onRetry={handleRetry}
  onEdit={(text) => { /* existing */ }}
/>
```

### 2b: Add `mode` to User Messages

- [ ] **In `handleSend`**, after constructing `userMsg`, add a `mode` field:

```js
const mode = enableResearch ? 'web' : (attachments.length > 0 ? 'vision' : 'chat');
const userMsg = {
  id: msgIdCounter.current++,
  role: 'user',
  content: userText,
  attachments: messageAttachments,
  mode, // NEW: 'chat' | 'web' | 'vision'
};
```

### 2c: Add `handleRetry` Callback

```js
const handleRetry = useCallback(async (userMsg) => {
  if (isGeneratingRef.current || !userMsg?.content) return;

  const retryMode = userMsg.mode || 'chat';
  updateStats(retryMode === 'web' ? ['message', 'search'] : 'message');

  setGenerating(true);
  setMessages(prev => [...prev, { id: msgIdCounter.current++, role: 'model', content: '' }]);

  const controller = new AbortController();
  streamingControllerRef.current = controller;

  try {
    const options = {
      systemInstruction: appConfig?.systemInstruction || '',
    };

    // Build context: all messages up to and including this userMsg
    const msgIndex = messages.findIndex(m => m.id === userMsg.id);
    if (msgIndex === -1) throw new Error('Message not found');
    const contextMessages = messages.slice(1, msgIndex + 1); // skip welcome, include userMsg

    // Use the message's original mode, NOT current enableResearch state
    const events = retryMode === 'web'
      ? streamResearch(userMsg.content, controller.signal)
      : retryMode === 'vision'
        ? streamVision(contextMessages, userMsg.attachments?.[0]?.data, options, controller.signal)
        : streamChat(contextMessages, options, controller.signal);

    // Same event handling as handleSend
    for await (const evt of events) {
      if (evt.event === 'chunk') {
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex] = {
            ...newMessages[lastIndex],
            content: newMessages[lastIndex].content + evt.data.text
          };
          return newMessages;
        });
      } else if (evt.event === 'sources') {
        const sourcesHtml = '\n\n─── ' + t('chat.sources_label') + ' ───\n'
          + evt.data.sources.map(s => `[${s.index}] ${s.title} → ${s.url}`).join('\n');
        setMessages(prev => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex] = {
            ...newMessages[lastIndex],
            content: newMessages[lastIndex].content + sourcesHtml
          };
          return newMessages;
        });
      } else if (evt.event === 'error') {
        toast.error(evt.data.message, { duration: 5000 });
        break;
      } else if (evt.event === 'key_status') {
        // forward key_status to keyManager if needed
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error("handleRetry Error", err);
    toast.error(t('chat.connection_error'));
  } finally {
    setGenerating(false);
    streamingControllerRef.current = null;
  }
}, [isGenerating, messages, appConfig, t]);
```

- [ ] **Add `handleRetry` to dependencies**: No new deps beyond what `handleSend` already has
- [ ] **Note**: `handleRetry` does NOT add the user message again (it's already in `messages`). It only adds a new empty assistant message and starts streaming with `contextMessages` (which includes the user message as the last item). This ensures the backend treats the user message as the current prompt.

### 2d: Quick Action Mode Preservation

Quick actions (translate/summarize/explain) work by prepending `t('chat.prompts.translate') + ':\n'` to the input text. The resulting `userText` already contains this prefix. When retried, the same prefixed content is sent via `streamChat`. So the AI will interpret it correctly without needing a separate `mode` value.

The `mode` field on user messages only needs `'chat'` | `'web'` | `'vision'` — quick actions are all `'chat'`.

## Task 3: Update Locales

- [ ] **`src/locales/en.json`**: Add to `chat.tooltips`:

```json
"retry": "Regenerate response",
"stop": "Stop"
```

- [ ] **`src/locales/tr.json`**: Add to `chat.tooltips`:

```json
"retry": "Yeniden yanıt oluştur",
"stop": "Durdur"
```

## Task 4: Verify Existing Behaviors Unchanged

- [ ] Loading skeleton: compact but no layout jump when stream starts (same container)
- [ ] Scroll auto-follow: `useLayoutEffect` and scroll logic unchanged
- [ ] SSE streaming: same `for await` pattern, just new events passed
- [ ] Web Research: `streamResearch` preserves `search_status` and `sources` events
- [ ] Vision: `streamVision` preserves image handling
- [ ] Quick actions (translate/summarize/explain): prompt text embedding unchanged
- [ ] Settings/key management: only ChatMessage and App.jsx input area changed
- [ ] Source links display: preserved in `handleSend` and `handleRetry`

---

## Test Checklist (Manual)

1. Short assistant message → card height compact (~60-80px), not ~100px+
2. Short user message → card compact, no wasted space
3. Long message with code block → readable, no horizontal overflow
4. Skeleton loading → `min-h-[28px]`, small pulsating bars
5. Streaming → stop button (red `Square`) replaces send button in input area
6. Stream ends → stop button reverts to send (`Send` icon)
7. Copy action → icon-only in header, hover visible, copies text
8. Edit action → icon-only in header, fills input with message text
9. Retry action → new assistant message generated from same user context
10. Retry with `mode: 'web'` → re-runs Web Research pipeline
11. Retry with `mode: 'vision'` → re-runs vision pipeline
12. Retry with `mode: 'chat'` → normal chat (including quick action prefixes if present)
13. Multiple retries of same message → each creates a new assistant message, no UI corruption
14. Actions visible on hover (desktop) and focus (keyboard/touch)
15. Tooltip and aria-label on every action button
16. Existing scroll, settings, stats, shortcuts, crop all work
