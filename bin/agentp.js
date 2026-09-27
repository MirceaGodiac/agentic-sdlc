#!/usr/bin/env node
// node:sqlite is stable enough for our use but still prints an ExperimentalWarning; hide only that one.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  console.warn(w);
});
await import('../dist/cli/main.js');
