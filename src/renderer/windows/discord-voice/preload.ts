import { contextBridge, ipcRenderer } from "electron";

let recapture: (() => void) | null = null;
ipcRenderer.on("discordVoice:recapture", () => {
  recapture?.();
});

contextBridge.exposeInMainWorld("discordVoice", {
  sendPcm: (bytes: Uint8Array) => ipcRenderer.send("discordVoice:pcm", bytes),
  reportError: (message: string) => ipcRenderer.send("discordVoice:captureError", message),
  reportStarted: () => ipcRenderer.send("discordVoice:captureStarted"),
  onRecapture: (callback: () => void) => {
    recapture = callback;
  }
});
