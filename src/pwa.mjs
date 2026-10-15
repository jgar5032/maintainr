if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      let updateRequested = false;
      const offerUpdate = () => {
        if (!registration.waiting || !navigator.serviceWorker.controller || document.querySelector('#update-notice')) return;
        const notice = document.createElement('div'); notice.id = 'update-notice'; notice.className = 'update-notice';
        notice.setAttribute('role', 'status');
        notice.innerHTML = '<span>A Maintainr update is ready.</span><button type="button" class="button button-quiet">Update & reload</button>';
        notice.querySelector('button').onclick = () => {
          if (document.querySelector('dialog[open]') && !confirm('Reload and discard the open form? Saved records will be kept.')) return;
          updateRequested = true; registration.waiting?.postMessage('ACTIVATE_UPDATE');
        };
        document.body.prepend(notice);
      };
      offerUpdate();
      registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', offerUpdate); });
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); });
    } catch (error) {
      // Database use still works online if shell caching fails. Report that
      // offline installation is incomplete instead of claiming it succeeded.
      const notice = document.createElement('p'); notice.className = 'storage-warning'; notice.setAttribute('role', 'status');
      notice.textContent = 'Offline installation could not finish. Reconnect and reload before using Maintainr offline.';
      document.body.prepend(notice); console.error('Offline installation failed', error);
    }
  });
}
