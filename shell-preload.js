const { contextBridge } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('youtubeTrayShell', {
  adGuardPreload: pathToFileURL(path.join(__dirname, 'ad-skip.js')).href
});
