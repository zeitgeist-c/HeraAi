const MAX_Z_INDEX = '2147483647';
const PRIMARY_COLOR = '#0ea5e9';
const DESTRUCTIVE_COLOR = '#ef4444';

export function injectCropOverlay(translations = {}) {
  const { confirm = '✔', cancel = '✖' } = translations;
  
  if (document.getElementById('heraai-crop-overlay')) {
    document.getElementById('heraai-crop-overlay').remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'heraai-crop-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    zIndex: MAX_Z_INDEX, cursor: 'crosshair', pointerEvents: 'auto',
    backgroundColor: 'rgba(0,0,0,0.4)', userSelect: 'none'
  });

  const selection = document.createElement('div');
  Object.assign(selection.style, {
    position: 'absolute', border: `2px dashed ${PRIMARY_COLOR}`,
    backgroundColor: 'transparent', display: 'none', cursor: 'move',
    boxShadow: `0 0 0 9999px rgba(0,0,0,0.5)`
  });

  const btnContainer = document.createElement('div');
  Object.assign(btnContainer.style, {
    position: 'absolute', bottom: '-40px', right: '0', display: 'flex', gap: '8px', zIndex: '2'
  });

  const btnConfirm = document.createElement('button');
  btnConfirm.innerHTML = confirm;
  Object.assign(btnConfirm.style, {
    padding: '6px 14px', background: PRIMARY_COLOR, color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', fontFamily: 'sans-serif'
  });

  const btnCancel = document.createElement('button');
  btnCancel.innerHTML = cancel;
  Object.assign(btnCancel.style, {
    padding: '6px 14px', background: DESTRUCTIVE_COLOR, color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', fontFamily: 'sans-serif'
  });

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnConfirm);
  selection.appendChild(btnContainer);

  const handles = ['nw', 'ne', 'sw', 'se'].map(pos => {
    const handle = document.createElement('div');
    Object.assign(handle.style, {
      position: 'absolute', width: '10px', height: '10px', backgroundColor: PRIMARY_COLOR, border: '1px solid #fff', cursor: `${pos}-resize`, zIndex: '1'
    });
    if (pos.includes('n')) handle.style.top = '-5px';
    if (pos.includes('s')) handle.style.bottom = '-5px';
    if (pos.includes('w')) handle.style.left = '-5px';
    if (pos.includes('e')) handle.style.right = '-5px';
    selection.appendChild(handle);
    return { el: handle, pos };
  });

  overlay.appendChild(selection);
  document.body.appendChild(overlay);

  let startX, startY, isDrawing = false, isDragging = false, isResizing = null;
  let rect = { x: 0, y: 0, w: 0, h: 0 };

  const updateSelection = () => {
    selection.style.left = rect.x + 'px';
    selection.style.top = rect.y + 'px';
    selection.style.width = rect.w + 'px';
    selection.style.height = rect.h + 'px';
  };

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target === btnConfirm || e.target === btnCancel) return;

    const handle = handles.find(h => h.el === e.target);
    if (handle) {
      isResizing = handle.pos;
      startX = e.clientX; startY = e.clientY;
      return;
    }

    if (e.target === selection) {
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      return;
    }

    isDrawing = true;
    startX = e.clientX; startY = e.clientY;
    rect = { x: startX, y: startY, w: 0, h: 0 };
    selection.style.display = 'block';
    updateSelection();
  });

  const mousemove = (e) => {
    if (isDrawing) {
      rect.x = Math.min(startX, e.clientX);
      rect.y = Math.min(startY, e.clientY);
      rect.w = Math.abs(e.clientX - startX);
      rect.h = Math.abs(e.clientY - startY);
      updateSelection();
    } else if (isDragging) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      rect.x += dx;
      rect.y += dy;
      startX = e.clientX; startY = e.clientY;
      updateSelection();
    } else if (isResizing) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (isResizing.includes('e')) { rect.w += dx; }
      if (isResizing.includes('w')) { rect.x += dx; rect.w -= dx; }
      if (isResizing.includes('s')) { rect.h += dy; }
      if (isResizing.includes('n')) { rect.y += dy; rect.h -= dy; }
      startX = e.clientX; startY = e.clientY;

      if (rect.w < 0) { rect.x += rect.w; rect.w = Math.abs(rect.w); isResizing = isResizing.replace('e', 'W').replace('w', 'e').toLowerCase(); }
      if (rect.h < 0) { rect.y += rect.h; rect.h = Math.abs(rect.h); isResizing = isResizing.replace('n', 'S').replace('s', 'n').toLowerCase(); }

      updateSelection();
    }
  };

  const mouseup = () => {
    isDrawing = false;
    isDragging = false;
    isResizing = null;
  };

  window.addEventListener('mousemove', mousemove);
  window.addEventListener('mouseup', mouseup);

  const cleanup = () => {
    window.removeEventListener('mousemove', mousemove);
    window.removeEventListener('mouseup', mouseup);
    if (document.body.contains(overlay)) {
      document.body.removeChild(overlay);
    }
  };

  btnCancel.onclick = (e) => {
    e.stopPropagation();
    cleanup();
  };

  btnConfirm.onclick = (e) => {
    e.stopPropagation();
    if (rect.w < 10 || rect.h < 10) {
      cleanup();
      return;
    }

    selection.style.boxShadow = 'none';
    selection.style.border = 'none';
    btnContainer.style.display = 'none';
    handles.forEach(h => h.el.style.display = 'none');

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'HERAAI_CROP_DONE',
        coords: {
          x: rect.x, y: rect.y, width: rect.w, height: rect.h,
          pixelRatio: window.devicePixelRatio
        }
      }).catch(() => {
        // Fallback: use storage
        chrome.storage.local.set({
          heraaiCropData: {
            x: rect.x, y: rect.y, width: rect.w, height: rect.h,
            pixelRatio: window.devicePixelRatio
          }
        });
      });
      cleanup();
    }, 50);
  };
}
