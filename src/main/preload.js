'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('tether', {
  platform: process.platform,
  defaults: () => call('defaults'),
  pickFolder: (title) => call('pickFolder', title),
  previewName: (input) => call('previewName', input),
  sessions: () => call('sessions'),
  createSession: (input) => call('createSession', input),
  openSession: (id) => call('openSession', id),
  closeSession: () => call('closeSession'),
  addLocation: (name) => call('addLocation', name),
  setActiveLocation: (name) => call('setActiveLocation', name),
  setReview: (id, review) => call('setReview', id, review),
  retry: (id) => call('retry', id),
  retryAll: () => call('retryAll'),
  clearEvents: () => call('clearEvents'),
  analyze: (id) => call('analyze', id),
  clipMask: (id) => call('clipMask', id),
  reveal: (id) => call('reveal', id),
  cameras: () => call('cameras'),
  chooseCameraFolder: (cam) => call('chooseCameraFolder', cam),
  dismissMissingCamera: (key) => call('dismissMissingCamera', key),
  onCameras: on('cameras'),
  sonyState: () => call('sonyState'),
  sonyShoot: () => call('sonyShoot'),
  onSony: on('sony'),
  onAsset: on('asset'),
  onStats: on('stats'),
  onSession: on('session'),
});
