// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from "electron";
import { MemoryStoreSchema, StoreSchema } from "~shared/store/schema";
import MemoryStore from "../../store-ipc/memory-store";
import Store from "../../store-ipc/store";
import { WindowsEventArguments } from "~shared/types";

const memoryStore = new MemoryStore<MemoryStoreSchema>();
const store = new Store<StoreSchema>();

let captureActive = false;
let captureEmit = false;
let setCaptureActive: ((active: boolean) => void) | null = null;
let setCaptureOutput: ((emit: boolean) => void) | null = null;
let recapture: (() => void) | null = null;

ipcRenderer.on("discordVoice:setActive", (_event, active: boolean) => {
  captureActive = Boolean(active);
  setCaptureActive?.(captureActive);
});
ipcRenderer.on("discordVoice:setOutput", (_event, emit: boolean) => {
  captureEmit = Boolean(emit);
  setCaptureOutput?.(captureEmit);
});
ipcRenderer.on("discordVoice:recapture", () => {
  recapture?.();
});

contextBridge.exposeInMainWorld("ytmd", {
  minimizeWindow: () => ipcRenderer.send("windowControls:minimize"),
  maximizeWindow: () => ipcRenderer.send("windowControls:maximize"),
  restoreWindow: () => ipcRenderer.send("windowControls:restore"),
  closeWindow: () => ipcRenderer.send("windowControls:close"),
  handleWindowEvents: (callback: (args: WindowsEventArguments) => void) =>
    ipcRenderer.on("windowControls:stateChanged", (event: Electron.IpcRendererEvent, args: WindowsEventArguments) => {
      callback(args);
    }),
  requestWindowState: () => ipcRenderer.send("windowControls:requestState"),

  isMainWindow: () => process.argv.includes("is-main-window"),

  openSettingsWindow: () => ipcRenderer.send("window:openSettings"),
  openMiniplayerWindow: () => ipcRenderer.send("window:openMiniplayer"),
  switchFocus: (context: string) => ipcRenderer.send("ytmView:switchFocus", context),
  ytmViewNavigateDefault: () => ipcRenderer.send("ytmView:navigateDefault"),
  ytmViewRecreate: () => ipcRenderer.send("ytmView:recreate"),
  restartApplicationForUpdate: () => ipcRenderer.send("app:restartApplicationForUpdate"),

  memoryStore: {
    set: (key: string, value: unknown) => memoryStore.set(key, value),
    get: async (key: keyof MemoryStoreSchema) => await memoryStore.get(key),
    onStateChanged: (callback: (newState: MemoryStoreSchema, oldState: MemoryStoreSchema) => void) => memoryStore.onStateChanged(callback)
  },
  store: {
    set: (key: string, value: unknown) => store.set(key, value),
    get: async (key: keyof StoreSchema) => await store.get(key),
    reset: (key: keyof StoreSchema) => store.reset(key),
    onDidAnyChange: (callback: (newState: StoreSchema, oldState: StoreSchema) => void) => store.onDidAnyChange(callback)
  }
});

contextBridge.exposeInMainWorld("discordVoice", {
  sendPcm: (bytes: Uint8Array) => ipcRenderer.send("discordVoice:pcm", bytes),
  reportError: (message: string) => ipcRenderer.send("discordVoice:captureError", message),
  reportStarted: () => ipcRenderer.send("discordVoice:captureStarted"),
  onRecapture: (callback: () => void) => {
    recapture = callback;
  },
  onSetActive: (callback: (active: boolean) => void) => {
    setCaptureActive = callback;
    callback(captureActive);
  },
  onSetOutput: (callback: (emit: boolean) => void) => {
    setCaptureOutput = callback;
    callback(captureEmit);
  }
});
