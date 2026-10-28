// While a job runs (a batch, an export, an AI order), the development server must not reload the page: an edit to the page's
// files did, mid-batch, and the images in flight lost their page (their replies: "Broken pipe"). The reload is held, and the page
// reloads by itself once the job ends (app.js, with the server-restart check). Does nothing in the built app (no import.meta.hot).
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    if (!(window.isBusy && window.isBusy())) return;
    window.__reloadWhenIdle = true;
    if (window.setStatus) window.setStatus('The page was updated: it reloads once this job ends.');
    throw new Error('Phosphene: reload held until the running job ends');   // a throw here is what stops Vite's reload
  });
}
